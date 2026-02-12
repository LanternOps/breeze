type CompactStats = {
  stringsTruncated: number;
  arraysTruncated: number;
  arrayItemsDropped: number;
  objectsTruncated: number;
  objectKeysDropped: number;
  depthLimited: number;
};

type CompactConfig = {
  maxStringChars: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxDepth: number;
};

const DEFAULT_CONFIG: CompactConfig = {
  maxStringChars: 1_500,
  maxArrayItems: 60,
  maxObjectKeys: 60,
  maxDepth: 6,
};

const MAX_TOOL_RESULT_CHARS = 8_000;
const RAW_PREVIEW_CHARS = 2_000;
const MAX_DISK_CANDIDATES = 60;
const MAX_DISK_LIST_ROWS = 30;

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

function clampInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultValue;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function compactValue(
  value: unknown,
  stats: CompactStats,
  config: CompactConfig,
  depth = 0
): unknown {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateText(value, config.maxStringChars, stats);
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
      output[key] = compactValue(itemValue, stats, config, depth + 1);
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

function compactCommandStylePayload(payload: Record<string, unknown>, stats: CompactStats): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ['status', 'exitCode', 'durationMs', 'error']) {
    if (payload[key] !== undefined) output[key] = payload[key];
  }

  if (typeof payload.stdout === 'string') {
    output.stdout = truncateText(payload.stdout, 2_000, stats);
    output.stdoutChars = payload.stdout.length;
  }

  if (typeof payload.stderr === 'string') {
    output.stderr = truncateText(payload.stderr, 1_200, stats);
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

  return parsed;
}

function appendChatMeta(result: unknown, stats: CompactStats, originalChars: number): unknown {
  const hasTruncation = (
    stats.stringsTruncated > 0 ||
    stats.arraysTruncated > 0 ||
    stats.objectsTruncated > 0 ||
    stats.depthLimited > 0
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
  if (rawResult.length <= MAX_TOOL_RESULT_CHARS) {
    return rawResult;
  }

  const parsed = tryParseJson(rawResult);
  if (parsed === null) {
    return JSON.stringify({
      _chat: {
        outputCompacted: true,
        nonJsonOutput: true,
        originalChars: rawResult.length,
      },
      preview: rawResult.slice(0, RAW_PREVIEW_CHARS),
    });
  }

  const stats: CompactStats = {
    stringsTruncated: 0,
    arraysTruncated: 0,
    arrayItemsDropped: 0,
    objectsTruncated: 0,
    objectKeysDropped: 0,
    depthLimited: 0,
  };

  const toolSpecific = applyToolSpecificCompaction(toolName, parsed, stats);
  const compacted = compactValue(toolSpecific, stats, DEFAULT_CONFIG);
  const withMeta = appendChatMeta(compacted, stats, rawResult.length);
  let serialized = safeStringify(withMeta);

  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return serialized;
  }

  const secondaryStats: CompactStats = {
    stringsTruncated: 0,
    arraysTruncated: 0,
    arrayItemsDropped: 0,
    objectsTruncated: 0,
    objectKeysDropped: 0,
    depthLimited: 0,
  };

  const aggressivelyCompacted = compactValue(toolSpecific, secondaryStats, {
    maxStringChars: 700,
    maxArrayItems: 20,
    maxObjectKeys: 20,
    maxDepth: 4,
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
