import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(
  fs.readFileSync(new URL('./trafficNavigation.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
).outputText;
const { requestsHref, bucketRequestHref, historyParams, modelRequestFilters } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const query = (href) => new URL(href, 'https://console.test').searchParams;
test('drilling into errors keeps project, model and selected exact interval without chart-only params', () => {
  const source = new URLSearchParams({
    projectId: 'project & one',
    model: 'gemini+pro',
    granularity: 'minute',
    from: '2026-11-09T20:02:30Z',
    toExclusive: '2026-11-09T20:04:30Z',
  });
  const q = query(
    bucketRequestHref(
      source,
      { start: '2026-11-09T20:00:00Z', end: '2026-11-09T20:05:00Z' },
      'failure'
    )
  );
  assert.equal(q.get('from'), '2026-11-09T20:02:30.000Z');
  assert.equal(q.get('toExclusive'), '2026-11-09T20:04:30.000Z');
  assert.equal(q.get('result'), 'failure');
  assert.equal(q.get('projectId'), 'project & one');
  assert.equal(q.get('model'), 'gemini+pro');
  assert.equal(q.has('granularity'), false);
  assert.equal(q.has('to'), false);
});
test('measurement and account attempt drilldowns preserve filters, and missing-model group is exact', () => {
  const base = new URLSearchParams({ from: '2026-11-09T20:00:00Z', accountId: 'A', offset: '50' });
  const q = query(requestsHref(base, { attemptOutcome: 'failure', metric: 'ttft_ms' }));
  assert.equal(q.get('accountId'), 'A');
  assert.equal(q.get('attemptOutcome'), 'failure');
  assert.equal(q.get('metric'), 'ttft_ms');
  assert.equal(q.has('offset'), false);
  assert.equal(
    query(requestsHref(new URLSearchParams({ model: 'old' }), modelRequestFilters(null))).get(
      'missingModel'
    ),
    'true'
  );
  assert.equal(
    historyParams(new URLSearchParams('metric=input_tokens&unknown=foo')).toString(),
    'metric=input_tokens'
  );
});

test('outcome drill intersects status and previous outcome without broadening zero counts', () => {
  const base = new URLSearchParams({ status: 'failure', projectId: 'one' });
  const q = query(requestsHref(base, { result: 'success' }));
  assert.equal(q.get('status'), 'failure');
  assert.equal(q.get('result'), 'success');
  const bucket = query(
    bucketRequestHref(
      base,
      { start: '2026-11-09T20:00:00Z', end: '2026-11-09T20:01:00Z' },
      'success'
    )
  );
  assert.equal(bucket.get('status'), 'failure');
  assert.equal(bucket.get('result'), 'success');
  assert.equal(
    query(requestsHref(new URLSearchParams('status=200'), { result: 'failure' })).get('status'),
    '200'
  );
  assert.equal(
    query(requestsHref(new URLSearchParams('result=success'), { result: 'failure' })).get('result'),
    'none'
  );
});
