import { describe, it, expect } from 'vitest';
import {
  m365WriteActionSchema,
  writeActionRequestSchema,
  writeActionResultSchema,
  writeActionFailureCodeSchema,
  M365_WRITE_ACTION_IDS,
  M365_PROBE_ACTION_IDS,
  M365_WRITE_ACTION_IDEMPOTENCY,
  M365_WRITE_ACTION_REQUIRED_ROLES,
} from './writeActions';

const UUID = '00000000-0000-4000-8000-000000000001';

describe('m365WriteActionSchema', () => {
  it('accepts the two first-cut actions', () => {
    expect(m365WriteActionSchema.parse({ type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'offboard' }).type)
      .toBe('m365.user.disable');
    expect(m365WriteActionSchema.parse({ type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'compromised' }).type)
      .toBe('m365.user.reset_password');
  });

  it('rejects an unknown action id', () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.delete', userIdentifier: 'a@b.com', reason: 'x' }).success)
      .toBe(false);
  });

  it('rejects extra keys (strict) and a missing reason', () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x', extra: 1 }).success)
      .toBe(false);
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: 'a@b.com' }).success)
      .toBe(false);
  });

  it("rejects a userIdentifier containing quotes/backslashes", () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: "a'b@example.com", reason: 'x' }).success)
      .toBe(false);
  });
});

describe('writeActionRequestSchema', () => {
  it('requires correlationId, tenantId, idempotencyKey, action', () => {
    const ok = writeActionRequestSchema.safeParse({
      correlationId: UUID, tenantId: UUID, idempotencyKey: 'intent-123',
      action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
    });
    expect(ok.success).toBe(true);
    expect(writeActionRequestSchema.safeParse({
      correlationId: UUID, tenantId: UUID,
      action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
    }).success).toBe(false); // missing idempotencyKey
  });
});

describe('writeActionResultSchema', () => {
  it('accepts a disable success', () => {
    expect(writeActionResultSchema.safeParse({ success: true, action: 'm365.user.disable', userId: UUID }).success).toBe(true);
  });
  it('accepts a reset success with temporaryPassword', () => {
    expect(writeActionResultSchema.safeParse({
      success: true, action: 'm365.user.reset_password', userId: UUID,
      temporaryPassword: 'Tmp!23xyz', forceChangeNextSignIn: true,
    }).success).toBe(true);
  });
  it('accepts a failure with a known code', () => {
    expect(writeActionResultSchema.safeParse({ success: false, errorCode: 'user_not_found' }).success).toBe(true);
    expect(writeActionResultSchema.safeParse({ success: false, errorCode: 'not_a_code' }).success).toBe(false);
  });
});

