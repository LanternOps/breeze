import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import {
  ALERT_SEVERITY_KINDS,
  allowsRunScript,
  buildAgentSaveBody,
  draftFrom,
  firstFreeKind,
  freeKinds,
  lines,
  toggle,
  type Draft,
} from './agentDraft';

/**
 * Task 13 (#5051), order-of-work step 1: this file pins `buildAgentSaveBody`'s
 * output for a partner draft and an org draft, so a future edit to either
 * `AiAgentForm.tsx`'s drawer or `AgentCreateFlow.tsx`'s guided flow cannot
 * silently diverge the two POST/PATCH bodies — the whole point of extracting
 * this module (spec §4.6).
 */

function baseDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    ownerScope: 'organization',
    kind: 'triage',
    name: 'Triage bot',
    enabled: false,
    mode: 'shadow',
    severities: ['critical', 'high'],
    respectMaintenanceWindows: true,
    toolAllowlist: 'manage_services:restart\nrun_script',
    services: 'spooler',
    paths: '',
    registryKeys: '',
    limits: { ...AI_AGENT_LIMIT_DEFAULTS },
    cooldownSeconds: 900,
    roleIds: ['role-1'],
    instructions: '',
    supervisedActionKeys: [],
    scriptIds: [],
    ticketAutonomousWrites: false,
    ...overrides,
  };
}

describe('lines', () => {
  it('trims, drops blanks and de-duplicates', () => {
    expect(lines(' a \n\nb\na \n')).toEqual(['a', 'b']);
  });
});

