/**
 * Catalog parity contract for the AI tool RBAC map.
 *
 * Every `{resource, action}` pair used by `TOOL_PERMISSIONS` (flat entries and
 * per-action entries), `TOOL_EXTRA_PERMISSIONS` and
 * `TOOL_ACTION_EXTRA_PERMISSIONS` must exist in the canonical permission catalog `packages/shared/src/constants/permissions.ts`.
 *
 * Why this is a contract and not a review item: `permissionGrantMatches`
 * (`services/permissionMatching.ts`) is exact string equality with a `*`
 * wildcard per axis, so a pair that is NOT in the catalog can only ever be
 * satisfied by an `*:*` grant (Partner Admin / platform admin). Nothing
 * validates a custom role's grants against the catalog either — the DB accepts
 * any string — so a phantom pair is simultaneously (a) a product bug, because
 * the tool is unusable by the roles it was written for, and (b) a latent
 * escalation, because a partner who grants the phantom string gets the tool in
 * chat with none of the controls its HTTP route carries.
 *
 * Static, no database. Deliberately has NO baseline/allowlist: a new phantom
 * pair must be fixed, not registered.
 *
 * Audit provenance: 2026-09-17 AI tool SITE/ROLE audit §2.6, §5.3.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSION_GRANTS } from '@breeze/shared';
import { TOOL_PERMISSIONS, TOOL_EXTRA_PERMISSIONS, TOOL_ACTION_EXTRA_PERMISSIONS } from './aiGuardrails';

type Grant = { resource: string; action: string };

const catalogPairs = new Set<string>(
  Object.values(PERMISSION_GRANTS).map((g) => `${g.resource}:${g.action}`),
);
const catalogResources = new Set<string>(Object.values(PERMISSION_GRANTS).map((g) => g.resource));

/**
 * The ONE deliberate exception, and it is not a baseline of unfixed bugs: a
 * pair that is intentionally absent from the catalog so that it can never be
 * granted, pinning a fail-closed decision. `manage_tickets` `link_device` and
 * `draft` are agent-only ticket-triage executors (#4191 P2-4, documented at
 * their mapping site in `aiGuardrails.ts`): the agent-principal path never
 * consults `TOOL_PERMISSIONS` at all, and no human path may reach them, so
 * they are mapped to a verb no role can hold. The assertions below are
 * therefore POSITIVE — each listed pair must still be absent from the catalog,
 * or the fail-closed property it encodes has quietly been undone.
 *
 * Do NOT add a pair here to silence a failure. A genuinely-needed permission
 * goes in the catalog; a tool on the wrong resource gets remapped onto the one
 * its HTTP route requires.
 */
const INTENTIONALLY_UNGRANTABLE_PAIRS = new Set(['tickets:update']);

const isGrant = (v: unknown): v is Grant =>
  typeof v === 'object' && v !== null && typeof (v as Grant).resource === 'string' && typeof (v as Grant).action === 'string';

/** Every (origin, grant) the tool RBAC map can ever require. */
function collectRequirements(): { origin: string; grant: Grant }[] {
  const out: { origin: string; grant: Grant }[] = [];
  for (const [tool, def] of Object.entries(TOOL_PERMISSIONS)) {
    if (isGrant(def)) {
      out.push({ origin: tool, grant: def });
      continue;
    }
    for (const [action, grant] of Object.entries(def as Record<string, Grant>)) {
      expect(isGrant(grant), `${tool}.${action} is not a {resource, action} pair`).toBe(true);
      out.push({ origin: `${tool}.${action}`, grant });
    }
  }
  for (const [tool, grants] of Object.entries(TOOL_EXTRA_PERMISSIONS)) {
    grants.forEach((grant, i) => out.push({ origin: `${tool}[extra#${i}]`, grant }));
  }
  for (const [tool, byAction] of Object.entries(TOOL_ACTION_EXTRA_PERMISSIONS)) {
    for (const [action, grants] of Object.entries(byAction)) {
      grants.forEach((grant, i) => out.push({ origin: `${tool}.${action}[extra#${i}]`, grant }));
    }
  }
  return out;
}

describe('AI tool permission map ↔ canonical catalog parity', () => {
  const requirements = collectRequirements();

  it('collects requirements from both maps', () => {
    expect(requirements.length).toBeGreaterThan(150);
    expect(requirements.some((r) => r.origin.includes('[extra#'))).toBe(true);
    // per-action extras are collected too (manage_tickets.move_org)
    expect(requirements.some((r) => /\.[a-z_]+\[extra#/.test(r.origin))).toBe(true);
  });

  it('every resource named by a tool exists in the catalog', () => {
    const phantomResources = [
      ...new Set(
        requirements.filter((r) => !catalogResources.has(r.grant.resource)).map((r) => r.grant.resource),
      ),
    ].sort();
    expect(phantomResources, `resources absent from PERMISSION_GRANTS: ${phantomResources.join(', ')}`).toEqual([]);
  });

  it('every {resource, action} pair a tool requires exists in the catalog', () => {
    const phantomPairs = requirements
      .filter((r) => {
        const pair = `${r.grant.resource}:${r.grant.action}`;
        return !catalogPairs.has(pair) && !INTENTIONALLY_UNGRANTABLE_PAIRS.has(pair);
      })
      .map((r) => `${r.origin} → ${r.grant.resource}:${r.grant.action}`)
      .sort();
    expect(phantomPairs, `tool permissions absent from PERMISSION_GRANTS:\n${phantomPairs.join('\n')}`).toEqual([]);
  });

  it('every intentionally-ungrantable pair is still absent from the catalog', () => {
    for (const pair of INTENTIONALLY_UNGRANTABLE_PAIRS) {
      expect(
        catalogPairs.has(pair),
        `${pair} is now grantable — the fail-closed decision it encoded is gone`,
      ).toBe(false);
    }
  });

  it('no pair is listed as intentionally ungrantable unless a tool actually uses it', () => {
    const used = new Set(requirements.map((r) => `${r.grant.resource}:${r.grant.action}`));
    for (const pair of INTENTIONALLY_UNGRANTABLE_PAIRS) {
      expect(used.has(pair), `${pair} is no longer used by any tool — drop it from the list`).toBe(true);
    }
  });
});
