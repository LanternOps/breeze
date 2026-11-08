/**
 * Streaming reader for snapshots/<id>/manifest.json (#11026). A manifest with a
 * million entries is over 500 MB, and JSON.parse holds about six times that in
 * memory, so entries are handed over one at a time and nothing else is kept.
 *
 * The manifest is written by the device that reported the snapshot, so a value
 * in it is not trusted to be small. Tokens are consumed unpacked: a value the
 * scanner has no use for is never assembled, and one it does use is refused
 * past a fixed size rather than buffered. stream-json's own docs warn against
 * feeding it hostile input for exactly this reason (its packed tokens and its
 * Assembler have no limits).
 */
import { StringDecoder } from 'node:string_decoder';
import { getManyValues, isMany, none } from 'stream-chain/core';
import * as streamJsonParser from 'stream-json/parser.js';

// The bare tokenizer: stream-json's documented named export for embedding
// (llms.txt, "Parser"), which its 3.7.0 typings leave out. It turns each string
// into a synchronous batch of tokens, where `parser()` wraps it in a generator
// pipeline that costs a promise per token. UTF-8 decoding is done here instead,
// with StringDecoder.
const jsonParser = (streamJsonParser as unknown as {
  jsonParser: (options: { packValues: boolean; streamValues: boolean }) => (input: string | typeof none) => unknown;
}).jsonParser;

/**
 * Largest single `files[]` entry, counted in characters plus a small charge per
 * token. A real entry is a few hundred bytes and two paths of at most 32 KB.
 */
export const MANIFEST_ENTRY_MAX_CHARS = 1024 * 1024;
const MANIFEST_ENTRY_MAX_DEPTH = 32;
const MANIFEST_ID_MAX_CHARS = 4096;
/** Largest requested top-level value (ManifestScanOptions.fields), in characters. */
const MANIFEST_FIELD_MAX_CHARS = 4096;
/** Longer than any key the scanner looks for: the rest of a long key is dropped. */
const TOP_LEVEL_KEY_MAX_CHARS = 16;
const TOKEN_CHARGE = 8;

/**
 * - `malformed`: the document is not a manifest (bad JSON, `files` of the wrong
 *   shape, a repeated `files` or `id`).
 * - `limit`: it may be fine, but holding it would break a bound this server
 *   sets. Size is not evidence of tampering, so callers do not treat it as an
 *   integrity failure.
 */
export class ManifestScanError extends Error {
  constructor(public readonly kind: 'malformed' | 'limit', message: string) {
    super(message);
    this.name = 'ManifestScanError';
  }
}

export type ManifestScalar = string | number | boolean | null;

export type ManifestScanResult = {
  id: string | null;
  entries: number;
  hasFilesKey: boolean;
  /**
   * Present when ManifestScanOptions.fields was given: each requested key the
   * manifest has, with its value as JSON.parse reads it.
   */
  fields?: Record<string, ManifestScalar>;
};

export type ManifestScanHandlers = {
  onEntry: (entry: unknown, index: number) => void | Promise<void>;
};

export type ManifestScanOptions = {
  /**
   * Top-level keys, besides `id` and `files`, whose values the caller needs
   * (#11233: the reconcile path reads `timestamp`, `size` and the like). Each
   * must hold a string, number, boolean or null of at most 4096 characters; a
   * container value or a repeated key is refused as malformed and a longer
   * value as a limit, so a caller never reads a value its own schema would not
   * have accepted from JSON.parse.
   */
  fields?: readonly string[];
};

type Token = { name: string; value?: unknown };

/** Assembles one `files[]` element from tokens, under the size and depth limits. */
class EntryBuilder {
  private budget = MANIFEST_ENTRY_MAX_CHARS;
  /** Open containers, innermost last. */
  private stack: Array<Record<string, unknown> | unknown[]> = [];
  /** Each open container's own key in its parent, set aside until it closes. */
  private keyStack: Array<string | null> = [];
  private pendingKey: string | null = null;
  private text: string[] = [];

  private charge(cost: number, index: number): void {
    this.budget -= cost;
    if (this.budget < 0) {
      throw new ManifestScanError('limit', `manifest entry ${index} is larger than the ${MANIFEST_ENTRY_MAX_CHARS}-character limit`);
    }
  }

