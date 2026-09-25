import { redactLogFields, redactLogMessage, redactToolOutputFields } from './logRedaction';
import { scrubErrorFieldsDeep } from './aiToolErrors';

type CompactStats = {
  stringsTruncated: number;
  arraysTruncated: number;
  arrayItemsDropped: number;
  objectsTruncated: number;
  objectKeysDropped: number;
  depthLimited: number;
  sensitiveFieldsOmitted: number;
  /** A-W05 (D12): the guidance text for THIS tool's current paging shape. */
  sentinelHint: string;
};

type CompactConfig = {
  maxStringChars: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxDepth: number;
  /**
   * Char budget for `stdout` string leaves specifically. Command output is the
   * payload the model is actually after (file listings, process lists), so it
   * gets a larger budget than generic string leaves — the old shared 1.5–2K cap
   * cut structured listings mid-JSON at ~2KB with no way to recover (#3093).
   */
  maxStdoutChars: number;
};

const DEFAULT_CONFIG: CompactConfig = {
  maxStringChars: 1_500,
  maxArrayItems: 60,
  maxObjectKeys: 60,
  maxDepth: 6,
  maxStdoutChars: 6_000,
};

/**
 * Progressively tighter budgets tried in order until the serialized result
 * fits MAX_TOOL_RESULT_CHARS. The final tier exists so structured command
 * output with long string items (event-log messages, service descriptions)
 * still lands as VALID JSON with its envelope and truncation marker intact —
 * without it those payloads fell through to the mid-string `preview` slice,
 * which is exactly the #3093 failure mode.
 */
const COMPACTION_TIERS: CompactConfig[] = [
  DEFAULT_CONFIG,
  { maxStringChars: 700, maxArrayItems: 20, maxObjectKeys: 20, maxDepth: 4, maxStdoutChars: 2_000 },
  { maxStringChars: 300, maxArrayItems: 10, maxObjectKeys: 15, maxDepth: 4, maxStdoutChars: 1_000 },
];

/**
 * The single chat-context budget for one tool result. EXPORTED because the
 * artifact capture hook (services/artifacts/toolResultCapture.ts) must fire on
 * exactly this threshold: a duplicated literal would drift the first time this
 * is tuned, and the capture would then either never fire or fire on results
 * that still fit.
 */
export const MAX_TOOL_RESULT_CHARS = 8_000;
const RAW_PREVIEW_CHARS = 2_000;

/**
 * A-W05 (Q3/fix 4): shrinks `text` in whole Unicode CODE POINTS (never
 * splitting a surrogate pair) until `JSON.stringify(text).length` — what the
 * window actually costs once escaped and quoted in the tool's response — is
 * at most `budgetChars`. A window sized purely by raw character count can
 * still be escape-heavy (control characters, backslashes cost up to 6x their
 * raw count once escaped) and blow the overall compaction budget, which
 * replaces the whole result with a digest and silently drops text the
 * caller was told (via its `nextOffset`/`stdoutNextOffset` sibling) it could
 * read. Each removed code point drops the escaped length by at least 1, so
 * this always terminates.
 */
export function shrinkToJsonBudget(text: string, budgetChars: number): string {
  let chars = Array.from(text);
  let escapedLength = JSON.stringify(chars.join('')).length;
  while (chars.length > 0 && escapedLength > budgetChars) {
    const overshoot = escapedLength - budgetChars;
    chars = chars.slice(0, Math.max(0, chars.length - overshoot));
    escapedLength = JSON.stringify(chars.join('')).length;
  }
  return chars.join('');
}
const STDOUT_TEXT_CHARS = 6_000;
const STDERR_TEXT_CHARS = 1_200;
const MAX_DISK_CANDIDATES = 60;
const MAX_DISK_LIST_ROWS = 30;
const REDACTED = '[REDACTED]';

const BARE_SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const TRUNCATION_MARKER_RE = /\n\.\.\.\[truncated (\d+) chars\]$/;

/**
 * Truncate a string leaf, appending an explicit `[truncated N chars]` marker.
 *
 * Idempotent across compaction passes: a string this function already cut
 * carries the marker, and a later pass with the same or a larger budget must
 * NOT re-truncate the (base + marker) result — that used to replace an honest
 * `[truncated 1500 chars]` with a false `[truncated 26 chars]` (the marker's
 * own overhang) and double-count stringsTruncated. When a tighter pass does
 * cut further, the reported count is cumulative from the original string.
 */
