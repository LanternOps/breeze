import { beforeEach, describe, expect, it, vi } from 'vitest';

const { audit, state } = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  state: {
    trustState: 'probation' as 'probation' | 'trusted' | 'restricted',
    probationEnrollments: 0,
    trustReviewRequestedAt: null as Date | null,
  },
}));

vi.mock('./auditService', () => ({ createAuditLog: audit }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: vi.fn(() => 'enforce') }));
vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./partnerTrust.repo', () => ({
  readTrust: vi.fn(async () => state),
  writeTrust: vi.fn(async () => {}),
  partnerForDevice: vi.fn(async () => 'p1'),
}));

import { partnerTrustMode } from '../config/partnerTrustMode';
import { CommandTypes } from './commandQueue';
import {
  evaluateCapability,
  GATED_COMMAND_TYPES,
  isLifecycleCommand,
  LIFECYCLE_COMMAND_TYPES,
} from './partnerTrust';

beforeEach(() => {
  audit.mockClear();
  state.trustState = 'probation';
  state.probationEnrollments = 0;
  vi.mocked(partnerTrustMode).mockReturnValue('enforce');
});

describe('evaluateCapability', () => {
  it.each(['remote_control', 'device_execute', 'installer_distribute'] as const)(
    'denies %s in probation',
    async (cap) => {
      const d = await evaluateCapability(cap, { partnerId: 'p1' });
      expect(d).toMatchObject({ allow: false, code: 'TRUST_PROBATION', capability: cap });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'partner.trust.capability_denied',
      }));
    },
  );

  it('denies with TRUST_RESTRICTED when restricted', async () => {
    state.trustState = 'restricted';
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' }))
      .toMatchObject({ allow: false, code: 'TRUST_RESTRICTED' });
  });

  it('allows everything when trusted and writes no audit row', async () => {
    state.trustState = 'trusted';
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' })).toEqual({ allow: true });
    expect(audit).not.toHaveBeenCalled();
  });

  it('allows enroll under the cap and denies at the cap', async () => {
    state.probationEnrollments = 4;
    expect(await evaluateCapability('agent_enroll', { partnerId: 'p1' })).toEqual({ allow: true });
    state.probationEnrollments = 5;
    expect(await evaluateCapability('agent_enroll', { partnerId: 'p1' }))
      .toMatchObject({ allow: false, reason: 'probation_enrollment_cap' });
  });

  it('uses the row-locked enrollment count from detail when supplied', async () => {
    state.probationEnrollments = 4;
    expect(await evaluateCapability('agent_enroll', {
      partnerId: 'p1',
      detail: { probationEnrollments: 5 },
    })).toMatchObject({ allow: false, reason: 'probation_enrollment_cap' });
  });

  it('lets lifecycle commands through device_execute even in probation', async () => {
    expect(await evaluateCapability('device_execute', {
      partnerId: 'p1',
      commandType: 'self_uninstall',
    })).toEqual({ allow: true });
  });

  it('shadow mode allows but records the would-deny', async () => {
    vi.mocked(partnerTrustMode).mockReturnValue('shadow');
    const d = await evaluateCapability('remote_control', { partnerId: 'p1' });
    expect(d).toMatchObject({ allow: true, shadowDenied: { code: 'TRUST_PROBATION' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.trust.capability_denied',
      details: expect.objectContaining({ mode: 'shadow' }),
    }));
  });

  it('off mode allows and touches nothing', async () => {
    vi.mocked(partnerTrustMode).mockReturnValue('off');
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' })).toEqual({ allow: true });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('command allowlist', () => {
  const dispatchLiteralsOutsideCommandTypes = [
    'actuate_elevation',
    'apply_browser_policy',
    'desktop_config',
    'desktop_input',
    'desktop_stream_start',
    'desktop_stream_stop',
    'dev_update',
    'network_discovery',
    'network_dns_check',
    'network_http_check',
    'network_ping',
    'network_tcp_check',
    'pam_apply_v2',
    'pam_cleanup_v2',
    'reboot',
    'restart_agent',
    'schedule_reboot',
    'set_auto_update',
    'shutdown',
    'snmp_poll',
    'start_desktop',
    'stop_desktop',
    'support_end',
    'tunnel_close',
    'tunnel_data',
    'tunnel_open',
    'update',
    'update_agent',
    'update_watchdog',
  ] as const;
  const realCommandTypes = [
    ...Object.values(CommandTypes),
    ...dispatchLiteralsOutsideCommandTypes,
  ];

  it('classifies every known command type exactly once', () => {
    expect(new Set(realCommandTypes).size).toBe(realCommandTypes.length);
    const lifecycle = new Set<string>(LIFECYCLE_COMMAND_TYPES);
    const gated = new Set<string>(GATED_COMMAND_TYPES);
    expect(LIFECYCLE_COMMAND_TYPES.filter((type) => gated.has(type))).toEqual([]);
    for (const type of realCommandTypes) {
      expect(
        Number(lifecycle.has(type)) + Number(gated.has(type)),
        `expected ${type} in exactly one command classification`,
      ).toBe(1);
      expect(isLifecycleCommand(type)).toBe(lifecycle.has(type));
    }
  });

  it('contains no stale command names from the proposed brief inventory', () => {
    const classified = new Set<string>([
      ...LIFECYCLE_COMMAND_TYPES,
      ...GATED_COMMAND_TYPES,
    ]);
    for (const type of classified) {
      expect(realCommandTypes, `classified command ${type} must exist in the repository inventory`)
        .toContain(type as (typeof realCommandTypes)[number]);
    }
  });

  it('an unknown command type is gated (fail closed)', () => {
    expect(isLifecycleCommand('brand_new_command')).toBe(false);
  });
});
