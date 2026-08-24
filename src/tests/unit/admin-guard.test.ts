import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { setServerConfig } from '@/server/server-config';

function createContext(token: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { authorization: `Bearer ${token}` },
      }),
    }),
  } as ExecutionContext;
}

describe('AdminGuard', () => {
  it('accepts only the separate admin API key', () => {
    setServerConfig({
      ...DEFAULT_PROXY_CONFIG,
      api_key: 'proxy-key',
      admin_api_key: 'admin-key',
    });
    const guard = new AdminGuard();

    expect(() => guard.canActivate(createContext('proxy-key'))).toThrow(UnauthorizedException);
    expect(guard.canActivate(createContext('admin-key'))).toBe(true);
  });
});
