import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import type { ProxyApiProject } from '../../config/types';
import { getServerConfig } from '../../../server/server-config';
import { extractApiKeyToken, resolveApiProject } from './guards/api-key-auth.util';

const projects = new AsyncLocalStorage<ProxyApiProject | undefined>();

export function getRequestProject(): ProxyApiProject | undefined {
  return projects.getStore();
}

export function runWithRequestProject<T>(project: ProxyApiProject | undefined, work: () => T): T {
  return projects.run(project, work);
}

export function installProjectContextHook(server: FastifyInstance): void {
  server.addHook('onRequest', (request, _reply, done) => {
    const config = getServerConfig();
    const resolved = resolveApiProject(config, extractApiKeyToken(request.headers));
    const project = resolved ? config?.projects?.find((item) => item.id === resolved.id && item.enabled) : undefined;
    runWithRequestProject(project, done);
  });
}
