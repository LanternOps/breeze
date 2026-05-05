import { describe, expect, it } from 'vitest';
import {
  assertBackupStorageEncryptionSupported,
  resolveBackupStorageEncryptionPlan,
} from './backupEncryption';

describe('backup encryption policy', () => {
  it('defaults to disabled when backup encryption is not requested', () => {
    expect(resolveBackupStorageEncryptionPlan({
      encryption: false,
      provider: 'local',
      providerConfig: { path: '/backups' },
    })).toEqual({
      required: false,
      mode: 'disabled',
      status: 'disabled',
    });
  });

  it('fails closed when encryption is required without an enforceable storage policy', () => {
    expect(() => assertBackupStorageEncryptionSupported({
      encryption: true,
      provider: 'local',
      providerConfig: { path: '/backups' },
    })).toThrow('Backup encryption is currently enforceable only for S3 storage');
  });

  it('accepts S3 SSE-S3 as an enforceable provider encryption policy', () => {
    expect(resolveBackupStorageEncryptionPlan({
      encryption: true,
      provider: 's3',
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        encryption: { mode: 'sse-s3' },
      },
    })).toEqual({
      required: true,
      mode: 's3-sse-s3',
      status: 'enforced',
      providerConfigPatch: {
        serverSideEncryption: 'AES256',
      },
      keyReference: null,
    });
  });

  it('requires a retrievable KMS reference for S3 SSE-KMS', () => {
    expect(() => assertBackupStorageEncryptionSupported({
      encryption: true,
      provider: 's3',
      providerConfig: {
        serverSideEncryption: 'aws:kms',
      },
    })).toThrow('S3 KMS backup encryption requires');

    expect(resolveBackupStorageEncryptionPlan({
      encryption: true,
      provider: 's3',
      providerConfig: {
        serverSideEncryption: 'aws:kms',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abcd',
      },
    })).toMatchObject({
      required: true,
      mode: 's3-sse-kms',
      status: 'enforced',
      keyReference: 'arn:aws:kms:us-east-1:123456789012:key/abcd',
    });
  });
});
