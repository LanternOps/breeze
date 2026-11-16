/**
 * A released step's result as text a technician can read in the thread.
 *
 * The agent returns most device reads as a command result whose `stdout` is a
 * JSON document (`{"events":[…]}`, `{"values":[…]}`). Pasting that into a post
 * shows one escaped record and a cut mid-sentence, so the known shapes are
 * described instead: how many, from where, over what span, then what each one
 * was. An unknown document is described by its fields. A document is never
 * pasted: one that parses is described, and output that only looks like JSON
 * (cut short, JSON Lines) is reported as unreadable. Plain text is shown as
 * written. The full output stays on the run page the post links to.
 *
 * Everything returned has been through `sanitizeUntrustedToolText` (this is
 * device-written text) and is capped by code point. The work is linear in the
 * size of the result: the device decides how many entries a result holds.
 */
import { sanitizeUntrustedToolText } from '../aiInputSanitizer';

const ITEM_VALUE_MAX_CHARS = 120;
/** One listed item (an event line, a registry value). */
const ITEM_MAX_CHARS = 300;
/** The least room worth giving a cut-down first item. */
const MIN_ITEM_ROOM = 24;
const FIELD_VALUE_MAX_CHARS = 80;
const MAX_FIELDS = 12;
const SECOND_LINE_MAX_CHARS = 80;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const length = (text: string): number => Array.from(text).length;

