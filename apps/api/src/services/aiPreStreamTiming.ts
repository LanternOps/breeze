/**
 * Phase timing for the synchronous setup an AI chat request does before its
 * SSE stream starts (#11004). That setup runs on the Node main thread; on EU
 * prod a first message after a restart blocked the loop for 37 s, and every
 * first-message-of-session blocks it for 1–3 s, with no log saying which
 * phase. This module answers that with ONE warn line per slow request:
 *
 *   [AI] slow pre-stream setup surface=chat.message sessionId=… total=1840ms
 *     slowest=dispatch.session.mcpServer:1210ms phases=preflight=310ms,…
 *
 * (printed on a single line). A request whose phases all stay under
 * PRE_STREAM_SLOW_PHASE_MS logs nothing.
 *
 * Phases are wall-clock (performance.now()), so an awaited DB phase shows its
 * I/O wait too; the synchronous ones (tool-set build, SDK MCP server creation,
 * system-prompt tool index, subprocess spawn) are CPU on the main thread.
 * `untimed` is the request's wall time that no top-level phase covers, so a
 * stall in code nobody instrumented still surfaces instead of hiding.
 *
 * The current timer and the enclosing phase name travel in an
 * AsyncLocalStorage, so deep callees (buildSystemPrompt, getOrCreate) record
 * phases without threading a parameter through every signature, and
 * concurrent phases (Promise.all) nest correctly. Outside a timed request
 * every call is a no-op passthrough.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** A phase (or the untimed remainder) at or above this logs the request. */
export const PRE_STREAM_SLOW_PHASE_MS = 500;

class PreStreamTimer {
  readonly startedAt = performance.now();
  readonly phases = new Map<string, number>();
  finished = false;

  constructor(
    readonly surface: string,
    readonly fields: Readonly<Record<string, string | null | undefined>>,
  ) {}

  record(name: string, ms: number): void {
    if (this.finished) return;
    this.phases.set(name, (this.phases.get(name) ?? 0) + ms);
  }
}

interface TimingFrame {
  readonly timer: PreStreamTimer;
  /** Dotted name of the enclosing phase ('' at the request's top level). */
  readonly prefix: string;
}

const timingStorage = new AsyncLocalStorage<TimingFrame>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

const round = (ms: number) => Math.round(ms);

/**
 * Field values can be request input (the route's `:id` param, percent-decoded
 * by Hono and not yet validated when the timer starts): keep them to one
 * bounded token so a crafted id cannot forge or split a log line.
 */
function logSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '?').slice(0, 64);
}

function finishTimer(timer: PreStreamTimer): void {
  if (timer.finished) return;
  const totalMs = performance.now() - timer.startedAt;
  timer.finished = true;

  const entries = [...timer.phases.entries()];
  const topLevelMs = entries.filter(([name]) => !name.includes('.')).reduce((sum, [, ms]) => sum + ms, 0);
  const untimedMs = Math.max(0, totalMs - topLevelMs);
  // A container's wall time always covers its children, so "slowest" is the
  // slowest LEAF — the phase someone can actually go and fix.
  const leaves = entries.filter(([name]) => !entries.some(([other]) => other.startsWith(`${name}.`)));
  const candidates: Array<[string, number]> = [...leaves, ['untimed', untimedMs]];
  const slowest = candidates.reduce((max, entry) => (entry[1] > max[1] ? entry : max));

  const anySlow = entries.some(([, ms]) => ms >= PRE_STREAM_SLOW_PHASE_MS) || untimedMs >= PRE_STREAM_SLOW_PHASE_MS;
  if (!anySlow) return;

  const fieldText = Object.entries(timer.fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${logSafe(String(value))}`)
    .join(' ');
  const phaseText = entries.map(([name, ms]) => `${name}=${round(ms)}ms`).join(',');
  console.warn(
    `[AI] slow pre-stream setup surface=${timer.surface}${fieldText ? ` ${fieldText}` : ''} `
    + `total=${round(totalMs)}ms slowest=${slowest[0]}:${round(slowest[1])}ms `
    + `phases=${phaseText || '-'} untimed=${round(untimedMs)}ms threshold=${PRE_STREAM_SLOW_PHASE_MS}ms`,
  );
}

/**
 * Time `fn` as one pre-stream request (`surface` names the entry point; keep
 * `fields` to non-secret identifiers such as the session id). Logs at most one
 * warn line when it settles. Nested inside an already-timed request it adds
 * nothing of its own — its phases fold into the outer timer.
 */
export async function withPreStreamTiming<T>(
  surface: string,
  fields: Readonly<Record<string, string | null | undefined>>,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = timingStorage.getStore();
  if (outer && !outer.timer.finished) return fn();
  const timer = new PreStreamTimer(surface, fields);
  try {
    return await timingStorage.run({ timer, prefix: '' }, fn);
  } finally {
    try {
      finishTimer(timer);
    } catch (err) {
      // Diagnostics must never fail the request they describe.
      console.error('[AI] pre-stream timing failed to report:', err);
    }
  }
}

/**
 * Time one phase of the current pre-stream request. Works for sync and async
 * `fn` (an async phase is timed until its promise settles). Phases nest: a
 * phase opened inside `preflight` is recorded as `preflight.<name>`. A no-op
 * passthrough outside a timed request or after the request's timer finished.
 */
export function timePreStreamPhase<T>(name: string, fn: () => T): T {
  const frame = timingStorage.getStore();
  if (!frame || frame.timer.finished) return fn();
  const fullName = frame.prefix ? `${frame.prefix}.${name}` : name;
  const startedAt = performance.now();
  const record = () => frame.timer.record(fullName, performance.now() - startedAt);
  let result: T;
  try {
    result = timingStorage.run({ timer: frame.timer, prefix: fullName }, fn);
  } catch (err) {
    record();
    throw err;
  }
  if (isPromiseLike(result)) {
    // One then() (not finally()): keeps the caller's resume a single tick
    // behind the phase's own settlement.
    return Promise.resolve(result).then(
      (value) => { record(); return value; },
      (err: unknown) => { record(); throw err; },
    ) as T;
  }
  record();
  return result;
}

/**
 * Run `fn` detached from the current pre-stream timer, for work that outlives
 * the request (the SDK query's background processor), so it neither records
 * into nor retains the request's timer.
 */
export function exitPreStreamTiming<T>(fn: () => T): T {
  return timingStorage.exit(fn);
}
