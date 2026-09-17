import { describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import { formatTerminalDownstreamError } from '../../modules/proxy-gateway/server/cloudcode-terminal-response';
import {
  classifyUpstreamFailure,
  safeDecodeGrpcMessage,
} from '../../modules/proxy-gateway/server/upstream-failure';

describe('Oracle Round 6 Representation & Decoding Boundaries', () => {
  describe('Item 1: Distinguish wire text from decoded text in upstream failure classification', () => {
    it('JSON BadRequest containing literal %22quota%22 preserves syntax and classifies as invalid-request with fieldViolations', () => {
      const jsonBody = JSON.stringify({
        error: {
          code: 400,
          message: 'Invalid value %22quota%22.',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [
                { field: 'filter', description: 'Invalid value %22quota%22.' },
              ],
            },
          ],
        },
      });

      const evidence = classifyUpstreamFailure({
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from(jsonBody, 'utf-8'),
        source: 'json',
      });

      expect(evidence.category).toBe('invalid-request');
      expect(evidence.isQuota).toBe(false);
      expect(evidence.ruleId).toBe('google.aip193.bad-request');
      expect(evidence.rpcStatus).toBe('INVALID_ARGUMENT');
      expect(evidence.rawErrorText).toContain('%22quota%22');

      const parsed = JSON.parse(evidence.rawErrorText || '{}');
      const details = parsed?.error?.details || [];
      const hasFieldViolations = details.some(
        (d: any) => d['@type']?.includes('BadRequest') && Array.isArray(d.fieldViolations) && d.fieldViolations.length > 0,
      );
      expect(hasFieldViolations).toBe(true);
    });

    it('gRPC wire message containing %2520 is decoded exactly once and avoids false project context trigger', () => {
      const wireMessage = 'Access%20denied%20to%20resource%20quota%2520project.';

      // 1. In gateway: safeDecodeGrpcMessage decodes %20 to space, while %2520 decodes to %20
      const gatewayDecoded = safeDecodeGrpcMessage(wireMessage);
      expect(gatewayDecoded).toBe('Access denied to resource quota%20project.');
      expect(gatewayDecoded).not.toBe('Access denied to resource quota project.');

      // 2. In classifier when explicit errorText is supplied by caller (already decoded):
      const evidenceWithExplicit = classifyUpstreamFailure({
        statusCode: 403,
        headers: {
          'content-type': 'application/grpc',
          'grpc-status': '7',
          'grpc-message': wireMessage,
        },
        errorText: gatewayDecoded,
        source: 'grpc',
      });

      expect(evidenceWithExplicit.category).toBe('permission-denied');
      expect(evidenceWithExplicit.category).not.toBe('project-context');
      expect(evidenceWithExplicit.rawErrorText).toBe('Access denied to resource quota%20project.');

      // 3. In classifier when errorText is omitted and extracted from grpc-message header:
      const evidenceFromHeader = classifyUpstreamFailure({
        statusCode: 403,
        headers: {
          'content-type': 'application/grpc',
          'grpc-status': '7',
          'grpc-message': wireMessage,
        },
        source: 'grpc',
      });

      expect(evidenceFromHeader.category).toBe('permission-denied');
      expect(evidenceFromHeader.category).not.toBe('project-context');
      expect(evidenceFromHeader.rawErrorText).toBe('Access denied to resource quota%20project.');
    });
  });

  describe('Item 2: Encoding headers and terminal error decompression', () => {
    it('Valid Brotli compressed JSON starting with 0x5b ([) decompresses and strips content-encoding', () => {
      const origError = {
        error: {
          code: 400,
          message: 'Invalid argument in brotli stream',
          status: 'INVALID_ARGUMENT',
        },
      };
      const json = JSON.stringify(origError);
      const req = { headers: { accept: 'application/json' } };

      const compressed = zlib.brotliCompressSync(Buffer.from(json, 'utf-8'));
      const f = formatTerminalDownstreamError(
        req as any,
        400,
        {
          'content-type': 'application/json',
          'content-encoding': 'br',
          'content-length': String(compressed.length),
        },
        compressed,
      );

      expect(f.statusCode).toBe(400);
      expect(f.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(f.body as string)).toEqual(origError);
    });

    it('Reconstructed plaintext application error without content-encoding is preserved verbatim', () => {
      const origError = {
        error: {
          code: 400,
          message: 'thought_signature is required',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [{ field: 'thought_signature', description: 'required' }],
            },
          ],
        },
      };
      const json = JSON.stringify(origError);
      const uncompressedBuf = Buffer.from(json, 'utf-8');
      const req = { headers: { accept: 'application/json' } };

      // Gateway deletes content-encoding and content-length before passing reconstructed application error
      const f = formatTerminalDownstreamError(
        req as any,
        400,
        {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(uncompressedBuf.length),
        },
        uncompressedBuf,
      );

      expect(f.statusCode).toBe(400);
      expect(f.headers['content-encoding']).toBeUndefined();
      expect(f.body).toBe(json);
      expect(JSON.parse(f.body as string)).toEqual(origError);
    });

    it('Oversized compressed body (>1MB) returns safe BAD_GATEWAY JSON without crashing', () => {
      const hugeBuf = Buffer.alloc(1024 * 1024 + 128, 0x78); // >1MB
      const req = { headers: { accept: 'application/json' } };

      // Oversized gzip
      const gz = zlib.gzipSync(hugeBuf);
      const fGz = formatTerminalDownstreamError(
        req as any,
        500,
        {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': String(gz.length),
        },
        gz,
      );

      expect(fGz.statusCode).toBe(500);
      expect(fGz.headers['content-encoding']).toBeUndefined();
      const parsedGz = JSON.parse(fGz.body as string);
      expect(parsedGz.error.status).toBe('BAD_GATEWAY');
      expect(parsedGz.error.message).toBe('Upstream error response could not be decoded');

      // Oversized brotli
      const br = zlib.brotliCompressSync(hugeBuf);
      const fBr = formatTerminalDownstreamError(
        req as any,
        502,
        {
          'content-type': 'application/json',
          'content-encoding': 'br',
          'content-length': String(br.length),
        },
        br,
      );

      expect(fBr.statusCode).toBe(502);
      expect(fBr.headers['content-encoding']).toBeUndefined();
      const parsedBr = JSON.parse(fBr.body as string);
      expect(parsedBr.error.status).toBe('BAD_GATEWAY');
      expect(parsedBr.error.message).toBe('Upstream error response could not be decoded');
    });
  });
});