  /** Files a finished value in its container. Returns the value once the entry is complete. */
  private place(value: unknown): { done: true; value: unknown } | null {
    const parent = this.stack[this.stack.length - 1];
    if (!parent) return { done: true, value };
    if (Array.isArray(parent)) {
      parent.push(value);
      return null;
    }
    const key = this.pendingKey as string;
    this.pendingKey = null;
    if (key === '__proto__') {
      // As JSON.parse does: an own property, never the prototype.
      Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true });
    } else {
      parent[key] = value;
    }
    return null;
  }

  private takeText(): string {
    const value = this.text.length === 1 ? (this.text[0] as string) : this.text.join('');
    this.text = [];
    return value;
  }

  consume(token: Token, index: number): { done: true; value: unknown } | null {
    this.charge(TOKEN_CHARGE, index);
    switch (token.name) {
      case 'startObject':
      case 'startArray': {
        if (this.stack.length >= MANIFEST_ENTRY_MAX_DEPTH) {
          throw new ManifestScanError('limit', `manifest entry ${index} is nested more than ${MANIFEST_ENTRY_MAX_DEPTH} levels deep`);
        }
        const container = token.name === 'startObject' ? {} : [];
        this.stack.push(container);
        this.keyStack.push(this.pendingKey);
        this.pendingKey = null;
        return null;
      }
      case 'endObject':
      case 'endArray': {
        const container = this.stack.pop();
        this.pendingKey = this.keyStack.pop() ?? null;
        return this.place(container);
      }
      case 'stringChunk':
      case 'numberChunk': {
        const chunk = token.value as string;
        this.charge(chunk.length, index);
        this.text.push(chunk);
        return null;
      }
      case 'endKey':
        this.pendingKey = this.takeText();
        return null;
      case 'endString':
        return this.place(this.takeText());
      case 'endNumber':
        return this.place(Number(this.takeText()));
      case 'nullValue':
      case 'trueValue':
      case 'falseValue':
        return this.place(token.value);
      default:
        // startKey, startString, startNumber: the chunks and the end carry it.
        return null;
    }
  }
}

/**
 * The scanner itself, for a caller that needs the bytes as well (the attestation
 * verifier hashes them as they pass). Feed it with write(), awaiting each call,
 * then call finish(). Throws ManifestScanError; a handler's error passes through
 * untouched.
 */
