import { describe, expect, it } from 'vitest';
import {
  RESTORE_POINT_REQUEST_BLOCK_KEYS,
  RESTORE_POINT_REQUEST_VERSION,
  RESTORE_POINT_STATUSES,
  RESTORE_POINT_TRIGGERS,
  type RestorePointRequestBlock,
} from './restorePoint';

describe('restore-point wire contract (#4609)', () => {
  it('pins the exact key set of the restorePoint block the agent parses', () => {
    // agent/internal/systemrestore/request.go reads exactly these keys. A
    // rename here silently turns every block into "missing" on the agent,
    // which for install_patches means legacy-enabled regardless of policy.
    expect([...RESTORE_POINT_REQUEST_BLOCK_KEYS].sort()).toEqual(
      ['enabled', 'label', 'policyRevision', 'requestId', 'resolvedAt', 'v', 'validUntil'],
    );
  });

  it('a value typed as the block carries exactly the pinned keys', () => {
    const block: RestorePointRequestBlock = {
      v: RESTORE_POINT_REQUEST_VERSION,
      requestId: '00000000-0000-4000-8000-000000000000',
      enabled: true,
      label: 'Breeze: run script X',
      resolvedAt: '2026-10-12T00:00:00.000Z',
      policyRevision: '',
      validUntil: '2026-10-13T00:00:00.000Z',
    };
    expect(Object.keys(block).sort()).toEqual([...RESTORE_POINT_REQUEST_BLOCK_KEYS].sort());
    expect(RESTORE_POINT_REQUEST_VERSION).toBe(1);
  });

  it('pins triggers and statuses', () => {
    expect([...RESTORE_POINT_TRIGGERS]).toEqual(['patch', 'script', 'software_install']);
    expect(RESTORE_POINT_STATUSES[0]).toBe('requested');
    expect(RESTORE_POINT_STATUSES).toHaveLength(11);
    expect([...RESTORE_POINT_STATUSES]).toEqual([
      'requested',
      'created',
      'existing_accepted',
      'skipped_disabled',
      'skipped_definition_only',
      'skipped_no_mutation',
      'unsupported',
      'busy',
      'insufficient_privileges',
      'verification_failed',
      'failed',
    ]);
  });
});