describe('M1 identity write catalog contract', () => {
  it('pins the mutating action id list', () => {
    expect([...M365_WRITE_ACTION_IDS]).toEqual([
      'm365.user.disable',
      'm365.user.reset_password',
      'm365.user.revoke_sessions',
      'm365.user.license.remove',
      'm365.user.license.assign',
      'm365.group.membership.remove',
      'm365.group.membership.add',
      'm365.intune.device.retire',
      'm365.user.create',
      'm365.user.mailbox.auto_reply',
    ]);
  });

  it('pins the probe action id list and keeps it disjoint from the write ids', () => {
    expect([...M365_PROBE_ACTION_IDS]).toEqual(['m365.user.mailbox.auto_reply.state']);
    for (const id of M365_PROBE_ACTION_IDS) {
      expect((M365_WRITE_ACTION_IDS as readonly string[]).includes(id)).toBe(false);
    }
  });

  it('classifies every mutating action for idempotency', () => {
    expect(M365_WRITE_ACTION_IDEMPOTENCY).toEqual({
      'm365.user.disable': 'idempotent',
      'm365.user.reset_password': 'non_idempotent',
      // Each call moves the session cutoff forward (and so also ends sessions
      // opened since the first call): repeat only when the probe says it is not done.
      'm365.user.revoke_sessions': 'idempotent_by_probe',
      'm365.user.license.remove': 'idempotent',
      'm365.user.license.assign': 'idempotent_by_probe',
      'm365.group.membership.remove': 'idempotent',
      'm365.group.membership.add': 'idempotent',
      'm365.intune.device.retire': 'idempotent',
      'm365.user.create': 'non_idempotent',
      'm365.user.mailbox.auto_reply': 'idempotent_by_probe',
    });
    expect(Object.keys(M365_WRITE_ACTION_IDEMPOTENCY).sort())
      .toEqual([...M365_WRITE_ACTION_IDS].sort());
  });

  it('names the app roles every executor action needs', () => {
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.disable']).toEqual(['User.ReadWrite.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.reset_password'])
      .toEqual(['User.ReadWrite.All', 'User-PasswordProfile.ReadWrite.All']);
    // Microsoft documents User.RevokeSessions.All as the ONLY application
    // permission for revokeSignInSessions (higher-privileged: "Not available").
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.revoke_sessions'])
      .toEqual(['User.ReadWrite.All', 'User.RevokeSessions.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.license.assign'])
      .toEqual(['User.ReadWrite.All', 'Organization.Read.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.group.membership.remove'])
      .toEqual(['GroupMember.ReadWrite.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.intune.device.retire'])
      .toEqual(['DeviceManagementManagedDevices.PrivilegedOperations.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.create']).toEqual(['User.ReadWrite.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.mailbox.auto_reply'])
      .toEqual(['MailboxSettings.ReadWrite']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.mailbox.auto_reply.state'])
      .toEqual(['MailboxSettings.ReadWrite']);
    expect(Object.keys(M365_WRITE_ACTION_REQUIRED_ROLES).sort())
      .toEqual([...M365_WRITE_ACTION_IDS, ...M365_PROBE_ACTION_IDS].sort());
  });

  it('adds the four new failure codes', () => {
    for (const code of ['license_unavailable', 'unsupported_group_type', 'device_not_found', 'user_already_exists']) {
      expect(writeActionFailureCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});

const GROUP = '00000000-0000-4000-8000-0000000000aa';
const SKU = '00000000-0000-4000-8000-0000000000bb';
const DEVICE = '00000000-0000-4000-8000-0000000000cc';

const MINIMAL_ARMS: Record<string, Record<string, unknown>> = {
  'm365.user.revoke_sessions': { type: 'm365.user.revoke_sessions', userIdentifier: 'a@b.com', reason: 'x' },
  'm365.user.license.remove': { type: 'm365.user.license.remove', userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'x' },
  'm365.user.license.assign': { type: 'm365.user.license.assign', userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'x' },
  'm365.group.membership.remove': { type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'x' },
  'm365.group.membership.add': { type: 'm365.group.membership.add', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'x' },
  'm365.intune.device.retire': { type: 'm365.intune.device.retire', managedDeviceId: DEVICE, reason: 'x' },
  'm365.user.create': {
    type: 'm365.user.create', userPrincipalName: 'new.user@b.com', displayName: 'New User',
    mailNickname: 'new.user', usageLocation: 'US', reason: 'x',
  },
  'm365.user.mailbox.auto_reply': { type: 'm365.user.mailbox.auto_reply', userIdentifier: 'a@b.com', status: 'alwaysEnabled', reason: 'x' },
};

describe('m365WriteActionSchema — M1 arms', () => {
  it.each(Object.entries(MINIMAL_ARMS))('accepts a minimal %s', (_id, body) => {
    expect(m365WriteActionSchema.safeParse(body).success).toBe(true);
  });

  it.each(Object.entries(MINIMAL_ARMS))('rejects an extra key on %s', (_id, body) => {
    expect(m365WriteActionSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  it.each(Object.entries(MINIMAL_ARMS))('rejects a missing reason on %s', (_id, body) => {
    const { reason: _reason, ...rest } = body;
    expect(m365WriteActionSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts the read-only auto-reply probe arm, which takes no reason', () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.mailbox.auto_reply.state', userIdentifier: 'a@b.com' }).success)
      .toBe(true);
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.mailbox.auto_reply.state', userIdentifier: 'a@b.com', reason: 'x' }).success)
      .toBe(false);
  });

  it('bounds skuIds to 1..20', () => {
    const base = MINIMAL_ARMS['m365.user.license.assign']!;
    expect(m365WriteActionSchema.safeParse({ ...base, skuIds: [] }).success).toBe(false);
    expect(m365WriteActionSchema.safeParse({ ...base, skuIds: Array.from({ length: 21 }, () => SKU) }).success).toBe(false);
    expect(m365WriteActionSchema.safeParse({ ...base, skuIds: Array.from({ length: 20 }, () => SKU) }).success).toBe(true);
  });

  it('rejects a non-GUID groupId', () => {
    expect(m365WriteActionSchema.safeParse({ ...MINIMAL_ARMS['m365.group.membership.add'], groupId: 'not-a-guid' }).success)
      .toBe(false);
  });

  it('requires a two-letter upper-case usageLocation', () => {
    expect(m365WriteActionSchema.safeParse({ ...MINIMAL_ARMS['m365.user.create'], usageLocation: 'USA' }).success).toBe(false);
    expect(m365WriteActionSchema.safeParse({ ...MINIMAL_ARMS['m365.user.create'], usageLocation: 'us' }).success).toBe(false);
  });

  it('requires both schedule instants on a scheduled auto-reply', () => {
    const base = { ...MINIMAL_ARMS['m365.user.mailbox.auto_reply'], status: 'scheduled' };
    expect(m365WriteActionSchema.safeParse({ ...base, scheduledStartDateTime: '2026-10-01T00:00:00Z' }).success).toBe(false);
    expect(m365WriteActionSchema.safeParse({
      ...base, scheduledStartDateTime: '2026-10-01T00:00:00Z', scheduledEndDateTime: '2026-10-08T00:00:00Z',
    }).success).toBe(true);
  });

  it('carries an M1 action through the request schema', () => {
    expect(writeActionRequestSchema.safeParse({
      correlationId: UUID, tenantId: UUID, idempotencyKey: 'k', action: MINIMAL_ARMS['m365.group.membership.remove'],
    }).success).toBe(true);
  });
});

describe('writeActionResultSchema — M1 arms', () => {
  const successes: Record<string, Record<string, unknown>> = {
    'm365.user.revoke_sessions': { success: true, action: 'm365.user.revoke_sessions', userId: UUID },
    'm365.user.license.remove': { success: true, action: 'm365.user.license.remove', userId: UUID, removedSkuIds: [SKU], noop: false },
    'm365.user.license.assign': { success: true, action: 'm365.user.license.assign', userId: UUID, assignedSkuIds: [SKU], noop: false },
    'm365.group.membership.remove': { success: true, action: 'm365.group.membership.remove', userId: UUID, groupId: GROUP, noop: true },
    'm365.group.membership.add': { success: true, action: 'm365.group.membership.add', userId: UUID, groupId: GROUP, noop: false },
    'm365.intune.device.retire': { success: true, action: 'm365.intune.device.retire', managedDeviceId: DEVICE },
    'm365.user.create': {
      success: true, action: 'm365.user.create', userId: UUID, userPrincipalName: 'new.user@b.com',
      temporaryPassword: 'Tmp!23xyz', forceChangeNextSignIn: true,
    },
    'm365.user.mailbox.auto_reply': { success: true, action: 'm365.user.mailbox.auto_reply', userId: UUID, status: 'disabled' },
    'm365.user.mailbox.auto_reply.state': {
      success: true, action: 'm365.user.mailbox.auto_reply.state', userId: UUID, status: 'scheduled',
      externalAudience: 'all', hasInternalReplyMessage: true, hasExternalReplyMessage: false,
      scheduledStartDateTime: '2026-10-01T00:00:00Z', scheduledEndDateTime: null,
    },
  };

  it.each(Object.entries(successes))('accepts a %s success', (_id, body) => {
    expect(writeActionResultSchema.safeParse(body).success).toBe(true);
  });

  it('rejects a user.create success without temporaryPassword', () => {
    expect(writeActionResultSchema.safeParse({
      success: true, action: 'm365.user.create', userId: UUID, userPrincipalName: 'new.user@b.com', forceChangeNextSignIn: true,
    }).success).toBe(false);
  });

  it('never accepts a reply body on the probe result', () => {
    expect(writeActionResultSchema.safeParse({
      ...successes['m365.user.mailbox.auto_reply.state'], internalReplyMessage: 'Out of office',
    }).success).toBe(false);
  });
});
