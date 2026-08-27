import type { Context, Next } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  dbAccessContextFromAuth,
  isAiAgentPrincipal,
  isInteractiveUserSession,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { checkPermissionRequirement, checkPermissionRequirements } from '../aiGuardrails';
import {
  AgentRunOwnershipError,
  agentDbAccessContext,
  buildAgentAuthContext,
} from './agentAuthContext';

const agentPartner = {
  id: 'agent-1',
  orgId: null,
  partnerId: 'partner-A',
  name: 'Triage',
  kind: 'triage' as const,
};
const agentOrg = {
  id: 'agent-2',
  orgId: 'org-1',
  partnerId: null,
  name: 'Triage',
  kind: 'triage' as const,
};
const run = { id: 'run-1', orgId: 'org-1', deviceId: null };
const org1 = { id: 'org-1', partnerId: 'partner-A' };

describe('buildAgentAuthContext', () => {
  it('builds an org-scoped, token-less context for a partner agent over one of its orgs', () => {
    const auth = buildAgentAuthContext(agentPartner, run, org1);

    expect(auth.principal).toEqual({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' });
    expect(auth.user).toEqual({
      id: 'agent-1',
      email: 'agent+agent-1@breeze.internal',
      name: 'Triage',
      isPlatformAdmin: false,
    });
    expect(auth.scope).toBe('organization');
    expect(auth.orgId).toBe('org-1');
    expect(auth.accessibleOrgIds).toEqual(['org-1']);
    expect(auth.partnerId).toBe('partner-A');
    expect(auth.partnerOrgAccess).toBeNull();
    expect(auth.token).toBeNull();
    expect(auth.canAccessOrg('org-1')).toBe(true);
    expect(auth.canAccessOrg('org-2')).toBe(false);
    expect(isAiAgentPrincipal(auth)).toBe(true);
  });

  it('rejects a partner agent over an org of another partner', () => {
    expect(() =>
      buildAgentAuthContext(agentPartner, run, { id: 'org-1', partnerId: 'partner-B' })
    ).toThrow(AgentRunOwnershipError);
  });

  it('rejects an org agent over a different org', () => {
    expect(() =>
      buildAgentAuthContext(
        agentOrg,
        { ...run, orgId: 'org-9' },
        { id: 'org-9', partnerId: 'partner-A' }
      )
    ).toThrow(AgentRunOwnershipError);
  });

  it('pins a device-bound run to the exact device, not just its site', () => {
    const deviceRun = { id: 'run-2', orgId: 'org-1', deviceId: 'device-1', deviceSiteId: 'site-A' };
    const auth = buildAgentAuthContext(agentOrg, deviceRun, org1);

    expect(auth.allowedDeviceIds).toEqual(['device-1']);
    // The existing site-level pin stays in place alongside the new device pin.
    expect(auth.allowedSiteIds).toEqual(['site-A']);
  });

  it('does not set allowedDeviceIds for a non-device-bound (org-wide) run', () => {
    const auth = buildAgentAuthContext(agentOrg, run, org1);

    expect(auth.allowedDeviceIds).toBeUndefined();
  });

  it('never carries a user id in either DB access-context path', () => {
    const auth = buildAgentAuthContext(agentPartner, run, org1);
    const expected = {
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: 'partner-A',
    };

    expect(agentDbAccessContext('org-1', 'partner-A')).toEqual(expected);
    expect(dbAccessContextFromAuth(auth)).toEqual(expected);
  });
});

describe('ai_agent user-RBAC denial', () => {
  const auth = buildAgentAuthContext(agentPartner, run, org1);

  it('exhaustively denies every user-RBAC helper before its default behavior', async () => {
    const helperDenials = [
      {
        name: 'isInteractiveUserSession',
        denied: () => !isInteractiveUserSession(auth),
      },
      {
        name: 'checkPermissionRequirements (empty)',
        denied: async () =>
          (await checkPermissionRequirements(auth, [])) ===
          'AI agent principals are never granted user permissions',
      },
      {
        name: 'checkPermissionRequirements (non-empty)',
        denied: async () =>
          (await checkPermissionRequirements(auth, [{ resource: 'devices', action: 'write' }])) ===
          'AI agent principals are never granted user permissions',
      },
      {
        name: 'checkPermissionRequirement',
        denied: async () =>
          (await checkPermissionRequirement(auth, { resource: 'devices', action: 'write' })) ===
          'AI agent principals are never granted user permissions',
      },
    ];

    for (const helper of helperDenials) {
      expect(await helper.denied(), helper.name).toBe(true);
    }
  });

  const middlewareDenials = [
    { name: 'requireScope', middleware: requireScope('organization') },
    { name: 'requirePermission', middleware: requirePermission('devices', 'write') },
    { name: 'requireMfa', middleware: requireMfa() },
  ];

  it.each(middlewareDenials)('$name denies before any permissive fallback', async ({ middleware }) => {
    const context = {
      get: (key: string) => (key === 'auth' ? auth : undefined),
    } as unknown as Context;
    const next: Next = async () => {};

    await expect(middleware(context, next)).rejects.toMatchObject({
      status: 403,
      message: 'AI agents cannot call HTTP routes',
    });
  });
});
