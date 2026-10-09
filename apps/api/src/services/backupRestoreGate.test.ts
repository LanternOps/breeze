import { describe, expect, it } from 'vitest';
import {
  MIN_RESTORE_INTEGRITY_PROTOCOL,
  PRIVILEGED_RESTORE_COMMAND_TYPES,
  RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE,
  RESTORE_INTEGRITY_MESSAGES,
  decideRestoreGate,
  gateForActor,
  isPrivilegedRestoreCommandType,
  isRestoreHelperUpdateRequiredError,
  overrideIntegrityPayload,
  restoreIntegrityHelperRefusal,
} from './backupRestoreGate';
import type { RestoreIntegrity } from './backupRestoreIntegrity';

const SNAP = 'snapshot-20261001T101500Z-0123456789abcdef01234567';
const SOURCE = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const AUTH_ID = '66666666-6666-4666-8666-666666666666';

const attested = (trust: 'server_verified' | 'producer_only' = 'server_verified'): RestoreIntegrity => ({
  mode: 'attested',
  trust,
  snapshotId: SNAP,
  sourceDeviceId: SOURCE,
  objects: [{ role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: 'a'.repeat(64), size: 10 }],
});
const unattested = (reason: 'unattested_legacy' | 'unattested' | 'pending' | 'attestation_failed'): RestoreIntegrity => ({
  mode: 'unattested',
  snapshotId: SNAP,
  reason,
});

describe('privileged restore command types', () => {
  it('names every restore that installs, imports or boots bytes, and no read-only validation', () => {
    expect([...PRIVILEGED_RESTORE_COMMAND_TYPES].sort()).toEqual([
      'backup_restore', 'bare_metal_rebuild', 'bmr_recover', 'hyperv_restore', 'mssql_restore',
      'vm_instant_boot', 'vm_restore_from_backup',
    ]);
    for (const t of ['backup_verify', 'backup_test_restore', 'mssql_verify']) {
      expect(isPrivilegedRestoreCommandType(t)).toBe(false);
    }
  });

  it('requires integrity protocol 2', () => {
    expect(MIN_RESTORE_INTEGRITY_PROTOCOL).toBe(2);
  });
});

describe('restoreIntegrityHelperRefusal (enqueue)', () => {
  it.each([0, 1, undefined])('refuses a privileged restore to a helper reporting %s', (protocol) => {
    expect(restoreIntegrityHelperRefusal('backup_restore', protocol)).toBe(RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(isRestoreHelperUpdateRequiredError(restoreIntegrityHelperRefusal('bare_metal_rebuild', protocol))).toBe(true);
  });

  it('queues a privileged restore for a device that has not reported its helper yet (delivery waits for the report)', () => {
    expect(restoreIntegrityHelperRefusal('backup_restore', null)).toBeNull();
  });

  it('allows a privileged restore to a helper that checks attestations', () => {
    expect(restoreIntegrityHelperRefusal('vm_instant_boot', 2)).toBeNull();
  });

  it('never refuses read-only validation or unrelated commands on integrity grounds', () => {
    expect(restoreIntegrityHelperRefusal('backup_verify', 0)).toBeNull();
    expect(restoreIntegrityHelperRefusal('backup_test_restore', 1)).toBeNull();
    expect(restoreIntegrityHelperRefusal('script', 0)).toBeNull();
  });

  it('tells the operator what to do', () => {
    expect(RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE).toMatch(/^Update the Breeze agent on this device, then try again\./);
  });
});

describe('decideRestoreGate', () => {
  const base = { commandType: 'backup_restore', targetDeviceId: SOURCE };

  it('allows a server-verified snapshot onto any device', () => {
    expect(decideRestoreGate({ ...base, integrity: attested() })).toEqual({ kind: 'allow' });
    expect(decideRestoreGate({ ...base, targetDeviceId: OTHER, integrity: attested() })).toEqual({ kind: 'allow' });
  });

  it('allows a device-local (producer-only) snapshot onto the device that wrote it', () => {
    expect(decideRestoreGate({ ...base, integrity: attested('producer_only') })).toEqual({ kind: 'allow' });
  });

  it('requires an authorization to restore a device-local snapshot onto another device', () => {
    expect(decideRestoreGate({ ...base, targetDeviceId: OTHER, integrity: attested('producer_only') }))
      .toEqual({ kind: 'authorization_required', reason: 'producer_only_other_target' });
  });

  it.each(['unattested_legacy', 'unattested'] as const)('requires an authorization for an %s snapshot', (reason) => {
    expect(decideRestoreGate({ ...base, integrity: unattested(reason) })).toEqual({ kind: 'authorization_required', reason });
  });

  it('asks to wait while the attestation is still being checked', () => {
    expect(decideRestoreGate({ ...base, integrity: unattested('pending') })).toEqual({
      kind: 'refuse',
      code: 'attestation_pending',
      message: RESTORE_INTEGRITY_MESSAGES.attestation_pending,
    });
  });

  it('refuses a snapshot that did not match its attestation, and never offers an authorization for it', () => {
    expect(decideRestoreGate({ ...base, integrity: unattested('attestation_failed') })).toEqual({
      kind: 'refuse',
      code: 'snapshot_integrity_failed',
      message: RESTORE_INTEGRITY_MESSAGES.snapshot_integrity_failed,
    });
  });

  it('refuses a privileged restore whose snapshot could not be resolved', () => {
    expect(decideRestoreGate({ ...base, integrity: null })).toMatchObject({ kind: 'refuse', code: 'snapshot_unresolved' });
  });

  it('allows read-only validation of any snapshot that has not failed its check (labelled by the integrity block)', () => {
    for (const commandType of ['backup_verify', 'backup_test_restore', 'mssql_verify']) {
      expect(decideRestoreGate({ commandType, targetDeviceId: OTHER, integrity: unattested('unattested_legacy') })).toEqual({ kind: 'allow' });
      expect(decideRestoreGate({ commandType, targetDeviceId: OTHER, integrity: unattested('pending') })).toEqual({ kind: 'allow' });
      expect(decideRestoreGate({ commandType, targetDeviceId: OTHER, integrity: null })).toEqual({ kind: 'allow' });
    }
  });
});

describe('gateForActor', () => {
  const needsAuth = { kind: 'authorization_required', reason: 'unattested_legacy' } as const;

  it('a user is asked for a step-up', () => {
    expect(gateForActor(needsAuth, 'user')).toEqual(needsAuth);
  });

  it.each(['ai_agent', 'system'] as const)('an %s is never offered a step-up: unattested restores are refused', (actor) => {
    expect(gateForActor(needsAuth, actor)).toEqual({
      kind: 'refuse',
      code: 'snapshot_integrity_unavailable',
      message: actor === 'ai_agent'
        ? RESTORE_INTEGRITY_MESSAGES.ai_unattested
        : RESTORE_INTEGRITY_MESSAGES.snapshot_integrity_unavailable,
    });
  });

  it('passes allow and refuse through unchanged', () => {
    expect(gateForActor({ kind: 'allow' }, 'ai_agent')).toEqual({ kind: 'allow' });
    const refuse = { kind: 'refuse', code: 'attestation_pending', message: 'x' } as const;
    expect(gateForActor(refuse, 'user')).toBe(refuse);
  });
});

describe('overrideIntegrityPayload', () => {
  it('is the exact wire shape the helper reads for a confirmed restore', () => {
    expect(overrideIntegrityPayload(SNAP, AUTH_ID)).toEqual({
      v: 1,
      mode: 'unattested_override',
      snapshotId: SNAP,
      authorizationId: AUTH_ID,
    });
  });
});
