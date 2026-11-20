import { z } from 'zod';
import {
  topologyDiagnosticCommandSchema,
  topologyDiagnosticResultSchema,
} from '@breeze/shared';

export type CriticalResultFamily =
  | 'restore'
  | 'verification'
  | 'vault'
  | 'dr'
  | 'topology_diagnostic';

export type GenericCommandResultEnvelope = {
  commandId: string;
  status: 'completed' | 'failed' | 'timeout';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  error?: string;
  result?: unknown;
};

export const CRITICAL_RESULT_STDOUT_MAX_BYTES = 1_048_576;
export const CRITICAL_RESULT_STDERR_MAX_BYTES = 262_144;
export const CRITICAL_RESULT_STRUCTURED_MAX_BYTES = 524_288;

const RESTORE_COMMAND_TYPES = new Set([
  'backup_restore',
  'vm_restore_from_backup',
  'vm_instant_boot',
  'bare_metal_rebuild',
]);

const DR_COMMAND_TYPES = new Set([
  'vm_restore_from_backup',
  'vm_instant_boot',
  'hyperv_restore',
  'mssql_restore',
  'bmr_recover',
]);

const VERIFICATION_COMMAND_TYPES = new Set(['backup_verify', 'backup_test_restore']);
const TOPOLOGY_DIAGNOSTIC_COMMAND_TYPES = new Set(['network_diagnostic']);
const VAULT_COMMAND_TYPES = new Set(['vault_sync']);

// Detail-list limits for restore / verification results. Mirrored by the agent
// (agent/internal/wire/critical_result_limits.go, pinned by a Go test that
// parses these declarations), which bounds its lists to them before sending.
// String limits count Unicode code points (zod 4), not bytes.
export const CRITICAL_RESULT_FAILED_FILES_MAX = 1000;
export const CRITICAL_RESULT_WARNINGS_MAX = 100;
export const CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS = 4096;
export const CRITICAL_RESULT_WARNING_TEXT_MAX_CHARS = 10_000;
export const CRITICAL_RESULT_ERROR_MAX_CHARS = 10_000;
// The largest raw body the server will parse and bound before applying the
// size caps: the general command_result cap (MAX_COMMAND_RESULT_BYTES in
// routes/agents/schemas.ts), which the transport schema already enforces. A
// larger body skips bounding and is rejected by the size check as before.
export const CRITICAL_RESULT_BOUNDING_MAX_BYTES = 5_000_000;

