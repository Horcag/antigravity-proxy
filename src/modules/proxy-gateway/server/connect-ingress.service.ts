import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { logger } from '../../../shared/logging/logger';
import { CaManager } from './cert/ca-manager';
import { CloudCodeFailoverGateway, GatewayReceiptTransferError } from './cloudcode-failover-gateway';
import { AnonymousTransportReceiptOwner } from './anonymous-transport-receipt';
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

  const ipv6Match = /^\[([a-fA-F0-9:.%]+)\]:([0-9]{1,5})$/.exec(trimmed);
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
  if (!ipv6Match && (
    hostname.startsWith('.') ||
    hostname.endsWith('.') ||
    hostname.includes('..') ||
    hostname.startsWith('-')
  )) {
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

function isDisallowedIpv4(uint: number): boolean {
  const b0 = (uint >>> 24) & 0xff;
  const b1 = (uint >>> 16) & 0xff;
  if (b0 === 0 || b0 === 127 || b0 === 10 || b0 >= 224) return true;
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  if (b0 === 192 && b1 === 168) return true;
  if (b0 === 169 && b1 === 254) return true;
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  return false;
}

function parseIpv6(ipStr: string): number[] | null {
  let str = ipStr.trim().toLowerCase();
  if (str.startsWith('[') && str.endsWith(']')) str = str.slice(1, -1);
  const zoneIndex = str.indexOf('%');
  if (zoneIndex !== -1) str = str.slice(0, zoneIndex);

  const lastColon = str.lastIndexOf(':');
  if (lastColon !== -1) {
    const potentialIpv4 = str.slice(lastColon + 1);
    if (potentialIpv4.includes('.')) {
      const v4Uint = parseIpToUint32(potentialIpv4);
      if (v4Uint === null) return null;
      str = str.slice(0, lastColon) + ':' + ((v4Uint >>> 16) & 0xffff).toString(16) + ':' + (v4Uint & 0xffff).toString(16);
    }
  }

  const doubleColonCount = (str.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let parts: string[];
  if (doubleColonCount === 1) {
    const [left, right] = str.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 1) return null;
    parts = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  } else {
    parts = str.split(':');
    if (parts.length !== 8) return null;
  }

  const words: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    words.push(parseInt(part, 16));
  }
  return words;
}

export function isDisallowedIp(ip: string): boolean {
  if (!ip) return true;
  let normalized = ip.toLowerCase().trim();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }

  // 1. Try IPv4
  const uint = parseIpToUint32(normalized);
  if (uint !== null) return isDisallowedIpv4(uint);

  // 2. Try IPv6
  const words = parseIpv6(normalized);
  if (words !== null) {
    // Loopback ::1 (all representations: ::1, 0:0:0:0:0:0:0:1, ::0001, [::1], etc.)
    if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
    // Unspecified ::
    if (words.every((w) => w === 0)) return true;

    // IPv4-mapped (::ffff:x.x.x.x) or IPv4-compatible (::x.x.x.x) or NAT64 (64:ff9b::x.x.x.x)
    if (
      (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) ||
      (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) ||
      (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0)
    ) {
      const v4Uint = ((words[6] << 16) | words[7]) >>> 0;
      return isDisallowedIpv4(v4Uint);
    }

    // ULA fc00::/7 (fc.. or fd..)
    if ((words[0] & 0xfe00) === 0xfc00) return true;
    // Link-local fe80::/10 (fe8.. to feb..)
    if ((words[0] & 0xffc0) === 0xfe80) return true;
    // Multicast ff00::/8
    if ((words[0] & 0xff00) === 0xff00) return true;
    // Discard prefix 100::/64
    if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true;

    return false;
  }

  return false;
}

export function isSelfOrLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  return isDisallowedIp(h);
}

