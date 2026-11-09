import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { openCompatibilityListeners, closeCompatibilityListeners } from '../../server/compatibility-listeners';
import { ProxyConfigSchema } from '../../modules/config/types';

const servers: http.Server[] = [];
afterEach(async () => {
  await closeCompatibilityListeners(servers.splice(0));
});

describe('legacy API port compatibility', () => {
  it('runs identical authenticated streaming handlers on a loopback alias', async () => {
    const primary = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer project-key') { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setImmediate(() => res.end('data: [DONE]\n\n'));
    });
    const aliases = await openCompatibilityListeners(primary, [0]);
    servers.push(...aliases);
    const address = aliases[0].address() as { address: string; port: number };
    expect(address.address).toBe('127.0.0.1');
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    expect((await fetch(url)).status).toBe(401);
    for (const path of ['/admin/accounts', '/admin/dashboard', '/dashboard', '/v1/../admin/accounts', '/v1/%2e%2e/admin/accounts']) {
      expect((await fetch(`http://127.0.0.1:${address.port}${path}`)).status).toBe(404);
    }
    expect(await (await fetch(url, { headers: { authorization: 'Bearer project-key' } })).text())
      .toBe('data: first\n\ndata: [DONE]\n\n');
  });

  it('fails startup on a port collision and closes earlier aliases', async () => {
    const occupied = http.createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    servers.push(occupied);
    const port = (occupied.address() as { port: number }).port;
    await expect(openCompatibilityListeners(http.createServer(), [0, port])).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('rejects duplicate ports, the primary port and wildcard port configuration', () => {
    for (const compatibility_ports of [[8045], [8317, 8317], [0], [65536]]) {
      expect(ProxyConfigSchema.safeParse({ compatibility_ports }).success).toBe(false);
    }
    expect(ProxyConfigSchema.parse({ compatibility_ports: [8317] }).compatibility_ports).toEqual([8317]);
  });
});
