import { describe, expect, test } from 'bun:test';
import { normalizeMcpToolInputSchema } from '../tool-schema.ts';

describe('MCP tool input schema repair', () => {
  test('repairs automation arrays without guessing action or condition types', () => {
    const input = {
      type: 'object',
      properties: { actions: { type: 'array' }, conditions: { type: 'array', minItems: 1 } },
      required: ['actions'],
      additionalProperties: false,
    };
    const { schema, repairs } = normalizeMcpToolInputSchema(input);
    expect(schema).toEqual({ ...input, properties: {
      actions: { type: 'array', items: {} },
      conditions: { type: 'array', minItems: 1, items: {} },
    } });
    expect(repairs).toEqual(['inputSchema.properties.actions.items', 'inputSchema.properties.conditions.items']);
    expect(input.properties.actions).toEqual({ type: 'array' });
    expect(normalizeMcpToolInputSchema(schema)).toEqual({ schema, repairs: [] });
  });

  test('repairs arrays in definitions, alternatives, tuples and nested items', () => {
    const result = normalizeMcpToolInputSchema({
      type: 'object',
      $defs: { list: { type: ['array', 'null'] } },
      properties: {
        choice: { anyOf: [{ type: 'array' }, { $ref: '#/$defs/list' }] },
        nested: { type: 'array', items: { type: 'array' } },
        tuple: { type: 'array', items: [{ type: 'array' }] },
        modern: { type: 'array', prefixItems: [{ type: 'array' }], items: false },
      },
    });
    expect(result.repairs).toHaveLength(5);
    expect(result.schema).toMatchObject({
      $defs: { list: { type: ['array', 'null'], items: {} } },
      properties: {
        choice: { anyOf: [{ type: 'array', items: {} }, { $ref: '#/$defs/list' }] },
        nested: { items: { type: 'array', items: {} } },
        tuple: { items: [{ type: 'array', items: {} }] },
        modern: { prefixItems: [{ type: 'array', items: {} }], items: false },
      },
    });
  });

  test('preserves valid items, references, untyped constraints and literal data', () => {
    const input = { type: 'object', properties: {
      empty: { type: 'array', items: {} },
      typed: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      closed: { type: 'array', items: false },
      open: { type: 'array', items: true },
      untyped: { properties: { name: { type: 'string' } } },
      ref: { $ref: '#/$defs/value' },
      literal: { default: { type: 'array' }, examples: [{ type: 'array' }], const: { type: 'array' } },
    }, $defs: { value: { type: 'number', minimum: 0 } } };
    expect(normalizeMcpToolInputSchema(input)).toEqual({ schema: input, repairs: [] });
  });

  test('supplies missing root schema and root type, removes unsupported meta schema', () => {
    expect(normalizeMcpToolInputSchema(undefined).schema).toEqual({ type: 'object', properties: {} });
    expect(normalizeMcpToolInputSchema({ $schema: 'https://example.test/schema', properties: {} })).toEqual({
      schema: { type: 'object', properties: {} }, repairs: ['inputSchema.type'],
    });
  });

  test.each([
    [[], 'inputSchema must be an object schema'],
    [{ type: 'array' }, 'inputSchema.type must be object'],
    [{ properties: { actions: { type: 'array', items: null } } }, 'inputSchema.properties.actions.items'],
    [{ properties: { actions: { type: [] } } }, 'inputSchema.properties.actions.type'],
    [{ properties: { actions: { type: 'invalid' } } }, 'inputSchema.properties.actions.type'],
    [{ properties: [] }, 'inputSchema.properties'],
    [{ required: 'actions' }, 'inputSchema.required'],
    [{ anyOf: [] }, 'inputSchema.anyOf'],
  ])('rejects malformed schema %j with its path', (input, message) => {
    expect(() => normalizeMcpToolInputSchema(input)).toThrow(message as string);
  });

  test('rejects recursive schemas instead of overflowing the stack', () => {
    const input: Record<string, unknown> = { type: 'object' };
    input.properties = { self: input };
    expect(() => normalizeMcpToolInputSchema(input)).toThrow('schema nesting exceeds 64 levels');
  });
});