function cap(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * Lead + as many items as fit, joined by "; ", then how many were left out.
 * Items are built one at a time from the front and only while there is room,
 * so the cost follows the cap, not the number of entries. If not even the
 * first item fits whole, it is cut to the room left rather than dropped: a
 * summary that lists nothing describes nothing.
 */
function fitList(lead: string, total: number, itemAt: (index: number) => string, max: number): string {
  const trailer = (rest: number): string => (rest > 0 ? `and ${rest} more.` : '');
  const assemble = (shown: string[]): string => {
    const parts = [...shown];
    const tail = trailer(total - shown.length);
    if (tail) parts.push(tail);
    return [lead, parts.join('; ')].filter(Boolean).join(' ');
  };
  // Room for the worst-case trailer is held back while items remain.
  const reserve = length(`; ${trailer(total)}`);
  const shown: string[] = [];
  let used = length(lead);
  for (let i = 0; i < total; i += 1) {
    const item = cap(itemAt(i), ITEM_MAX_CHARS);
    const cost = length(item) + (shown.length === 0 ? (lead ? 1 : 0) : 2);
    const holdBack = i === total - 1 ? 0 : reserve;
    if (used + cost + holdBack > max) {
      if (shown.length === 0) {
        const room = max - used - (lead ? 1 : 0) - (total > 1 ? reserve : 0);
        if (room >= MIN_ITEM_ROOM) shown.push(cap(item, room));
      }
      break;
    }
    shown.push(item);
    used += cost;
  }
  return assemble(shown);
}

// ---------------------------------------------------------------------------
// Event log queries
// ---------------------------------------------------------------------------

const ESCAPES: Readonly<Record<string, string>> = { '\\': '\\', '/': '/', r: '\r', n: '\n', t: '\t', '"': '"' };

/**
 * The message's lines, each made safe to show.
 *
 * The Windows agent copies every event field out of PowerShell's JSON text
 * without decoding it (agent/internal/remote/tools/eventlogs_query.go,
 * `extractValue`), so after JSON.parse a message still holds JSON escapes:
 * `\r\n`, `\\`, `\"`, and `\u0027`-style codes for quotes and angle brackets.
 * One left-to-right pass undoes those (so `\\n` stays a backslash and an "n").
 * That path never yields a real line break, so a message that has one came
 * from somewhere else and is left alone: unescaping it would turn `C:\temp`
 * into a tab.
 *
 * The text is sanitised HERE, while it still has its line breaks. The
 * sanitiser finds a forged role label ("System: …") at the start of a line;
 * flattening first would hide one in the middle of a sentence.
 */
function messageLines(message: string): string[] {
  const text = /[\r\n]/.test(message)
    ? message
    : message.replace(/\\(u[0-9a-fA-F]{4}|[\\/rnt"])/g, (_, c: string) =>
      c.length === 5 ? String.fromCharCode(Number.parseInt(c.slice(1), 16)) : ESCAPES[c] ?? c);
  return sanitizeUntrustedToolText(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** `Label: value` lines of a Windows event message, first occurrence of each label. */
function messageFields(lines: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^([^:\t]{2,40}):\s*(\S.*)$/.exec(line);
    if (match && !fields.has(match[1]!.trim())) fields.set(match[1]!.trim(), oneLine(match[2]!));
  }
  return fields;
}

/** What the event was about: the fields that identify it, else its first line. */
function eventDetail(message: string): string {
  const lines = messageLines(message);
  const fields = messageFields(lines);

  const newProcess = fields.get('New Process Name');
  if (newProcess) {
    const parent = fields.get('Creator Process Name');
    const commandLine = fields.get('Process Command Line');
    const who = [baseName(newProcess), parent ? `started by ${baseName(parent)}` : ''].filter(Boolean).join(', ');
    return commandLine ? `${who} (${cap(commandLine, ITEM_VALUE_MAX_CHARS)})` : who;
  }

  const objectName = fields.get('Object Name');
  if (objectName) {
    const valueName = fields.get('Object Value Name');
    const by = fields.get('Process Name');
    return [
      valueName ? `${valueName} in ${cap(objectName, ITEM_VALUE_MAX_CHARS)}` : cap(objectName, ITEM_VALUE_MAX_CHARS),
      by ? `by ${baseName(by)}` : '',
    ].filter(Boolean).join(', ');
  }

  const [first, second] = lines.map(oneLine);
  if (!first) return 'no message';
  return second && length(second) <= SECOND_LINE_MAX_CHARS ? `${first} (${second})` : first;
}

const stamp = (d: Date): { date: string; time: string } => {
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
};

function eventSpan(times: Date[]): string {
  if (times.length === 0) return '';
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  const from = stamp(sorted[0]!);
  const to = stamp(sorted[sorted.length - 1]!);
  if (from.date === to.date && from.time === to.time) return `, ${from.date} ${from.time} UTC`;
  if (from.date === to.date) return `, ${from.date} ${from.time} to ${to.time} UTC`;
  return `, ${from.date} ${from.time} to ${to.date} ${to.time} UTC`;
}

function describeEvents(events: unknown[], max: number): string {
  const rows = events.filter(isObject);
  if (rows.length === 0) return 'No events matched.';

  const timeOf = (row: Json): Date | null => {
    const d = typeof row.timeCreated === 'string' ? new Date(row.timeCreated) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  const logs = new Set(rows.map((row) => (typeof row.logName === 'string' ? row.logName : '')).filter(Boolean));
  const source = logs.size === 1 ? ` from the ${[...logs][0]} log` : logs.size > 1 ? ` from ${logs.size} logs` : '';
  const times = rows.map(timeOf).filter((d): d is Date => d !== null);
  const lead = `${plural(rows.length, 'event')}${source}${eventSpan(times)}.`;
  // A time alone is ambiguous once the result crosses midnight: add the day.
  const manyDays = new Set(times.map((d) => stamp(d).date)).size > 1;
  const when = (d: Date): string => (manyDays ? `${stamp(d).date.slice(5)} ${stamp(d).time}` : stamp(d).time);

  const itemAt = (index: number): string => {
    const row = rows[index]!;
    const at = timeOf(row);
    const id = typeof row.eventId === 'number' || typeof row.eventId === 'string' ? `event ${row.eventId}` : 'event';
    const detail = eventDetail(typeof row.message === 'string' ? row.message : '');
    return `${at ? `${when(at)} ` : ''}${id}: ${detail}`;
  };
  return fitList(lead, rows.length, itemAt, max);
}

// ---------------------------------------------------------------------------
// Registry reads, and anything else
// ---------------------------------------------------------------------------

function describeRegistryValues(values: unknown[], max: number): string {
  const rows = values.filter(isObject);
  if (rows.length === 0) return 'The key has no values.';
  const itemAt = (index: number): string => {
    const row = rows[index]!;
    const name = typeof row.name === 'string' && row.name ? row.name : '(Default)';
    // The agent types `data` as a string; anything else is shown compactly, capped.
    const data = row.data === null || row.data === undefined ? '' : typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
    return `${name} = ${cap(oneLine(data), ITEM_VALUE_MAX_CHARS)}`;
  };
  return fitList(`${plural(rows.length, 'registry value')}:`, rows.length, itemAt, max);
}

/** An unknown document, by its fields: scalars as they are, containers by size. */
function describeFields(doc: Json): string {
  const entries = Object.entries(doc);
  const parts = entries.slice(0, MAX_FIELDS).map(([key, value]) => {
    if (value === null || value === undefined) return `${key}: none`;
    if (Array.isArray(value)) return `${key}: ${plural(value.length, 'item')}`;
    if (isObject(value)) return `${key}: ${plural(Object.keys(value).length, 'field')}`;
    return `${key}: ${cap(oneLine(String(value)), FIELD_VALUE_MAX_CHARS)}`;
  });
  if (entries.length > MAX_FIELDS) parts.push(`and ${entries.length - MAX_FIELDS} more.`);
  return parts.join('; ');
}

function describeDocument(doc: unknown, max: number): string {
  if (Array.isArray(doc)) return plural(doc.length, 'item');
  if (!isObject(doc)) return oneLine(String(doc));
  if (Array.isArray(doc.events)) return describeEvents(doc.events, max);
  if (Array.isArray(doc.values)) return describeRegistryValues(doc.values, max);
  return describeFields(doc);
}

/** `{"…`, `{}`, `[{…`, `[[…`, `["…`, `[]`: the start of a JSON document, not of a log line such as `[INFO] done`. */
const LOOKS_LIKE_JSON = /^(?:\{\s*["}]|\[\s*[[{"\]])/;

/** Output text: a JSON document is described, anything else is shown as written. */
function describeOutput(output: string, max: number): string {
  const text = output.trim();
  if (!LOOKS_LIKE_JSON.test(text)) return text;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // Cut short, JSON Lines, or a document followed by other text. Showing it
    // as text would paste the escaped dump this module exists to replace.
    return `The output was not a readable JSON document (${text.length} characters). The full output is on the run page.`;
  }
  return describeDocument(doc, max);
}

/** The step ran, but not cleanly: said first, so its output is never read as a success. */
function outcomePrefix(result: Json): string {
  if (result.status === 'timeout') return 'Timed out. ';
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return `Exited with code ${result.exitCode}. `;
  if (result.status === 'failed') return 'Failed. ';
  return '';
}

/** The fields that carry a result's text, in the order they are preferred. */
const TEXT_KEYS = ['stdout', 'message', 'raw', 'value'] as const;
const NON_FIELD_KEYS: ReadonlySet<string> = new Set([...TEXT_KEYS, 'stderr', 'summary']);

function describeResultObject(result: Json, max: number): string {
  if (typeof result.summary === 'string' && result.summary.trim()) return result.summary;
  // `raw` is non-JSON tool output and `value` a non-object JSON value, as the
  // release worker stores them (intentReleaseWorker.ts normalizeToolResult).
  for (const key of TEXT_KEYS) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return describeOutput(value, max);
  }
  if (typeof result.stderr === 'string' && result.stderr.trim()) return `stderr: ${result.stderr.trim()}`;
  // A result too large to store is replaced by this marker (intentReleaseWorker.ts).
  if (result.truncated === true && Object.keys(result).length === 1) {
    return 'The output was too large to show here. The full output is on the run page.';
  }
  // A command result (it has a stdout key) whose text is all blank printed
  // nothing: say "no output" rather than list exitCode and status. Any other
  // object is described by its remaining fields.
  if ('stdout' in result) return '';
  return describeFields(Object.fromEntries(Object.entries(result).filter(([key]) => !NON_FIELD_KEYS.has(key) || typeof result[key] !== 'string')));
}

export function summarizeStepResult(result: unknown, max: number): string {
  if (result === null || result === undefined) return 'no result recorded';
  const prefix = isObject(result) ? outcomePrefix(result) : '';
  const room = Math.max(0, max - length(prefix));
  const text = typeof result === 'string'
    ? describeOutput(result, room)
    : isObject(result) ? describeResultObject(result, room) : describeDocument(result, room);
  const clean = cap(sanitizeUntrustedToolText(text).trim(), room);
  return `${prefix}${clean.length > 0 ? clean : 'no output'}`;
}
