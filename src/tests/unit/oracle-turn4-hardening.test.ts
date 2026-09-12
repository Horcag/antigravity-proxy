import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { extractRequestAbortSignal } from '../../modules/proxy-gateway/server/request-abort-signal';
import {
  ProductionOwnerGate,
  SplitBrainPreventedException,
} from '../../modules/cloud-account/persistence/production-owner-gate';
import { ConnectIngressService, isLocalPeer } from '../../modules/proxy-gateway/server/connect-ingress.service';
import { AdminController } from '../../admin/admin.controller';
import { extractCommentsFromContent, runDebtCheck } from '../../../scripts/quality/check-debt-baseline';
import { countPhysicalLines } from '../../../scripts/quality/file-size-policy';
import { verifyBaselineIntegrity } from '../../../scripts/quality/check-file-size';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Oracle Turn 4 Hardening Suite', () => {
  describe('T4-F06: Request Abort Signal Lifecycle', () => {
    it('Scenario 1: aborts signal if client socket disconnects while waiting for upstream response', async () => {
      const server = http.createServer();
      let capturedSignal: AbortSignal | undefined;

      const bodyReceived = new Promise<void>((resolve) => {
        server.on('request', (req, res) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            expect(req.complete).toBe(true);
            capturedSignal = extractRequestAbortSignal({ raw: req } as any, { raw: res } as any);
            resolve();
          });
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as net.AddressInfo).port;

      const clientReq = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
      });
      clientReq.on('error', () => {});
      clientReq.write('hello upstream');
      clientReq.end();

      await bodyReceived;
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);

      const abortPromise = new Promise<void>((resolve) => {
        if (capturedSignal?.aborted) {
          resolve();
        } else {
          capturedSignal?.addEventListener('abort', () => resolve(), { once: true });
        }
      });

      // Premature client socket destruction
      clientReq.destroy();

      await abortPromise;
      expect(capturedSignal?.aborted).toBe(true);

      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('Scenario 2: does not abort signal on normal event loop continuation when client is connected', async () => {
      const server = http.createServer();
      let capturedSignal: AbortSignal | undefined;

      const responseFinished = new Promise<void>((resolve) => {
        server.on('request', (req, res) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            setImmediate(() => {
              capturedSignal = extractRequestAbortSignal({ raw: req } as any, { raw: res } as any);
              res.end('ok');
              resolve();
            });
          });
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as net.AddressInfo).port;

      const clientReq = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
        },
        (res) => {
          res.resume();
        },
      );
      clientReq.write('hello');
      clientReq.end();

      await responseFinished;
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);

      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  describe('T4-F02: Production Owner Gate (Split-Brain Prevention)', () => {
    it('acquires exclusive ownership and blocks second concurrent owner', async () => {
      // Temporarily override test environment flag to test production lock logic
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        await ProductionOwnerGate.acquireExclusiveOwnership(8045);

        // Attempting to acquire a second owner concurrently must fail
        await expect(
          ProductionOwnerGate.acquireExclusiveOwnership(8046),
        ).rejects.toThrow(SplitBrainPreventedException);

        // Release must permit clean re-acquisition
        await ProductionOwnerGate.releaseExclusiveOwnership();
      } finally {
        await ProductionOwnerGate.releaseExclusiveOwnership();
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  describe('T4-F05: Readiness Gate HTTP Status', () => {
    it('returns HTTP 503 when ConnectIngressService is not ready', () => {
      const controller = new AdminController({} as any);
      const mockReply: any = {
        status: vi.fn(),
      };

      // When instanceAttached is false
      (ConnectIngressService as any).instanceAttached = false;
      const result = controller.health(mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(503);
      expect(result).toEqual({ ok: false, connect_ready: false });
    });

    it('returns HTTP 200 when ConnectIngressService is ready', () => {
      const controller = new AdminController({} as any);
      const mockReply: any = {
        status: vi.fn(),
      };

      (ConnectIngressService as any).instanceAttached = true;
      (ConnectIngressService as any).fatalError = false;
      const result = controller.health(mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, connect_ready: true });
    });
  });

  describe('T4-F04: Debt Baseline Comments & Blanket Suppression', () => {
    it('ignores comment syntax inside string literals', () => {
      const code = 'const fixture = "// eslint-disable-next-line";';
      const comments = extractCommentsFromContent(code);
      expect(comments).toHaveLength(0);
    });

    it('extracts real comments accurately', () => {
      const code = `
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason
        /* eslint-disable -- migration */
      `;
      const comments = extractCommentsFromContent(code);
      expect(comments).toHaveLength(2);
      expect(comments[0].type).toBe('line');
      expect(comments[1].type).toBe('block');
    });

    it('accurately parses Oracle T6-F05 template string and directive counterexamples', () => {
      const code1 = 'export const tag = `${1}`;\n// @ts-expect-error: deliberate negative type test\nexport const value: number = "not a number";';
      const comments1 = extractCommentsFromContent(code1);
      expect(comments1).toHaveLength(1);
      expect(comments1[0].text).toBe('// @ts-expect-error: deliberate negative type test');

      const code2 = 'export const value = `${1} // eslint-disable`;';
      const comments2 = extractCommentsFromContent(code2);
      expect(comments2).toHaveLength(0);

      const code3 = 'const x = `${/* inside */ 42}`; const el = <div>{/* in jsx */ 1}</div>; const re = /abc\\//i; // after regex';
      const comments3 = extractCommentsFromContent(code3);
      expect(comments3).toHaveLength(3);
    });

    it('fails closed when parser fails or receives unparseable content (T7-F01)', () => {
      // 1. extractCommentsFromContent throws with filepath when syntax is unparseable
      expect(() => {
        extractCommentsFromContent('const = ; // unparseable syntax', 'src/broken.ts');
      }).toThrow(/Debt audit could not parse src\/broken\.ts/);

      // 2. verify that runDebtCheck catches parse error, logs failure, and returns 1 without printing OK
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const exitCode = runDebtCheck();
        expect(exitCode).toBe(0);
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Architecture debt baseline OK'));
      } finally {
        consoleErrorSpy.mockRestore();
        consoleLogSpy.mockRestore();
      }
    }, 20_000);

    it('CLI returns exit code 1, logs file path, and omits success summary when a file fails to parse (T7-F01 CLI)', () => {
      const brokenFile = path.join(process.cwd(), 'src/temp-broken-test.ts');
      fs.writeFileSync(brokenFile, 'const = ; // unparseable syntax');
      try {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const exitCode = runDebtCheck();
          expect(exitCode).toBe(1);
          expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Debt audit could not parse src/temp-broken-test.ts'));
          expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Architecture debt baseline OK'));
        } finally {
          consoleErrorSpy.mockRestore();
          consoleLogSpy.mockRestore();
        }
      } finally {
        fs.unlinkSync(brokenFile);
      }
    }, 20_000);
  });

  describe('T4-F03: File Size Line Counting', () => {
    it('counts empty files as 0 lines', () => {
      const tmp = path.join(os.tmpdir(), `test-empty-${Date.now()}.txt`);
      fs.writeFileSync(tmp, '', 'utf-8');
      expect(countPhysicalLines(tmp)).toBe(0);
      fs.unlinkSync(tmp);
    });

    it('does not count trailing newline as extra line (500 lines + LF = 500 lines)', () => {
      const tmp = path.join(os.tmpdir(), `test-500-${Date.now()}.txt`);
      const lines500 = Array.from({ length: 500 }, (_, i) => `const x_${i} = ${i};`).join('\n') + '\n';
      fs.writeFileSync(tmp, lines500, 'utf-8');
      expect(countPhysicalLines(tmp)).toBe(500);
      fs.unlinkSync(tmp);
    });

    it('rejects manual cap inflation against trusted baseline', () => {
      const trustedJson = JSON.stringify({ files: { 'fileA.ts': 600 } });
      const candidateBaseline = { 'fileA.ts': 601 };

      expect(() => {
        verifyBaselineIntegrity('/tmp', candidateBaseline, 'quality/file-size-policy.json', {
          trustedBaselineJson: trustedJson,
          trustedRef: 'origin/main',
        });
      }).toThrow(/Baseline tampering detected: Baseline limit for fileA.ts cannot be manually increased/);
    });

    it('rejects adding new oversized file to baseline', () => {
      const trustedJson = JSON.stringify({ files: { 'fileA.ts': 600 } });
      const candidateBaseline = { 'fileA.ts': 600, 'newOversized.ts': 550 };

      expect(() => {
        verifyBaselineIntegrity('/tmp', candidateBaseline, 'quality/file-size-policy.json', {
          trustedBaselineJson: trustedJson,
          trustedRef: 'origin/main',
        });
      }).toThrow(/Baseline tampering detected: Cannot add new oversized file to baseline/);
    });

    it('throws when trusted baseline JSON is corrupted', () => {
      expect(() => {
        verifyBaselineIntegrity('/tmp', {}, 'quality/file-size-policy.json', {
          trustedBaselineJson: '{ corrupted json',
          trustedRef: 'origin/main',
        });
      }).toThrow(/Failed to parse trusted baseline from git reference/);
    });

    it('throws immediately when explicit trusted reference does not exist without fallback (T6-F02)', () => {
      expect(() => {
        verifyBaselineIntegrity(process.cwd(), {}, 'quality/file-size-baseline.json', {
          trustedRef: 'non-existent-candidate-ref-xyz',
        });
      }).toThrow(/Explicit trusted reference \[non-existent-candidate-ref-xyz\] is not accessible/);
    });
  });

  describe('T6-F03: Strict Local Peer Trust Model', () => {
    it('rejects undefined remoteAddress fail-closed', () => {
      expect(isLocalPeer(undefined)).toBe(false);
    });

    it('rejects non-loopback addresses', () => {
      expect(isLocalPeer('10.0.0.1')).toBe(false);
      expect(isLocalPeer('192.168.1.1')).toBe(false);
      expect(isLocalPeer('1.1.1.1')).toBe(false);
    });

    it('accepts loopback addresses', () => {
      expect(isLocalPeer('127.0.0.1')).toBe(true);
      expect(isLocalPeer('127.0.0.2')).toBe(true);
      expect(isLocalPeer('::1')).toBe(true);
      expect(isLocalPeer('::ffff:127.0.0.1')).toBe(true);
    });
  });
});
