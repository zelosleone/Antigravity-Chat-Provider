const UNSUPPORTED_CONSTRAINTS = [
  'minLength',
  'maxLength',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  'minItems',
  'maxItems',
  'format',
  'default',
  'examples',
] as const;

const UNSUPPORTED_KEYWORDS = new Set<string>([
  ...UNSUPPORTED_CONSTRAINTS,
  '$schema',
  '$defs',
  'definitions',
  'const',
  '$ref',
  'additionalProperties',
  'propertyNames',
  'title',
  '$id',
  '$comment',
]);

type SchemaObject = Record<string, unknown>;

function asSchemaObject(value: unknown): SchemaObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as SchemaObject;
}

function mapSchema(
  value: unknown,
  transform: (obj: SchemaObject) => SchemaObject,
): unknown {
  if (Array.isArray(value)) {
    return value.map(item => mapSchema(item, transform));
  }

  const record = asSchemaObject(value);
  if (!record) {
    return value;
  }

  const mapped: SchemaObject = {};
  for (const [key, child] of Object.entries(record)) {
    mapped[key] = mapSchema(child, transform);
  }
  return transform(mapped);
}

function appendHint(schema: SchemaObject, hint: string): SchemaObject {
  const description =
    typeof schema.description === 'string' ? schema.description : '';
  return {
    ...schema,
    description: description ? `${description} (${hint})` : hint,
  };
}

function normalizeRefsAndConst(schema: SchemaObject): SchemaObject {
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    const name = ref.includes('/') ? ref.split('/').pop() : ref;
    return appendHint({type: 'object'}, `See: ${name}`);
  }

  if (schema.const !== undefined && !Array.isArray(schema.enum)) {
    const out = {...schema};
    const constValue = out.const;
    delete out.const;
    return {...out, enum: [constValue]};
  }

  return schema;
}

function mergeAllOfMember(
  out: SchemaObject,
  mergedProps: SchemaObject,
  required: Set<string>,
  member: unknown,
): void {
  const record = asSchemaObject(member);
  if (!record) {
    return;
  }

  const properties = asSchemaObject(record.properties);
  if (properties) {
    Object.assign(mergedProps, properties);
  }

  if (Array.isArray(record.required)) {
    for (const entry of record.required) {
      if (typeof entry === 'string') {
        required.add(entry);
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === 'properties' || key === 'required' || out[key] !== undefined) {
      continue;
    }
    out[key] = value;
  }
}

function mergeAllOf(schema: SchemaObject): SchemaObject {
  if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) {
    return schema;
  }

  const out: SchemaObject = {...schema};
  delete out.allOf;

  const mergedProps: SchemaObject = {
    ...(asSchemaObject(out.properties) ?? {}),
  };
  const required = new Set<string>(
    Array.isArray(out.required)
      ? out.required.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  );

  for (const member of schema.allOf) {
    mergeAllOfMember(out, mergedProps, required, member);
  }

  if (Object.keys(mergedProps).length > 0) {
    out.properties = mergedProps;
  }

  if (required.size > 0) {
    out.required = Array.from(required);
  } else {
    delete out.required;
  }

  return out;
}

function scoreUnionOption(option: unknown): {
  score: number;
  typeName: string;
} {
  const record = asSchemaObject(option);
  if (!record) {
    return {score: 0, typeName: 'unknown'};
  }

  const type = record.type;

  if (type === 'object' || record.properties) {
    return {score: 3, typeName: 'object'};
  }
  if (type === 'array' || record.items) {
    return {score: 2, typeName: 'array'};
  }
  if (typeof type === 'string' && type !== 'null') {
    return {score: 1, typeName: type};
  }

  return {score: 0, typeName: typeof type === 'string' ? type : 'null'};
}

function isComplexUnionOption(option: SchemaObject): boolean {
  return Boolean(
    option.properties ||
    option.items ||
    option.anyOf ||
    option.oneOf ||
    option.allOf,
  );
}

function mergeUnionEnum(options: unknown[]): string[] | null {
  const values: string[] = [];

  for (const option of options) {
    const record = asSchemaObject(option);
    if (!record || isComplexUnionOption(record)) {
      return null;
    }

    if (record.const !== undefined) {
      values.push(String(record.const));
      continue;
    }

    if (Array.isArray(record.enum) && record.enum.length > 0) {
      values.push(...record.enum.map(value => String(value)));
      continue;
    }

    if (typeof record.type === 'string') {
      return null;
    }
  }

  return values.length > 0 ? values : null;
}