function truncateCodePoints(value: string, max: number): string {
  // UTF-16 length is never below the code-point count.
  if (value.length <= max) return value;
  // Walk at most max + 1 code points rather than spreading a string that may
  // be megabytes long into an array.
  let index = 0;
  let cutAt = 0;
  for (let count = 0; index < value.length; count++) {
    if (count === max - 1) cutAt = index;
    if (count === max) return value.slice(0, cutAt) + '…';
    index += value.codePointAt(index)! > 0xffff ? 2 : 1;
  }
  return value;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function omittedCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Bounds a restore / verification result's `failedFiles` and `warnings` lists
 * (and its `error` text) to the schema limits instead of letting one oversize
 * list reject the whole result, which loses its counts and status. Agents that
 * predate agent-side bounding send unbounded lists. The first entries are kept;
 * `failedFilesOmitted` / `warningsOmitted` record how many were dropped (added
 * to any count the agent already reported), and a final warning says so. Counts
 * such as `filesFailed` are never touched. A restricted-descriptor path list
 * is trimmed to its own limit (its count is authoritative).
 *
 * With `size`, the lists are then cut until JSON.stringify of the result fits
 * `size.maxBytes`. That work is linear in the input: one encode of the result
 * with its lists emptied, a per-entry upper-bound size estimate, and one encode
 * to confirm — never a re-encode of the whole body per pass. When the non-list
 * part alone is over the cap the lists are not cut (the size check rejects the
 * result as before). `size.encodedBytes`, the caller's measurement of the
 * input, lets an unchanged body that already fits skip the encodes entirely.
 *
 * Returns the input itself when nothing was over a limit.
 */
export function boundCriticalResultLists(
  value: unknown,
  size?: { maxBytes: number; encodedBytes: number },
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...input };
  let changed = false;

  const clean = (list: string[]): string[] => {
    const cleaned = list
      .filter((entry) => entry.length > 0)
      .map((entry) => truncateCodePoints(entry, CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS));
    if (cleaned.length !== list.length || cleaned.some((entry, i) => entry !== list[i])) changed = true;
    return cleaned;
  };
  // A numeric failedFiles (bmr_recover's count) is left alone.
  const failed = isStringList(input.failedFiles) ? clean(input.failedFiles) : null;
  const warnings = isStringList(input.warnings) ? clean(input.warnings) : null;
  for (const [key, max] of [
    ['warnings', CRITICAL_RESULT_WARNING_TEXT_MAX_CHARS],
    ['error', CRITICAL_RESULT_ERROR_MAX_CHARS],
  ] as const) {
    const text = input[key];
    if (typeof text === 'string') {
      const cut = truncateCodePoints(text, max);
      if (cut !== text) {
        out[key] = cut;
        changed = true;
      }
    }
  }

  // Only a list of strings is trimmed; anything else is left for the schema to
  // reject, as it always has.
  if (isStringList(input.securityDescriptorQuarantinedPaths)) {
    const list = input.securityDescriptorQuarantinedPaths;
    const trimmed = boundQuarantinedPaths(list) ?? [];
    if (trimmed.length !== list.length || trimmed.some((entry, i) => entry !== list[i])) {
      out.securityDescriptorQuarantinedPaths = trimmed;
      changed = true;
    }
  }

  const priorFailedOmitted = omittedCount(input.failedFilesOmitted);
  const priorWarningsOmitted = omittedCount(input.warningsOmitted);
  // The note rides a warnings list: the run's own, or a new one.
  const canNote = warnings !== null || input.warnings === undefined;
  let failedKeep = failed ? Math.min(failed.length, CRITICAL_RESULT_FAILED_FILES_MAX) : 0;
  let warnKeep = warnings ? Math.min(warnings.length, CRITICAL_RESULT_WARNINGS_MAX) : 0;
  const dropping = () =>
    (failed !== null && failedKeep < failed.length) || (warnings !== null && warnKeep < warnings.length);
  const reserveNoteSlot = () => {
    if (canNote && dropping()) warnKeep = Math.min(warnKeep, CRITICAL_RESULT_WARNINGS_MAX - 1);
  };
  const setOmitted = (key: string, n: number) => {
    if (n > 0) out[key] = n;
    else delete out[key];
  };
  const apply = () => {
    const failedOmitted = priorFailedOmitted + (failed ? failed.length - failedKeep : 0);
    const warningsOmitted = priorWarningsOmitted + (warnings ? warnings.length - warnKeep : 0);
    if (failed) {
      out.failedFiles = failed.slice(0, failedKeep);
      setOmitted('failedFilesOmitted', failedOmitted);
    }
    const note = canNote && dropping();
    if (warnings || note) {
      const kept = (warnings ?? []).slice(0, warnKeep);
      if (note) {
        kept.push(
          `${failedOmitted} more failed file(s) and ${warningsOmitted} more warning(s) not listed: ` +
            "the result exceeded the server's limits for detail lists; the file counts are complete"
        );
      }
      out.warnings = kept;
      setOmitted('warningsOmitted', warningsOmitted);
    }
  };

  reserveNoteSlot();
  if (dropping()) changed = true;
  if (!size || (!changed && size.encodedBytes <= size.maxBytes)) {
    if (changed) apply();
    return changed ? out : value;
  }

  // Size of everything but the list entries: the result with both lists
  // emptied, carrying the worst-case note and markers.
  const keptFailed = failedKeep;
  const keptWarnings = warnKeep;
  failedKeep = 0;
  warnKeep = 0;
  apply();
  const base = Buffer.byteLength(JSON.stringify(out), 'utf8');
  failedKeep = keptFailed;
  warnKeep = keptWarnings;
  if (base > size.maxBytes) {
    // Over the cap without any list entries: cutting them cannot help.
    if (changed) apply();
    return changed ? out : value;
  }

  const failedCosts = (failed ?? []).slice(0, failedKeep).map(encodedEntryBytesUpperBound);
  const warnCosts = (warnings ?? []).slice(0, warnKeep).map(encodedEntryBytesUpperBound);
  const total = (costs: number[]) => costs.reduce((sum, cost) => sum + cost, 0);
  const prefixWithin = (costs: number[], budget: number) => {
    let used = 0;
    let n = 0;
    while (n < costs.length && used + costs[n]! <= budget) used += costs[n++]!;
    return n;
  };
  const room = size.maxBytes - base;
  const warnTotal = total(warnCosts);
  if (total(failedCosts) + warnTotal > room) {
    // failedFiles gives way first, then warnings.
    if (warnTotal <= room) {
      failedKeep = prefixWithin(failedCosts, room - warnTotal);
    } else {
      failedKeep = 0;
      warnKeep = prefixWithin(warnCosts, room);
    }
    reserveNoteSlot();
    changed = true;
  }
  if (!changed) return value;
  apply();
  // The estimates are upper bounds; one encode confirms the result fits.
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > size.maxBytes) {
    failedKeep = 0;
    warnKeep = 0;
    apply();
  }
  return out;
}

