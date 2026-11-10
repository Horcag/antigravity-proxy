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
  requestAccountLabel,
  requestModelLabel,
  missingMeasurement,
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
    'Операция не сохранена'
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

test('missing metrics distinguish non-applicable service calls, failed requests, old metadata and absent counters', () => {
  for (const request_kind of ['service', 'probe']) {
    const message = missingMeasurement({ request_kind, route: '/' }, 'input_tokens');
    assert.equal(message.label, '—');
    assert.match(message.reason, /Не применяется/);
  }
  assert.equal(
    missingMeasurement({ route: 'other', status: 200 }, 'input_tokens').label,
    'Не сохранено'
  );
  assert.equal(
    missingMeasurement({ route: 'other', status: 404 }, 'input_tokens').label,
    'Нет данных'
  );
  assert.equal(
    missingMeasurement({ route: '/v1/chat/completions', status: 200 }, 'input_tokens').label,
    'Не передано'
  );
  assert.equal(requestModelLabel({ request_kind: 'probe', route: '/' }), 'Корневой адрес сервиса');
  assert.equal(
    requestModelLabel({ request_kind: 'unknown', route: '/v1internal:NewRpc' }),
    'Модель не записана'
  );
});
