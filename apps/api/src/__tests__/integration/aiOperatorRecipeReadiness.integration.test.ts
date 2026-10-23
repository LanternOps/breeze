/**
 * Recipe readiness end to end (Recipe Library §4.1, D-R1-12; W06 R1a Task 14).
 *
 * `listWorkflowReadiness` — the Library route's I/O half — against real rows,
 * read in a real user's RLS context (`breeze_app`), mapped through the route's
 * DTO. Proves the readiness rule through real connection rows, not just the
 * pure function: a stale manifest is setup_required with the missing roles
 * named; a current, fully granted one is READY with the three Exchange gaps
 * reported as manual steps; no connection is unavailable; another org's
 * connection grants nothing; a disabled recipe reports no gaps of either kind.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { db } from '../../db';
import { aiAgents, googleWorkspaceConnections, m365Connections } from '../../db/schema';
import { callerVerificationPolicies } from '../../db/schema/callerVerification';
import { listWorkflowReadiness, toWorkflowDto } from '../../services/aiOperator/recipeReadiness';
import { IDENTITY_OFFBOARDING_EFFECT_TOOLS } from '../../services/aiOperator/recipes/identityOffboarding';
import { buildTaskActorAuthContext } from '../../services/actionIntents/actorContext';
import { PERMISSIONS } from '../../services/permissions';
import { asUser, system } from './planApprovalFixtures';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createUser, grantRolePermissions,
} from './db-utils';

const PROFILE = M365_PERMISSION_PROFILES['customer-graph-actions'];
/** In the canonical order `m365_connections_observed_grants_check` requires. */
const grantKey = (g: { resourceApplicationId: string; appRoleId: string }) => `${g.resourceApplicationId}/${g.appRoleId}`;
const ALL_GRANTS = [...(PROFILE.applicationPermissionAssignments ?? [])]
  .sort((x, y) => (grantKey(x) < grantKey(y) ? -1 : grantKey(x) > grantKey(y) ? 1 : 0));
const EXCHANGE = ['m365.exchange.forwarding', 'm365.exchange.mailbox_delegate', 'm365.exchange.shared_mailbox_conversion'];

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); });

async function seedOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.AI_AGENTS_READ, PERMISSIONS.ORGS_READ]);
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `ready-${randomUUID()}@readiness.test` });
  await assignUserToOrganization(user.id, org.id, role.id);
  await system(() => db.insert(aiAgents).values({
    orgId: null, partnerId: partner.id, kind: 'helpdesk', name: 'Helpdesk', createdBy: user.id,
    enabled: true, mode: 'shadow', toolAllowlist: [...IDENTITY_OFFBOARDING_EFFECT_TOOLS],
  }));
  const auth = await buildTaskActorAuthContext({ orgId: org.id, partnerId: partner.id, userId: user.id });
  if (!auth) throw new Error('no auth');
  return { partnerId: partner.id, orgId: org.id, userId: user.id, auth };
}

async function m365Connection(orgId: string, over: Partial<typeof m365Connections.$inferInsert> = {}) {
  await getTestDb().insert(m365Connections).values({
    orgId, userId: null, tenantId: randomUUID(), consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
    profile: 'customer-graph-actions', authMode: 'application-certificate', credentialDomain: 'customer-graph-actions',
    vaultRef: 'akv://vault.example/test-certificate/version', credentialVersion: 'test-version',
    permissionManifestVersion: PROFILE.version, status: 'active',
    observedGrants: ALL_GRANTS, grantsVerifiedAt: new Date(),
    ...over,
  } as never);
}

async function googleConnection(orgId: string) {
  await system(() => db.insert(googleWorkspaceConnections).values({
    orgId, customerDomain: 'customer.example', adminEmail: 'admin@customer.example',
    serviceAccountEmail: 'sa@project.iam.gserviceaccount.com', serviceAccountKey: 'sealed', status: 'active',
  } as never));
}

async function library(t: Awaited<ReturnType<typeof seedOrg>>) {
  const rows = await asUser(t.auth, () => listWorkflowReadiness(t.orgId, t.auth));
  return rows.map(toWorkflowDto);
}
const identity = (dtos: Awaited<ReturnType<typeof library>>) => dtos.find((d) => d.recipeKey === 'identity_offboarding')!;

