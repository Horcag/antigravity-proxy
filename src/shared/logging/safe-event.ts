type SafeEventValue = string | number | boolean | null;

/** Copies only own enumerable data properties; getters and prototype data never enter logs. */
export function formatSafeEvent(
  event: string,
  fields: Record<string, SafeEventValue>,
  allowedKeys: readonly string[],
): string {
  const snapshot: Record<string, SafeEventValue> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(fields);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.includes(key)) throw new TypeError(`Unexpected event field: ${key}`);
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Unsafe event field: ${key}`);
    }
    const value = descriptor.value;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new TypeError(`Unsafe event value: ${key}`);
    }
    snapshot[key] = value;
  }
  return JSON.stringify({ event, ...snapshot });
}
