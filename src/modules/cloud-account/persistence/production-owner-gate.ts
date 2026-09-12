import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../../../shared/logging/logger';
import { getDataDir } from '../../../shared/paths';

export class SplitBrainPreventedException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitBrainPreventedException';
  }
}

export interface OwnerInfo {
  pid: number;
  port?: number;
  startedAt: string;
}

export class ProductionOwnerGate {
  private static ownerServer: net.Server | null = null;
  private static socketPath: string | null = null;
  private static lockFilePath: string | null = null;

  private static getSocketPath(): string {
    // On Linux, use abstract domain socket which is cleaned up automatically on process exit
    if (process.platform === 'linux') {
      return '\0antigravity-proxy-production-owner';
    }
    return path.join(os.tmpdir(), 'antigravity-proxy-production-owner.sock');
  }

  static async acquireExclusiveOwnership(port?: number): Promise<void> {
    if (this.ownerServer) {
      throw new SplitBrainPreventedException('Exclusive ownership is already held by this process.');
    }

    const sock = this.getSocketPath();
    const info: OwnerInfo = {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
    };

    // On non-Linux or filesystem sockets, if old socket file exists, verify if owner is alive
    if (process.platform !== 'linux' && fs.existsSync(sock)) {
      const isAlive = await this.queryExistingOwner(sock);
      if (isAlive) {
        throw new SplitBrainPreventedException(
          `Another production owner process is already running and active. Refusing concurrent production start.`,
        );
      }
      try {
        fs.unlinkSync(sock);
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((conn) => {
        try {
          conn.write(JSON.stringify(info));
        } catch {
          // ignore
        } finally {
          conn.end();
        }
      });

      server.on('error', async (err: any) => {
        if (err.code === 'EADDRINUSE') {
          const owner = await this.queryExistingOwner(sock);
          const msg = owner
            ? `Another production instance (PID ${owner.pid}, port ${owner.port ?? 'unknown'}) already holds exclusive ownership of production accounts.`
            : `Another production instance already holds exclusive ownership (address in use).`;
          logger.error(`[ProductionOwnerGate] ${msg}`);
          reject(new SplitBrainPreventedException(msg));
        } else {
          logger.error('[ProductionOwnerGate] Failed to bind ownership gate', err);
          reject(err);
        }
      });

      server.listen(sock, () => {
        this.ownerServer = server;
        this.socketPath = sock;
        logger.info(`[ProductionOwnerGate] Exclusive production account ownership acquired by PID ${process.pid}`);
        try {
          this.lockFilePath = path.join(getDataDir(), 'accounts.db.owner');
          fs.writeFileSync(this.lockFilePath, JSON.stringify(info, null, 2), {
            encoding: 'utf-8',
            mode: 0o600,
          });
        } catch {
          // ignore lockfile error
        }
        resolve();
      });
    });
  }

  private static async queryExistingOwner(sock: string): Promise<OwnerInfo | null> {
    return new Promise((resolve) => {
      let data = '';
      const client = net.connect(sock, () => {});
      client.setTimeout(1000);
      client.on('data', (chunk) => {
        data += chunk.toString();
      });
      client.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ pid: -1, startedAt: 'unknown' });
        }
      });
      client.on('error', () => {
        resolve(null);
      });
      client.on('timeout', () => {
        client.destroy();
        resolve(null);
      });
    });
  }

  static async releaseExclusiveOwnership(): Promise<void> {
    if (this.ownerServer) {
      await new Promise<void>((resolve) => {
        this.ownerServer?.close(() => resolve());
      });
      this.ownerServer = null;
    }
    if (this.socketPath && process.platform !== 'linux' && fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
    if (this.lockFilePath && fs.existsSync(this.lockFilePath)) {
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch {
        // ignore
      }
    }
    this.socketPath = null;
    this.lockFilePath = null;
  }
}