export function isLocalPeer(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  let normalized = remoteAddress.toLowerCase().trim();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  if (normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost') return true;
  const uint = parseIpToUint32(normalized);
  if (uint !== null) return ((uint >>> 24) & 0xff) === 127;
  const words = parseIpv6(normalized);
  if (!words) return false;
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    return ((((words[6] << 16) | words[7]) >>> 24) & 0xff) === 127;
  }
  return false;
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
  private reservedSockets = 0;
  private isClosed = false;

  constructor(accountLeaseService?: AccountLeaseService) {
    this.failoverGateway = new CloudCodeFailoverGateway(accountLeaseService);
  }

  attach(httpServer: http.Server): void {
    this.isClosed = false;
    const secureContext = CaManager.ensureCertificates();

    this.h2Server = http2.createSecureServer(
      {
        allowHTTP1: true,
        SNICallback: (servername, cb) => {
          if (servername && !CaManager.isTargetHost(servername)) {
            logger.warn(`[ConnectIngress] SNI servername not allowed: ${servername}`);
            cb(new Error(`Untrusted host: ${servername}`), undefined);
            return;
          }
          cb(null, secureContext);
        },
      },
      (req, res) => {
        this.failoverGateway.handleRequest(req, res).catch((err: unknown) => {
          const originalCause = err instanceof GatewayReceiptTransferError ? err.originalCause : err;
          logger.error('[ConnectIngress] Error processing request in transparent gateway', originalCause);
          const receiptOwner = err instanceof GatewayReceiptTransferError
            ? err.receiptOwner
            : new AnonymousTransportReceiptOwner(crypto.randomUUID());
          receiptOwner.observeResponse(res);
          const rejectAndTerminate = () => {
            receiptOwner.reject('internal_error');
            try {
              if (!res.writableEnded && !(res as any).destroyed) {
                res.destroy(new Error('Gateway internal error response could not be completed'));
              }
            } catch {
              // If the response cannot be destroyed, emit the rejected owner directly.
            }
            receiptOwner.emit();
          };
          if (!res.headersSent) {
            try {
              receiptOwner.expectDownstreamCommit('internal_error');
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 502, message: 'Gateway internal error' } }));
            } catch {
              rejectAndTerminate();
            }
          } else if (!res.writableEnded) {
            rejectAndTerminate();
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
    if (this.isClosed) {
      clientSocket.destroy();
      return;
    }

    // Immediately enforce 60s timeout on client socket before any async operations
    if (typeof clientSocket.setTimeout === 'function') {
      clientSocket.setTimeout(60000, () => {
        clientSocket.destroy();
      });
    }

    clientSocket.on('error', (err) => {
      logger.debug(`[ConnectIngress] Client socket error: ${err.message}`);
    });

    // 1. Verify local peer trust model (CONNECT strictly restricted to loopback)
    if (!isLocalPeer(clientSocket.remoteAddress)) {
      logger.warn(`[ConnectIngress] Non-local peer rejected for CONNECT: ${clientSocket.remoteAddress}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const destination = req.url || '';
    const parsed = parseConnectAuthority(destination);
    if (!parsed) {
      logger.warn(`[ConnectIngress] Malformed CONNECT destination rejected: ${destination}`);
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const isTarget = CaManager.isTargetHost(destination);

    // Enforce concurrency limit uniformly across both target and non-target requests
    // Target uses 1 socket (clientSocket). Non-target uses 2 sockets (clientSocket + upstreamSocket).
    const requiredSockets = isTarget ? 1 : 2;
    if (this.activeSockets.size + this.reservedSockets + requiredSockets > this.maxConcurrentSockets) {
      logger.warn(
        `[ConnectIngress] Socket pool saturated (active=${this.activeSockets.size}, reserved=${this.reservedSockets}, cap=${this.maxConcurrentSockets}), rejecting ${destination}`,
      );
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    this.activeSockets.add(clientSocket);
    clientSocket.once('close', () => {
      this.activeSockets.delete(clientSocket);
    });

    logger.info(`[ConnectIngress] CONNECT destination: ${destination} (intercepted=${isTarget})`);

    // 2. If destination is Google CloudCode, terminate TLS and failover
    if (isTarget) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        clientSocket.unshift(head);
      }

      if (this.h2Server && !this.isClosed) {
        this.h2Server.emit('connection', clientSocket);
      }
      return;
    }

    // 3. Standard TCP tunnel for non-target destinations
    if (isSelfOrLoopback(parsed.hostname) || (parsed.port !== 443 && parsed.port !== 8443)) {
      logger.warn(`[ConnectIngress] Non-target destination disallowed: ${destination}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Reserve 1 socket slot for upstream during DNS lookup
    this.reservedSockets++;
    let hasReservation = true;
    const releaseReservation = () => {
      if (hasReservation) {
        this.reservedSockets = Math.max(0, this.reservedSockets - 1);
        hasReservation = false;
      }
    };

    let clientClosed = clientSocket.destroyed || clientSocket.closed;
    const onEarlyClose = () => {
      clientClosed = true;
      releaseReservation();
    };
    clientSocket.once('close', onEarlyClose);

    dns.lookup(parsed.hostname, { all: true }, (lookupErr, addresses) => {
      clientSocket.removeListener('close', onEarlyClose);
      releaseReservation();

      if (this.isClosed || clientClosed || clientSocket.destroyed || clientSocket.closed) {
        return;
      }

      if (lookupErr || !addresses || addresses.length === 0) {
        logger.warn(`[ConnectIngress] DNS lookup failed for ${parsed.hostname}: ${lookupErr?.message}`);
        if (!clientSocket.destroyed && !clientSocket.closed) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.destroy();
        }
        return;
      }

      const hasDisallowed = addresses.some((a) => isDisallowedIp(a.address));
      if (hasDisallowed) {
        logger.warn(`[ConnectIngress] Non-target destination resolved to disallowed address: ${parsed.hostname}`);
        if (!clientSocket.destroyed && !clientSocket.closed) {
          clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          clientSocket.destroy();
        }
        return;
      }

      if (this.isClosed || clientClosed || clientSocket.destroyed || clientSocket.closed) {
        return;
      }

      const verifiedIp = addresses[0].address;

      const upstreamSocket = net.connect({ host: verifiedIp, port: parsed.port }, () => {
        if (this.isClosed || clientClosed || clientSocket.destroyed || clientSocket.closed) {
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

      this.activeSockets.add(upstreamSocket);
      upstreamSocket.once('close', () => {
        this.activeSockets.delete(upstreamSocket);
      });

      clientSocket.once('close', () => {
        clientClosed = true;
        upstreamSocket.destroy();
      });

      upstreamSocket.once('close', () => {
        clientSocket.destroy();
      });

      upstreamSocket.setTimeout(60000, () => {
        upstreamSocket.destroy();
        clientSocket.destroy();
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
    this.isClosed = true;
    this.reservedSockets = 0;
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
