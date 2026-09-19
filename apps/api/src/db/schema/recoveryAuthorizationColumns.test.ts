import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import {
  c2cBackupJobs,
  drExecutions,
  recoveryBootMediaArtifacts,
  recoveryMediaArtifacts,
  recoveryTokens,
  restoreJobs,
} from './index';
import { getTenantExportPolicyRegistry } from '../../services/tenantExportPolicyRegistry';

const SUBJECT_COLUMNS = [
  'authorizationPrincipalKind',
  'authorizationPrincipalId',
  'authorizationGrantRevision',
  'authorizationState',
  'authorizationDenialCode',
  'authorizationCheckedAt',
] as const;

const SUBJECT_DB_COLUMNS = [
  'authorization_principal_kind',
  'authorization_principal_id',
  'authorization_grant_revision',
  'authorization_state',
  'authorization_denial_code',
  'authorization_checked_at',
] as const;

describe('durable queued-recovery authorization subject schema', () => {
  it.each([
    ['recovery_tokens', recoveryTokens],
    ['recovery_media_artifacts', recoveryMediaArtifacts],
    ['recovery_boot_media_artifacts', recoveryBootMediaArtifacts],
    ['restore_jobs', restoreJobs],
    ['dr_executions', drExecutions],
    ['c2c_backup_jobs', c2cBackupJobs],
  ])('%s embeds the complete typed authorization subject tuple', (_name, table) => {
    const columns = getTableColumns(table);
    expect(SUBJECT_COLUMNS.every((column) => column in columns)).toBe(true);
    expect(columns.authorizationPrincipalKind.notNull).toBe(true);
    expect(columns.authorizationState.notNull).toBe(true);
  });

  it('distinguishes C2C sync, restore, and unknown legacy work', () => {
    const columns = getTableColumns(c2cBackupJobs);
    expect(columns.operationKind.name).toBe('operation_kind');
    expect(columns.operationKind.notNull).toBe(true);
  });

  it.each([
    'recovery_tokens',
    'recovery_media_artifacts',
    'recovery_boot_media_artifacts',
    'restore_jobs',
    'dr_executions',
    'c2c_backup_jobs',
  ])('registers every %s subject field in tenant export policy', (tableName) => {
    const policy = getTenantExportPolicyRegistry()[tableName];
    expect(policy).toBeDefined();
    for (const column of SUBJECT_DB_COLUMNS) {
      expect(policy?.columns[column]).toMatchObject({
        decision: 'include',
        reviewedSensitiveName: true,
      });
    }
  });

  it('registers the C2C operation discriminator in tenant export policy', () => {
    expect(getTenantExportPolicyRegistry().c2c_backup_jobs?.columns.operation_kind)
      .toMatchObject({ decision: 'include' });
  });
});
