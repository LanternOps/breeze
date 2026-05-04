type JsonRecord = Record<string, unknown>;

export type BackupStorageEncryptionPlan =
  | {
      required: false;
      mode: 'disabled';
      status: 'disabled';
    }
  | {
      required: true;
      mode: 's3-sse-s3' | 's3-sse-kms';
      status: 'enforced';
      providerConfigPatch: JsonRecord;
      keyReference: string | null;
    }
  | {
      required: true;
      mode: 'unsupported';
      status: 'unsupported';
      reason: string;
    };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getStringValue(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getNestedEncryptionConfig(providerConfig: JsonRecord): JsonRecord {
  const nested = providerConfig.encryption;
  return isRecord(nested) ? nested : {};
}

function normalizeS3SseAlgorithm(providerConfig: JsonRecord): string | null {
  const nested = getNestedEncryptionConfig(providerConfig);
  const raw =
    getStringValue(providerConfig, 'serverSideEncryption') ??
    getStringValue(providerConfig, 'sseAlgorithm') ??
    getStringValue(providerConfig, 'sse') ??
    getStringValue(nested, 'serverSideEncryption') ??
    getStringValue(nested, 'algorithm') ??
    getStringValue(nested, 'mode');

  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized === 'aes256' || normalized === 'sse-s3' || normalized === 's3') {
    return 'AES256';
  }
  if (normalized === 'aws:kms' || normalized === 'sse-kms' || normalized === 'kms') {
    return 'aws:kms';
  }
  return null;
}

function resolveS3KmsKeyId(providerConfig: JsonRecord): string | null {
  const nested = getNestedEncryptionConfig(providerConfig);
  return (
    getStringValue(providerConfig, 'kmsKeyId') ??
    getStringValue(providerConfig, 'sseKmsKeyId') ??
    getStringValue(providerConfig, 'kmsKeyArn') ??
    getStringValue(nested, 'kmsKeyId') ??
    getStringValue(nested, 'keyId') ??
    getStringValue(nested, 'keyArn')
  );
}

export function resolveBackupStorageEncryptionPlan(input: {
  encryption: boolean | null | undefined;
  provider: string | null | undefined;
  providerConfig: unknown;
}): BackupStorageEncryptionPlan {
  if (input.encryption !== true) {
    return {
      required: false,
      mode: 'disabled',
      status: 'disabled',
    };
  }

  const provider = input.provider ?? null;
  const providerConfig = isRecord(input.providerConfig) ? input.providerConfig : {};

  if (provider !== 's3') {
    return {
      required: true,
      mode: 'unsupported',
      status: 'unsupported',
      reason: 'Backup encryption is currently enforceable only for S3 storage with explicit server-side encryption settings.',
    };
  }

  const algorithm = normalizeS3SseAlgorithm(providerConfig);
  if (algorithm === 'AES256') {
    return {
      required: true,
      mode: 's3-sse-s3',
      status: 'enforced',
      providerConfigPatch: {
        serverSideEncryption: 'AES256',
      },
      keyReference: null,
    };
  }

  if (algorithm === 'aws:kms') {
    const kmsKeyId = resolveS3KmsKeyId(providerConfig);
    if (!kmsKeyId) {
      return {
        required: true,
        mode: 'unsupported',
        status: 'unsupported',
        reason: 'S3 KMS backup encryption requires a kmsKeyId or keyArn.',
      };
    }

    return {
      required: true,
      mode: 's3-sse-kms',
      status: 'enforced',
      providerConfigPatch: {
        serverSideEncryption: 'aws:kms',
        kmsKeyId,
      },
      keyReference: kmsKeyId,
    };
  }

  return {
    required: true,
    mode: 'unsupported',
    status: 'unsupported',
    reason: 'Backup encryption is enabled but no enforceable client encryption or S3 SSE/KMS policy is configured.',
  };
}

export function assertBackupStorageEncryptionSupported(input: {
  encryption: boolean | null | undefined;
  provider: string | null | undefined;
  providerConfig: unknown;
}): BackupStorageEncryptionPlan {
  const plan = resolveBackupStorageEncryptionPlan(input);
  if (plan.required && plan.status === 'unsupported') {
    throw new Error(plan.reason);
  }
  return plan;
}

export function buildBackupStorageEncryptionResponse(input: {
  encryption: boolean | null | undefined;
  provider: string | null | undefined;
  providerConfig: unknown;
}): Record<string, unknown> {
  const plan = resolveBackupStorageEncryptionPlan(input);
  if (!plan.required) {
    return {
      enabled: false,
      status: 'disabled',
      mode: 'disabled',
    };
  }
  if (plan.status === 'unsupported') {
    return {
      enabled: true,
      status: 'unsupported',
      mode: 'unsupported',
      reason: plan.reason,
    };
  }
  return {
    enabled: true,
    status: 'enforced',
    mode: plan.mode,
    keyReference: plan.keyReference,
  };
}
