import { describe, expect, it, vi } from 'vitest';
import { CaManager } from '../../modules/proxy-gateway/server/cert/ca-manager';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { ConnectIngressService } from '../../modules/proxy-gateway/server/connect-ingress.service';
import http from 'node:http';

describe('CaManager', () => {
  it('identifies target CloudCode hosts correctly', () => {
    expect(CaManager.isTargetHost('daily-cloudcode-pa.googleapis.com:443')).toBe(true);
    expect(CaManager.isTargetHost('cloudcode-pa.googleapis.com:443')).toBe(true);
    expect(CaManager.isTargetHost('daily-cloudcode-pa.sandbox.googleapis.com:443')).toBe(true);
    expect(CaManager.isTargetHost('generativelanguage.googleapis.com:443')).toBe(true);
    expect(CaManager.isTargetHost('api.openai.com:443')).toBe(false);
    expect(CaManager.isTargetHost('github.com:443')).toBe(false);
  });

  it('generates and provides a valid secureContext', () => {
    const ctx = CaManager.ensureCertificates();
    expect(ctx).toBeDefined();
    expect(CaManager.getCaCertPath()).toContain('ca.crt');
  });
});

describe('CloudCodeFailoverGateway', () => {
  it('detects quota error strings accurately', () => {
    const gateway = new CloudCodeFailoverGateway();
    const isQuotaError = (gateway as any).isQuotaErrorText.bind(gateway);

    expect(isQuotaError('RESOURCE_EXHAUSTED')).toBe(true);
    expect(isQuotaError('Quota exceeded for quota metric')).toBe(true);
    expect(isQuotaError('Rate limit exceeded')).toBe(true);
    expect(isQuotaError('Insufficient AI credit')).toBe(true);
    expect(isQuotaError('normal valid response')).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe('ConnectIngressService', () => {
  it('attaches to http.Server and closes cleanly', () => {
    const server = http.createServer();
    const ingress = new ConnectIngressService();

    expect(() => ingress.attach(server)).not.toThrow();
    expect(() => ingress.close()).not.toThrow();
  });
});
