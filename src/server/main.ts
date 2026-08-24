import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { logger } from '../shared/logging/logger';
import { AccountLeaseService } from '../modules/proxy-gateway/server/account-lease.service';

import { ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from './server-config';

let app: NestFastifyApplication | null = null;
let currentPort: number = 0;
let currentHost = '127.0.0.1';

export type NestServerStartResult =
  | {
      success: true;
      port: number;
      base_url: string;
    }
  | {
      success: false;
      reason: 'address-in-use' | 'invalid-config' | 'unknown';
      port: number;
      message: string;
    };

function isAddressInUseError(error: unknown): boolean {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return false;
  }

  return Reflect.get(error, 'code') === 'EADDRINUSE';
}

async function cleanupFailedServerStart() {
  if (!app) {
    return;
  }

  try {
    await app.close();
  } catch (closeError) {
    logger.warn('Failed to clean up NestJS server after startup failure', closeError);
  } finally {
    app = null;
    currentPort = 0;
    currentHost = '127.0.0.1';
  }
}

export async function bootstrapNestServer(config: ProxyConfig): Promise<NestServerStartResult> {
  const port = config.port || 8045;
  const host = config.host || '127.0.0.1';
  if (app) {
    logger.info('NestJS server already running.');
    return {
      success: true,
      port: currentPort,
      base_url: `http://${currentHost}:${currentPort}`,
    };
  }

  setServerConfig(config);

  const isLoopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
  if (!isLoopback) {
    if (!config.api_key || !config.admin_api_key) {
      return {
        success: false,
        reason: 'invalid-config',
        port,
        message: 'Non-loopback binding requires both proxy and admin API keys',
      };
    }
    if (config.api_key === config.admin_api_key) {
      return {
        success: false,
        reason: 'invalid-config',
        port,
        message: 'Proxy and admin API keys must be different for non-loopback binding',
      };
    }
  }

  try {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: ['error', 'warn', 'log'],
    });

    // Enable CORS
    app.enableCors();

    await app.listen(port, host);
    currentPort = port;
    currentHost = host;
    logger.info(`NestJS Proxy Server running on http://${host}:${port}`);
    return {
      success: true,
      port,
      base_url: `http://${host}:${port}`,
    };
  } catch (error) {
    await cleanupFailedServerStart();

    if (isAddressInUseError(error)) {
      const message = `Port ${port} is already in use`;
      logger.warn(`NestJS Proxy Server could not start: ${message}`, error);
      return {
        success: false,
        reason: 'address-in-use',
        port,
        message,
      };
    }

    logger.error('Failed to start NestJS server', error);
    return {
      success: false,
      reason: 'unknown',
      port,
      message: error instanceof Error ? error.message : 'Failed to start NestJS server',
    };
  }
}

export async function stopNestServer(): Promise<boolean> {
  if (app) {
    try {
      await app.close();
      app = null;
      currentPort = 0;
      currentHost = '127.0.0.1';
      logger.info('NestJS server stopped.');
      return true;
    } catch (e) {
      logger.error('Failed to stop NestJS server', e);
      return false;
    }
  }
  return true;
}

export function isNestServerRunning(): boolean {
  return app !== null;
}

export async function getNestServerStatus(): Promise<{
  running: boolean;
  port: number;
  base_url: string;
  active_accounts: number;
}> {
  const running = isNestServerRunning();
  let activeAccounts = 0;

  if (app) {
    try {
      const accountLeaseService = app.get(AccountLeaseService);
      activeAccounts = accountLeaseService.getAccountCount();
    } catch (e) {
      // AccountLeaseService might not be available
    }
  }

  return {
    running,
    port: currentPort,
    base_url: running ? `http://${currentHost}:${currentPort}` : '',
    active_accounts: activeAccounts,
  };
}
