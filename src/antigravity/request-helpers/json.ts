import { createLogger } from "../logger";

const log = createLogger("request-helpers");

// RECURSIVE JSON STRING AUTO-PARSING (Ported from LLM-API-Key-Proxy)

/**
 * Recursively parses JSON strings in nested data structures.
 * 
 * This is a port of LLM-API-Key-Proxy's _recursively_parse_json_strings() function.
 * 
 * Handles:
 * - JSON-stringified values: {"files": "[{...}]"} → {"files": [{...}]}
 * - Malformed double-encoded JSON (extra trailing chars)
 * - Escaped control characters (\\n → \n, \\t → \t)
 * 
 * This is useful because Antigravity sometimes returns JSON-stringified values
 * in tool arguments, which can cause downstream parsing issues.
 * 
 * @param obj - The object to recursively parse
 * @param skipParseKeys - Set of keys whose values should NOT be parsed as JSON (preserved as strings)
 * @param currentKey - The current key being processed (internal use)
 * @returns The parsed object with JSON strings expanded
 */
// Keys whose string values should NOT be parsed as JSON - they contain literal text content
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

  // Check if string contains control character escape sequences
  // that need unescaping (\\n, \\t but NOT \\" or \\\\)
  const hasControlCharEscapes = obj.includes("\\n") || obj.includes("\\t");
  const hasIntentionalEscapes = obj.includes('\\"') || obj.includes("\\\\");

  if (hasControlCharEscapes && !hasIntentionalEscapes) {
    try {
      // Use JSON.parse with quotes to unescape the string
      return JSON.parse(`"${obj}"`);
    } catch {
      // Continue with original processing
    }
  }

  // Check if it looks like JSON (starts with { or [)
  if (stripped && (stripped[0] === "{" || stripped[0] === "[")) {
    // Try standard parsing first
    if (
      (stripped.startsWith("{") && stripped.endsWith("}")) ||
      (stripped.startsWith("[") && stripped.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(obj);
        return recursivelyParseJsonStrings(parsed);
      } catch {
        // Continue
      }
    }

    // Handle malformed JSON: array that doesn't end with ]
    if (stripped.startsWith("[") && !stripped.endsWith("]")) {
      try {
        const lastBracket = stripped.lastIndexOf("]");
        if (lastBracket > 0) {
          const cleaned = stripped.slice(0, lastBracket + 1);
          const parsed = JSON.parse(cleaned);
          log.debug("Auto-corrected malformed JSON array", {
            truncatedChars: stripped.length - cleaned.length,
          });
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
        // Continue
      }
    }

    // Handle malformed JSON: object that doesn't end with }
    if (stripped.startsWith("{") && !stripped.endsWith("}")) {
      try {
        const lastBrace = stripped.lastIndexOf("}");
        if (lastBrace > 0) {
          const cleaned = stripped.slice(0, lastBrace + 1);
          const parsed = JSON.parse(cleaned);
          log.debug("Auto-corrected malformed JSON object", {
            truncatedChars: stripped.length - cleaned.length,
          });
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
        // Continue
      }
    }
  }

  return obj;
}

// ============================================================================
