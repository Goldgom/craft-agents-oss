/** Repairs incomplete MCP schemas without guessing tool argument types. */
export function normalizeMcpToolInputSchema(input: unknown): {
  schema: Record<string, unknown>;
  repairs: string[];
} {
  const repairs: string[] = [];
  if (input === undefined || input === null) {
    return { schema: { type: 'object', properties: {} }, repairs: ['inputSchema'] };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('inputSchema must be an object schema');
  }

  const schema = structuredClone(input) as Record<string, unknown>;
  // MCP tool arguments are always objects, even when the server omits type.
  if (schema.type === undefined) {
    schema.type = 'object';
    repairs.push('inputSchema.type');
  }
  if (schema.type !== 'object') throw new Error('inputSchema.type must be object');
  normalizeSchemaNode(schema, 'inputSchema', repairs, 0);
  // Pi's validator does not register arbitrary external meta-schema URIs.
  delete schema.$schema;
  return { schema, repairs };
}

function normalizeSchemaNode(value: unknown, path: string, repairs: string[], depth: number): void {
  if (typeof value === 'boolean') return; // Legal JSON Schema true/false constraints.
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a schema object or boolean`);
  }
  if (depth > 64) throw new Error(`${path}: schema nesting exceeds 64 levels`);
  const schema = value as Record<string, unknown>;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const invalidTypeList = Array.isArray(schema.type) && (types.length === 0 || new Set(types).size !== types.length);
  if (invalidTypeList || types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type as string))) {
    throw new Error(`${path}.type contains an invalid JSON Schema type`);
  }
  // Nested schemas may deliberately omit type (for example conditional
  // constraints). Inferring one would narrow the arguments they accept.
  const isArray = schema.type === 'array' || Array.isArray(schema.type) && schema.type.includes('array');
  if (isArray && schema.items === undefined) {
    // {} accepts every JSON value. Inventing a string/object type would reject
    // valid arguments (actions, mixed filters, nested arrays, and so on).
    schema.items = {};
    repairs.push(`${path}.items`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) {
    throw new Error(`${path}.required must be an array of property names`);
  }

  // Traverse schema keywords only: examples/defaults/const are literal data.
  for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    const entries = schema[keyword];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error(`${path}.${keyword} must be an object`);
    }
    for (const [name, child] of Object.entries(entries)) {
      normalizeSchemaNode(child, `${path}.${keyword}.${name}`, repairs, depth + 1);
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const children = schema[keyword];
    if (children === undefined) continue;
    if (!Array.isArray(children) || children.length === 0) throw new Error(`${path}.${keyword} must be a non-empty array`);
    for (const [index, child] of children.entries()) {
      normalizeSchemaNode(child, `${path}.${keyword}[${index}]`, repairs, depth + 1);
    }
  }
  for (const keyword of ['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
    const child = schema[keyword];
    if (child === undefined) continue;
    // Draft-07 and earlier allow tuple schemas in items.
    if (keyword === 'items' && Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        normalizeSchemaNode(item, `${path}.items[${index}]`, repairs, depth + 1);
      }
    } else {
      normalizeSchemaNode(child, `${path}.${keyword}`, repairs, depth + 1);
    }
  }
}
