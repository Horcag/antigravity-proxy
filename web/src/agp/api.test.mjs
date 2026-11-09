import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { api, setCsrf, mapping, display, localDateValue } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
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