function selectBestUnionOption(options: unknown[]): {
  selected: SchemaObject;
  typeNames: string[];
} {
  let bestIndex = 0;
  let bestScore = -1;
  const typeNames: string[] = [];

  for (let i = 0; i < options.length; i += 1) {
    const {score, typeName} = scoreUnionOption(options[i]);
    typeNames.push(typeName);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const record = asSchemaObject(options[bestIndex]);
  return {
    selected: record ? {...record} : {type: 'string'},
    typeNames,
  };
}

function mergeDescriptions(
  parentDescription: string,
  selected: SchemaObject,
): SchemaObject {
  if (!parentDescription) {
    return selected;
  }

  const childDescription =
    typeof selected.description === 'string' ? selected.description : '';
  return {
    ...selected,
    description:
      childDescription && childDescription !== parentDescription
        ? `${parentDescription} (${childDescription})`
        : parentDescription,
  };
}

function flattenUnions(schema: SchemaObject): SchemaObject {
  let out: SchemaObject = {...schema};

  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const union = out[unionKey];
    if (!Array.isArray(union) || union.length === 0) {
      continue;
    }

    const parentDescription =
      typeof out.description === 'string' ? out.description : '';
    const mergedEnum = mergeUnionEnum(union);
    if (mergedEnum) {
      delete out[unionKey];
      out.type = 'string';
      out.enum = mergedEnum;
      if (parentDescription) {
        out.description = parentDescription;
      }
      continue;
    }

    const {selected, typeNames} = selectBestUnionOption(union);
    let normalized = mergeDescriptions(parentDescription, selected);

    const uniqueTypes = Array.from(new Set(typeNames.filter(Boolean)));
    if (uniqueTypes.length > 1) {
      normalized = appendHint(
        normalized,
        `Accepts: ${uniqueTypes.join(' | ')}`,
      );
    }

    const rest = {...out};
    delete rest[unionKey];
    out = {...rest, ...normalized};
  }

  return out;
}

function flattenTypeArrays(schema: SchemaObject): SchemaObject {
  if (!Array.isArray(schema.type)) {
    return schema;
  }

  const types = schema.type.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  const hasNull = types.includes('null');
  const nonNull = types.filter(entry => entry !== 'null');

  let out: SchemaObject = {
    ...schema,
    type: nonNull[0] ?? 'string',
  };

  if (nonNull.length > 1) {
    out = appendHint(out, `Accepts: ${nonNull.join(' | ')}`);
  }
  if (hasNull) {
    out = appendHint(out, 'nullable');
  }

  return out;
}

function addHints(schema: SchemaObject): SchemaObject {
  let out: SchemaObject = {...schema};

  if (Array.isArray(out.enum) && out.enum.length > 1 && out.enum.length <= 10) {
    out = appendHint(
      out,
      `Allowed: ${out.enum.map(value => String(value)).join(', ')}`,
    );
  }

  if (out.additionalProperties === false) {
    out = appendHint(out, 'No extra properties allowed');
  }

  for (const key of UNSUPPORTED_CONSTRAINTS) {
    const value = out[key];
    if (value !== undefined && (typeof value !== 'object' || value === null)) {
      out = appendHint(out, `${key}: ${value}`);
    }
  }

  return out;
}

function removeUnsupported(schema: SchemaObject): SchemaObject {
  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!UNSUPPORTED_KEYWORDS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

function cleanupRequired(schema: SchemaObject): SchemaObject {
  if (!Array.isArray(schema.required)) {
    return schema;
  }

  const properties = asSchemaObject(schema.properties);
  if (!properties) {
    const rest = {...schema};
    delete rest.required;
    return rest;
  }

  const filtered = schema.required.filter(
    (key): key is string =>
      typeof key === 'string' &&
      Object.prototype.hasOwnProperty.call(properties, key),
  );
  if (filtered.length === schema.required.length) {
    return schema;
  }

  if (filtered.length === 0) {
    const rest = {...schema};
    delete rest.required;
    return rest;
  }

  return {...schema, required: filtered};
}

const PIPELINE = [
  normalizeRefsAndConst,
  mergeAllOf,
  flattenUnions,
  flattenTypeArrays,
  addHints,
  removeUnsupported,
  cleanupRequired,
] as const;

function applyPipeline(schema: SchemaObject): SchemaObject {
  let current = schema;
  for (const transform of PIPELINE) {
    current = transform(current);
  }
  return current;
}

export function cleanJSONSchemaForAntigravity(
  schema: unknown,
): Record<string, unknown> {
  const root = asSchemaObject(schema);
  if (!root) {
    return {};
  }

  const result = mapSchema(root, applyPipeline);
  return asSchemaObject(result) ?? {};
}