export function createManifestScanner(handlers: ManifestScanHandlers, options: ManifestScanOptions = {}): {
  write(chunk: Uint8Array | string): Promise<void>;
  finish(): ManifestScanResult;
} {
  const parse = jsonParser({ packValues: false, streamValues: true });
  const decoder = new StringDecoder('utf8');

  const wanted = new Set(options.fields ?? []);
  for (const name of wanted) {
    if (name === 'id' || name === 'files' || name === '__proto__' || name.length === 0 || name.length > TOP_LEVEL_KEY_MAX_CHARS) {
      throw new Error(`manifest scanner cannot capture the top-level key ${JSON.stringify(name)}`);
    }
  }
  const fields: Record<string, ManifestScalar> | null = options.fields ? {} : null;

  let id: string | null = null;
  let seenId = false;
  let hasFilesKey = false;
  let entries = 0;

  // Where the document is. `depth` counts open containers while skipping.
  type Mode = 'root' | 'top' | 'key' | 'value' | 'id' | 'field' | 'skip-scalar' | 'skip' | 'files' | 'entry' | 'end';
  let mode: Mode = 'root';
  let key = '';
  let keyTooLong = false;
  let skipDepth = 0;
  let idChars: string[] = [];
  let idLength = 0;
  let fieldChars: string[] = [];
  let fieldLength = 0;
  let builder: EntryBuilder | null = null;

  /** Returns a finished entry for the caller to hand over. */
  const consume = (token: Token): { done: true; value: unknown } | null => {
    switch (mode) {
      case 'root':
        if (token.name !== 'startObject') throw new ManifestScanError('malformed', 'manifest is not a JSON object');
        mode = 'top';
        return null;

      case 'top':
        if (token.name === 'startKey') {
          key = '';
          keyTooLong = false;
          mode = 'key';
        } else if (token.name === 'endObject') {
          mode = 'end';
        }
        return null;

      case 'key':
        if (token.name === 'stringChunk') {
          if (keyTooLong) return null;
          key += token.value as string;
          if (key.length > TOP_LEVEL_KEY_MAX_CHARS) {
            keyTooLong = true;
            key = '';
          }
        } else if (token.name === 'endKey') {
          if (key === 'files' && hasFilesKey) throw new ManifestScanError('malformed', 'manifest has more than one files key');
          if (key === 'id' && seenId) throw new ManifestScanError('malformed', 'manifest has more than one id key');
          if (fields && wanted.has(key) && Object.hasOwn(fields, key)) {
            throw new ManifestScanError('malformed', `manifest has more than one ${key} key`);
          }
          mode = 'value';
        }
        return null;

      case 'value':
        if (key === 'files') {
          hasFilesKey = true;
          if (token.name === 'startArray') {
            mode = 'files';
          } else if (token.name === 'nullValue') {
            mode = 'top'; // A nil Go slice marshals as null: no entries.
          } else {
            throw new ManifestScanError('malformed', 'manifest files is not an array');
          }
          return null;
        }
        if (key === 'id') {
          seenId = true;
          if (token.name === 'startString') {
            idChars = [];
            idLength = 0;
            mode = 'id';
            return null;
          }
        }
        if (fields && wanted.has(key)) {
          if (token.name === 'startString' || token.name === 'startNumber') {
            fieldChars = [];
            fieldLength = 0;
            mode = 'field';
          } else if (token.name === 'nullValue' || token.name === 'trueValue' || token.name === 'falseValue') {
            fields[key] = token.value as ManifestScalar;
            mode = 'top';
          } else {
            throw new ManifestScanError('malformed', `manifest ${key} is not a string, number, boolean or null`);
          }
          return null;
        }
        // Any other value, or an id that is not a string (left null).
        if (token.name === 'startObject' || token.name === 'startArray') {
          skipDepth = 1;
          mode = 'skip';
        } else if (token.name === 'startString' || token.name === 'startNumber') {
          mode = 'skip-scalar';
        } else {
          mode = 'top';
        }
        return null;

      case 'id':
        if (token.name === 'stringChunk') {
          const chunk = token.value as string;
          idLength += chunk.length;
          if (idLength > MANIFEST_ID_MAX_CHARS) {
            throw new ManifestScanError('limit', `manifest id is longer than ${MANIFEST_ID_MAX_CHARS} characters`);
          }
          idChars.push(chunk);
        } else if (token.name === 'endString') {
          id = idChars.join('');
          mode = 'top';
        }
        return null;

      case 'field':
        if (token.name === 'stringChunk' || token.name === 'numberChunk') {
          const chunk = token.value as string;
          fieldLength += chunk.length;
          if (fieldLength > MANIFEST_FIELD_MAX_CHARS) {
            throw new ManifestScanError('limit', `manifest ${key} is longer than ${MANIFEST_FIELD_MAX_CHARS} characters`);
          }
          fieldChars.push(chunk);
        } else if (token.name === 'endString' || token.name === 'endNumber') {
          const text = fieldChars.join('');
          (fields as Record<string, ManifestScalar>)[key] = token.name === 'endString' ? text : Number(text);
          mode = 'top';
        }
        return null;

      case 'skip-scalar':
        if (token.name === 'endString' || token.name === 'endNumber') mode = 'top';
        return null;

      case 'skip':
        if (token.name === 'startObject' || token.name === 'startArray') {
          skipDepth += 1;
        } else if (token.name === 'endObject' || token.name === 'endArray') {
          skipDepth -= 1;
          if (skipDepth === 0) mode = 'top';
        }
        return null;

      case 'files':
        if (token.name === 'endArray') {
          mode = 'top';
          return null;
        }
        builder = new EntryBuilder();
        mode = 'entry';
        // falls through: this token opens the entry
      case 'entry': {
        const finished = (builder as EntryBuilder).consume(token, entries);
        if (finished) {
          builder = null;
          mode = 'files';
        }
        return finished;
      }

      default:
        return null;
    }
  };

  const feed = async (produced: unknown): Promise<void> => {
    if (produced === none) return;
    const tokens = (isMany(produced as never) ? getManyValues(produced as never) : [produced]) as Token[];
    for (const token of tokens) {
      const finished = consume(token);
      if (!finished) continue;
      const index = entries;
      entries += 1;
      const pending = handlers.onEntry(finished.value, index);
      if (pending) await pending;
    }
  };

  const tokenize = (input: string | typeof none): unknown => {
    try {
      return parse(input as never);
    } catch (err) {
      throw new ManifestScanError('malformed', `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let finished = false;
  return {
    async write(chunk) {
      // StringDecoder holds a multi-byte character split across chunks.
      const text = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (text.length > 0) await feed(tokenize(text));
    },
    finish() {
      if (finished) throw new Error('manifest scanner already finished');
      finished = true;
      const rest = decoder.end();
      if (rest.length > 0) {
        // Only a truncated character can be left. It can never complete the
        // document, so tokenizing it can only produce no tokens or an error.
        tokenize(rest);
      }
      // The tokenizer's flush reports an unfinished document; it yields no
      // tokens the scanner needs once the root has closed.
      tokenize(none);
      if (mode !== 'end') throw new ManifestScanError('malformed', 'manifest ended early');
      return fields ? { id, entries, hasFilesKey, fields } : { id, entries, hasFilesKey };
    },
  };
}

/**
 * Reads a whole manifest from `source`, calling onEntry for each `files[]`
 * element in order and awaiting it, which is also the backpressure on the
 * source. Top-level keys may come in any order, and anything but `id` and
 * `files` is skipped without being held. A source that errors rejects with that
 * error, so a dropped connection is never read as the end of the document.
 */
export async function scanManifest(
  source: NodeJS.ReadableStream | AsyncIterable<Uint8Array | string>,
  handlers: ManifestScanHandlers,
  options?: ManifestScanOptions,
): Promise<ManifestScanResult> {
  const scanner = createManifestScanner(handlers, options);
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    await scanner.write(chunk);
  }
  return scanner.finish();
}
