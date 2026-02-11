const SKIP_PARSE_KEYS = new Set([
  "oldString",
  "newString",
  "content",
  "filePath",
  "path",
  "text",
  "code",
  "source",
  "data",
  "body",
  "message",
  "prompt",
  "input",
  "output",
  "result",
  "value",
  "query",
  "pattern",
  "replacement",
  "template",
  "script",
  "command",
  "snippet",
]);

export function recursivelyParseJsonStrings(
  obj: unknown,
  skipParseKeys: Set<string> = SKIP_PARSE_KEYS,
  currentKey?: string,
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => recursivelyParseJsonStrings(item, skipParseKeys));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = recursivelyParseJsonStrings(value, skipParseKeys, key);
    }
    return result;
  }

  if (typeof obj !== "string") {
    return obj;
  }

  if (currentKey && skipParseKeys.has(currentKey)) {
    return obj;
  }

  const stripped = obj.trim();
  const hasControlCharEscapes = obj.includes("\\n") || obj.includes("\\t");
  const hasIntentionalEscapes = obj.includes('\\"') || obj.includes("\\\\");

  if (hasControlCharEscapes && !hasIntentionalEscapes) {
    try {
      return JSON.parse(`"${obj}"`);
    } catch {
    }
  }

  if (stripped && (stripped[0] === "{" || stripped[0] === "[")) {
    if (
      (stripped.startsWith("{") && stripped.endsWith("}")) ||
      (stripped.startsWith("[") && stripped.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(obj);
        return recursivelyParseJsonStrings(parsed);
      } catch {
      }
    }

    for (const [open, close] of [["[", "]"], ["{", "}"]] as const) {
      if (stripped.startsWith(open) && !stripped.endsWith(close)) {
        try {
          const last = stripped.lastIndexOf(close);
          if (last > 0) return recursivelyParseJsonStrings(JSON.parse(stripped.slice(0, last + 1)));
        } catch {}
      }
    }
  }

  return obj;
}
