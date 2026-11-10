export type ChartBucket = {
  start: string;
  end: string;
  total_requests: number;
  failed_requests: number;
};

export const chartLayout = { width: 960, height: 280, left: 52, right: 18, top: 20, bottom: 224 };

export function createTrafficGeometry(buckets: ChartBucket[]) {
  const { width, left, right, top, bottom } = chartLayout;
  const from = buckets.length ? Date.parse(buckets[0].start) : 0;
  const to = buckets.length ? Date.parse(buckets[buckets.length - 1].end) : from + 1;
  const max = buckets.reduce(
    (maximum, bucket) =>
      Math.max(maximum, bucket.total_requests - bucket.failed_requests, bucket.failed_requests),
    1
  );
  const x = (time: number) =>
    left + ((time - from) / Math.max(1, to - from)) * (width - left - right);
  const y = (count: number) => bottom - (count / max) * (bottom - top);
  const points = buckets.map((bucket) => ({
    bucket,
    left: x(Date.parse(bucket.start)),
    right: x(Date.parse(bucket.end)),
    x: x((Date.parse(bucket.start) + Date.parse(bucket.end)) / 2),
    successY: y(bucket.total_requests - bucket.failed_requests),
    failureY: y(bucket.failed_requests),
  }));
  function path(status: 'success' | 'failure', area = false) {
    return points
      .map((point, index) => {
        const level = status === 'success' ? point.successY : point.failureY;
        const previous = points[index - 1];
        const connected = previous && previous.bucket.end === point.bucket.start;
        if (area) return `M${point.left},${bottom}V${level}H${point.right}V${bottom}Z`;
        return `${connected ? 'L' : 'M'}${point.left},${level}H${point.right}`;
      })
      .join('');
  }
  return { points, max, y, path, from, to };
}

export function bucketAtX(points: ReturnType<typeof createTrafficGeometry>['points'], x: number) {
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const point = points[middle];
    if (x < point.left) high = middle - 1;
    else if (x >= point.right) low = middle + 1;
    else return middle;
  }
  return -1;
}

export function seriesAtY(
  point: ReturnType<typeof createTrafficGeometry>['points'][number],
  y: number,
  tolerance = 10
): 'success' | 'failure' | undefined {
  const failureDistance = Math.abs(point.failureY - y);
  const successDistance = Math.abs(point.successY - y);
  if (
    point.bucket.failed_requests > 0 &&
    failureDistance <= tolerance &&
    failureDistance <= successDistance
  )
    return 'failure';
  if (point.bucket.total_requests > point.bucket.failed_requests && successDistance <= tolerance)
    return 'success';
  return undefined;
}
