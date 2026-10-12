/**
 * #7413 — group a device's script executions into one entry per script, newest
 * run first, so the Scripts tab can show "which scripts last passed or failed"
 * at a glance. Pure so it can be tested without mounting the tab.
 */

export type GroupableExecution = {
  scriptId?: string;
  scriptName?: string;
  name?: string;
  startedAt?: string;
  createdAt?: string;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
};

export type ScriptRunGroup<T extends GroupableExecution> = {
  /** Stable key: the scriptId, or the script name for runs that carry no id. */
  key: string;
  /** All runs of this script, newest first. */
  runs: T[];
  /** The newest run (runs[0]). */
  latest: T;
};

function startedMs(item: GroupableExecution): number {
  const value = item.startedAt ?? item.createdAt;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function groupKey(item: GroupableExecution, fallbackName: string): string {
  return item.scriptId ?? item.scriptName ?? item.name ?? fallbackName;
}

/**
 * Groups by scriptId (falling back to the script name), orders each group's
 * runs newest-first, and orders groups by their latest run. Sorting is stable,
 * so rows with no usable timestamp keep the API's (newest-first) order.
 */
export function groupExecutionsByScript<T extends GroupableExecution>(
  executions: T[],
  fallbackName: string,
): ScriptRunGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const item of executions) {
    const key = groupKey(item, fallbackName);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(item);
    else byKey.set(key, [item]);
  }
  const groups = Array.from(byKey, ([key, runs]) => {
    const sorted = [...runs].sort((a, b) => startedMs(b) - startedMs(a));
    return { key, runs: sorted, latest: sorted[0]! };
  });
  return groups.sort((a, b) => startedMs(b.latest) - startedMs(a.latest));
}

const EXCERPT_MAX_CHARS = 140;

/**
 * One-line excerpt of a run's output: the last non-empty stdout line (scripts
 * conventionally end with their summary), else the error message, else the
 * last non-empty stderr line. Empty string when the run produced nothing.
 */
export function outputExcerpt(item: GroupableExecution): string {
  const lastLine = (text?: string) => {
    if (!text) return '';
    const lines = text.replace(/\\r\\n|\\n/g, '\n').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? '';
  };
  const raw = lastLine(item.stdout) || item.errorMessage?.trim() || lastLine(item.stderr);
  if (raw.length <= EXCERPT_MAX_CHARS) return raw;
  return `${raw.slice(0, EXCERPT_MAX_CHARS - 1)}…`;
}
