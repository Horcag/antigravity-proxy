import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const code = ts.transpileModule(fs.readFileSync(new URL('./quotaSummary.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { summarizeAccountQuota, listDisplayQuotaModels } = await import(dataUrl(code));

test('summarizeAccountQuota formats 5h and weekly group quotas for Pro account with Argon and Hydrogen', () => {
  const quota = {
    subscription_tier: 'g1-pro-tier',
    models: {
      'gemini-4-argon-high': { percentage: 70, resetTime: '2026-11-23T16:40:10Z', display_name: 'Gemini 4 Argon (High)' },
      'gemini-4-argon-medium': { percentage: 70, resetTime: '2026-11-23T16:40:10Z', display_name: 'Gemini 4 Argon (Medium)' },
      'gemini-4-hydrogen-medium': { percentage: 94, resetTime: '2026-11-18T08:40:53Z', display_name: 'Gemini 4 Hydrogen (Medium)' },
      'gemini-4-hydrogen-sonar': { percentage: 94, resetTime: '2026-11-18T08:40:53Z' },
      'gemini-2.5-flash': { percentage: 100, resetTime: '2026-11-18T12:00:00Z' },
      'claude-opus-5-5-high': { percentage: 100, resetTime: '2026-11-18T12:00:00Z', display_name: 'Claude Opus 5.5 (High)' },
    },
    quota_groups: [
      {
        display_name: 'Gemini Models',
        description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash',
        buckets: [
          { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.985, reset_time: '2026-11-20T05:13:20Z' },
          { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.946, reset_time: '2026-11-18T08:40:53Z' },
        ],
      },
      {
        display_name: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
        buckets: [
          { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-25T04:15:36Z' },
          { bucket_id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-18T09:15:36Z' },
        ],
      },
      {
        display_name: 'Gemini 4 Argon',
        description: 'For paid Pro plans, Argon quota is separate.',
        buckets: [
          { bucket_id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0.703, reset_time: '2026-11-23T16:40:10Z' },
        ],
      },
    ],
  };

  const summary = summarizeAccountQuota(quota);
  assert.equal(summary.tierLabel, 'g1-pro-tier · Argon + Hydrogen');
  assert.equal(summary.hasArgon, true);
  assert.equal(summary.hasHydrogen, true);
  assert.deepEqual(
    summary.groups.map((g) => g.compactText),
    [
      'Gemini (Hydrogen / 3.8): 5ч 94% · Нед 98%',
      'Gemini 4 Argon: Нед 70%',
      'Claude / GPT: 5ч 100% · Нед 100%',
    ],
  );

  const modelIds = listDisplayQuotaModels(quota).map((m) => m.modelId);
  assert.deepEqual(modelIds, [
    'gemini-4-argon-high',
    'gemini-4-argon-medium',
    'gemini-4-hydrogen-medium',
    'claude-opus-5-5-high',
  ]);
});

test('summarizeAccountQuota omits Argon row on standard accounts without Argon access', () => {
  const quota = {
    subscription_tier: 'Standard',
    models: {
      'gemini-3.8-flash-high': { percentage: 100, resetTime: '2026-11-18T09:16:07Z', display_name: 'Gemini 3.8 Flash (High)' },
      'gemini-4-hydrogen-sonar': { percentage: 100, resetTime: '2026-11-18T09:16:07Z' },
      'gemini-2.5-flash-thinking': { percentage: 100, resetTime: '2026-11-18T09:16:07Z' },
    },
    quota_groups: [
      {
        display_name: 'Gemini Models',
        buckets: [
          { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.65, reset_time: '2026-11-21T07:53:27Z' },
          { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-18T09:16:07Z' },
        ],
      },
    ],
  };

  const summary = summarizeAccountQuota(quota);
  assert.equal(summary.tierLabel, 'Standard');
  assert.equal(summary.hasArgon, false);
  assert.equal(summary.hasHydrogen, false);
  assert.deepEqual(summary.groups.map((g) => g.compactText), ['Gemini (3.8 Flash): 5ч 100% · Нед 65%']);
});

test('summarizeAccountQuota highlights Neon alongside Argon and Hydrogen when present', () => {
  const quota = {
    subscription_tier: 'Google AI Pro',
    models: {
      'gemini-4-neon-high': { percentage: 100, resetTime: '2026-11-19T07:01:01Z', display_name: 'Gemini 4 Neon (High)' },
      'gemini-4-argon-medium': { percentage: 80, resetTime: '2026-11-26T02:01:01Z', display_name: 'Gemini 4 Argon (Medium)' },
      'gemini-4-hydrogen-medium': { percentage: 95, resetTime: '2026-11-19T07:01:01Z', display_name: 'Gemini 4 Hydrogen (Medium)' },
    },
    quota_groups: [
      {
        display_name: 'Gemini Models',
        buckets: [
          { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.99, reset_time: '2026-11-26T02:01:01Z' },
          { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.95, reset_time: '2026-11-19T07:01:01Z' },
        ],
      },
      {
        display_name: 'Gemini 4 Argon',
        buckets: [
          { bucket_id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0.80, reset_time: '2026-11-26T02:01:01Z' },
        ],
      },
    ],
  };

  const summary = summarizeAccountQuota(quota);
  assert.equal(summary.hasNeon, true);
  assert.equal(summary.tierLabel, 'Google AI Pro · Neon + Argon + Hydrogen');
  assert.equal(summary.groups[0].compactText, 'Gemini (Neon / Hydrogen / 3.8): 5ч 95% · Нед 99%');
  assert.equal(listDisplayQuotaModels(quota)[0].modelId, 'gemini-4-neon-high');
});
