const SKIP_PARSE_KEYS = new Set([
  'oldString',
  'newString',
  'content',
  'filePath',
  'path',
  'text',
  'code',
  'source',
  'data',
  'body',
  'message',
  'prompt',
  'input',
  'output',
  'result',
  'value',
  'query',
  'pattern',
  'replacement',
  'template',
  'script',
  'command',
  'snippet',
]);

type JsonParseResult = {ok: true; value: unknown} | {ok: false};

function parseJson(value: string): JsonParseResult {
  try {
    return {ok: true, value: JSON.parse(value)};
  } catch {
    return {ok: false};
  }
}

function parseEscapedControlText(value: string): string | undefined {
  const hasControlCharEscapes = value.includes('\\n') || value.includes('\\t');
  if (!hasControlCharEscapes) {
    return undefined;
  }

  const hasIntentionalEscapes = value.includes('\\"') || value.includes('\\\\');
  if (hasIntentionalEscapes) {
    return undefined;
  }

  const parsed = parseJson(`"${value}"`);
  return parsed.ok && typeof parsed.value === 'string'
    ? parsed.value
    : undefined;
}

function parseCompleteContainer(value: string): unknown | undefined {
  const stripped = value.trim();
  if (!stripped) {
    return undefined;
  }

  const isObject = stripped.startsWith('{') && stripped.endsWith('}');
  const isArray = stripped.startsWith('[') && stripped.endsWith(']');
  if (!isObject && !isArray) {
    return undefined;
  }

  const parsed = parseJson(value);
  return parsed.ok ? parsed.value : undefined;
}

function parseTruncatedContainer(value: string): unknown | undefined {
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    if (!value.startsWith(open) || value.endsWith(close)) {
      continue;
    }

    const last = value.lastIndexOf(close);
    if (last <= 0) {
      continue;
    }

    const parsed = parseJson(value.slice(0, last + 1));
    if (parsed.ok) {
      return parsed.value;
    }
  }

  return undefined;
}

function parseContainerCandidate(value: string): unknown | undefined {
  const stripped = value.trim();
  if (!stripped || (stripped[0] !== '{' && stripped[0] !== '[')) {
    return undefined;
  }

  return parseCompleteContainer(value) ?? parseTruncatedContainer(stripped);
}

export function recursivelyParseJsonStrings(
  obj: unknown,
  skipParseKeys: Set<string> = SKIP_PARSE_KEYS,
  currentKey?: string,
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => recursivelyParseJsonStrings(item, skipParseKeys));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = recursivelyParseJsonStrings(value, skipParseKeys, key);
    }
    return result;
  }

  if (typeof obj !== 'string') {
    return obj;
  }

  if (currentKey && skipParseKeys.has(currentKey)) {
    return obj;
  }

  const parsedEscapedText = parseEscapedControlText(obj);
  if (parsedEscapedText !== undefined) {
    return parsedEscapedText;
  }

  const parsedContainer = parseContainerCandidate(obj);
  if (parsedContainer !== undefined) {
    return recursivelyParseJsonStrings(parsedContainer, skipParseKeys);
  }

  return obj;
}