describe('toggle', () => {
  it('adds a value not present and removes one that is', () => {
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('freeKinds / firstFreeKind', () => {
  const agents = [
    { id: 'p1', kind: 'triage' as const, ownerScope: 'partner' as const, orgId: null },
    { id: 'o1', kind: 'patch' as const, ownerScope: 'organization' as const, orgId: 'org-1' },
  ] as unknown as Parameters<typeof freeKinds>[0];

  it('excludes a kind already taken on the SAME ownership axis, independently per axis', () => {
    expect(freeKinds(agents, 'partner', 'org-1')).toEqual(['patch', 'helpdesk']);
    expect(freeKinds(agents, 'organization', 'org-1')).toEqual(['triage', 'helpdesk']);
    expect(firstFreeKind(agents, 'partner', 'org-1')).toBe('patch');
  });

  it('never lets one org own a kind another org already owns', () => {
    expect(freeKinds(agents, 'organization', 'org-2')).toEqual(['triage', 'patch', 'helpdesk']);
  });
});

describe('draftFrom', () => {
  it('defaults a create draft to shadow mode, switched off, with the given owner scope and kind', () => {
    const draft = draftFrom(null, { ownerScope: 'partner', kind: 'patch' });
    expect(draft.ownerScope).toBe('partner');
    expect(draft.kind).toBe('patch');
    expect(draft.mode).toBe('shadow');
    expect(draft.enabled).toBe(false);
    expect(draft.severities).toEqual(['critical', 'high']);
    expect(draft.cooldownSeconds).toBe(900);
  });

  it('drops a stored severity the shared ALERT_SEVERITIES no longer recognises, rather than crashing', () => {
    const draft = draftFrom(
      {
        kind: 'triage',
        ownerScope: 'organization',
        orgId: 'org-1',
        triggers: { alertSeverities: ['critical', 'not_a_real_severity'] },
      } as never,
      { ownerScope: 'organization', kind: 'triage' },
    );
    expect(draft.severities).toEqual(['critical']);
  });
});

describe('buildAgentSaveBody', () => {
  it('pins the PARTNER draft body: create-only kind/ownerScope, no orgId, live actAssets', () => {
    const draft = baseDraft({ ownerScope: 'partner', mode: 'act', supervisedActionKeys: ['manage_services:restart'] });
    const body = buildAgentSaveBody(draft, { isCreate: true, orgId: null });
    expect(body).toEqual({
      name: 'Triage bot',
      enabled: false,
      mode: 'act',
      triggers: {
        alertSeverities: ['critical', 'high'],
        respectMaintenanceWindows: true,
        ticketAutonomousWrites: false,
      },
      toolAllowlist: ['manage_services:restart', 'run_script'],
      protectedResources: { services: ['spooler'], paths: [], registryKeys: [] },
      limits: { ...AI_AGENT_LIMIT_DEFAULTS },
      cooldownSeconds: 900,
      recipients: { roleIds: ['role-1'] },
      instructions: null,
      actAssets: { supervisedActionKeys: ['manage_services:restart'], scriptIds: [] },
      kind: 'triage',
      ownerScope: 'partner',
    });
  });

  it('pins the ORG draft body: create-only orgId set, actAssets carries scriptIds only (#5049 grant-only keys, #5065 scripts)', () => {
    const draft = baseDraft({
      ownerScope: 'organization',
      mode: 'act',
      supervisedActionKeys: ['manage_services:restart'],
      scriptIds: ['3c1f5c8e-2b1d-4c5e-9a1b-2f3d4e5f6a7b'],
    });
    const body = buildAgentSaveBody(draft, { isCreate: true, orgId: 'org-1' });
    expect(body).toEqual({
      name: 'Triage bot',
      enabled: false,
      mode: 'act',
      triggers: {
        alertSeverities: ['critical', 'high'],
        respectMaintenanceWindows: true,
        ticketAutonomousWrites: false,
      },
      toolAllowlist: ['manage_services:restart', 'run_script'],
      protectedResources: { services: ['spooler'], paths: [], registryKeys: [] },
      limits: { ...AI_AGENT_LIMIT_DEFAULTS },
      cooldownSeconds: 900,
      recipients: { roleIds: ['role-1'] },
      instructions: null,
      actAssets: { scriptIds: ['3c1f5c8e-2b1d-4c5e-9a1b-2f3d4e5f6a7b'] },
      kind: 'triage',
      ownerScope: 'organization',
      orgId: 'org-1',
    });
    // Never the keys: an org row's supervisedActionKeys are grant-only.
    expect(body.actAssets).not.toHaveProperty('supervisedActionKeys');
  });

  it('a PATCH body (isCreate: false) carries the policy fields only — no kind/ownerScope/orgId', () => {
    const draft = baseDraft();
    const body = buildAgentSaveBody(draft, { isCreate: false, orgId: 'org-1' });
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('ownerScope');
    expect(body).not.toHaveProperty('orgId');
  });

  it('omits triggers.alertSeverities for a kind that never reads it (ALERT_SEVERITY_KINDS)', () => {
    expect(ALERT_SEVERITY_KINDS.has('patch')).toBe(false);
    const draft = baseDraft({ kind: 'patch', ownerScope: 'partner' });
    const body = buildAgentSaveBody(draft, { isCreate: true, orgId: null });
    expect(body.triggers).not.toHaveProperty('alertSeverities');
  });

  it('sends actAssets.supervisedActionKeys as [] on a partner draft not in act mode, even if the draft holds a stale selection', () => {
    const draft = baseDraft({ ownerScope: 'partner', mode: 'shadow', supervisedActionKeys: ['manage_services:restart'] });
    const body = buildAgentSaveBody(draft, { isCreate: true, orgId: null });
    expect(body.actAssets).toEqual({ supervisedActionKeys: [], scriptIds: [] });
  });

  it('allowsRunScript recognises the bare and scoped forms only (#5065)', () => {
    expect(allowsRunScript('manage_services:restart\nrun_script')).toBe(true);
    expect(allowsRunScript('run_script:execute')).toBe(true);
    expect(allowsRunScript('manage_services:restart\nrun_playbook')).toBe(false);
    expect(allowsRunScript('')).toBe(false);
  });
});
