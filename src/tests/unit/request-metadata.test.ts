import { afterEach, expect, it } from 'vitest';
import { normalizedRoute, requestMetadata } from '@/observability/metadata';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
const config = getServerConfig();
afterEach(() => setServerConfig(config));
it('retains bounded RPC operation metadata and never query values, resource paths or credentials', () => {
  expect(normalizedRoute('/v1internal:NewClientRpc?token=secret')).toBe('/v1internal:NewClientRpc');
  expect(normalizedRoute('/google.internal.cloud.code.SomeService/FetchStatus?token=secret')).toBe('/google.internal.cloud.code.SomeService/FetchStatus');
  expect(normalizedRoute('/projects/private-id/secret-document')).toBe('other');
  expect(normalizedRoute('/v1internal:' + 'a'.repeat(101))).toBe('other');
  expect(normalizedRoute('/v1internal:../private')).toBe('other');
  setServerConfig({ ...DEFAULT_PROXY_CONFIG, admin_api_key: 'PrivateAdminValue' });
  expect(normalizedRoute('/v1internal:PrivateAdminValue')).toBe('other');
});
it('distinguishes root transport probes, service calls, unclassified RPCs and inference without inventing models', () => {
  expect(normalizedRoute('/?probe=secret')).toBe('/');
  expect(requestMetadata('/', 'connect', 'A')).toMatchObject({ request_kind: 'probe', authorization_source: 'pool' });
  expect(requestMetadata('/v1internal:fetchUserInfo', 'connect', null)).toMatchObject({ request_kind: 'service', authorization_source: 'client' });
  expect(requestMetadata('/v1internal:NewClientRpc', 'connect', 'A').request_kind).toBe('unknown');
  expect(requestMetadata('/google.internal.cloud.code.SomeService/FetchStatus', 'connect', 'A').request_kind).toBe('unknown');
  expect(requestMetadata('/v1internal:streamGenerateContent', 'connect', 'A').request_kind).toBe('inference');
});
