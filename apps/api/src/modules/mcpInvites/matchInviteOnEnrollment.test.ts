import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { update: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  deploymentInvites: {
    enrollmentKeyId: 'enrollmentKeyId',
    enrolledAt: 'enrolledAt',
  },
}));

import { matchDeploymentInviteOnEnrollment, type MatchInviteDb } from './matchInviteOnEnrollment';

describe('matchDeploymentInviteOnEnrollment', () => {
  let db: { update: ReturnType<typeof vi.fn> };
  let setSpy: ReturnType<typeof vi.fn>;
  let whereSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    whereSpy = vi.fn().mockResolvedValue(undefined);
    setSpy = vi.fn(() => ({ where: whereSpy }));
    db = { update: vi.fn(() => ({ set: setSpy })) };
  });

  it('updates matching pending-enrollment invites with enrolled status + deviceId', async () => {
    const now = new Date('2026-04-19T12:00:00Z');

    await matchDeploymentInviteOnEnrollment(
      { enrollmentKeyId: 'key-abc', deviceId: 'dev-1', now },
      db as unknown as MatchInviteDb,
    );

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({
      status: 'enrolled',
      enrolledAt: now,
      deviceId: 'dev-1',
    });
    expect(whereSpy).toHaveBeenCalledTimes(1);
    // The where clause must include both the key-id eq and the isNull(enrolledAt)
    // guard so re-enrollments don't clobber the first-enrolled timestamp.
    // We don't introspect the drizzle AST here — the call shape and guard are
    // enforced by integration tests and the RLS contract test.
  });

  it('swallows db errors so enrollment never fails because of invite-matching', async () => {
    whereSpy.mockRejectedValueOnce(new Error('connection closed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      matchDeploymentInviteOnEnrollment(
        { enrollmentKeyId: 'key-abc', deviceId: 'dev-1' },
        db as unknown as MatchInviteDb,
      ),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('matchDeploymentInviteOnEnrollment'),
      expect.anything(),
    );
    consoleSpy.mockRestore();
  });

  it('uses a default timestamp when `now` is omitted', async () => {
    await matchDeploymentInviteOnEnrollment(
      { enrollmentKeyId: 'key-abc', deviceId: 'dev-1' },
      db as unknown as MatchInviteDb,
    );
    const call = setSpy.mock.calls[0]?.[0] as { enrolledAt: Date };
    expect(call.enrolledAt).toBeInstanceOf(Date);
  });
});
