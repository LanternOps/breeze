/**
 * Agent-run site scope: the `targetType:'site'` + `targetId(s)` input shape
 * (2026-09-17 AI tool SITE/ROLE audit §2.8).
 *
 * `siteScopeDenial` used to inspect only explicitly site-NAMED keys
 * (`siteId`, `site_id`, `targetSiteId`, `siteIds`, `site_ids`). A device-bound
 * agent run could therefore name an out-of-scope site through the assignment
 * shape the policy tools actually use — `{ level: 'site', targetId }`,
 * `{ targetType: 'site', targetIds: [...] }` and the peripheral tools'
 * `{ target_type: 'site', target_ids: { siteIds: [...] } }` — and the guard
 * saw nothing. The config-policy case happened to be caught downstream by
 * `authorizeAssignmentTarget`; the guard itself must not depend on that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAgentGuardrails, type AgentGuardrailPolicy } from './aiGuardrails';

const POLICY = {
  enabled: true,
  mode: 'act' as const,
  toolAllowlist: [],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  deviceSiteId: 'site-a',
  deviceId: 'dev-1',
} satisfies AgentGuardrailPolicy;

const denied = (input: Record<string, unknown>) =>
  checkAgentGuardrails('query_devices', input, POLICY).allowed === false;

describe('siteScopeDenial — targetType/level site selectors', () => {
  beforeEach(() => vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('still enforces the explicitly site-named keys (regression guard)', () => {
    expect(denied({ siteId: 'site-b' })).toBe(true);
    expect(denied({ siteIds: ['site-a', 'site-b'] })).toBe(true);
    expect(denied({ siteId: 'site-a' })).toBe(false);
  });

  it('denies { targetType: "site", targetId } naming another site', () => {
    expect(denied({ targetType: 'site', targetId: 'site-b' })).toBe(true);
  });

  it('denies { targetType: "site", targetIds: [...] } containing another site', () => {
    expect(denied({ targetType: 'site', targetIds: ['site-a', 'site-b'] })).toBe(true);
  });

  it('denies the snake_case { target_type, target_ids } form', () => {
    expect(denied({ target_type: 'site', target_ids: ['site-b'] })).toBe(true);
  });

  it('denies the peripheral nested form { target_type: "site", target_ids: { siteIds } }', () => {
    expect(denied({ target_type: 'site', target_ids: { siteIds: ['site-b'] } })).toBe(true);
  });

  it('denies the assignment { level: "site", targetId } form', () => {
    expect(denied({ level: 'site', targetId: 'site-b' })).toBe(true);
  });

  it('allows the same shapes when they name the run device\'s own site', () => {
    expect(denied({ targetType: 'site', targetId: 'site-a' })).toBe(false);
    expect(denied({ targetType: 'site', targetIds: ['site-a'] })).toBe(false);
    expect(denied({ level: 'site', targetId: 'site-a' })).toBe(false);
    expect(denied({ target_type: 'site', target_ids: { siteIds: ['site-a'] } })).toBe(false);
  });

  it('does NOT treat a non-site target as a site selector', () => {
    // A device-group or org assignment names a different kind of id entirely;
    // reading it as a site id would deny every legitimate group assignment.
    expect(denied({ targetType: 'device_group', targetId: 'group-9' })).toBe(false);
    expect(denied({ level: 'organization', targetId: 'org-9' })).toBe(false);
    expect(denied({ targetType: 'devices', targetIds: ['dev-1'] })).toBe(false);
  });

  it('rejects a malformed site target rather than ignoring it', () => {
    expect(denied({ targetType: 'site', targetId: 42 })).toBe(true);
    expect(denied({ targetType: 'site', targetIds: [1, 2] })).toBe(true);
  });

  it('denies a site target when the run device has no site at all', () => {
    expect(
      checkAgentGuardrails('query_devices', { targetType: 'site', targetId: 'site-a' }, {
        ...POLICY,
        deviceSiteId: null,
      }).allowed,
    ).toBe(false);
  });
});
