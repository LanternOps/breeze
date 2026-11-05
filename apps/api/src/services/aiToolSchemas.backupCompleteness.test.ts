import { describe, expect, it } from 'vitest';
import './aiTools'; // populates the registry map
import { aiTools } from './aiToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { backupVerificationToolSchemas, BACKUP_VERIFICATION_ACTIONS, BACKUP_VERIFICATION_STATUSES, BACKUP_VERIFICATION_TYPES } from './aiToolSchemasBackupVerification';
import { backupRecoveryReadToolSchemas, BACKUP_HEALTH_LEVELS, BACKUP_HEALTH_SOURCES, BMR_RECOVERY_ACTIONS } from './aiToolSchemasBackupRecoveryReads';
import { C2C_CONFIG_ACTIONS, c2cConfigToolSchemas } from './aiToolSchemasC2CConfigs';
import { c2cBackupScopes } from '../routes/c2c/schemas';

// W17 (#6788): the registry input_schema, the toolInputSchemas entry and the SDK shape must agree
// (inputShape() takes the Zod .shape directly, so Zod IS the SDK surface).
const W17_TOOLS = [
  ...Object.keys(backupVerificationToolSchemas),
  ...Object.keys(backupRecoveryReadToolSchemas),
  ...Object.keys(c2cConfigToolSchemas),
];
const UUID = '11111111-1111-4111-8111-111111111111';
const shapeOf = (name: string) => (toolInputSchemas[name] as unknown as { shape: Record<string, { isOptional: () => boolean }> }).shape;
const registry = (name: string) => aiTools.get(name)!.definition.input_schema as {
  properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
  required?: string[];
  additionalProperties?: boolean;
};

describe('W17 backup tool input schemas', () => {
  it('covers exactly the five W17 tools', () => {
    expect([...W17_TOOLS].sort()).toEqual([
      'get_backup_health', 'get_vss_status', 'list_bmr_recoveries', 'manage_backup_verification', 'manage_c2c_configs',
    ]);
  });

  it.each(W17_TOOLS)('%s: registry properties and Zod keys agree, strict', (name) => {
    const schema = registry(name);
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(shapeOf(name)).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(W17_TOOLS)('%s: every registry-required key is required by Zod too', (name) => {
    for (const key of registry(name).required ?? []) {
      expect(shapeOf(name)[key]!.isOptional(), `${name}.${key} is required in the registry but optional in Zod`).toBe(false);
    }
  });

  it('registry enums equal the Zod enums', () => {
    expect(registry('manage_backup_verification').properties.action!.enum).toEqual([...BACKUP_VERIFICATION_ACTIONS]);
    expect(registry('manage_backup_verification').properties.verificationType!.enum).toEqual([...BACKUP_VERIFICATION_TYPES]);
    expect(registry('manage_backup_verification').properties.status!.enum).toEqual([...BACKUP_VERIFICATION_STATUSES]);
    expect(registry('list_bmr_recoveries').properties.action!.enum).toEqual([...BMR_RECOVERY_ACTIONS]);
    expect(registry('manage_c2c_configs').properties.action!.enum).toEqual([...C2C_CONFIG_ACTIONS]);
    expect(registry('manage_c2c_configs').properties.backupScope!.enum).toEqual([...c2cBackupScopes]);
    expect(registry('get_backup_health').properties.source!.items!.enum).toEqual([...BACKUP_HEALTH_SOURCES]);
    expect(registry('get_backup_health').properties.health!.items!.enum).toEqual([...BACKUP_HEALTH_LEVELS]);
  });

  it('accepts the shapes the tools document', () => {
    expect(validateToolInput('manage_backup_verification', { action: 'run', deviceId: UUID, verificationType: 'test_restore', snapshotId: UUID }).success).toBe(true);
    expect(validateToolInput('get_vss_status', { deviceId: UUID }).success).toBe(true);
    expect(validateToolInput('list_bmr_recoveries', { action: 'get', recoveryId: UUID }).success).toBe(true);
    expect(validateToolInput('get_backup_health', {}).success).toBe(true);
    expect(validateToolInput('get_backup_health', { source: ['provider'], health: ['critical'], status: ['failed'], withBackup: false }).success).toBe(true);
    expect(validateToolInput('manage_c2c_configs', {
      action: 'create', connectionId: UUID, name: 'Finance', backupScope: c2cBackupScopes[0],
      targetUsers: ['a@example.test'], schedule: { frequency: 'daily', time: '02:00' }, retention: { keepDays: 30 },
    }).success).toBe(true);
    expect(validateToolInput('manage_c2c_configs', { action: 'update', configId: UUID, storageConfigId: null, isActive: false }).success).toBe(true);
  });

  it('refuses what a tool does not take', () => {
    // No input maps to the routes' refresh flag, which writes readiness rows.
    expect(validateToolInput('manage_backup_verification', { action: 'health', refresh: true }).success).toBe(false);
    expect(validateToolInput('manage_backup_verification', { action: 'purge' }).success).toBe(false);
    expect(validateToolInput('manage_backup_verification', { action: 'list', limit: 101 }).success).toBe(false);
    expect(validateToolInput('get_vss_status', {}).success).toBe(false);
    expect(validateToolInput('get_vss_status', { deviceId: 'nope' }).success).toBe(false);
    expect(validateToolInput('list_bmr_recoveries', { action: 'create' }).success).toBe(false);
    expect(validateToolInput('list_bmr_recoveries', { action: 'list', limit: 51 }).success).toBe(false);
    expect(validateToolInput('get_backup_health', { source: ['elsewhere'] }).success).toBe(false);
    expect(validateToolInput('manage_c2c_configs', { action: 'create', targetUsers: ['not-an-email'] }).success).toBe(false);
    expect(validateToolInput('manage_c2c_configs', { action: 'list', orgId: 'nope' }).success).toBe(false);
  });
});
