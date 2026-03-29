import { describe, expect, it } from 'vitest';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';

describe('backup-related AI tool schemas', () => {
  it('accepts legacy backup IDs for run_backup_verification', () => {
    const schema = toolInputSchemas['run_backup_verification']!;
    const result = schema.safeParse({
      deviceId: 'dev-001',
      backupJobId: 'job-001',
      snapshotId: 'snap-001',
      verificationType: 'test_restore'
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional legacy device IDs for read-only backup tools', () => {
    const health = validateToolInput('get_backup_health', { deviceId: 'dev-001' });
    expect(health.success).toBe(true);

    const readiness = validateToolInput('get_recovery_readiness', { deviceId: 'dev-001' });
    expect(readiness.success).toBe(true);
  });

  it('rejects empty run_backup_verification device IDs', () => {
    const result = validateToolInput('run_backup_verification', {
      deviceId: ''
    });
    expect(result.success).toBe(false);
  });
});
