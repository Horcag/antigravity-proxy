import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { logger } from '../../../shared/logging/logger';
import { CaManager } from './cert/ca-manager';
import { CloudCodeFailoverGateway } from './cloudcode-failover-gateway';
import { AccountLeaseService } from './account-lease.service';

export interface ParsedConnectAuthority {
  hostname: string;
  port: number;
}

export function parseConnectAuthority(destination: string | undefined): ParsedConnectAuthority | null {
  if (!destination || typeof destination !== 'string') return null;
  const trimmed = destination.trim();
  const match = /^([a-zA-Z0-9.-]+):([0-9]{1,5})$/.exec(trimmed);
  if (!match) return null;
  const hostname = match[1].toLowerCase();
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (
    hostname.startsWith('.') ||
    hostname.endsWith('.') ||
    hostname.includes('..') ||
    hostname.startsWith('-')
  ) {
    return null;
  }
  return { hostname, port };
}

export function isSelfOrLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export class ConnectIngressService {
  private static instanceAttached = false;

  static isReady(): boolean {
    return this.instanceAttached;
  }

  private h2Server: http2.Http2SecureServer | null = null;
  private failoverGateway: CloudCodeFailoverGateway;
  private activeSockets = new Set<net.Socket>();

  constructor(accountLeaseService?: AccountLeaseService) {
    this.failoverGateway = new CloudCodeFailoverGateway(accountLeaseService);
  }

  attach(httpServer: http.Server): void {
    const secureContext = CaManager.ensureCertificates();

    this.h2Server = http2.createSecureServer(
      {
        allowHTTP1: true,
        SNICallback: (servername, cb) => {
          if (servername && !CaManager.isTargetHost(servername)) {
            logger.warn(`[ConnectIngress] SNI servername not allowed: ${servername}`);
            cb(new Error(`SNI servername not allowed: ${servername}`));
            return;
          }
          cb(null, secureContext);
        },
      },
      (req, res) => {
        this.failoverGateway.handleRequest(req, res).catch((err) => {
          logger.error('[ConnectIngress] Gateway error handling request', err);
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 502, message: String(err) } }));
          }
        });
      },
    );

    this.h2Server.on('error', (err) => {
      logger.warn('[ConnectIngress] Internal TLS server error', err);
    });

    this.h2Server.on('clientError', (err, socket) => {
      logger.debug(`[ConnectIngress] Client TLS error: ${err.message}`);
      socket.destroy();
    });

    httpServer.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
      this.handleConnect(req, clientSocket, head);
    });

    logger.info(
      `[ConnectIngress] Transparent HTTPS failover attached. CA cert path: ${CaManager.getCaCertPath()}`,
    );
    ConnectIngressService.instanceAttached = true;
  }

  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    this.activeSockets.add(clientSocket);
    clientSocket.once('close', () => {
      this.activeSockets.delete(clientSocket);
    });

    const destination = req.url || '';
    const parsed = parseConnectAuthority(destination);
    if (!parsed) {
      logger.warn(`[ConnectIngress] Malformed CONNECT destination rejected: ${destination}`);
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    clientSocket.on('error', (err) => {
      logger.debug(`[ConnectIngress] Client socket error for ${destination}: ${err.message}`);
    });

    // 1. If destination is Google CloudCode, terminate TLS and failover
    const isTarget = CaManager.isTargetHost(destination);
    logger.info(`[ConnectIngress] CONNECT destination: ${destination} (intercepted=${isTarget})`);

    if (isTarget) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      if (head && head.length > 0) {
        clientSocket.unshift(head);
      }

      if (this.h2Server) {
        this.h2Server.emit('connection', clientSocket);
      }
      return;
    }

    // 2. Standard TCP tunnel for non-target destinations
    if (isSelfOrLoopback(parsed.hostname) || (parsed.port !== 443 && parsed.port !== 8443)) {
      logger.warn(`[ConnectIngress] Non-target destination disallowed: ${destination}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    let isConnected = false;
    let clientClosed = false;

    const upstreamSocket = net.connect(parsed.port, parsed.hostname, () => {
      isConnected = true;
      if (clientClosed) {
        upstreamSocket.destroy();
        return;
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });

    clientSocket.once('close', () => {
      clientClosed = true;
      if (!isConnected) {
        upstreamSocket.destroy();
      }
    });

    clientSocket.setTimeout(60000, () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    });

    upstreamSocket.setTimeout(60000, () => {
      upstreamSocket.destroy();
      clientSocket.destroy();
    });

    this.activeSockets.add(upstreamSocket);
    upstreamSocket.once('close', () => {
      this.activeSockets.delete(upstreamSocket);
    });

    upstreamSocket.on('error', (err) => {
      logger.debug(`[ConnectIngress] Upstream tunnel error for ${destination}: ${err.message}`);
      clientSocket.destroy();
    });
  }

  isAttached(): boolean {
    return this.h2Server !== null;
  }

  close(): void {
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore error
      }
    }
    this.activeSockets.clear();

    if (this.h2Server) {
      try {
        this.h2Server.close();
      } catch {
        // ignore close error
      }
      this.h2Server = null;
    }
    ConnectIngressService.instanceAttached = false;
  }
}
