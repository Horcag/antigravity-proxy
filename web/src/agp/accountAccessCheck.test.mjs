import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const timeUrl = dataUrl(ts.transpileModule(fs.readFileSync(new URL('./time.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText);
const sharedUrl = dataUrl('export const Button = () => null; export const ErrorMessage = () => null;');
const code = ts.transpileModule(fs.readFileSync(new URL('./AccountAccessCheck.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
}).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  .replaceAll("'./shared'", JSON.stringify(sharedUrl)).replaceAll("'./time'", JSON.stringify(timeUrl));
const { AccessCheckStatus } = await import(dataUrl(code));
const result = {
  outcome: 'banned', comparison: 'same', checked_at: '2026-11-15T03:56:10Z',
  duration_ms: 216, reason: 'tos_violation', message: 'Блокировка подтверждена.',
  evidence: { stage: 'generation', http_status: 403 },
};
const render = (value) => renderToStaticMarkup(createElement(AccessCheckStatus, { result: value }));
test('shows Google response and measured duration outside collapsed diagnostics', () => {
  const visible = render(result).split('<details>')[0];
  assert.match(visible, /216 мс/);
  assert.match(visible, /Ответ Google \(генерация\): HTTP 403/);
  assert.match(visible, /07:56:10.*Самара/);
  assert.match(render({ ...result, duration_ms: 0 }), /0 мс/);
});
test('OAuth failure and legacy results do not imply a Google generation response or measured time', () => {
  const html = render({ ...result, duration_ms: undefined, outcome: 'inconclusive', evidence: { stage: 'oauth' } });
  assert.match(html, /Длительность: не измерена/);
  assert.match(html, /Проверка остановилась на OAuth: ответ генерации не получен/);
  assert.doesNotMatch(html, /HTTP 403/);
});
