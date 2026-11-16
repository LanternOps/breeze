/**
 * A released step's result as text a technician can read in the thread.
 *
 * The agent returns most device reads as a command result whose `stdout` is a
 * JSON document (`{"events":[…]}`, `{"values":[…]}`). Pasting that into a post
 * shows one escaped record and a cut mid-sentence, so the known shapes are
 * described instead: how many, from where, over what span, then what each one
 * was. An unknown document is described by its fields. Raw JSON never leaves
 * here; the full output stays on the run page the post links to.
 *
 * Everything returned has been through `sanitizeUntrustedToolText` (this is
 * device-written text) and is capped by code point.
 */
import { sanitizeUntrustedToolText } from '../aiInputSanitizer';

const ITEM_VALUE_MAX_CHARS = 120;
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
 * Lead + items joined by "; ", dropping items from the end until it fits and
 * saying how many were dropped.
 */
function fitList(lead: string, items: string[], max: number): string {
  for (let shown = items.length; shown >= 0; shown -= 1) {
    const rest = items.length - shown;
    const parts = items.slice(0, shown);
    if (rest > 0) parts.push(`and ${rest} more.`);
    const text = [lead, parts.join('; ')].filter(Boolean).join(' ');
    if (length(text) <= max || shown === 0) return text;
  }
  return lead;
}

// ---------------------------------------------------------------------------
// Event log queries
// ---------------------------------------------------------------------------

const ESCAPES: Readonly<Record<string, string>> = { '\\': '\\', r: '\r', n: '\n', t: '\t', '"': '"' };

/**
 * The message's lines. The agent escapes an event message a second time, so a
 * parsed one can still hold the characters `\r\n`, `\\` for one backslash and
 * `\"` for a quote. One left-to-right pass undoes that (so `\\n` stays a
 * backslash and an "n"). A message with real line breaks was not escaped
 * twice and is left alone, or `C:\temp` would lose its `\t`.
 */
function messageLines(message: string): string[] {
  const text = /[\r\n]/.test(message) ? message : message.replace(/\\([\\rnt"])/g, (_, c: string) => ESCAPES[c] ?? c);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** `Label:<tab>value` lines of a Windows event message, first occurrence of each label. */
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

  const items = rows.map((row) => {
    const at = timeOf(row);
    const id = typeof row.eventId === 'number' || typeof row.eventId === 'string' ? `event ${row.eventId}` : 'event';
    const detail = eventDetail(typeof row.message === 'string' ? row.message : '');
    return `${at ? `${when(at)} ` : ''}${id}: ${detail}`;
  });
  return fitList(lead, items, max);
}

// ---------------------------------------------------------------------------
// Registry reads, and anything else
// ---------------------------------------------------------------------------

function describeRegistryValues(values: unknown[], max: number): string {
  const rows = values.filter(isObject);
  if (rows.length === 0) return 'The key has no values.';
  const items = rows.map((row) => {
    const name = typeof row.name === 'string' && row.name ? row.name : '(Default)';
    const data = row.data === null || row.data === undefined ? '' : typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
    return `${name} = ${cap(oneLine(data), ITEM_VALUE_MAX_CHARS)}`;
  });
  return fitList(`${plural(rows.length, 'registry value')}:`, items, max);
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

/** Output text: a JSON document is described, anything else is shown as written. */
function describeOutput(output: string, max: number): string {
  const text = output.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return describeDocument(JSON.parse(text), max);
    } catch {
      // Not JSON after all (or cut short by the agent): show it as text.
    }
  }
  return text;
}

export function summarizeStepResult(result: unknown, max: number): string {
  if (result === null || result === undefined) return 'no result recorded';
  const text = (() => {
    if (typeof result === 'string') return describeOutput(result, max);
    if (!isObject(result)) return describeDocument(result, max);
    if (typeof result.summary === 'string' && result.summary.trim()) return result.summary;
    for (const key of ['stdout', 'message', 'stderr'] as const) {
      const value = result[key];
      if (typeof value === 'string' && value.trim()) return describeOutput(value, max);
    }
    // Only fields the technician did not ask for are left once the text ones are blank.
    const rest = Object.fromEntries(Object.entries(result).filter(([key]) => !['stdout', 'message', 'stderr', 'summary'].includes(key)));
    return Object.keys(rest).length > 0 && !('stdout' in result) ? describeFields(rest) : '';
  })();
  const clean = cap(sanitizeUntrustedToolText(text).trim(), max);
  return clean.length > 0 ? clean : 'no output';
}
