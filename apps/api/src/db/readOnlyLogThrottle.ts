import { isReadOnlySqlError } from './readOnlyDatabase';

/**
 * #11741 item 1: one log line per source per minute for SQLSTATE 25006.
 *
 * When the database goes read-only (a provider's `default_transaction_read_only
 * = on`, see readOnlyDatabase.ts), every write fails, and every failure is
 * logged with a full stack: ~150 BullMQ `worker.on('failed')` handlers, the
 * shared `attachWorkerObservability` handler, the agent ingest and heartbeat
 * paths, route error handlers. The 11-11 incident wrote ~900k lines per ten
 * minutes, which buried the one line that said what was wrong.
 *
 * The throttle sits at the console, the one place every one of those paths
 * already goes through, instead of in ~150 handlers. It touches ONLY a call
 * whose arguments carry a read-only error (an error object with SQLSTATE 25006,
 * also when wrapped on `cause`, or the driver's "cannot execute X in a
 * read-only transaction" text) and no other error. Every other line passes
 * through untouched, in order, with its original arguments.
 *
 * For a read-only error, the first call from a source in a window writes ONE
 * line without a stack: the source, the SQLSTATE, the driver message and the
 * call's own first message (shortened), so what failed stays visible. Later
 * calls from that source in the window are counted, and the next line (or the
 * periodic flush) carries the count. Sentry is not involved: events there are
 * already throttled by `throttleEvent` (services/sentry.ts).
 *
 * A source is the leading `[tag]` of the first string argument (every worker
 * and service in this codebase prefixes its lines that way), so per-job ids do
 * not split one handler into a thousand sources. Untagged messages fall back to
 * the message with digits and ids normalized.
 */

export interface ConsoleLike {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

type Level = keyof ConsoleLike;
const LEVELS: readonly Level[] = ['error', 'warn', 'log', 'info'];

export const READ_ONLY_LOG_WINDOW_MS = 60_000;
const DEFAULT_MAX_SOURCES = 500;
const OVERFLOW_SOURCE = '(other sources)';
const NO_MESSAGE_SOURCE = '(no message)';

const READ_ONLY_MESSAGE = /cannot execute \S+ in a read-only transaction/i;
const LEADING_TAG = /^\s*(\[[^\]\n]{1,80}\])/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DIGITS = /\d+/g;

function firstString(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg === 'string') return arg;
  }
  return undefined;
}

/** The throttle key for a console call. Exported for tests. */
export function readOnlyLogSource(args: readonly unknown[]): string {
  const message = firstString(args);
  if (message === undefined) return NO_MESSAGE_SOURCE;
  const tag = LEADING_TAG.exec(message)?.[1];
  if (tag) return tag;
  const normalized = message.replace(UUID, '<id>').replace(DIGITS, '#').trim().slice(0, 80);
  return normalized || NO_MESSAGE_SOURCE;
}

/**
 * The read-only error's message when a call carries one, else null. A call
 * that ALSO carries any other error (an Error, or an object with an error
 * `code`) is never throttled: collapsing it would drop that error.
 */
function readOnlyDetail(args: readonly unknown[]): string | null {
  let detail: string | null = null;
  for (const arg of args) {
    if (typeof arg === 'string') {
      const match = READ_ONLY_MESSAGE.exec(arg);
      if (match && detail === null) detail = match[0];
    } else if (arg !== null && typeof arg === 'object') {
      if (isReadOnlySqlError(arg)) {
        if (detail === null) detail = readOnlyMessage(arg);
      } else if (arg instanceof Error || typeof (arg as { code?: unknown }).code === 'string') {
        return null;
      }
    }
  }
  return detail;
}

const MAX_EXAMPLE_LENGTH = 200;

/** The call's own first message, shortened, so the compact line keeps it. */
function exampleMessage(args: readonly unknown[]): string {
  const message = firstString(args)?.trim() ?? '';
  return message.length > MAX_EXAMPLE_LENGTH ? `${message.slice(0, MAX_EXAMPLE_LENGTH)}…` : message;
}

