/**
 * Locate the VALUE an RFC 6901 JSON pointer names inside raw JSON text, as a
 * 1-based Monaco-style range. Used to turn the API's validation issue pointers
 * (e.g. `/steps/0/input/scriptId`) into editor markers on the text exactly as
 * the user typed it — so it scans the text itself rather than JSON.parse'ing
 * it, which would lose every offset.
 *
 * Strict JSON only (no comments, no trailing commas): anything JSON.parse
 * would reject returns null, as does a pointer that names nothing.
 */

export interface JsonPointerLocation {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

type JsonNode =
  | { kind: 'object'; start: number; end: number; members: Map<string, JsonNode> }
  | { kind: 'array'; start: number; end: number; items: JsonNode[] }
  | { kind: 'scalar'; start: number; end: number };

class JsonSyntaxError extends Error {}

const MAX_DEPTH = 512;

function scan(text: string): JsonNode {
  let pos = 0;

  const fail = (): never => {
    throw new JsonSyntaxError();
  };

  const skipWhitespace = () => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      // space, tab, LF, CR — the only whitespace JSON allows.
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };

  const expectLiteral = (word: string) => {
    if (text.startsWith(word, pos)) pos += word.length;
    else fail();
  };

  /** Scans a string starting at the opening quote; returns its decoded value. */
  const scanString = (): string => {
    if (text[pos] !== '"') fail();
    pos++;
    let out = '';
    for (;;) {
      if (pos >= text.length) fail();
      const ch = text[pos];
      const code = text.charCodeAt(pos);
      if (ch === '"') {
        pos++;
        return out;
      }
      if (code < 0x20) fail();
      if (ch !== '\\') {
        out += ch;
        pos++;
        continue;
      }
      const esc = text[pos + 1];
      switch (esc) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = text.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 4;
          break;
        }
        default:
          fail();
      }
      pos += 2;
    }
  };

  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const scanNumber = () => {
    numberPattern.lastIndex = pos;
    const match = numberPattern.exec(text);
    if (!match) fail();
    pos += match![0].length;
  };

  const scanValue = (depth: number): JsonNode => {
    if (depth > MAX_DEPTH) fail();
    skipWhitespace();
    const start = pos;
    const ch = text[pos];
    if (ch === '{') {
      pos++;
      const members = new Map<string, JsonNode>();
      skipWhitespace();
      if (text[pos] === '}') {
        pos++;
        return { kind: 'object', start, end: pos, members };
      }
      for (;;) {
        skipWhitespace();
        const key = scanString();
        skipWhitespace();
        if (text[pos] !== ':') fail();
        pos++;
        const value = scanValue(depth + 1);
        // Last duplicate wins, matching JSON.parse. delete() first so Map
        // order is irrelevant either way.
        members.delete(key);
        members.set(key, value);
        skipWhitespace();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return { kind: 'object', start, end: pos, members };
        }
        fail();
      }
    }
    if (ch === '[') {
      pos++;
      const items: JsonNode[] = [];
      skipWhitespace();
      if (text[pos] === ']') {
        pos++;
        return { kind: 'array', start, end: pos, items };
      }
      for (;;) {
        items.push(scanValue(depth + 1));
        skipWhitespace();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return { kind: 'array', start, end: pos, items };
        }
        fail();
      }
    }
    if (ch === '"') scanString();
    else if (ch === 't') expectLiteral('true');
    else if (ch === 'f') expectLiteral('false');
    else if (ch === 'n') expectLiteral('null');
    else if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) scanNumber();
    else fail();
    return { kind: 'scalar', start, end: pos };
  };

  const root = scanValue(0);
  skipWhitespace();
  if (pos !== text.length) fail();
  return root;
}

/** Splits an RFC 6901 pointer into unescaped reference tokens; null if malformed. */
function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return null;
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** 1-based line/column for a UTF-16 offset; CRLF and lone CR count as one break, as in Monaco. */
function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      line++;
      lineStart = i + 1;
    } else if (c === 0x0d && text.charCodeAt(i + 1) !== 0x0a) {
      // A lone CR is a break; the CR of a CRLF is not (its LF counts).
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

export function locateJsonPointer(text: string, pointer: string): JsonPointerLocation | null {
  const tokens = parsePointer(pointer);
  if (!tokens) return null;

  let node: JsonNode;
  try {
    node = scan(text);
  } catch (err) {
    if (err instanceof JsonSyntaxError) return null;
    throw err;
  }

  for (const token of tokens) {
    if (node.kind === 'object') {
      const next = node.members.get(token);
      if (!next) return null;
      node = next;
    } else if (node.kind === 'array') {
      if (!ARRAY_INDEX.test(token)) return null;
      const next = node.items[Number(token)];
      if (!next) return null;
      node = next;
    } else {
      return null;
    }
  }

  const start = positionAt(text, node.start);
  const end = positionAt(text, node.end);
  return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column };
}