describe('GET /workflows readiness over real rows', () => {
  runDb('1. a STALE manifest is setup_required, naming the capabilities whose roles that manifest lacks', async () => {
    const t = await seedOrg();
    const stale = ALL_GRANTS.filter((g) => g.value === 'User.ReadWrite.All' || g.value === 'User-PasswordProfile.ReadWrite.All');
    await m365Connection(t.orgId, { permissionManifestVersion: PROFILE.version - 1, observedGrants: stale });
    await googleConnection(t.orgId);
    const dto = identity(await library(t));
    expect(dto.readiness).toBe('setup_required');
    expect(dto.missingCapabilities.map((m) => m.key).sort()).toEqual([
      'm365.graph.auto_reply', 'm365.graph.group_membership_write', 'm365.graph.intune_retire', 'm365.graph.session_revoke',
    ]);
    for (const m of dto.missingCapabilities) expect(m.action.kind).toBe('reconsent_m365');
    expect(dto.degradedEffects).toContain('m365_set_auto_reply');
    expect(dto.degradedEffects).not.toContain('m365_remove_license');
  });

  runDb('2. the current profile with full grants is READY with the three Exchange steps done by hand', async () => {
    const t = await seedOrg();
    await m365Connection(t.orgId);
    await googleConnection(t.orgId);
    const dto = identity(await library(t));
    expect(dto.readiness).toBe('ready');
    expect(dto.missingCapabilities).toEqual([]);
    expect(dto.alwaysManualCapabilities.map((c) => c.key).sort()).toEqual([...EXCHANGE].sort());
    expect(dto.manualStepCount).toBe(3);
    // The product-default caller-verification policy (tier 2) holds the
    // disable back for a human: degraded, but NOT a setup gap.
    expect(dto.degradedEffects).toEqual(['m365_disable_user']);
    expect(dto.agentKind).toBe('helpdesk');
  });

  runDb('2b. a partner policy at tier 0 for disable_user lets the Operator plan the disable', async () => {
    const t = await seedOrg();
    await m365Connection(t.orgId);
    await googleConnection(t.orgId);
    await system(() => db.insert(callerVerificationPolicies).values({ partnerId: t.partnerId, orgId: null, requiredTierDisableUser: 0 } as never));
    const dto = identity(await library(t));
    expect(dto.readiness).toBe('ready');
    expect(dto.degradedEffects).toEqual([]);
  });

  runDb('3. an org with neither connection is unavailable', async () => {
    const t = await seedOrg();
    const dto = identity(await library(t));
    expect(dto.readiness).toBe('unavailable');
    expect(dto.missingCapabilities.filter((m) => m.kind === 'provider_connection').map((m) => m.key).sort())
      .toEqual(['google.workspace.connection', 'm365.connection']);
  });

  runDb('4. readiness is ORG-SCOPED: another org\'s connections do not make this org ready', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await m365Connection(b.orgId);
    await googleConnection(b.orgId);
    expect(identity(await library(a)).readiness).toBe('unavailable');
    expect(identity(await library(b)).readiness).toBe('ready');
  });

  runDb('5. with the recipe flag off: unavailable and no gaps of either kind', async () => {
    vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED', 'false');
    const t = await seedOrg();
    await m365Connection(t.orgId);
    await googleConnection(t.orgId);
    const dto = identity(await library(t));
    expect(dto.readiness).toBe('unavailable');
    expect(dto.missingCapabilities).toEqual([]);
    expect(dto.alwaysManualCapabilities).toEqual([]);
    expect(dto.manualStepCount).toBe(0);
  });

  runDb('the Library lists both recipes; service_recovery needs no capability', async () => {
    const t = await seedOrg();
    const dtos = await library(t);
    expect(dtos.map((d) => d.recipeKey)).toEqual(['identity_offboarding', 'service_recovery']);
    expect(dtos.find((d) => d.recipeKey === 'service_recovery')!.readiness).toBe('ready');
  });
});