/** The driver's own text, from the error or the first `cause` that has it. */
function readOnlyMessage(error: object): string {
  let cur: unknown = error;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const message = (cur as { message?: unknown }).message;
    if (typeof message === 'string') {
      const match = READ_ONLY_MESSAGE.exec(message);
      if (match) return match[0];
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return 'read-only transaction';
}

interface SourceState {
  windowStart: number;
  suppressed: number;
  level: Level;
}

export interface ReadOnlyLogThrottle {
  /** Console methods with the throttle applied; they write to the sink. */
  console: ConsoleLike;
  /** Report suppressed counts whose window has closed; forget idle sources. */
  flush(): void;
}

export function createReadOnlyLogThrottle(
  sink: ConsoleLike,
  options: { now?: () => number; windowMs?: number; maxSources?: number } = {},
): ReadOnlyLogThrottle {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? READ_ONLY_LOG_WINDOW_MS;
  const maxSources = options.maxSources ?? DEFAULT_MAX_SOURCES;
  const sources = new Map<string, SourceState>();
  const windowSeconds = Math.round(windowMs / 1000);

  const suppressedNote = (count: number): string =>
    count > 0 ? ` (${count} more suppressed in the last ${windowSeconds}s)` : '';

  const write = (
    level: Level,
    source: string,
    detail: string,
    example: string,
    suppressed: number,
  ): void => {
    const exampleNote = example && example !== source ? ` Latest: ${example}` : '';
    sink[level](
      `${source} database is read-only (SQLSTATE 25006): ${detail}${suppressedNote(suppressed)}.` +
        `${exampleNote} Further read-only errors from this source are summarized every ${windowSeconds}s.`,
    );
  };

  /** True when the call was handled (written compactly or counted). */
  const handle = (level: Level, args: readonly unknown[]): boolean => {
    const detail = readOnlyDetail(args);
    if (detail === null) return false;

    let source = readOnlyLogSource(args);
    if (!sources.has(source) && sources.size >= maxSources) source = OVERFLOW_SOURCE;
    const at = now();
    const state = sources.get(source);
    if (state && at - state.windowStart < windowMs) {
      state.suppressed += 1;
      return true;
    }
    write(level, source, detail, exampleMessage(args), state?.suppressed ?? 0);
    sources.set(source, { windowStart: at, suppressed: 0, level });
    return true;
  };

  const wrapped = {} as ConsoleLike;
  for (const level of LEVELS) {
    wrapped[level] = (...args: unknown[]): void => {
      let handled = false;
      try {
        handled = handle(level, args);
      } catch {
        // A log call must never throw because of the throttle; fall through
        // and write the line as it was given.
        handled = false;
      }
      if (!handled) sink[level](...args);
    };
  }

  return {
    console: wrapped,
    flush(): void {
      const at = now();
      for (const [source, state] of sources) {
        if (at - state.windowStart < windowMs) continue;
        if (state.suppressed > 0) {
          sink[state.level](
            `${source} database is read-only (SQLSTATE 25006): ${state.suppressed} more suppressed ` +
              `in the last ${windowSeconds}s.`,
          );
          state.windowStart = at;
          state.suppressed = 0;
        } else {
          sources.delete(source);
        }
      }
    },
  };
}

let installed: { restore: () => void } | null = null;

/**
 * Route the process console through the throttle. Idempotent; returns a
 * function that restores the original methods (tests). Called first thing by
 * both entrypoints (index.ts, worker.ts).
 */
export function installReadOnlyLogThrottle(): () => void {
  if (installed) return installed.restore;
  const original: ConsoleLike = {
    error: console.error,
    warn: console.warn,
    log: console.log,
    info: console.info,
  };
  const sink: ConsoleLike = {
    error: original.error.bind(console),
    warn: original.warn.bind(console),
    log: original.log.bind(console),
    info: original.info.bind(console),
  };
  const throttle = createReadOnlyLogThrottle(sink);
  for (const level of LEVELS) console[level] = throttle.console[level];
  const timer = setInterval(() => throttle.flush(), READ_ONLY_LOG_WINDOW_MS);
  timer.unref?.();
  const restore = (): void => {
    clearInterval(timer);
    for (const level of LEVELS) console[level] = original[level];
    installed = null;
  };
  installed = { restore };
  return restore;
}
