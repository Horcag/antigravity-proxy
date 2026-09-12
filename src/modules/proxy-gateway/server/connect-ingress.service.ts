import dns from 'node:dns';
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
  let hostname = '';
  let port = 0;

  const ipv6Match = /^\[([a-fA-F0-9:]+)\]:([0-9]{1,5})$/.exec(trimmed);
  if (ipv6Match) {
    hostname = ipv6Match[1].toLowerCase();
    port = Number(ipv6Match[2]);
  } else {
    const standardMatch = /^([a-zA-Z0-9.-]+):([0-9]{1,5})$/.exec(trimmed);
    if (!standardMatch) return null;
    hostname = standardMatch[1].toLowerCase();
    port = Number(standardMatch[2]);
  }

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

export function parseIpToUint32(ipStr: string): number | null {
  if (/^\d+$/.test(ipStr)) {
    const n = Number(ipStr);
    if (n >= 0 && n <= 0xffffffff) return n >>> 0;
  }
  if (/^0x[0-9a-fA-F]+$/i.test(ipStr)) {
    const n = Number(ipStr);
    if (n >= 0 && n <= 0xffffffff) return n >>> 0;
  }
  const parts = ipStr.split('.');
  if (parts.length >= 1 && parts.length <= 4 && parts.every(p => /^(0x[0-9a-fA-F]+|\d+)$/i.test(p))) {
    const vals = parts.map(p =>
      p.startsWith('0x') || p.startsWith('0X')
        ? parseInt(p, 16)
        : (p.startsWith('0') && p.length > 1 ? parseInt(p, 8) : parseInt(p, 10)),
    );
    if (vals.some(v => isNaN(v) || v < 0)) return null;
    if (parts.length === 4) {
      if (vals.every(v => v <= 255)) {
        return ((vals[0] << 24) | (vals[1] << 16) | (vals[2] << 8) | vals[3]) >>> 0;
      }
    } else if (parts.length === 2) {
      if (vals[0] <= 255 && vals[1] <= 0xffffff) {
        return ((vals[0] << 24) | vals[1]) >>> 0;
      }
    } else if (parts.length === 1) {
      if (vals[0] <= 0xffffffff) return vals[0] >>> 0;
    }
  }
  return null;
}

export function isDisallowedIp(ip: string): boolean {
  if (!ip) return true;
  let normalized = ip.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice(7);
  }

  const uint = parseIpToUint32(normalized);
  if (uint !== null) {
    const b0 = (uint >>> 24) & 0xff;
    const b1 = (uint >>> 16) & 0xff;
    // 0.0.0.0/8 (Current network)
    if (b0 === 0) return true;
    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;
    // 10.0.0.0/8 (RFC 1918 Private)
    if (b0 === 10) return true;
    // 172.16.0.0/12 (RFC 1918 Private: 172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && (b1 >= 16 && b1 <= 31)) return true;
    // 192.168.0.0/16 (RFC 1918 Private)
    if (b0 === 192 && b1 === 168) return true;
    // 169.254.0.0/16 (Link-local / Cloud metadata)
    if (b0 === 169 && b1 === 254) return true;
    // 100.64.0.0/10 (Carrier-grade NAT: 100.64.0.0 - 100.127.255.255)
    if (b0 === 100 && (b1 >= 64 && b1 <= 127)) return true;
    // 224.0.0.0/4 (Multicast) or 240.0.0.0/4 (Reserved)
    if (b0 >= 224) return true;
    return false;
  }

  // IPv6 checks
  if (normalized === '::1' || normalized === '::') return true;
  // Unique Local Address fc00::/7 (fc.. or fd..)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;
  // Link-local fe80::/10 (fe8.., fe9.., fea.., feb..)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;
  // Multicast ff00::/8
  if (/^ff[0-9a-f]{2}:/i.test(normalized)) return true;

  return false;
}

export function isSelfOrLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  return isDisallowedIp(h);
}

export class ConnectIngressService {
  private static instanceAttached = false;
  private static fatalError = false;

  static isReady(): boolean {
    return this.instanceAttached && !this.fatalError;
  }

  private h2Server: http2.Http2SecureServer | null = null;
  private failoverGateway: CloudCodeFailoverGateway;
  private activeSockets = new Set<net.Socket>();
  private attachedServer: http.Server | null = null;
  private connectListener: ((req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => void) | null = null;
  private readonly maxConcurrentSockets = 512;

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
      ConnectIngressService.fatalError = true;
    });

    this.h2Server.on('clientError', (err, socket) => {
      logger.debug(`[ConnectIngress] Client TLS error: ${err.message}`);
      socket.destroy();
    });

    this.attachedServer = httpServer;
    this.connectListener = (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
      this.handleConnect(req, clientSocket, head);
    };
    httpServer.on('connect', this.connectListener);

    logger.info(
      `[ConnectIngress] Transparent HTTPS failover attached. CA cert path: ${CaManager.getCaCertPath()}`,
    );
    ConnectIngressService.instanceAttached = true;
    ConnectIngressService.fatalError = false;
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
      clientSocket.setTimeout(60000, () => {
        clientSocket.destroy();
      });

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

    if (this.activeSockets.size >= this.maxConcurrentSockets) {
      logger.warn(`[ConnectIngress] Socket pool saturated (${this.activeSockets.size}), rejecting tunnel for ${destination}`);
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Resolve DNS and verify that resolved IPs do not hit private/loopback/cloud-metadata ranges
    dns.lookup(parsed.hostname, { all: true }, (lookupErr, addresses) => {
      if (lookupErr || !addresses || addresses.length === 0) {
        logger.warn(`[ConnectIngress] DNS lookup failed for ${parsed.hostname}: ${lookupErr?.message}`);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const hasDisallowed = addresses.some((a) => isDisallowedIp(a.address));
      if (hasDisallowed) {
        logger.warn(`[ConnectIngress] Non-target destination resolved to disallowed address: ${parsed.hostname}`);
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const verifiedIp = addresses[0].address;
      let clientClosed = false;

      const upstreamSocket = net.connect({ host: verifiedIp, port: parsed.port }, () => {
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
        upstreamSocket.destroy();
      });

      upstreamSocket.once('close', () => {
        clientSocket.destroy();
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
    });
  }

  isAttached(): boolean {
    return this.h2Server !== null;
  }

  close(): void {
    if (this.attachedServer && this.connectListener) {
      this.attachedServer.removeListener('connect', this.connectListener);
      this.connectListener = null;
      this.attachedServer = null;
    }

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
    ConnectIngressService.fatalError = false;
  }
}
