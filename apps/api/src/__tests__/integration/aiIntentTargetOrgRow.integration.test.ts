/**
 * Integration test — #11222: an AI write that names its target by row id files its intent in the ROW's org, against
 * real Postgres as the unprivileged `breeze_app` role, through the REAL durable pipeline: the chat gate's target
 * decision (`intentTargetOrg.ts`, `intentRowTarget.ts`) -> `createActionIntent` (approver fan-out) -> approve via
 * `approvalRoutes` -> `releaseApprovedIntent` (the worker's function), with the requesting session gone.
 *
 * A partner admin whose session is bound to org A asks for `manage_notification_channels:delete` (four-eyes, so a
 * second person's card shows where it was filed) on a channel in sibling org B.
 *
 * Proven:
 *   - the row read works as `breeze_app` for a row outside the session org;
 *   - the intent row is org B's, and the approval card goes to org B's approver only, never org A's;
 *   - org B's approver approves, the worker releases, and org B's channel is deleted;
 *   - CONTROL (the defect): filed in the session org, the same call cards org A's approver, and the worker's rebuilt
 *     authority cannot find org B's channel, so the release changes nothing;
 *   - a channel of another partner, and one that does not exist, get the same refusal, and nothing is filed anywhere;
 *   - a partner-wide channel of the caller's own partner stays in the session org.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { notificationChannels } from '../../db/schema';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { approvalRoutes } from '../../routes/approvals';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { INTENT_ROW_TARGET, resolveIntentRowTarget } from '../../services/actionIntents/intentRowTarget';
import { decideIntentOrg, INTENT_ORG_OUT_OF_REACH, resolveIntentTarget } from '../../services/actionIntents/intentTargetOrg';
import { createAccessToken } from '../../services/jwt';
import { clearPermissionCache, PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization, assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Person = { id: string; email: string; roleId: string };

function partnerSession(user: Person, partnerId: string, sessionOrgId: string, reach: string[]): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures(reach);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Fixture', isPlatformAdmin: false },
    token: { sub: user.id, email: user.email, roleId: user.roleId, orgId: sessionOrgId, partnerId, scope: 'partner', type: 'access', mfa: true },
    partnerId,
    orgId: sessionOrgId,
    scope: 'partner',
    accessibleOrgIds: reach,
    partnerOrgAccess: 'all',
    orgCondition,
    canAccessOrg,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

async function approve(approver: Person, orgId: string, partnerId: string, approvalRowId: string) {
  const token = await createAccessToken({
    sub: approver.id, email: approver.email, roleId: approver.roleId, orgId, partnerId, scope: 'organization', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function orgApprover(partnerId: string, orgId: string): Promise<Person> {
  const role = await createRole({ scope: 'organization', orgId, name: `11222 approver ${randomUUID()}` });
  await grantRolePermissions(role.id, [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.ALERTS_READ, PERMISSIONS.ALERTS_WRITE]);
  const user = await createUser({ partnerId, orgId, email: `i11222-app-${randomUUID()}@example.com` });
  await assignUserToOrganization(user.id, orgId, role.id);
  return { id: user.id, email: user.email, roleId: role.id };
}

const insertChannel = async (owner: { orgId: string } | { partnerId: string }, name: string) => {
  const [channel] = await withSystemDbAccessContext(() => db.insert(notificationChannels).values({ ...owner, name, type: 'email' }).returning());
  return channel!;
};

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const foreignOrg = await createOrganization({ partnerId: (await createPartner()).id });

  const requesterRole = await createRole({ scope: 'partner', partnerId: partner.id, name: `11222 ${randomUUID()}` });
  await grantRolePermissions(requesterRole.id, [PERMISSIONS.ORGS_READ, PERMISSIONS.ALERTS_READ, PERMISSIONS.ALERTS_WRITE]);
  const requesterRow = await createUser({ partnerId: partner.id, orgId: null, email: `i11222-req-${randomUUID()}@example.com` });
  await assignUserToPartner(requesterRow.id, partner.id, requesterRole.id, 'all');
  const requester: Person = { id: requesterRow.id, email: requesterRow.email, roleId: requesterRole.id };

  return {
    partner, orgA, orgB, foreignOrg,
    channelB: await insertChannel({ orgId: orgB.id }, 'org B'),
    foreignChannel: await insertChannel({ orgId: foreignOrg.id }, 'foreign'),
    approverA: await orgApprover(partner.id, orgA.id),
    approverB: await orgApprover(partner.id, orgB.id),
    session: partnerSession(requester, partner.id, orgA.id, [orgA.id, orgB.id]),
  };
}

const del = (channelId: string) => ({ action: 'delete', channelId });
const cardsOf = (intentId: string) => withSystemDbAccessContext(() =>
  db.select({ id: approvalRequests.id, userId: approvalRequests.userId }).from(approvalRequests).where(eq(approvalRequests.intentId, intentId)));
const intentsOf = (orgId: string) => withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.orgId, orgId)));
const channelExists = async (id: string) => {
  const rows = await withSystemDbAccessContext(() => db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.id, id)));
  return rows.length > 0;
};

/** The chat gate's decision (createSessionPreToolUse), then the real filing. */
async function fileAsChat(session: AuthContext, toolInput: Record<string, unknown>) {
  const decision = decideIntentOrg(await resolveIntentTarget('manage_notification_channels', toolInput), session);
  if (decision.kind === 'refuse') return { kind: 'refused' as const, error: decision.error };
  const orgId = decision.kind === 'target' ? decision.orgId : session.orgId!;
  const snapshot = await createActionIntent(session, { toolName: 'manage_notification_channels', input: toolInput, source: 'chat', orgId } as never);
  return { kind: 'filed' as const, snapshot, orgId };
}

