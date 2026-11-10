import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(
  fs.readFileSync(new URL('./trafficChartModel.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }
).outputText;
const { createTrafficGeometry, bucketAtX, seriesAtY, chartLayout } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const bucket = (minute, duration = 1, total = 4, failed = 1) => ({
  start: new Date(Date.UTC(2026, 10, 10, 0, minute)).toISOString(),
  end: new Date(Date.UTC(2026, 10, 10, 0, minute + duration)).toISOString(),
  total_requests: total,
  failed_requests: failed,
});

test('timestamp spacing preserves empty bins and unequal real durations', () => {
  const bins = [bucket(0), bucket(1, 1, 0, 0), bucket(2, 5)];
  const { points, path, y } = createTrafficGeometry(bins);
  assert.ok(
    Math.abs((points[2].right - points[2].left) / (points[0].right - points[0].left) - 5) < 1e-10
  );
  assert.equal(points[1].successY, chartLayout.bottom);
  assert.equal(y(0), chartLayout.bottom);
  assert.match(path('success'), /H/);
  assert.doesNotMatch(path('success'), /[CQST]/);
  assert.equal(points[0].successY, y(3));
});
test('interval lookup is start inclusive, end exclusive, including gaps', () => {
  const { points } = createTrafficGeometry([bucket(0), bucket(1), bucket(3)]);
  assert.equal(bucketAtX(points, points[0].left), 0);
  assert.equal(bucketAtX(points, points[0].right), 1);
  assert.equal(bucketAtX(points, (points[1].right + points[2].left) / 2), -1);
  assert.equal(bucketAtX(points, points[2].right), -1);
  assert.equal(bucketAtX(points, points[0].left - 1), -1);
});
test('click classification selects real error/success levels and ignores zero-count lines', () => {
  const geometry = createTrafficGeometry([bucket(0), bucket(1, 1, 0, 0)]);
  const [point, empty] = geometry.points;
  assert.equal(seriesAtY(point, point.failureY), 'failure');
  assert.equal(seriesAtY(point, point.successY), 'success');
  assert.equal(seriesAtY(point, -50), undefined);
  assert.equal(seriesAtY(empty, empty.failureY), undefined);
  const tied = createTrafficGeometry([bucket(0, 1, 2, 1)]).points[0];
  assert.equal(seriesAtY(tied, tied.failureY), 'failure');
});
test('gaps are separate path segments and empty input remains finite', () => {
  const geometry = createTrafficGeometry([bucket(0), bucket(3)]);
  assert.equal((geometry.path('failure').match(/M/g) ?? []).length, 2);
  const empty = createTrafficGeometry([]);
  assert.equal(empty.max, 1);
  assert.equal(empty.path('success'), '');
  assert.equal(bucketAtX(empty.points, 100), -1);
});
test('week of minute bins retains every point and exact last interval selection', () => {
  const bins = Array.from({ length: 10080 }, (_, index) =>
    bucket(index, 1, index === 9999 ? 1 : 0, index === 9999 ? 1 : 0)
  );
  const geometry = createTrafficGeometry(bins);
  assert.equal(geometry.points.length, 10080);
  assert.equal(bucketAtX(geometry.points, geometry.points[9999].x), 9999);
  assert.equal(geometry.points[9999].bucket.failed_requests, 1);
  assert.equal(bucketAtX(geometry.points, geometry.points.at(-1).x), 10079);
  assert.doesNotMatch(geometry.path('failure'), /NaN|Infinity/);
});
