import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  api,
  setCsrf,
  mapping,
  display,
  localDateValue,
  requestAccountLabel,
  requestModelLabel,
  statisticsQueryDates,
  statisticsTraffic,
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
globalThis.window = { setTimeout, clearTimeout, dispatchEvent: () => {} };
test('API uses same origin HttpOnly session with CSRF only on mutations; no management Authorization', async () => {
  let seen;
  globalThis.fetch = async (path, options) => {
    seen = { path, ...options };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  setCsrf('csrf-test');
  await api('/admin/console/projects', 'POST', { name: 'test' });
  assert.equal(seen.path, '/admin/console/projects');
  assert.equal(seen.credentials, 'same-origin');
  assert.equal(seen.redirect, 'error');
  assert.equal(seen.cache, 'no-store');
  assert.equal(seen.headers['X-CSRF-Token'], 'csrf-test');
  assert.equal(seen.headers.Authorization, undefined);
  await api('/admin/console/accounts');
  assert.equal(seen.headers['X-CSRF-Token'], undefined);
});
test('API refuses external, relative traversal and non admin addresses before network', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error('unexpected');
  };
  for (const path of [
    'https://example.com/admin/session',
    '//example.com/admin/session',
    '/admin/../api',
    '/v1/models',
  ])
    await assert.rejects(api(path), /Недопустимый/);
  assert.equal(calls, 0);
});
test('session expiration is signaled and safe server errors preserved', async () => {
  let expired = false;
  window.dispatchEvent = (e) => {
    expired = e.type === 'agp-session-expired';
  };
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: 'Войдите заново' }),
  });
  await assert.rejects(api('/admin/console/accounts'), /Войдите заново/);
  assert.equal(expired, true);
});
test('network failures do not expose transport credential fragments', async () => {
  globalThis.fetch = async () => {
    throw Error('transport secret=do-not-display');
  };
  await assert.rejects(api('/admin/session'), (error) => !error.message.includes('do-not-display'));
});
test('mapping validates string map and unknown counters stay unknown', () => {
  assert.deepEqual(mapping('{"alias":"physical"}'), { alias: 'physical' });
  for (const value of ['null', '[]', '{"alias":3}']) assert.throws(() => mapping(value));
  assert.equal(display(null), 'Неизвестно');
  assert.equal(display(undefined), 'Неизвестно');
  assert.equal(display(0), '0');
});

test('date filters preserve local calendar day in Samara after ISO roundtrip', () => {
  const original = process.env.TZ;
  process.env.TZ = 'Europe/Samara';
  try {
    assert.equal(localDateValue(new Date('2026-11-09T00:00:00').toISOString()), '2026-11-09');
    assert.equal(localDateValue(new Date('2026-11-09T23:59:59.999').toISOString()), '2026-11-09');
    assert.equal(localDateValue(null), '');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('hourly and daily traffic preserve filtered totals and distinct UTC buckets', () => {
  const statistics = {
    total_requests: 7,
    success_requests: 5,
    failed_requests: 2,
    by_hour: [
      { hour: '2026-11-08T23:00:00.000Z', total_requests: 2, failed_requests: 0 },
      { hour: '2026-11-09T00:00:00.000Z', total_requests: 5, failed_requests: 2 },
    ],
    by_day: [
      { date: '2026-11-08', total_requests: 2, failed_requests: 0 },
      { date: '2026-11-09', total_requests: 5, failed_requests: 2 },
    ],
  };
  const hourly = statisticsTraffic(statistics, 'hour');
  const daily = statisticsTraffic(statistics, 'day');
  assert.deepEqual(hourly.buckets, [
    { time: '2026.11.08 23:00 UTC', success: 2, failed: 0 },
    { time: '2026.11.09 00:00 UTC', success: 3, failed: 2 },
  ]);
  assert.deepEqual(
    daily.buckets.map((bucket) => bucket.time),
    ['2026.11.08 UTC', '2026.11.09 UTC']
  );
  for (const traffic of [hourly, daily]) {
    assert.equal(traffic.total, 7);
    assert.equal(traffic.totalSuccess, 5);
    assert.equal(traffic.totalFailure, 2);
    assert.equal(traffic.peakTotal, 5);
    assert.equal(traffic.peakIndex, 1);
    assert.equal(traffic.activeBuckets, 2);
  }
  assert.equal(hourly.windowMinutes, 120);
  assert.equal(daily.windowMinutes, 2880);
});

test('traffic has an honest empty state before loading and without measurements', () => {
  for (const granularity of ['hour', 'day']) {
    const traffic = statisticsTraffic(undefined, granularity);
    assert.deepEqual(traffic.buckets, []);
    assert.equal(traffic.total, 0);
    assert.equal(traffic.successRate, null);
    assert.equal(traffic.peakIndex, -1);
    assert.equal(traffic.windowMinutes, 0);
  }
});

test('both granularities share local day filters, including partial UTC days', () => {
  const original = process.env.TZ;
  process.env.TZ = 'Europe/Samara';
  try {
    const params = statisticsQueryDates('2026-11-09', '2026-11-09');
    assert.equal(params.get('from'), '2026-11-08T20:00:00.000Z');
    assert.equal(params.get('to'), '2026-11-09T19:59:59.999Z');
    assert.equal(statisticsQueryDates('', '').toString(), '');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('request labels distinguish known service calls, inference and unknown history', () => {
  assert.equal(
    requestModelLabel({ request_kind: 'service', route: 'recordClientEvent' }),
    'Служебный запрос'
  );
  assert.equal(
    requestModelLabel({
      request_kind: 'inference',
      route: 'chat',
      requested_model: 'gemini',
      effective_model: null,
    }),
    'gemini → Не измерена'
  );
  assert.equal(
    requestModelLabel({ route: 'other', requested_model: null, effective_model: null }),
    'Историческая запись: операция не сохранена'
  );
});

test('account labels use verified authorization source and resolve pool identities', () => {
  assert.equal(requestAccountLabel({ authorization_source: 'client' }, []), 'Исходная авторизация');
  assert.equal(
    requestAccountLabel({ request_kind: 'service', protocol: 'connect' }, []),
    'Аккаунт неизвестен'
  );
  assert.equal(
    requestAccountLabel({ account_id: 'id' }, [
      { id: 'id', email: 'pool@example.com', name: 'Pool' },
    ]),
    'pool@example.com'
  );
  assert.equal(requestAccountLabel({ account_id: 'id' }, [{ id: 'id', name: 'Pool' }]), 'Pool');
  assert.equal(requestAccountLabel({ account_id: 'removed' }, []), 'removed');
});
