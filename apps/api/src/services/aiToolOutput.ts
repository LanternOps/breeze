import { redactLogFields, redactLogMessage } from './logRedaction';
import { scrubErrorFieldsDeep } from './aiToolErrors';

type CompactStats = {
  stringsTruncated: number;
  arraysTruncated: number;
  arrayItemsDropped: number;
  objectsTruncated: number;
  objectKeysDropped: number;
  depthLimited: number;
  sensitiveFieldsOmitted: number;
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

const MAX_TOOL_RESULT_CHARS = 8_000;
const RAW_PREVIEW_CHARS = 2_000;
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

function truncateText(value: string, maxChars: number, stats: CompactStats): string {
  if (value.length <= maxChars) return value;
  stats.stringsTruncated += 1;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
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
    if (value.length > config.maxArrayItems) {
      stats.arraysTruncated += 1;
      stats.arrayItemsDropped += value.length - config.maxArrayItems;
    }
    return value
      .slice(0, config.maxArrayItems)
      .map((item) => compactValue(item, stats, config, depth + 1));
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > config.maxObjectKeys) {
      stats.objectsTruncated += 1;
      stats.objectKeysDropped += entries.length - config.maxObjectKeys;
    }

    const output: Record<string, unknown> = {};
    for (const [key, itemValue] of entries.slice(0, config.maxObjectKeys)) {
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
 */
const COMMAND_PAGING_NOTE =
  'Output was compacted to fit the chat budget. To fetch the rest, page or filter via payload: ' +
  'list_processes and event_logs_query accept { page, limit (max 500), search/filter fields }; ' +
  'file_list accepts { path, limit (max 5000) } — use a narrower path or a follow-up page instead of repeating the same call.';

function compactCommandStylePayload(payload: Record<string, unknown>, stats: CompactStats): Record<string, unknown> {
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
      const compactedStdout = compactValue(parsedStdout, stdoutStats, {
        ...DEFAULT_CONFIG,
        maxArrayItems: 50,
      });
      output.stdout = compactedStdout;
      output.stdoutChars = payload.stdout.length;
      if (statsShowTruncation(stdoutStats)) {
        output.stdoutTruncation = {
          itemsDropped: stdoutStats.arrayItemsDropped,
          note: COMMAND_PAGING_NOTE,
        };
      }
      mergeStats(stats, stdoutStats);
    } else {
      output.stdout = truncateText(redactAiToolOutputText(payload.stdout), STDOUT_TEXT_CHARS, stats);
      output.stdoutChars = payload.stdout.length;
    }
  }

  if (typeof payload.stderr === 'string') {
    output.stderr = truncateText(redactAiToolOutputText(payload.stderr), STDERR_TEXT_CHARS, stats);
    output.stderrChars = payload.stderr.length;
  }

  if (payload.data !== undefined) {
    output.data = compactValue(payload.data, stats, {
      ...DEFAULT_CONFIG,
      maxArrayItems: 40,
      maxObjectKeys: 40,
      maxStringChars: 1_000,
    });
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
    output[key] = sanitizeToolPayloadValue(toolName, entry, stats, depth + 1, key);
  }
  return output;
}

function applyToolSpecificCompaction(
  toolName: string,
  parsed: unknown,
  stats: CompactStats
): unknown {
  if (!isRecord(parsed)) return parsed;

  if (toolName === 'analyze_disk_usage') {
    return compactDiskUsagePayload(parsed, stats);
  }

  if (toolName === 'disk_cleanup') {
    return compactDiskCleanupPayload(parsed, stats);
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
    return compactCommandStylePayload(parsed, stats);
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

  const meta = {
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

export function compactToolResultForChat(toolName: string, rawResult: string): string {
  const parsed = tryParseJson(rawResult);
  if (parsed === null) {
    // Non-JSON output is raw tool payload (command stdout, file contents, log
    // text) — NOT error text. It is deliberately not error-scrubbed here: the
    // #2603 scrub is keyed on error-ish JSON fields, and applying it to free
    // text would wipe legitimate output that merely looks query-shaped.
    // Thrown errors never reach this branch; they are wrapped in
    // JSON.stringify({ error }) by sanitizeThrownToolError at the call sites.
    const redactedRaw = redactAiToolOutputText(rawResult);
    if (redactedRaw.length <= MAX_TOOL_RESULT_CHARS) {
      return redactedRaw;
    }
    return JSON.stringify({
      _chat: {
        outputCompacted: true,
        nonJsonOutput: true,
        originalChars: rawResult.length,
      },
      preview: redactedRaw.slice(0, RAW_PREVIEW_CHARS),
    });
  }

  const stats = emptyStats();

  // Scrub driver/runtime detail out of error-ish fields BEFORE compaction, so it
  // cannot survive into a truncated `preview` further down (#2603). This is the
  // single chokepoint every aiTools*.ts result passes through, which is why the
  // fix does not need a catch-block edit in each of the ~19 leaking handlers.
  const errorScrubbed = scrubErrorFieldsDeep(parsed);

  const minimized = sanitizeToolPayloadValue(toolName, errorScrubbed, stats);
  const redacted = redactLogFields(minimized);
  const sanitized = sanitizeToolPayloadValue(toolName, redacted, stats);
  const toolSpecific = applyToolSpecificCompaction(toolName, sanitized, stats);
  const compacted = compactValue(toolSpecific, stats, DEFAULT_CONFIG);
  const withMeta = appendChatMeta(compacted, stats, rawResult.length);
  let serialized = safeStringify(withMeta);

  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return serialized;
  }

  const secondaryStats = emptyStats();

  const aggressivelyCompacted = compactValue(toolSpecific, secondaryStats, {
    maxStringChars: 700,
    maxArrayItems: 20,
    maxObjectKeys: 20,
    maxDepth: 4,
    maxStdoutChars: 2_000,
  });
  const aggressiveWithMeta = appendChatMeta(aggressivelyCompacted, secondaryStats, rawResult.length);
  serialized = safeStringify(aggressiveWithMeta);

  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return serialized;
  }

  return JSON.stringify({
    _chat: {
      outputCompacted: true,
      originalChars: rawResult.length,
      reason: 'max_output_chars_exceeded',
    },
    summary: {
      toolName,
      keys: isRecord(parsed) ? Object.keys(parsed).slice(0, 20) : [],
    },
    preview: serialized.slice(0, RAW_PREVIEW_CHARS),
  });
}
