const UNSUPPORTED_CONSTRAINTS = [
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "pattern", "minItems", "maxItems", "format",
  "default", "examples",
] as const;

const UNSUPPORTED_KEYWORDS = new Set<string>([
  ...UNSUPPORTED_CONSTRAINTS,
  "$schema",
  "$defs",
  "definitions",
  "const",
  "$ref",
  "additionalProperties",
  "propertyNames",
  "title",
  "$id",
  "$comment",
]);

function mapSchema(value: unknown, transform: (obj: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => mapSchema(item, transform));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    mapped[key] = mapSchema(child, transform);
  }
  return transform(mapped);
}

function appendHint(schema: Record<string, unknown>, hint: string): Record<string, unknown> {
  const description = typeof schema.description === "string" ? schema.description : "";
  return {
    ...schema,
    description: description ? `${description} (${hint})` : hint,
  };
}

function normalizeRefsAndConst(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const name = ref.includes("/") ? ref.split("/").pop() : ref;
    return appendHint({ type: "object" }, `See: ${name}`);
  }

  if (schema.const !== undefined && !Array.isArray(schema.enum)) {
    const { const: ignored, ...rest } = schema;
    return { ...rest, enum: [ignored] };
  }

  return schema;
}

function mergeAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) {
    return schema;
  }

  const out: Record<string, unknown> = { ...schema };
  delete out.allOf;

  const mergedProps: Record<string, unknown> = {
    ...((out.properties as Record<string, unknown> | undefined) ?? {}),
  };
  const required = new Set<string>(Array.isArray(out.required) ? (out.required as string[]) : []);

  for (const item of schema.allOf as unknown[]) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;

    if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
      Object.assign(mergedProps, record.properties as Record<string, unknown>);
    }

    if (Array.isArray(record.required)) {
      for (const entry of record.required) {
        if (typeof entry === "string") {
          required.add(entry);
        }
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key === "properties" || key === "required") {
        continue;
      }
      if (out[key] === undefined) {
        out[key] = value;
      }
    }
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

function scoreUnionOption(option: unknown): { score: number; typeName: string } {
  if (!option || typeof option !== "object") {
    return { score: 0, typeName: "unknown" };
  }

  const record = option as Record<string, unknown>;
  const type = record.type;

  if (type === "object" || record.properties) {
    return { score: 3, typeName: "object" };
  }
  if (type === "array" || record.items) {
    return { score: 2, typeName: "array" };
  }
  if (typeof type === "string" && type !== "null") {
    return { score: 1, typeName: type };
  }

  return { score: 0, typeName: typeof type === "string" ? type : "null" };
}

function mergeUnionEnum(options: unknown[]): string[] | null {
  const values: string[] = [];

  for (const option of options) {
    if (!option || typeof option !== "object") {
      return null;
    }

    const record = option as Record<string, unknown>;
    if (record.properties || record.items || record.anyOf || record.oneOf || record.allOf) {
      return null;
    }

    if (record.const !== undefined) {
      values.push(String(record.const));
      continue;
    }

    if (Array.isArray(record.enum) && record.enum.length > 0) {
      values.push(...record.enum.map((v) => String(v)));
      continue;
    }

    if (typeof record.type === "string") {
      return null;
    }
  }

  return values.length > 0 ? values : null;
}

function flattenUnions(schema: Record<string, unknown>): Record<string, unknown> {
  let out = { ...schema };

  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const union = out[unionKey];
    if (!Array.isArray(union) || union.length === 0) {
      continue;
    }

    const parentDescription = typeof out.description === "string" ? out.description : "";
    const mergedEnum = mergeUnionEnum(union);
    if (mergedEnum) {
      delete out[unionKey];
      out.type = "string";
      out.enum = mergedEnum;
      if (parentDescription) {
        out.description = parentDescription;
      }
      continue;
    }

    let bestIndex = 0;
    let bestScore = -1;
    const typeNames: string[] = [];

    for (let i = 0; i < union.length; i += 1) {
      const { score, typeName } = scoreUnionOption(union[i]);
      typeNames.push(typeName);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    const chosen = union[bestIndex];
    const selected = chosen && typeof chosen === "object"
      ? { ...(chosen as Record<string, unknown>) }
      : ({ type: "string" } as Record<string, unknown>);

    if (parentDescription) {
      const childDescription = typeof selected.description === "string" ? selected.description : "";
      selected.description = childDescription && childDescription !== parentDescription
        ? `${parentDescription} (${childDescription})`
        : parentDescription;
    }

    const uniqueTypes = Array.from(new Set(typeNames.filter(Boolean)));
    if (uniqueTypes.length > 1) {
      Object.assign(selected, appendHint(selected, `Accepts: ${uniqueTypes.join(" | ")}`));
    }

    const { [unionKey]: ignored, ...rest } = out;
    out = { ...rest, ...selected };
  }

  return out;
}

function flattenTypeArrays(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.type)) {
    return schema;
  }

  const types = schema.type.filter((t): t is string => typeof t === "string");
  const hasNull = types.includes("null");
  const nonNull = types.filter((t) => t !== "null");

  let out: Record<string, unknown> = {
    ...schema,
    type: nonNull[0] ?? "string",
  };

  if (nonNull.length > 1) {
    out = appendHint(out, `Accepts: ${nonNull.join(" | ")}`);
  }
  if (hasNull) {
    out = appendHint(out, "nullable");
  }

  return out;
}

function addHints(schema: Record<string, unknown>): Record<string, unknown> {
  let out = { ...schema };

  if (Array.isArray(out.enum) && out.enum.length > 1 && out.enum.length <= 10) {
    out = appendHint(out, `Allowed: ${out.enum.map((v) => String(v)).join(", ")}`);
  }

  if (out.additionalProperties === false) {
    out = appendHint(out, "No extra properties allowed");
  }

  for (const key of UNSUPPORTED_CONSTRAINTS) {
    const value = out[key];
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      out = appendHint(out, `${key}: ${value}`);
    }
  }

  return out;
}

function removeUnsupported(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!UNSUPPORTED_KEYWORDS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

function cleanupRequired(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.required)) {
    return schema;
  }

  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    const { required, ...rest } = schema;
    return rest;
  }

  const filtered = schema.required.filter((key) => Object.prototype.hasOwnProperty.call(properties, key));
  if (filtered.length === schema.required.length) {
    return schema;
  }

  if (filtered.length === 0) {
    const { required, ...rest } = schema;
    return rest;
  }

  return { ...schema, required: filtered };
}

export function cleanJSONSchemaForAntigravity(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }

  const pipeline = (obj: Record<string, unknown>) =>
    cleanupRequired(removeUnsupported(addHints(flattenTypeArrays(flattenUnions(mergeAllOf(normalizeRefsAndConst(obj)))))));

  const result = mapSchema(schema, pipeline);
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}
