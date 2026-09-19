/**
 * CONTRACT TEST — every mutating M365 / Google Workspace AI tool is classified
 * as an ORG-WIDE GOVERNANCE intent.
 *
 * These tools act on the org's whole identity tenant (an Entra directory, a
 * Google Workspace customer), never on a site or a device: there is no
 * per-site slice of "disable this user" to narrow a site-restricted caller
 * to. Their handlers already refuse a ceilinged caller
 * (`canMutateOrgWideGovernance`, services/aiToolsM365.ts + aiToolsGoogle.ts),
 * but they are Tier-3 four-eyes tools whose durable intent is minted BEFORE
 * the handler runs and whose approved release re-enters through the HEADLESS
 * `*Action` functions (services/{m365,google}ToolsHeadless.ts), which take no
 * AuthContext at all. Classifying them here is what puts the ceiling on the
 * raise, the fan-out, the decide and the release instead of only on the
 * in-session handler.
 *
 * The ground truth is derived MECHANICALLY from the real permission map
 * (`TOOL_PERMISSIONS`): an `m365_*` / `google_*` tool requiring
 * `organizations:write` is a mutation of the identity tenant. So a new write
 * tool added to either domain cannot ship without also carrying the ceiling —
 * this test goes red the moment the permission entry lands.
 */
import { describe, expect, it } from 'vitest';

import { TOOL_PERMISSIONS } from '../aiGuardrails';
import { ORG_WIDE_GOVERNANCE_TOOL_ACTIONS, isOrgWideGovernanceIntent } from './orgWideGovernanceTools';

/** `m365_*` / `google_*` tools whose flat requirement is `organizations:write`. */
function identityTenantWriteTools(): string[] {
  return Object.entries(TOOL_PERMISSIONS)
    .filter(([name]) => name.startsWith('m365_') || name.startsWith('google_'))
    .filter(([, requirement]) => {
      const flat = requirement as { resource?: unknown; action?: unknown };
      return flat?.resource === 'organizations' && flat?.action === 'write';
    })
    .map(([name]) => name)
    .sort();
}

describe('org-wide governance classification of identity-tenant write tools', () => {
  it('finds the identity-tenant write surface at all (guards a vacuous pass)', () => {
    const tools = identityTenantWriteTools();
    expect(tools).toContain('m365_disable_user');
    expect(tools).toContain('google_reset_password');
    expect(tools.length).toBeGreaterThanOrEqual(20);
  });

  it('classifies every m365_*/google_* organizations:write tool as org-wide governance', () => {
    const unclassified = identityTenantWriteTools().filter(
      (name) => !isOrgWideGovernanceIntent(name, {}),
    );
    expect(
      unclassified,
      'These identity-tenant write tools are not classified as org-wide governance. ' +
        'Add them to ORG_WIDE_GOVERNANCE_TOOL_ACTIONS (whole-tool entry: empty action set) ' +
        'in services/actionIntents/intentApprovers.ts, or the site ceiling stops at the ' +
        'in-session handler and an approved intent releases headlessly with no ceiling at all.\n' +
        unclassified.join('\n'),
    ).toEqual([]);
  });

  it('classifies them for every action shape, including no action argument', () => {
    // Whole-tool entries: these tools are single-action, so a missing or
    // unrecognised `action` must not read as "not governance".
    expect(isOrgWideGovernanceIntent('m365_disable_user', null)).toBe(true);
    expect(isOrgWideGovernanceIntent('m365_disable_user', undefined)).toBe(true);
    expect(isOrgWideGovernanceIntent('google_suspend_user', { userKey: 'a@b.test' })).toBe(true);
  });

  it('does not classify the READ tools of the same domains', () => {
    expect(isOrgWideGovernanceIntent('m365_lookup_user', {})).toBe(false);
    expect(isOrgWideGovernanceIntent('m365_query_users', {})).toBe(false);
    expect(isOrgWideGovernanceIntent('google_lookup_user', {})).toBe(false);
    expect(isOrgWideGovernanceIntent('google_security_drift', {})).toBe(false);
  });

  it('keeps the pre-existing action-discriminated entry intact', () => {
    expect(ORG_WIDE_GOVERNANCE_TOOL_ACTIONS.get('manage_ai_agents')).toEqual(
      new Set(['authorize_supervised_key']),
    );
    expect(isOrgWideGovernanceIntent('manage_ai_agents', { action: 'list' })).toBe(false);
  });
});
