import { describe, expect, it } from 'vitest';

import { normalizeObjectJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';

describe('normalizeObjectJsonSchema enum compatibility', () => {
  it('preserves nested primitive enum constraints as Gemini-compatible strings without mutating input', () => {
    const schema = {
      type: 'object',
      definitions: {
        RetryCount: { type: 'integer', enum: [1, 2, 2.5, 'three', null, { invalid: true }] },
      },
      properties: {
        retry_count: { $ref: '#/definitions/RetryCount' },
        ratio: { type: 'number', enum: [0, 0.5, 'invalid', false] },
        enabled: { type: 'boolean', enum: [true, false, 'true', 1] },
        mode: { type: 'string', enum: ['fast', 'safe', 1, true] },
        nullable_level: { type: ['integer', 'null'], enum: [3, 4.5, 'three', null] },
        nested: {
          type: 'array',
          items: { type: 'boolean', enum: [true, false, 0, 'false'] },
        },
      },
    };
    const original = structuredClone(schema);

    const normalized = normalizeObjectJsonSchema(schema);

    expect(normalized).toMatchObject({
      type: 'object',
      properties: {
        retry_count: { type: 'integer', enum: ['1', '2'] },
        ratio: { type: 'number', enum: ['0', '0.5'] },
        enabled: { type: 'boolean', enum: ['true', 'false'] },
        mode: { type: 'string', enum: ['fast', 'safe'] },
        nullable_level: { type: 'integer', enum: ['3'] },
        nested: { type: 'array', items: { type: 'boolean', enum: ['true', 'false'] } },
      },
    });
    expect(schema).toEqual(original);
  });

  it('drops malformed enum members deterministically and leaves no description-only enum hint', () => {
    const normalized = normalizeObjectJsonSchema({
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'Retry count', enum: [NaN, Infinity, 1.5, null] },
      },
    });

    expect(normalized.properties).toEqual({
      count: { type: 'integer', description: 'Retry count' },
    });
  });

  it.each([
    ['null first', ['NULL', 'INTEGER']],
    ['null last', ['INTEGER', 'nUlL']],
  ])('normalizes mixed-case nullable types with %s', (_case, type) => {
    const normalized = normalizeObjectJsonSchema({
      type: 'object',
      properties: {
        count: { type, enum: [1, 2.5, 'three', null] },
      },
    });

    expect(normalized.properties).toEqual({
      count: { type: 'integer', enum: ['1'] },
    });
  });
});