// Upper bound on the bytes one string adds to a JSON array: its UTF-8 bytes,
// quotes and a comma, plus escape overhead (`"` and `\` become two bytes,
// control characters six, and every surrogate is counted as if it were lone).
function encodedEntryBytesUpperBound(entry: string): number {
  const escaped = entry.match(/["\\]/g)?.length ?? 0;
  const control = entry.match(/[\u0000-\u001f]/g)?.length ?? 0;
  const surrogates = entry.match(/[\ud800-\udfff]/g)?.length ?? 0;
  return Buffer.byteLength(entry, 'utf8') + 3 + escaped + 5 * control + 3 * surrogates;
}

const warningListSchema = z.union([
  z.array(z.string().max(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS)).max(CRITICAL_RESULT_WARNINGS_MAX),
  z.string().max(CRITICAL_RESULT_WARNING_TEXT_MAX_CHARS),
]);

// Windows entries restored with a restrictive access list because their
// recorded security descriptor could not be applied as-is. The count is the
// authoritative total; the path list is display detail, so an oversize list is
// trimmed here rather than rejecting (and so failing) an otherwise-successful
// restore result.
export const RESTORE_QUARANTINED_PATHS_MAX = 100;
export const RESTORE_QUARANTINED_PATH_MAX_CHARS = 1024;

export function boundQuarantinedPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, RESTORE_QUARANTINED_PATHS_MAX)
    // By code point: a UTF-16 slice can leave a lone surrogate, which jsonb rejects.
    .map((entry) => truncateCodePoints(entry, RESTORE_QUARANTINED_PATH_MAX_CHARS));
}

