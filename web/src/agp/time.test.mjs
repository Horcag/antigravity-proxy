import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync(new URL('./time.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  localDateValue,
  localDateTimeValue,
  samaraDateTimeToIso,
  samaraDayBoundary,
  formatSamaraDateTime,
  formatConsoleValue,
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('Samara dates and filters remain fixed across browser/host time zones and midnight', () => {
  const before = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      assert.equal(localDateValue('2026-11-09T20:00:00Z'), '2026-11-10');
      assert.equal(localDateTimeValue('2026-11-09T20:05:01Z'), '2026-11-10T00:05:01');
      assert.equal(samaraDateTimeToIso('2026-11-10T00:05:01'), '2026-11-09T20:05:01.000Z');
      assert.equal(samaraDayBoundary('2026-11-10'), '2026-11-09T20:00:00.000Z');
      assert.equal(samaraDayBoundary('2026-11-10', true), '2026-11-10T19:59:59.999Z');
      assert.match(formatSamaraDateTime('2026-11-09T20:05:01Z'), /10\.11\.2026.*00:05:01.*Самара/);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
test('unknown dates remain unknown and metadata dates are rendered in Samara', () => {
  assert.equal(localDateValue(null), '');
  assert.equal(formatSamaraDateTime(null), 'Неизвестно');
  assert.match(
    formatConsoleValue('quota', { resetTime: '2026-11-09T20:05:01Z', percentage: 50 }),
    /00:05:01.*Самара/
  );
  assert.equal(formatConsoleValue('duration_ms', 500), '500');
  assert.equal(formatSamaraDateTime(1794254701), formatSamaraDateTime(1794254701000));
});
