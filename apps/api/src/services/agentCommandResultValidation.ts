import { z } from 'zod';

export type CriticalResultFamily = 'restore' | 'verification' | 'vault' | 'dr';

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
]);

const DR_COMMAND_TYPES = new Set([
  'vm_restore_from_backup',
  'vm_instant_boot',
  'hyperv_restore',
  'mssql_restore',
  'bmr_recover',
]);

const VERIFICATION_COMMAND_TYPES = new Set(['backup_verify', 'backup_test_restore']);
const VAULT_COMMAND_TYPES = new Set(['vault_sync']);

const warningListSchema = z.union([
  z.array(z.string().max(4096)).max(100),
  z.string().max(10_000),
]);

export const restoreStructuredResultSchema = z.object({
  snapshotId: z.string().min(1).max(255).optional(),
  status: z.enum(['completed', 'failed', 'partial', 'degraded']).optional(),
  filesRestored: z.number().int().nonnegative().optional(),
  bytesRestored: z.number().int().nonnegative().optional(),
  filesFailed: z.number().int().nonnegative().optional(),
  failedFiles: z.array(z.string().min(1).max(4096)).max(1000).optional(),
  warnings: warningListSchema.optional(),
  error: z.string().max(10_000).optional(),
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
  syncProgress: z.union([z.number(), z.record(z.unknown())]).optional(),
  databaseName: z.string().max(255).optional(),
  restoredAs: z.string().max(255).optional(),
}).passthrough();

export const backupVerificationStructuredResultSchema = z.object({
  snapshotId: z.string().min(1).max(255).optional(),
  status: z.enum(['passed', 'failed', 'partial']),
  filesVerified: z.number().int().nonnegative().optional(),
  filesFailed: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  restoreTimeSeconds: z.number().int().nonnegative().optional(),
  restorePath: z.string().max(4096).optional(),
  cleanedUp: z.boolean().optional(),
  failedFiles: z.array(z.string().min(1).max(4096)).max(1000).optional(),
  error: z.string().max(10_000).optional(),
}).passthrough();

export const vaultSyncStructuredResultSchema = z.object({
  vaultId: z.string().uuid().optional(),
  snapshotId: z.string().min(1).max(255).optional(),
  vaultPath: z.string().min(1).max(4096).optional(),
  fileCount: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  manifestVerified: z.boolean().optional(),
  auto: z.boolean().optional(),
  error: z.string().max(10_000).optional(),
}).passthrough();

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

function parseStructuredResult(envelope: GenericCommandResultEnvelope): unknown {
  if (envelope.result !== undefined) {
    return envelope.result;
  }
  if (!envelope.stdout) {
    return undefined;
  }
  try {
    return JSON.parse(envelope.stdout);
  } catch {
    return undefined;
  }
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
  envelope: GenericCommandResultEnvelope
): CriticalCommandValidation {
  const family = detectCriticalFamily(commandType);
  if (!family) return null;

  ensureCriticalResultSizeLimits(envelope);

  const parsed = parseStructuredResult(envelope);

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
