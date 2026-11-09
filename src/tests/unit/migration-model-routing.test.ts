import { afterEach, describe, expect, it } from 'vitest';
import { getAllDynamicModels, getOpenAICompatibleModels } from '@/modules/proxy-gateway/antigravity/ModelMapping';
import { ProxyModelRoutingPolicy } from '@/modules/proxy-gateway/server/proxy-model-routing-policy';
import { setServerConfig } from '@/server/server-config';
import { runWithRequestProject } from '@/modules/proxy-gateway/server/request-project-context';
import { ProxyConfigSchema } from '@/modules/config/types';

afterEach(() => setServerConfig(null));

describe('Migrated model aliases', () => {
  it('advertises explicit aliases only for live targets and keeps image/service aliases out of chat', () => {
    const mapping = {
      'client-pro': 'gemini-3.1-pro-preview',
      'client-image': 'gemini-3-pro-image',
      'client-service': 'chat_20706',
      'client-missing': 'claude-sonnet-4-6-thinking',
      'client-chain': 'client-pro',
      'gemini-*': 'gemini-3.1-pro-high',
    };
    const live = ['gemini-3.1-pro-high', 'gemini-3-pro-image', 'chat_20706'];
    expect(getAllDynamicModels(mapping, live)).toEqual(['client-image', 'client-pro', 'gemini-3-pro-image', 'gemini-3.1-pro-high']);
    expect(getOpenAICompatibleModels(mapping, live, { 'anthropic-alias': 'gemini-3.1-pro-high' })).toEqual(['anthropic-alias', 'client-pro', 'gemini-3.1-pro-high']);
    expect(getOpenAICompatibleModels(mapping, [])).toEqual([]);
  });

  it('prefers an explicit alias over a matching wildcard regardless of insertion order', () => {
    setServerConfig(ProxyConfigSchema.parse({ custom_mapping: {
      'gemini-*': 'gemini-3-flash',
      'gemini-3.1-pro-preview': 'gemini-3.1-pro-low',
    } }));
    const policy = new ProxyModelRoutingPolicy();
    expect(policy.resolveTargetModel('models/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-low');
    expect(policy.resolveTargetModel('gemini-other')).toBe('gemini-3-flash');
  });

  it('isolates concurrent project aliases and restores the global mapping outside requests', async () => {
    setServerConfig(ProxyConfigSchema.parse({ custom_mapping: { shared: 'global-model' } }));
    const policy = new ProxyModelRoutingPolicy();
    const result = await Promise.all(['first', 'second'].map((id) =>
      runWithRequestProject({ id, name: id, api_key: `test-${id}`, enabled: true, model_mapping: { shared: `${id}-model` } }, async () => {
        await Promise.resolve();
        return policy.resolveTargetModel('shared');
      }),
    ));
    expect(result).toEqual(['first-model', 'second-model']);
    expect(policy.resolveTargetModel('shared')).toBe('global-model');
  });

  it('keeps configured provider IDs and unsupported distinct model names intact', () => {
    setServerConfig(ProxyConfigSchema.parse({ custom_mapping: { 'old-client-model': 'gemini-3.5-flash-high' } }));
    const policy = new ProxyModelRoutingPolicy();
    expect(policy.resolveTargetModel('old-client-model')).toBe('gemini-3.5-flash-high');
    expect(policy.resolveTargetModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(policy.resolveTargetModel('claude-sonnet-4-6-thinking')).toBe('claude-sonnet-4-6-thinking');
  });
});