// Exported preprocessed below as restoreStructuredResultSchema.
const restoreStructuredResultObject = z.object({
  snapshotId: z.string().min(1).max(255).optional(),
  // 'refused' is the bare_metal_rebuild engine's preflight verdict (W05a); the
  // helper reports it as a successful command and the server maps it.
  status: z.enum(['completed', 'failed', 'partial', 'degraded', 'refused']).optional(),
  filesRestored: z.number().int().nonnegative().optional(),
  // v4 .int() caps at 2^53; cumulative byte totals can exceed it — keep v3
  // semantics (integer, any magnitude) so a large backup isn't recorded failed.
  bytesRestored: z.number().nonnegative().refine(Number.isInteger, 'expected integer').optional(),
  filesFailed: z.number().int().nonnegative().optional(),
  // A path list from file restores; a count from the bare-metal recovery
  // helper (bmr_recover), which always sends the field.
  failedFiles: z.union([
    z.array(z.string().min(1).max(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS)).max(CRITICAL_RESULT_FAILED_FILES_MAX),
    z.number().int().nonnegative(),
  ]).optional(),
  warnings: warningListSchema.optional(),
  error: z.string().max(CRITICAL_RESULT_ERROR_MAX_CHARS).optional(),
  stagingDir: z.string().max(4096).optional(),
  stateApplied: z.boolean().optional(),
  driversInjected: z.number().int().nonnegative().optional(),
  validated: z.boolean().optional(),
  vmName: z.string().max(255).optional(),
  newVmId: z.string().max(255).optional(),
  vhdxPath: z.string().max(4096).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  bootTimeMs: z.number().int().nonnegative().optional(),
  backgroundSyncActive: z.boolean().optional(),
  syncProgress: z.union([z.number(), z.record(z.string(), z.unknown())]).optional(),
  databaseName: z.string().max(255).optional(),
  restoredAs: z.string().max(255).optional(),
  // W05a bare_metal_rebuild: the rebuild engine's Result fields the server keeps.
  phaseReached: z.string().max(64).optional(),
  refusal: z.string().max(10_000).optional(),
  target: z.object({
    kind: z.string().max(16),
    path: z.string().max(4096),
    imageSizeBytes: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
  // W06d: the optional Hyper-V VM step after a Windows rebuild.
  vmCreated: z.boolean().optional(),
  vmError: z.string().max(10_000).optional(),
  securityDescriptorQuarantined: z.number().int().nonnegative().optional(),
  securityDescriptorQuarantinedPaths: z.array(z.string()).transform(boundQuarantinedPaths).optional(),
  // bmr_recover: stable outcome code (see bmrCompleteSchema in routes/backup/schemas.ts).
  code: z.string().max(64).optional(),
}).passthrough();

// Exported preprocessed below as backupVerificationStructuredResultSchema.
const backupVerificationStructuredResultObject = z.object({
  snapshotId: z.string().min(1).max(255).optional(),
  status: z.enum(['passed', 'failed', 'partial']),
  filesVerified: z.number().int().nonnegative().optional(),
  filesFailed: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().nonnegative().refine(Number.isInteger, 'expected integer').optional(),
  durationMs: z.number().int().nonnegative().optional(),
  restoreTimeSeconds: z.number().int().nonnegative().optional(),
  restorePath: z.string().max(4096).optional(),
  cleanedUp: z.boolean().optional(),
  failedFiles: z.array(z.string().min(1).max(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS)).max(CRITICAL_RESULT_FAILED_FILES_MAX).optional(),
  // #6350: files the BACKUP run never uploaded. They are absent from the
  // manifest, so verification cannot observe them — the agent reads the count
  // off the manifest and refuses `passed` when it is non-zero.
  filesIncomplete: z.number().int().nonnegative().optional(),
  // Files the run never reached a verdict on: its time budget ran out, or its
  // storage session ended (code `storage_session_lost`). Not failures.
  filesUnchecked: z.number().int().nonnegative().optional(),
  warnings: warningListSchema.optional(),
  error: z.string().max(CRITICAL_RESULT_ERROR_MAX_CHARS).optional(),
  // Stable outcome code (e.g. `storage_session_lost`, an integrity failure code).
  code: z.string().max(64).optional(),
}).passthrough();

export const vaultSyncStructuredResultSchema = z.object({
  vaultId: z.string().guid().optional(),
  snapshotId: z.string().min(1).max(255).optional(),
  vaultPath: z.string().min(1).max(4096).optional(),
  fileCount: z.number().int().nonnegative().optional(),
  totalBytes: z.number().nonnegative().refine(Number.isInteger, 'expected integer').optional(),
  manifestVerified: z.boolean().optional(),
  auto: z.boolean().optional(),
  error: z.string().max(10_000).optional(),
}).passthrough();

// Restore and verification results are preprocessed so an oversize detail list
// is bounded, not rejected — on every parse, including handlers that re-parse
// stored stdout (verificationScheduled.ts).
export const restoreStructuredResultSchema = z.preprocess(
  (value) => boundCriticalResultLists(value),
  restoreStructuredResultObject,
);
export const backupVerificationStructuredResultSchema = z.preprocess(
  (value) => boundCriticalResultLists(value),
  backupVerificationStructuredResultObject,
);

export type CriticalCommandValidation =
  | {
      family: CriticalResultFamily;
      structuredResult: Record<string, unknown>;
      normalizedStdout: string | undefined;
      serializedResultBytes: number;
    }
  | null;

function byteLength(value?: string): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function detectCriticalFamily(commandType: string): CriticalResultFamily | null {
  if (TOPOLOGY_DIAGNOSTIC_COMMAND_TYPES.has(commandType)) return 'topology_diagnostic';
  if (VERIFICATION_COMMAND_TYPES.has(commandType)) return 'verification';
  if (VAULT_COMMAND_TYPES.has(commandType)) return 'vault';
  if (DR_COMMAND_TYPES.has(commandType)) return 'dr';
  if (RESTORE_COMMAND_TYPES.has(commandType)) return 'restore';
  return null;
}

function ensureCriticalResultSizeLimits(envelope: GenericCommandResultEnvelope): void {
  if (byteLength(envelope.stdout) > CRITICAL_RESULT_STDOUT_MAX_BYTES) {
    throw new Error(`stdout exceeds ${CRITICAL_RESULT_STDOUT_MAX_BYTES} bytes`);
  }
  if (byteLength(envelope.stderr) > CRITICAL_RESULT_STDERR_MAX_BYTES) {
    throw new Error(`stderr exceeds ${CRITICAL_RESULT_STDERR_MAX_BYTES} bytes`);
  }
  if (envelope.result !== undefined) {
    let serialized = '';
    try {
      serialized = JSON.stringify(envelope.result);
    } catch {
      throw new Error('structured result payload is not JSON-serializable');
    }
    if (Buffer.byteLength(serialized, 'utf8') > CRITICAL_RESULT_STRUCTURED_MAX_BYTES) {
      throw new Error(`structured result exceeds ${CRITICAL_RESULT_STRUCTURED_MAX_BYTES} bytes`);
    }
  }
}

// Agents encode the structured result as a JSON string (marshalResult → stdout),
// and depending on the path it can arrive double-encoded (a JSON string whose
// value is itself the JSON object). Parse repeatedly until we reach a non-string,
// so critical-family validation (ensureObjectLike + the family schemas) sees an
// object — otherwise verify/test-restore/restore results are rejected as "must be
// a JSON object" and the record never leaves running.
function deepJsonParse(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 3 && typeof current === 'string'; i++) {
    try {
      current = JSON.parse(current);
    } catch {
      return undefined;
    }
  }
  return current;
}

function parseStructuredResult(envelope: GenericCommandResultEnvelope): unknown {
  if (envelope.result !== undefined) {
    return deepJsonParse(envelope.result);
  }
  if (!envelope.stdout) {
    return undefined;
  }
  return deepJsonParse(envelope.stdout);
}

// Shipped agents bound a result body only to the general 5 MB cap, so a
// restore / verification body can arrive over the structured-size cap purely
// because of its detail lists. Bound the lists (and shrink them to the cap)
// BEFORE the size check, and measure the bounded body, so such a result keeps
// its counts and status instead of being rejected whole. A body still over the
// cap after its lists are emptied is rejected as before; the caps themselves
// are unchanged.
//
// The raw size is checked FIRST, before any parse: a body over
// CRITICAL_RESULT_BOUNDING_MAX_BYTES (the general cap the transport already
// enforces) is handed straight to the size check, which rejects it. The body
// is bounded to the cap ensureCriticalResultSizeLimits will apply to it: the
// structured cap when it carries `result`, the stdout cap when it is stdout
// alone.
function boundEnvelopeDetailLists(envelope: GenericCommandResultEnvelope): GenericCommandResultEnvelope {
  if (byteLength(envelope.stdout) > CRITICAL_RESULT_BOUNDING_MAX_BYTES) return envelope;
  let encodedBytes = byteLength(envelope.stdout);
  let maxBytes = CRITICAL_RESULT_STDOUT_MAX_BYTES;
  if (envelope.result !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(envelope.result);
    } catch {
      return envelope; // the size check reports it
    }
    encodedBytes = byteLength(serialized);
    if (encodedBytes > CRITICAL_RESULT_BOUNDING_MAX_BYTES) return envelope;
    maxBytes = CRITICAL_RESULT_STRUCTURED_MAX_BYTES;
  }
  const parsed = parseStructuredResult(envelope);
  const bounded = boundCriticalResultLists(parsed, { maxBytes, encodedBytes });
  if (bounded === parsed) return envelope;
  if (envelope.result === undefined) {
    return { ...envelope, stdout: JSON.stringify(bounded) };
  }
  // `result` was trimmed. Its stdout is replaced only when it is the same
  // document (the WebSocket leg sends the body as both); any other stdout
  // keeps its own size check, so trimming `result` cannot let an unrelated
  // oversize stdout through.
  const stdoutIsSameDocument =
    envelope.stdout === undefined || jsonDocumentsEqual(deepJsonParse(envelope.stdout), parsed);
  return {
    ...envelope,
    stdout: stdoutIsSameDocument ? JSON.stringify(bounded) : envelope.stdout,
    result: bounded,
  };
}