function truncateText(value: string, maxChars: number, stats: CompactStats): string {
  const marker = value.match(TRUNCATION_MARKER_RE);
  const priorOmitted = marker ? Number(marker[1]) : 0;
  const base = marker ? value.slice(0, marker.index) : value;
  if (base.length <= maxChars) return value;
  stats.stringsTruncated += 1;
  const omitted = base.length - maxChars + priorOmitted;
  return `${base.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

// A-W05 (D12): the guidance appended to a truncated ARRAY must be something the
// tool can honour. The hub injects the resolver (setToolPaginationHintResolver)
// so this module never imports the registry — importing aiToolNames here would
// pull the extension registry (Hono + Ajv) into every worker that imports this
// file for MAX_TOOL_RESULT_CHARS (#4086, workerEntrypointClosure contract) and
// would read an EMPTY map in any process that loads the compactor without the hub.
export type ToolPaginationHint = 'cursor' | 'limit' | 'none';
export const SENTINEL_HINTS: Readonly<Record<ToolPaginationHint, string>> = {
  cursor: 'Call again with the nextCursor value',
  limit: 'Pass a smaller limit or add filters',
  none: 'Narrow the query with filters',
};
const LEGACY_SENTINEL_HINT = 'Use pagination or the REST API';
let paginationHintResolver: (toolName: string) => ToolPaginationHint = () => 'none';
export function setToolPaginationHintResolver(resolver: (toolName: string) => ToolPaginationHint): void {
  paginationHintResolver = resolver;
}
// Q8: the resolver is injected by the tool hub and must never crash the
// compactor — a hub that has not installed a resolver yet (or one whose
// resolver throws) degrades to 'none' rather than losing the tool result.
function resolvePaginationHint(toolName: string): ToolPaginationHint {
  try {
    return paginationHintResolver(toolName);
  } catch {
    return 'none';
  }
}
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// #3521: the in-band marker appended to a truncated ARRAY, mirroring the string
// `[truncated N chars]` marker. The ANCHORED regex matches only our exact
// canonical marker, so a re-compaction pass recognizes its own marker (staying
// idempotent) without misclassifying a legitimate trailing string that merely
// begins similarly. Accepts every hint text ever emitted, including the
// pre-A-W05 legacy one, so already-persisted payloads still round-trip.
const ARRAY_SENTINEL_RE = new RegExp(
  `^\\.\\.\\.\\[truncated: (\\d+) more items omitted\\. (?:${[LEGACY_SENTINEL_HINT, ...Object.values(SENTINEL_HINTS)].map(escapeForRegExp).join('|')})\\]$`,
);

function arrayTruncationSentinel(dropped: number, hint: string): string {
  return `...[truncated: ${dropped} more items omitted. ${hint}]`;
}

/**
 * A-W05 (Q3): a character window a tool sized deliberately — `text` paired
 * with `nextOffset`/`hasMore` (e.g. `read_artifact`), or `stdout`/`stderr`
 * paired with `stdoutNextOffset`/`stderrNextOffset` (e.g.
 * `get_script_execution`) — is already a bounded chunk. Generic string/array
 * compaction must never re-cut it: a mid-window truncation would silently
 * drop text the tool told the model it could read at `nextOffset`, and the
 * model would never know to re-request it. Recognised structurally by the
 * sibling key, not by tool name, so it applies to every current and future
 * window-shaped tool without a name list here.
 */
const WINDOW_SIBLING_KEY: Readonly<Record<string, string>> = {
  text: 'nextOffset',
  stdout: 'stdoutNextOffset',
  stderr: 'stderrNextOffset',
};

function isCharacterWindowField(key: string, container: Record<string, unknown>): boolean {
  const sibling = WINDOW_SIBLING_KEY[key];
  return sibling !== undefined && sibling in container;
}

// Prior omitted count if `value` is exactly our marker, else null. Used to carry
// the count forward across a tighter re-compaction (mirrors truncateText's
// priorOmitted), so the marker reports the TOTAL omitted from the original input.
function priorArrayOmitted(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ARRAY_SENTINEL_RE.exec(value);
  return match ? Number(match[1]) : null;
}

export function redactAiToolOutputText(value: string): string {
  return BARE_SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED),
    redactLogMessage(value),
  );
}

/**
 * Deep-redact known-sensitive keys from a tool-call INPUT before it is persisted
 * to `ai_messages.tool_input` (SR5-16).
 *
 * Tool schemas invite plaintext secrets — e.g. `manage_backup_configs`
 * `providerConfig.accessKey` / `secretKey` — and the streaming manager persists
 * `block.input` UNCONDITIONALLY, even for a call the user later denies. That put
 * cleartext credentials in the transcript, readable by anyone who could load the
 * session. This is the single chokepoint that keeps them out: it runs
 * `redactLogFields` (the shared deep key-based redactor — masks values for keys
 * matching password/token/secret/*key/clientSecret/connectionString/… and also
 * scrubs inline `key=value` secrets in string leaves) over EVERY tool's input as
 * defense-in-depth, rather than relying on per-tool allow/deny lists.
 */
export function redactSensitiveToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactLogFields(input);
  return isRecord(redacted) ? redacted : {};
}

/**
 * Read-side companion for historical JSONB rows. Unlike the write-side helper,
 * this preserves null/array/scalar legacy shapes while applying the same deep
 * key and inline-secret redaction before an admin response is serialized.
 */
export function redactPersistedToolInput(input: unknown): unknown {
  return redactLogFields(input);
}

function clampInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultValue;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function compactValue(
  value: unknown,
  stats: CompactStats,
  config: CompactConfig,
  depth = 0,
  keyHint = ''
): unknown {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    // stdout carries the command output the model asked for — give it the
    // dedicated (larger) budget instead of the generic leaf cap (#3093).
    const maxChars = keyHint === 'stdout' ? config.maxStdoutChars : config.maxStringChars;
    return truncateText(value, maxChars, stats);
  }

  if (depth >= config.maxDepth) {
    stats.depthLimited += 1;
    return '[truncated: max depth reached]';
  }

  if (Array.isArray(value)) {
    // #3521: a truncated array used to be `.slice()`d with only a buried
    // `_chat.arrayItemsDropped` stat — the array itself reads as a complete,
    // plausible list, so it silently misrepresents state. Append an in-band
    // marker element (mirroring the string `...[truncated N chars]` marker) at
    // the point of loss. It is a JSON string, so the array stays valid JSON.
    //
    // Idempotence: if this array already carries our marker (e.g. output that is
    // ever re-compacted), strip it first so the synthetic element is not counted
    // as a real item nor re-truncated in place; re-emit or refresh it below.
    const priorOmitted = value.length > 0 ? priorArrayOmitted(value[value.length - 1]) : null;
    const items = priorOmitted !== null ? value.slice(0, -1) : value;
    const compacted = items
      .slice(0, config.maxArrayItems)
      .map((item) => compactValue(item, stats, config, depth + 1));
    const droppedThisPass = items.length - config.maxArrayItems;
    if (droppedThisPass > 0) {
      stats.arraysTruncated += 1;
      stats.arrayItemsDropped += droppedThisPass;
      // Marker reports the CUMULATIVE omission from the original input, so a
      // tighter re-compaction of already-marked output doesn't understate it.
      compacted.push(arrayTruncationSentinel((priorOmitted ?? 0) + droppedThisPass, stats.sentinelHint));
    } else if (priorOmitted !== null) {
      // Already-truncated upstream and still fits — preserve the existing count
      // rather than silently dropping the "more omitted" signal.
      compacted.push(arrayTruncationSentinel(priorOmitted, stats.sentinelHint));
    }
    return compacted;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > config.maxObjectKeys) {
      stats.objectsTruncated += 1;
      stats.objectKeysDropped += entries.length - config.maxObjectKeys;
    }

    const output: Record<string, unknown> = {};
    for (const [key, itemValue] of entries.slice(0, config.maxObjectKeys)) {
      // Q3: a character window the tool sized deliberately — pass through
      // untouched rather than re-truncating it against the generic string cap.
      if (typeof itemValue === 'string' && isCharacterWindowField(key, value)) {
        output[key] = itemValue;
        continue;
      }
      output[key] = compactValue(itemValue, stats, config, depth + 1, key);
    }
    return output;
  }

  return String(value);
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pruneLargeList(value: unknown, maxItems: number): { items: unknown[]; dropped: number } {
  const rows = asArray(value);
  if (rows.length <= maxItems) return { items: rows, dropped: 0 };
  return { items: rows.slice(0, maxItems), dropped: rows.length - maxItems };
}

function compactDiskUsagePayload(payload: Record<string, unknown>, stats: CompactStats): Record<string, unknown> {
  const output = { ...payload };

  const snapshot = isRecord(output.snapshot) ? { ...output.snapshot } : null;
  if (snapshot) {
    for (const key of [
      'topLargestFiles',
      'topLargestDirectories',
      'oldDownloads',
      'unrotatedLogs',
      'trashUsage',
      'duplicateCandidates',
      'errors',
    ]) {
      const { items, dropped } = pruneLargeList(snapshot[key], MAX_DISK_LIST_ROWS);
      snapshot[key] = items;
      if (dropped > 0) {
        stats.arraysTruncated += 1;
        stats.arrayItemsDropped += dropped;
      }
    }
    output.snapshot = snapshot;
  }

  const cleanupPreview = isRecord(output.cleanupPreview) ? { ...output.cleanupPreview } : null;
  if (cleanupPreview) {
    const candidates = asArray(cleanupPreview.candidates ?? cleanupPreview.topCandidates);
    const limit = clampInteger(
      cleanupPreview.maxCandidates,
      MAX_DISK_CANDIDATES,
      1,
      200
    );
    const { items, dropped } = pruneLargeList(candidates, limit);

    cleanupPreview.topCandidates = items;
    cleanupPreview.candidates = items;
    cleanupPreview.returnedCandidateCount = items.length;
    cleanupPreview.totalCandidateCount = clampInteger(
      cleanupPreview.candidateCount ?? candidates.length,
      candidates.length,
      0,
      Number.MAX_SAFE_INTEGER
    );
    cleanupPreview.truncatedCandidateCount = Math.max(0, dropped);
    delete cleanupPreview.maxCandidates;

    if (dropped > 0) {
      stats.arraysTruncated += 1;
      stats.arrayItemsDropped += dropped;
    }
    output.cleanupPreview = cleanupPreview;
  }

  return output;
}

function compactDiskCleanupPayload(payload: Record<string, unknown>, stats: CompactStats): Record<string, unknown> {
  const output = { ...payload };
  const candidates = asArray(output.candidates);
  if (candidates.length === 0) return output;

  const limit = clampInteger(output.maxCandidates, MAX_DISK_CANDIDATES, 1, 200);
  const { items, dropped } = pruneLargeList(candidates, limit);

  output.candidates = items;
  output.returnedCandidateCount = items.length;
  output.totalCandidateCount = clampInteger(
    output.candidateCount ?? candidates.length,
    candidates.length,
    0,
    Number.MAX_SAFE_INTEGER
  );
  output.truncatedCandidateCount = Math.max(0, dropped);
  delete output.maxCandidates;

  if (dropped > 0) {
    stats.arraysTruncated += 1;
    stats.arrayItemsDropped += dropped;
  }

  return output;
}

function mergeStats(target: CompactStats, source: CompactStats): void {
  target.stringsTruncated += source.stringsTruncated;
  target.arraysTruncated += source.arraysTruncated;
  target.arrayItemsDropped += source.arrayItemsDropped;
  target.objectsTruncated += source.objectsTruncated;
  target.objectKeysDropped += source.objectKeysDropped;
  target.depthLimited += source.depthLimited;
  target.sensitiveFieldsOmitted += source.sensitiveFieldsOmitted;
}

function statsShowTruncation(stats: CompactStats): boolean {
  return (
    stats.stringsTruncated > 0 ||
    stats.arraysTruncated > 0 ||
    stats.objectsTruncated > 0 ||
    stats.depthLimited > 0
  );
}

/**
 * Guidance appended to compacted command output so the model can actually
 * recover the rest instead of re-issuing blind variants of the same command
 * (#3093 — each retry costs a fresh approval, compounding approval fatigue).
 *
 * Both notes must stay under the tightest tier's maxStringChars (300) or the
 * final compaction pass will cut the guidance itself. Parameter claims are
 * verified against the agent handlers (processes.go, eventlogs.go, fileops.go):
 * event_logs_query has NO search param and its page is hard-capped at 20;
 * file_list has no paging at all — only path + limit.
 */
const COMMAND_PAGING_NOTE =
  'Output compacted to fit chat budget. Page/filter via payload: ' +
  'list_processes {page, limit<=500, search, sortBy}; ' +
  'event_logs_query {page<=20, limit<=500, logName, level, source, eventId}; ' +
  'file_list: no paging - narrow path or raise limit (<=5000).';

const COMMAND_TEXT_TRUNCATION_NOTE =
  'Long text fields were shortened (see [truncated N chars] markers). ' +
  'Paging will not recover them; issue a narrower command instead ' +
  '(e.g. file_read a specific file, or event_logs_query filtered by eventId/source).';

// Keys this function already curates explicitly — everything else on a
// command-shaped payload is passed through by the loop at the bottom (Q3),
// so a future window tool's `stdoutNextOffset`/`stdoutHasMore`/`stderrTruncated`
// siblings are never silently dropped just because this allowlist predates them.
const COMMAND_STYLE_HANDLED_KEYS = new Set([
  'status', 'exitCode', 'durationMs', 'error', 'stdout', 'stdoutChars', 'stderr', 'stderrChars', 'data',
]);

function compactCommandStylePayload(
  payload: Record<string, unknown>,
  stats: CompactStats,
  config: CompactConfig,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ['status', 'exitCode', 'durationMs', 'error']) {
    if (payload[key] !== undefined) output[key] = payload[key];
  }

  if (typeof payload.stdout === 'string') {
    // Structured commands (list_processes, file_list, event logs, services…)
    // return their whole response as JSON in `stdout`. Blind char-truncation
    // used to cut that JSON mid-string at ~2KB, destroying the trailing
    // envelope fields (total/page/truncated) the model needed to page (#3093).
    // Compact it structurally instead: keep the envelope, drop excess list
    // items, and report exactly what was dropped plus how to fetch more.
    const parsedStdout = tryParseJson(payload.stdout);
    if (parsedStdout !== null && typeof parsedStdout === 'object') {
      const stdoutStats = emptyStats();
      // The key-based redactor ran while stdout was still a string leaf, where
      // its assignment regex cannot match JSON's `"password":"x"` syntax. The
      // parsed structure is the first (and only) place key-based redaction can
      // see these fields — without this, credentials in structured command
      // output (service configs, env dumps) reach the model and the persisted
      // transcript verbatim.
      const redactedStdout = redactToolOutputFields(parsedStdout, redactAiToolOutputText);
      const compactedStdout = compactValue(redactedStdout, stdoutStats, {
        ...config,
        maxArrayItems: Math.min(config.maxArrayItems, 50),
      });
      output.stdout = compactedStdout;
      output.stdoutChars = payload.stdout.length;
      if (stdoutStats.arrayItemsDropped > 0) {
        // Items were dropped from a list — paging/filtering can recover them.
        output.stdoutTruncation = {
          itemsDropped: stdoutStats.arrayItemsDropped,
          note: COMMAND_PAGING_NOTE,
        };
      } else if (statsShowTruncation(stdoutStats)) {
        // Only string/depth cuts — paging would re-fetch the same shortened
        // fields and burn an approval for nothing; steer to narrower commands.
        output.stdoutTruncation = {
          itemsDropped: 0,
          note: COMMAND_TEXT_TRUNCATION_NOTE,
        };
      }
      mergeStats(stats, stdoutStats);
    } else if (isCharacterWindowField('stdout', payload)) {
      // Q3: the tool already sized this window (e.g. get_script_execution's
      // stdoutOffset/stdoutMaxChars) — never re-truncate it against the
      // generic stdout budget, or nextOffset would skip text the model
      // never actually saw.
      output.stdout = redactAiToolOutputText(payload.stdout);
      output.stdoutChars = payload.stdout.length;
    } else {
      output.stdout = truncateText(redactAiToolOutputText(payload.stdout), config.maxStdoutChars, stats);
      output.stdoutChars = payload.stdout.length;
    }
  }

  if (typeof payload.stderr === 'string') {
    if (isCharacterWindowField('stderr', payload)) {
      output.stderr = redactAiToolOutputText(payload.stderr);
    } else {
      output.stderr = truncateText(
        redactAiToolOutputText(payload.stderr),
        Math.min(STDERR_TEXT_CHARS, config.maxStdoutChars),
        stats,
      );
    }
    output.stderrChars = payload.stderr.length;
  }

  if (payload.data !== undefined) {
    output.data = compactValue(payload.data, stats, {
      ...config,
      maxArrayItems: Math.min(config.maxArrayItems, 40),
      maxObjectKeys: Math.min(config.maxObjectKeys, 40),
      maxStringChars: Math.min(config.maxStringChars, 1_000),
    });
  }

  for (const [key, value] of Object.entries(payload)) {
    if (COMMAND_STYLE_HANDLED_KEYS.has(key)) continue;
    if (typeof value === 'string' && isCharacterWindowField(key, payload)) {
      output[key] = redactAiToolOutputText(value);
      continue;
    }
    output[key] = compactValue(value, stats, config, 0, key);
  }

  return output;
}

function emptyStats(): CompactStats {
  return {
    stringsTruncated: 0,
    arraysTruncated: 0,
    arrayItemsDropped: 0,
    objectsTruncated: 0,
    objectKeysDropped: 0,
    depthLimited: 0,
    sensitiveFieldsOmitted: 0,
    sentinelHint: SENTINEL_HINTS.none,
  };
}

function looksLikeScriptBody(value: string): boolean {
  if (value.length >= 300) return true;
  return /(^#!|\bfunction\b|\bparam\s*\(|\bWrite-Host\b|\bInvoke-|\bGet-|\bSet-|\$\w+|\bsudo\b|\bapt-get\b|\bNew-Object\b)/i.test(value);
}

function shouldOmitScriptText(toolName: string, key: string, value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const normalizedKey = key.replace(/[_-]/g, '').toLowerCase();
  const scriptTool = /script/i.test(toolName);

  if (normalizedKey === 'scriptcontent' || normalizedKey === 'scriptbody') return true;
  if (toolName === 'get_script_details' && normalizedKey === 'content') return true;
  if (toolName === 'apply_script_code' && normalizedKey === 'code') return true;
  if (scriptTool && ['content', 'code', 'source'].includes(normalizedKey) && looksLikeScriptBody(value)) return true;

  return false;
}

function sanitizeToolPayloadValue(
  toolName: string,
  value: unknown,
  stats: CompactStats,
  depth = 0,
  keyHint = '',
): unknown {
  if (typeof value === 'string') {
    const redacted = redactAiToolOutputText(value);
    if (['stdout', 'stderr'].includes(keyHint.toLowerCase())) {
      // JSON stdout is structured command output — leave it whole here so
      // compactCommandStylePayload can compact it structurally instead of
      // cutting the JSON mid-string (#3093). It stays bounded either way:
      // the compaction pipeline's compactValue pass caps stdout leaves at
      // maxStdoutChars and the overall result at MAX_TOOL_RESULT_CHARS.
      if (keyHint.toLowerCase() === 'stdout') {
        const parsed = tryParseJson(redacted);
        if (parsed !== null && typeof parsed === 'object') return redacted;
        return truncateText(redacted, STDOUT_TEXT_CHARS, stats);
      }
      return truncateText(redacted, STDERR_TEXT_CHARS, stats);
    }
    return redacted;
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= DEFAULT_CONFIG.maxDepth + 2) {
    stats.depthLimited += 1;
    return '[truncated: max depth reached]';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeToolPayloadValue(toolName, entry, stats, depth + 1));
  }

  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (shouldOmitScriptText(toolName, key, entry)) {
      output[`${key}Omitted`] = true;
      output[`${key}Chars`] = entry.length;
      stats.sensitiveFieldsOmitted += 1;
      continue;
    }
    // Q3: a character window the tool sized deliberately — redact but never
    // truncate it in this pre-pass (compactCommandStylePayload / compactValue
    // apply the same rule for the shaping pass that follows).
    if (typeof entry === 'string' && isCharacterWindowField(key, value)) {
      output[key] = redactAiToolOutputText(entry);
      continue;
    }
    output[key] = sanitizeToolPayloadValue(toolName, entry, stats, depth + 1, key);
  }
  return output;
}

const MAX_SYSTEM_CLEANUP_ACTIONS = 40;
const MAX_SYSTEM_CLEANUP_OUTPUT_TAIL = 2_000;

/**
 * `system_cleanup` has two result shapes behind one tool name: the `list`
 * catalog (`{ catalog: { actions: [...] } }`) and the `run` report
 * (`{ actions: [{ outputTail }], volumes, freedBytes }`). Both are pruned here;
 * the numbers an answer is actually built from — freedBytes, status, exitCode,
 * estimates — are never dropped, only the prose is.
 */
function compactSystemCleanupPayload(payload: Record<string, unknown>, stats: CompactStats): Record<string, unknown> {
  const output = { ...payload };

  const catalog = isRecord(output.catalog) ? { ...output.catalog } : null;
  if (catalog) {
    const actions = asArray(catalog.actions);
    const { items, dropped } = pruneLargeList(actions, MAX_SYSTEM_CLEANUP_ACTIONS);
    catalog.actions = items;
    catalog.returnedActionCount = items.length;
    catalog.totalActionCount = actions.length;
    catalog.truncatedActionCount = Math.max(0, dropped);
    if (dropped > 0) {
      stats.arraysTruncated += 1;
      stats.arrayItemsDropped += dropped;
    }
    output.catalog = catalog;
  }

  const runActions = asArray(output.actions);
  if (runActions.length > 0) {
    output.actions = runActions.map((entry) => {
      if (!isRecord(entry)) return entry;
      const tail = entry.outputTail;
      if (typeof tail !== 'string' || tail.length <= MAX_SYSTEM_CLEANUP_OUTPUT_TAIL) return entry;
      // Q8: this is a per-row STRING tail truncation, not an array-item drop —
      // no items left the `actions` array. Counting it as arrayItemsDropped
      // would make the compactor tell the model to page/narrow-filter for a
      // shortened field paging can never recover, so it is tracked as a
      // string truncation instead (the same bucket `truncateText` uses).
      stats.stringsTruncated += 1;
      return {
        ...entry,
        outputTail: tail.slice(-MAX_SYSTEM_CLEANUP_OUTPUT_TAIL),
        outputTailTruncated: true,
      };
    });
  }

  return output;
}

function applyToolSpecificCompaction(
  toolName: string,
  parsed: unknown,
  stats: CompactStats,
  config: CompactConfig
): unknown {
  if (!isRecord(parsed)) return parsed;

  if (toolName === 'analyze_disk_usage') {
    return compactDiskUsagePayload(parsed, stats);
  }

  if (toolName === 'disk_cleanup') {
    return compactDiskCleanupPayload(parsed, stats);
  }

  if (toolName === 'system_cleanup') {
    return compactSystemCleanupPayload(parsed, stats);
  }

  const looksLikeCommandResult = (
    'status' in parsed &&
    (
      'stdout' in parsed ||
      'stderr' in parsed ||
      'data' in parsed ||
      'exitCode' in parsed
    )
  );

  if (looksLikeCommandResult) {
    return compactCommandStylePayload(parsed, stats, config);
  }

  // Fleet tools: compact large arrays in standard list/data responses
  const fleetListTools = [
    'manage_deployments', 'manage_patches',
    'manage_groups', 'manage_maintenance_windows', 'manage_automations',
    'manage_alert_rules', 'manage_service_monitors', 'generate_report',
    'list_configuration_policies', 'get_configuration_policy', 'configuration_policy_compliance',
    'query_monitors', 'manage_monitors', 'get_service_monitoring_status',
  ];
  if (fleetListTools.includes(toolName)) {
    return compactFleetPayload(parsed, stats);
  }

  return parsed;
}

function compactFleetPayload(payload: Record<string, unknown>, stats: CompactStats): Record<string, unknown> {
  const output = { ...payload };
  const listKeys = [
    'policies', 'deployments', 'patches', 'groups', 'windows',
    'automations', 'rules', 'channels', 'reports', 'runs',
    'devices', 'members', 'log', 'data', 'activeWindows',
    'history',
  ];
  for (const key of listKeys) {
    if (Array.isArray(output[key])) {
      const { items, dropped } = pruneLargeList(output[key], 40);
      output[key] = items;
      if (dropped > 0) {
        stats.arraysTruncated += 1;
        stats.arrayItemsDropped += dropped;
        output[`${key}Dropped`] = dropped;
      }
    }
  }
  return output;
}

function appendChatMeta(result: unknown, stats: CompactStats, originalChars: number): unknown {
  const hasTruncation = (
    stats.stringsTruncated > 0 ||
    stats.arraysTruncated > 0 ||
    stats.objectsTruncated > 0 ||
    stats.depthLimited > 0
    || stats.sensitiveFieldsOmitted > 0
  );
  if (!hasTruncation) return result;

  // A-W05 (D12/Q8): nextStep is guidance the model can act on by re-calling the
  // tool differently, so it only fires when real ARRAY ITEMS were dropped
  // (arraysTruncated / arrayItemsDropped) — never for a string-tail cut alone
  // (e.g. system_cleanup's outputTail), which paging or narrower filters
  // cannot recover.
  const hasArrayTruncation = stats.arraysTruncated > 0 || stats.arrayItemsDropped > 0;

  const meta: Record<string, unknown> = {
    outputCompacted: true,
    originalChars,
    stringsTruncated: stats.stringsTruncated,
    arraysTruncated: stats.arraysTruncated,
    arrayItemsDropped: stats.arrayItemsDropped,
    objectsTruncated: stats.objectsTruncated,
    objectKeysDropped: stats.objectKeysDropped,
    depthLimited: stats.depthLimited,
    sensitiveFieldsOmitted: stats.sensitiveFieldsOmitted,
  };
  if (hasArrayTruncation) {
    meta.nextStep = stats.sentinelHint;
  }

  if (isRecord(result)) {
    return { ...result, _chat: meta };
  }

  return { value: result, _chat: meta };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'Failed to serialize tool output for chat' });
  }
}

/**
 * Shrink a tool result to something a chat turn can carry, and mark it honestly.
 *
 * Three outcomes, and a programmatic consumer has to be able to tell them apart
 * (#3329 — a poller silently stored a digest as if it were a record):
 *
 * 1. **Result fits** — returned verbatim.
 * 2. **Result was compacted but the data survived** — the payload keeps its own
 *    shape (`logs`, `alerts`, …) and gains a `_chat` note describing what was
 *    trimmed. Rows are still there; keep reading them.
 * 3. **Result could not be made to fit** — the payload is REPLACED by a digest
 *    (`summary`/`preview`) that contains no rows at all.
 *
 * `summarized: true` is set on outcome 3 only, and is the supported way to
 * detect it. Do NOT branch on the presence of `_chat`: it is also present in
 * outcome 2, where the rows are intact and must be consumed — `manage_alerts`
 * in particular returns `_chat` right next to a real `alerts` array.
 */
/**
 * The shape `captureLargeToolResult` returns for an oversized result
 * (execution-plane spec §5.2): an opaque handle with raw previews, plus the
 * tool's own result, which is then compacted here exactly as it would have been
 * without the capture. Recognised STRUCTURALLY (handle + compacted string), not
 * by the presence of an `artifact` key, so a tool that legitimately returns
 * `{ artifact: … }` is untouched.
 */
// A-W05 (Task 0): when a payload cannot be made to fit and is replaced by the
// row-less digest below, the model loses the array it was reading — but it
// must NOT also lose the paging envelope, or it has no way to continue. These
// are the top-level SCALAR paging keys every shaped list/keyset tool emits
// (see aiToolPagination.ts's pageEnvelope/keysetEnvelope). Read from the
// already-redacted/sanitized payload so a key the redactor wiped stays wiped.
// Fix 4c: `nextOffset`/`stdoutNextOffset`/`stderrNextOffset`/`stdoutHasMore`
// are the continuation state for a character-window tool (read_artifact,
// get_script_execution) — without them, a digest that replaces the payload
// also strands the model with no way to resume the window it was reading.
const PAGING_ENVELOPE_KEYS = [
  'total', 'totalMode', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor', 'count',
  'nextOffset', 'stdoutNextOffset', 'stderrNextOffset', 'stdoutHasMore',
] as const;
function extractPagingEnvelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of PAGING_ENVELOPE_KEYS) {
    if (!(key in value)) continue;
    const v = (value as Record<string, unknown>)[key];
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v;
    }
  }
  return out;
}

function asCaptureEnvelope(value: unknown): { artifact: Record<string, unknown>; compacted: string } | null {
  if (!isRecord(value)) return null;
  const { artifact, compacted } = value as Record<string, unknown>;
  if (typeof compacted !== 'string') return null;
  if (!isRecord(artifact) || typeof artifact.handle !== 'string') return null;
  if (Object.keys(value).length !== 2) return null;
  return { artifact, compacted };
}

export function compactToolResultForChat(
  toolName: string,
  rawResult: string,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): string {
  const parsed = tryParseJson(rawResult);

  // Capture envelope: the artifact block is small, fixed and must survive
  // verbatim (it is the model's only route back to the bytes). Compact the
  // INNER payload with the remaining budget so `applyToolSpecificCompaction`
  // still sees the tool's native shape — keyed on `stdout`/`alerts`/… — rather
  // than `artifact`/`compacted`, and the model's view of the compacted half is
  // byte-identical to what it would have got with capture switched off.
  const envelope = asCaptureEnvelope(parsed);
  if (envelope) {
    const artifactJson = JSON.stringify({ artifact: envelope.artifact, compacted: '' });
    const innerBudget = Math.max(512, maxChars - artifactJson.length - 8);
    const inner = compactToolResultForChat(toolName, envelope.compacted, innerBudget);
    return safeStringify({ artifact: envelope.artifact, compacted: tryParseJson(inner) ?? inner });
  }

  if (parsed === null) {
    // Non-JSON output is raw tool payload (command stdout, file contents, log
    // text) — NOT error text. It is deliberately not error-scrubbed here: the
    // #2603 scrub is keyed on error-ish JSON fields, and applying it to free
    // text would wipe legitimate output that merely looks query-shaped.
    // Thrown errors never reach this branch; they are wrapped in
    // JSON.stringify({ error }) by sanitizeThrownToolError at the call sites.
    const redactedRaw = redactAiToolOutputText(rawResult);
    if (redactedRaw.length <= maxChars) {
      return redactedRaw;
    }
    return JSON.stringify({
      summarized: true,
      _chat: {
        outputCompacted: true,
        nonJsonOutput: true,
        originalChars: rawResult.length,
        nextStep: SENTINEL_HINTS[resolvePaginationHint(toolName)],
      },
      preview: redactedRaw.slice(0, RAW_PREVIEW_CHARS),
    });
  }

  const stats = emptyStats();
  // A-W05 (D12): resolved once per call — every tier's stats copy carries it
  // (object spread), so the sentinel and _chat.nextStep always agree.
  stats.sentinelHint = SENTINEL_HINTS[resolvePaginationHint(toolName)];

  // Scrub driver/runtime detail out of error-ish fields BEFORE compaction, so it
  // cannot survive into a truncated `preview` further down (#2603). This is the
  // single chokepoint every aiTools*.ts result passes through, which is why the
  // fix does not need a catch-block edit in each of the ~19 leaking handlers.
  const errorScrubbed = scrubErrorFieldsDeep(parsed);

  const minimized = sanitizeToolPayloadValue(toolName, errorScrubbed, stats);
  const redacted = redactToolOutputFields(minimized, redactAiToolOutputText);
  const sanitized = sanitizeToolPayloadValue(toolName, redacted, stats);

  // Try each tier from `sanitized`, not from the previous tier's output: a
  // tighter tier that re-compacted already-compacted data would report drop
  // counts relative to the prior tier (e.g. "30 dropped" when 180 of 200 are
  // gone) and leave `stdoutTruncation` stale. Recomputing from the sanitized
  // payload keeps the marker and counters accurate for whichever tier ships.
  const baseStats: CompactStats = { ...stats };
  let serialized = '';
  for (const tier of COMPACTION_TIERS) {
    const tierStats: CompactStats = { ...baseStats };
    const toolSpecific = applyToolSpecificCompaction(toolName, sanitized, tierStats, tier);
    const compacted = compactValue(toolSpecific, tierStats, tier);
    const withMeta = appendChatMeta(compacted, tierStats, rawResult.length);
    serialized = safeStringify(withMeta);
    if (serialized.length <= maxChars) {
      return serialized;
    }
  }

  return JSON.stringify({
    ...extractPagingEnvelope(sanitized),
    summarized: true,
    _chat: {
      outputCompacted: true,
      originalChars: rawResult.length,
      reason: 'max_output_chars_exceeded',
      nextStep: SENTINEL_HINTS[resolvePaginationHint(toolName)],
    },
    summary: {
      toolName,
      keys: isRecord(parsed) ? Object.keys(parsed).slice(0, 20) : [],
    },
    preview: serialized.slice(0, RAW_PREVIEW_CHARS),
  });
}
