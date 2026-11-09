import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { ProxyConfigSchema } from '../../modules/config/types';
import { setServerConfig } from '../../server/server-config';
import { installProjectContextHook } from '../../modules/proxy-gateway/server/request-project-context';
import { ProxyModelRoutingPolicy } from '../../modules/proxy-gateway/server/proxy-model-routing-policy';

afterEach(() => setServerConfig(null));
it('keeps project aliases isolated through real concurrent Fastify request hooks', async () => {
  setServerConfig(ProxyConfigSchema.parse({ api_key: 'legacy', projects: [
    { id: 'one', name: 'One', api_key: 'one-key', model_mapping: { chosen: 'gemini-one' } },
    { id: 'two', name: 'Two', api_key: 'two-key', model_mapping: { chosen: 'gemini-two' } },
  ], custom_mapping: { chosen: 'gemini-default' } }));
  const server = Fastify();
  installProjectContextHook(server);
  server.get('/mapping', async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { model: new ProxyModelRoutingPolicy().resolveTargetModel('chosen') };
  });
  try {
    const responses = await Promise.all(['one-key', 'two-key', 'legacy', 'one-key'].map((key) =>
      server.inject({ url: '/mapping', headers: { authorization: `Bearer ${key}` } })));
    expect(responses.map((response) => response.json().model)).toEqual(['gemini-one', 'gemini-two', 'gemini-default', 'gemini-one']);
  } finally {
    await server.close();
  }
});
