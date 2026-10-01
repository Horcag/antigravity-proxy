import { Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Observable } from 'rxjs';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { logUpstreamTerminalDiagnostic } from '@/modules/proxy-gateway/server/cloudcode-diagnostics';

const body = { model: 'gemini-3-flash', project: '', requestId: 'caller-secret', request: {} };
const secret = 'SYNTHETIC_SECRET password=private-value https://user:password@private.test';
function observeLogs() {
  const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  return () => spy.mock.calls.flatMap(([message]) => {
    const match = String(message).match(/^\[UpstreamTerminal\] (.*)$/);
    return match ? [JSON.parse(match[1])] : [];
  });
}
function collect(stream: Observable<string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    stream.subscribe({ next: chunk => chunks.push(chunk), complete: () => resolve(chunks), error: reject });
  });
}
afterEach(() => vi.restoreAllMocks());

describe('upstream terminal diagnostics', () => {
  it('logs an allowlisted raw nonstream enum and actual HTTP status without altering the envelope', async () => {
    const logs = observeLogs();
    const response = { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [{ text: secret }] } }] };
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 201, data: { response } });
    const result = await new GeminiClient().generateInternal(body as never, secret);
    expect(result).toBe(response);
    expect(logs().map(x => x.event)).toEqual(['start', 'http_response', 'terminal']);
    expect(logs()[2]).toMatchObject({ httpStatus: 201, rawTerminalEnum: 'MALFORMED_FUNCTION_CALL' });
    expect(new Set(logs().map(x => x.requestId)).size).toBe(1);
    expect(logs()[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(logs())).not.toContain(secret);
    expect(JSON.stringify(logs())).not.toContain('caller-secret');
    expect(Object.keys(response)).toEqual(['candidates']);
  });

  it.each(['chat-completions', 'responses'].flatMap(protocol =>
    ['MALFORMED_FUNCTION_CALL', 'MALFORMED_RESPONSE', 'MISSING_THOUGHT_SIGNATURE'].map(reason => [protocol, reason]),
  ))('correlates real client transport with %s/%s terminal while preserving fail-closed wire mapping', async (protocol, reason) => {
    const logs = observeLogs();
    const source = new Readable({ read() {} });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: source });
    const stream = await new GeminiClient().streamGenerateInternal(body as never, secret);
    expect(stream).toBe(source);
    const service = new ProxyService({} as never, {} as never);
    const result = collect((service as any).createOpenAIProtocolStream(stream, 'gemini-3-flash', protocol, { variant: 'chat', includeUsage: false }));
    source.push(`data: ${JSON.stringify({ candidates: [{ finishReason: reason }] })}\n\n`);
    source.push(null);
    const chunks = await result;
    expect(chunks.join('')).toContain('content_filter');
    expect(logs().map(x => x.event)).toEqual(['start', 'http_response', 'terminal']);
    expect(logs()[2]).toMatchObject({ httpStatus: 200, rawTerminalEnum: reason });
    expect(new Set(logs().map(x => x.requestId)).size).toBe(1);
    expect(chunks.join('')).not.toContain(logs()[0].requestId);
    expect(chunks.join('')).not.toContain(reason);
  });

  it.each(['chat-completions', 'responses'])('keeps arbitrary terminal content out of %s logs', async protocol => {
    const logs = observeLogs();
    const source = new Readable({ read() {} });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: source });
    const stream = await new GeminiClient().streamGenerateInternal(body as never, secret);
    const service = new ProxyService({} as never, {} as never);
    const result = collect((service as any).createOpenAIProtocolStream(stream, 'gemini-3-flash', protocol, { variant: 'chat', includeUsage: false }));
    source.push(`data: ${JSON.stringify({ candidates: [{ finishReason: secret }] })}\n\n`);
    source.push(null);
    expect((await result).join('')).toContain('content_filter');
    expect(logs().at(-1)).toMatchObject({ rawTerminalEnum: 'UNKNOWN_TERMINAL' });
    expect(JSON.stringify(logs())).not.toContain(secret);
  });

  it('retains a stable server trace across endpoint failure and success without exception data', async () => {
    const logs = observeLogs();
    const failure = new AxiosError(secret, 'ERR_BAD_RESPONSE', undefined, undefined, { status: 503, data: { message: secret } } as never);
    vi.spyOn(axios, 'post').mockRejectedValueOnce(failure).mockResolvedValue({ status: 200, data: { candidates: [{ finishReason: 'STOP' }] } });
    await new GeminiClient().generateInternal(body as never, secret);
    expect(logs().map(x => x.event)).toEqual(['start', 'failure', 'http_response', 'terminal']);
    expect(logs()[1]).toMatchObject({ httpStatus: 503, rawTerminalEnum: 'ABSENT' });
    expect(new Set(logs().map(x => x.requestId)).size).toBe(1);
    expect(JSON.stringify(logs())).not.toContain(secret);
  });

  it.each(['chat-completions', 'responses'])('links %s stream failures to the same transport status and trace', async protocol => {
    const logs = observeLogs();
    const source = new Readable({ read() {} });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: source });
    const stream = await new GeminiClient().streamGenerateInternal(body as never, secret);
    const service = new ProxyService({} as never, {} as never);
    const result = collect((service as any).createOpenAIProtocolStream(stream, 'gemini-3-flash', protocol, { variant: 'chat', includeUsage: false }));
    source.destroy(new Error(secret));
    if (protocol === 'responses') expect((await result).join('')).toContain('response.failed');
    else await expect(result).rejects.toThrow('Upstream stream failed');
    expect(logs().at(-1)).toMatchObject({ event: 'failure', httpStatus: 200 });
    expect(new Set(logs().map(x => x.requestId)).size).toBe(1);
    expect(JSON.stringify(logs())).not.toContain(secret);
  });

  it('bounds unknown enum values, forged IDs, and nonnumeric statuses without logging derivatives', () => {
    const logs = observeLogs();
    for (const value of [secret, 'STOP\n' + secret, 'SAFETY_SECRET', 'x'.repeat(10000), { secret }]) {
      logUpstreamTerminalDiagnostic({ requestId: secret, httpStatus: secret as never }, 'terminal', value);
    }
    for (const event of logs()) {
      expect(event).toEqual({ event: 'terminal', requestId: 'invalid_request_id', httpStatus: null, rawTerminalEnum: 'UNKNOWN_TERMINAL' });
    }
  });
});