// Structural equality of two parsed JSON values, ignoring object key order (Go
// re-marshals the parsed body with sorted keys). Linear in the documents.
function jsonDocumentsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => jsonDocumentsEqual(value, other[i]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = Object.keys(aRecord);
  if (keys.length !== Object.keys(bRecord).length) return false;
  return keys.every((key) => Object.hasOwn(bRecord, key) && jsonDocumentsEqual(aRecord[key], bRecord[key]));
}

function ensureObjectLike(commandType: string, value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`critical ${commandType} result must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function validateCriticalCommandResult(
  commandType: string,
  envelope: GenericCommandResultEnvelope,
  options: { commandPayload?: unknown } = {}
): CriticalCommandValidation {
  const family = detectCriticalFamily(commandType);
  if (!family) return null;

  if (family === 'verification' || family === 'restore' || family === 'dr') {
    envelope = boundEnvelopeDetailLists(envelope);
  }
  ensureCriticalResultSizeLimits(envelope);

  const parsed = parseStructuredResult(envelope);

  if (family === 'topology_diagnostic') {
    if (envelope.status !== 'completed' && parsed === undefined) {
      return { family, structuredResult: {}, normalizedStdout: envelope.stdout, serializedResultBytes: 0 };
    }
    if (parsed === undefined) {
      throw new Error(`critical ${commandType} result is missing structured diagnostic data`);
    }
    const validated = topologyDiagnosticResultSchema.parse(ensureObjectLike(commandType, parsed));
    // A digest is an integrity seal, never authorization: the ids and digest a
    // result claims must equal the ones the SERVER pinned into the delivered
    // command, so a result cannot be re-pointed at another run or attempt.
    const command = topologyDiagnosticCommandSchema.safeParse(options.commandPayload);
    if (!command.success) {
      throw new Error(`critical ${commandType} result has no pinned command authority`);
    }
    if (
      validated.runId !== command.data.runId ||
      validated.attemptId !== command.data.attemptId ||
      validated.commandId !== command.data.commandId ||
      validated.planDigest !== command.data.planDigest
    ) {
      throw new Error(`critical ${commandType} result does not match its accepted plan`);
    }
    const normalizedStdout = JSON.stringify(validated);
    return {
      family,
      structuredResult: validated as unknown as Record<string, unknown>,
      normalizedStdout,
      serializedResultBytes: Buffer.byteLength(normalizedStdout, 'utf8'),
    };
  }

  if (family === 'verification') {
    if (envelope.status !== 'completed' && parsed === undefined) {
      return { family, structuredResult: {}, normalizedStdout: envelope.stdout, serializedResultBytes: 0 };
    }
    if (parsed === undefined) {
      throw new Error(`critical ${commandType} result is missing structured verification data`);
    }
    const validated = backupVerificationStructuredResultSchema.parse(
      ensureObjectLike(commandType, parsed)
    );
    const normalizedStdout = JSON.stringify(validated);
    return {
      family,
      structuredResult: validated as Record<string, unknown>,
      normalizedStdout,
      serializedResultBytes: Buffer.byteLength(normalizedStdout, 'utf8'),
    };
  }

  if (family === 'vault') {
    if (envelope.status !== 'completed' && parsed === undefined) {
      return { family, structuredResult: {}, normalizedStdout: envelope.stdout, serializedResultBytes: 0 };
    }
    if (parsed === undefined) {
      throw new Error(`critical ${commandType} result is missing structured vault sync data`);
    }
    const validated = vaultSyncStructuredResultSchema.parse(
      ensureObjectLike(commandType, parsed)
    );
    const normalizedStdout = JSON.stringify(validated);
    return {
      family,
      structuredResult: validated as Record<string, unknown>,
      normalizedStdout,
      serializedResultBytes: Buffer.byteLength(normalizedStdout, 'utf8'),
    };
  }

  if (envelope.status !== 'completed' && parsed === undefined) {
    return { family, structuredResult: {}, normalizedStdout: envelope.stdout, serializedResultBytes: 0 };
  }
  if (parsed === undefined) {
    throw new Error(`critical ${commandType} result is missing structured restore data`);
  }
  const validated = restoreStructuredResultSchema.parse(
    ensureObjectLike(commandType, parsed)
  );
  const normalizedStdout = JSON.stringify(validated);
  return {
    family,
    structuredResult: validated as Record<string, unknown>,
    normalizedStdout,
    serializedResultBytes: Buffer.byteLength(normalizedStdout, 'utf8'),
  };
}

export function detectResultValidationFamily(commandType: string): CriticalResultFamily | null {
  return detectCriticalFamily(commandType);
}

/** Canonical set of DR command types — import this instead of redefining locally. */
export { DR_COMMAND_TYPES };