describe('the row registry against the real schema (#11222)', () => {
  // The unit suite's db is a mock, so this is what proves each registered read is valid SQL as breeze_app.
  const entries = Object.entries(INTENT_ROW_TARGET).flatMap(([toolName, list]) => list.map((entry) => [toolName, entry.arg, entry] as const));

  it.each(entries)('%s %s: the read runs and finds no owner for an unknown id', async (toolName, arg, entry) => {
    if (!process.env.DATABASE_URL) return;
    const action = entry.actions === 'all' ? undefined : entry.actions[0];
    const id = randomUUID();
    await expect(resolveIntentRowTarget(toolName, { ...(action ? { action } : {}), [arg]: entry.firstOfArray ? [id] : id }))
      .resolves.toEqual({ orgId: null, partnerId: null });
  });
});

describe('manage_notification_channels:delete by a partner session bound to a sibling org (#11222)', () => {
  runDb('is filed in the row\'s org, carded to that org\'s approver, and released there by the worker', async () => {
    const f = await seed();
    const filed = await fileAsChat(f.session, del(f.channelB.id));
    if (filed.kind !== 'filed') throw new Error(`refused: ${filed.error}`);
    const { snapshot } = filed;
    expect(snapshot.status, JSON.stringify(snapshot)).toBe('pending_approval');

    const [row] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, snapshot.id)));
    expect(row!.orgId).toBe(f.orgB.id);
    const cards = await cardsOf(snapshot.id);
    expect(cards.map((c) => c.userId)).toContain(f.approverB.id);
    expect(cards.map((c) => c.userId)).not.toContain(f.approverA.id);

    const card = cards.find((c) => c.userId === f.approverB.id)!;
    const res = await approve(f.approverB, f.orgB.id, f.partner.id, card.id);
    expect(res.status, await res.clone().text()).toBe(200);
    clearPermissionCache();
    await releaseApprovedIntent(snapshot.id);

    const [released] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, snapshot.id)));
    expect(released!.status, JSON.stringify(released!.result)).toBe('completed');
    await expect(channelExists(f.channelB.id)).resolves.toBe(false);
  });

  runDb('CONTROL (the defect): filed in the session org, org A\'s approver gets the card and the release cannot reach the row', async () => {
    const f = await seed();
    const snapshot = await createActionIntent(f.session, {
      toolName: 'manage_notification_channels', input: del(f.channelB.id), source: 'chat', orgId: f.orgA.id,
    } as never);
    const cards = await cardsOf(snapshot.id);
    expect(cards.map((c) => c.userId)).toContain(f.approverA.id);
    expect(cards.map((c) => c.userId)).not.toContain(f.approverB.id);

    const card = cards.find((c) => c.userId === f.approverA.id)!;
    const res = await approve(f.approverA, f.orgA.id, f.partner.id, card.id);
    expect(res.status, await res.clone().text()).toBe(200);
    clearPermissionCache();
    await releaseApprovedIntent(snapshot.id);
    const [released] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, snapshot.id)));
    expect(JSON.stringify(released!.result)).toContain('not found or access denied');
    await expect(channelExists(f.channelB.id)).resolves.toBe(true);
  });

  runDb('a row of another partner and a row that does not exist get the same refusal, and nothing is filed anywhere', async () => {
    const f = await seed();
    const foreign = await fileAsChat(f.session, del(f.foreignChannel.id));
    const missing = await fileAsChat(f.session, del(randomUUID()));
    expect(foreign).toEqual({ kind: 'refused', error: INTENT_ORG_OUT_OF_REACH });
    expect(missing).toEqual(foreign);
    for (const org of [f.orgA, f.orgB, f.foreignOrg]) await expect(intentsOf(org.id)).resolves.toHaveLength(0);
    await expect(channelExists(f.foreignChannel.id)).resolves.toBe(true);
  });

  runDb('a partner-wide channel of the caller\'s own partner stays in the session org', async () => {
    const f = await seed();
    const partnerChannel = await insertChannel({ partnerId: f.partner.id }, 'partner-wide');
    const decision = decideIntentOrg(await resolveIntentTarget('manage_notification_channels', del(partnerChannel.id)), f.session);
    expect(decision).toEqual({ kind: 'session' });
  });
});
