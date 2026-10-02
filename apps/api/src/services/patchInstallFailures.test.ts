import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { deviceCommandOutcome } from './patchInstallFailures';

const PATCH = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function envelope(status: string, summary: unknown, extra: Record<string, unknown> = {}) {
  return { status, exitCode: status === 'completed' ? 0 : 1, stdout: JSON.stringify(summary), ...extra };
}

// The SQL that picks the latest attempt is covered against real Postgres by
// __tests__/integration/patchInstallFailureStatus.integration.test.ts; this is
// the per-patch reading of one stored install_patches result (#7680).
describe('deviceCommandOutcome', () => {
  it('reads an installed entry that needs a restart', () => {
    const result = envelope('completed', {
      results: [{ id: PATCH, status: 'installed', rebootRequired: true, message: 'installed but not verified — reboot may be required' }],
    });
    expect(deviceCommandOutcome('completed', result, PATCH)).toEqual({ outcome: 'installed', error: null, rebootRequired: true });
  });

  it('reads the per-patch error of a failed entry, not the envelope summary', () => {
    const result = envelope(
      'failed',
      { results: [{ id: OTHER, status: 'installed' }, { id: PATCH, status: 'failed', error: 'WUA install: 0x80240022' }] },
      { error: '1 patch operations failed' },
    );
    expect(deviceCommandOutcome('failed', result, PATCH)).toEqual({ outcome: 'failed', error: 'WUA install: 0x80240022', rebootRequired: false });
    // The sibling patch in the same failed command installed fine.
    expect(deviceCommandOutcome('failed', result, OTHER)).toEqual({ outcome: 'installed', error: null, rebootRequired: false });
  });

  it('a skipped entry is neither a failure nor an install', () => {
    const result = envelope('completed', { results: [{ id: PATCH, status: 'skipped', skipReason: 'not_offered' }] });
    expect(deviceCommandOutcome('completed', result, PATCH).outcome).toBe('other');
  });

  it('a whole-command failure with no per-patch lines fails the patch with the envelope error', () => {
    const result = { status: 'failed', exitCode: 1, error: 'preflight check "battery" failed: running on battery power' };
    expect(deviceCommandOutcome('failed', result, PATCH)).toEqual({
      outcome: 'failed',
      error: 'preflight check "battery" failed: running on battery power',
      rebootRequired: false,
    });
  });

  it('a completed command with no line for this patch says nothing about it', () => {
    const result = envelope('completed', { results: [{ id: OTHER, status: 'installed' }] });
    expect(deviceCommandOutcome('completed', result, PATCH).outcome).toBe('other');
  });

  it('a server-side timeout is a failure with the reaper reason', () => {
    const result = { status: 'timeout', error: 'Server-side timeout: no response from agent after 120 minutes', timedOutBy: 'server' };
    expect(deviceCommandOutcome('timeout', result, PATCH)).toEqual({
      outcome: 'failed',
      error: 'Server-side timeout: no response from agent after 120 minutes',
      rebootRequired: false,
    });
  });

  it('a queued or in-flight command is an attempt with no outcome yet', () => {
    expect(deviceCommandOutcome('pending', null, PATCH).outcome).toBe('other');
    expect(deviceCommandOutcome('sent', null, PATCH).outcome).toBe('other');
  });

  it('tolerates unparsable stdout and an already-parsed summary object', () => {
    expect(deviceCommandOutcome('failed', { stdout: '{not json', error: 'boom' }, PATCH)).toEqual({
      outcome: 'failed',
      error: 'boom',
      rebootRequired: false,
    });
    expect(
      deviceCommandOutcome('completed', { stdout: { results: [{ patchId: PATCH, success: true, rebootRequired: false }] } }, PATCH),
    ).toEqual({ outcome: 'installed', error: null, rebootRequired: false });
  });
});
