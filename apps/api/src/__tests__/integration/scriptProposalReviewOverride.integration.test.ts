import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs } from '../../db/schema';
import { devices } from '../../db/schema/devices';
import { scriptProposalReviews, scriptProposals } from '../../db/schema/scriptProposals';
import { scriptExecutions, scriptVersions, scripts } from '../../db/schema/scripts';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { aiScriptProposalRoutes } from '../../routes/ai/scriptProposals';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { PERMISSIONS } from '../../services/permissions';
import { assertProposalRunnable, createScriptProposal, loadProposalGuardrailContext } from '../../services/scriptProposals';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions,
} from './db-utils';

/**
 * #10954: the human override of a `review_failed` proposal against real Postgres
 * as `breeze_app`, through the real route, JWT and auth middleware. Mounted under
 * /api/v1 so the run takes its self-managed path, as it does in production.
 *
 * The mocked route suite cannot see what this pins: the approval_method and
 * review_summary constraints on the rows the override writes, the immutability
 * trigger on the proposal, RLS on the reads, the audit row actually landing, and
 * the proposal staying out of the AI's reach afterwards.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const FAILURE = 'Reviewer returned no parseable JSON verdict';
const MARKER = 'approved_without_passing_ai_review';

interface Scenario {
  partnerId: string;
  orgId: string;
  signer: { id: string; email: string };
  signerRoleId: string;
  noExecute: { id: string; email: string };
  noExecuteRoleId: string;
  deviceId: string;
}

async function seedUser(orgId: string, partnerId: string, grants: Array<{ resource: string; action: string }>) {
  const role = await withSystemDbAccessContext(() => createRole({ scope: 'organization', orgId }));
  await withSystemDbAccessContext(() => grantRolePermissions(role.id, grants));
  const user = await withSystemDbAccessContext(() => createUser({
    partnerId, orgId, email: `override-${randomUUID().slice(0, 8)}@example.test`,
  }));
  await withSystemDbAccessContext(() => assignUserToOrganization(user.id, orgId, role.id));
  return { user: { id: user.id, email: user.email }, roleId: role.id };
}

async function seedScenario(): Promise<Scenario> {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const signer = await seedUser(org.id, partner.id, [
    PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.SCRIPTS_EXECUTE, PERMISSIONS.SCRIPTS_WRITE, PERMISSIONS.SCRIPTS_READ,
  ]);
  const noExecute = await seedUser(org.id, partner.id, [
    PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.SCRIPTS_WRITE, PERMISSIONS.SCRIPTS_READ,
  ]);
  const site = await withSystemDbAccessContext(() => createSite({ orgId: org.id }));
  const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `override-agent-${randomUUID()}`, hostname: `override-${randomUUID().slice(0, 6)}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id }));
  return {
    partnerId: partner.id, orgId: org.id,
    signer: signer.user, signerRoleId: signer.roleId,
    noExecute: noExecute.user, noExecuteRoleId: noExecute.roleId,
    deviceId: device!.id,
  };
}

async function tokenFor(s: Scenario, user: { id: string; email: string }, roleId: string): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id, email: user.email, roleId, orgId: s.orgId, partnerId: s.partnerId,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function authFor(s: Scenario): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([s.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: s.signer.id, email: s.signer.email, name: 'U', isPlatformAdmin: false },
    token: { sub: s.signer.id, email: s.signer.email, roleId: s.signerRoleId, orgId: s.orgId, partnerId: s.partnerId, scope: 'organization', type: 'access', mfa: true },
    partnerId: s.partnerId, orgId: s.orgId, scope: 'organization', accessibleOrgIds: [s.orgId], orgCondition, canAccessOrg,
  } as AuthContext;
}

async function post(path: string, token: string, body: unknown): Promise<Response> {
  const app = new Hono();
  app.route('/api/v1/ai/script-proposals', aiScriptProposalRoutes);
  return app.request(`/api/v1/ai/script-proposals${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A proposal whose reviewer failed, in the state `failReview` leaves it. */
async function seedFailedProposal(s: Scenario): Promise<string> {
  const auth = { orgId: s.orgId, user: { id: s.signer.id }, principal: { kind: 'user_session' } } as never;
  const { proposal } = await withDbAccessContext(
    { scope: 'organization', orgId: s.orgId, accessibleOrgIds: [s.orgId], accessiblePartnerIds: [], userId: s.signer.id },
    () => createScriptProposal(auth, {
      language: 'powershell', content: 'Restart-Service -Name Spooler', goal: 'Restart the spooler', expectedEffect: 'Spooler runs',
      verification: { kind: 'exit_code', equals: 0 }, deviceIds: [s.deviceId], runAs: 'system', timeoutSeconds: 60,
    }, { kind: 'chat_session', sessionId: null }, s.orgId),
  );
  await withSystemDbAccessContext(async () => {
    await db.insert(scriptProposalReviews).values({
      orgId: s.orgId, proposalId: proposal.id, reviewerKind: 'model', model: 'test', status: 'failed',
      summary: FAILURE, verdict: { error: FAILURE },
    });
    await db.update(scriptProposals).set({ status: 'review_failed', decisionNote: FAILURE }).where(eq(scriptProposals.id, proposal.id));
  });
  return proposal.id;
}

async function readProposal(id: string) {
  const [row] = await withSystemDbAccessContext(() => db.select().from(scriptProposals).where(eq(scriptProposals.id, id)));
  return row!;
}

async function readOverrideAudit(id: string) {
  return withSystemDbAccessContext(() => db.select().from(auditLogs).where(and(
    eq(auditLogs.resourceId, id), eq(auditLogs.action, 'script.proposal.review_override'),
  )));
}

let s: Scenario;
beforeEach(async () => { s = await seedScenario(); });

describe('POST /:id/override-run (real Postgres, breeze_app)', () => {
  runDb('signs, audits and dispatches: the rows say a person approved it without a passing review', async () => {
    const id = await seedFailedProposal(s);
    const token = await tokenFor(s, s.signer, s.signerRoleId);

    const res = await post(`/${id}/override-run`, token, { confirmNoPassingReview: true });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'executed', results: [{ deviceId: s.deviceId, ok: true }] });

    const proposal = await readProposal(id);
    expect(proposal.status).toBe('executed');
    expect(proposal.decidedBy).toBe(s.signer.id);
    expect(proposal.decidedAt).toBeInstanceOf(Date);
    expect(proposal.decisionNote).toContain(FAILURE);
    expect(proposal.riskTier).toBeNull();

    const executions = await withSystemDbAccessContext(() => db.select().from(scriptExecutions).where(eq(scriptExecutions.proposalId, id)));
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      sourceKind: 'proposal', deviceId: s.deviceId, approvedBy: s.signer.id, approvalMethod: 'direct_ui',
      reviewRiskTier: null, triggeredBy: s.signer.id,
    });
    expect(executions[0]!.reviewSummary).toMatch(/without a passing AI review/);

    const audit = await readOverrideAudit(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ orgId: s.orgId, actorType: 'user', actorId: s.signer.id, result: 'success' });
    expect(audit[0]!.details).toMatchObject({ override: MARKER, decision: 'run', reviewFailure: FAILURE });
  });

  runDb('leaves the proposal out of the AI\'s reach afterwards', async () => {
    const id = await seedFailedProposal(s);
    const token = await tokenFor(s, s.signer, s.signerRoleId);
    expect((await post(`/${id}/override-run`, token, { confirmNoPassingReview: true })).status).toBe(200);

    const runnable = await withSystemDbAccessContext(() => assertProposalRunnable(authFor(s), { proposalId: id, deviceIds: [s.deviceId] }));
    expect(runnable).toEqual({ ok: false, reason: 'not_reviewed' });
    const guardrail = await loadProposalGuardrailContext({ proposalId: id }, s.orgId);
    expect(guardrail?.proposal).toBeUndefined();
  });

  runDb('a second sign-off cannot run it twice', async () => {
    const id = await seedFailedProposal(s);
    const token = await tokenFor(s, s.signer, s.signerRoleId);
    expect((await post(`/${id}/override-run`, token, { confirmNoPassingReview: true })).status).toBe(200);

    const again = await post(`/${id}/override-run`, token, { confirmNoPassingReview: true });

    expect(again.status).toBe(409);
    const executions = await withSystemDbAccessContext(() => db.select().from(scriptExecutions).where(eq(scriptExecutions.proposalId, id)));
    expect(executions).toHaveLength(1);
  });

  runDb('without scripts:execute: 403, nothing written', async () => {
    const id = await seedFailedProposal(s);
    const token = await tokenFor(s, s.noExecute, s.noExecuteRoleId);

    expect((await post(`/${id}/override-run`, token, { confirmNoPassingReview: true })).status).toBe(403);

    expect((await readProposal(id)).status).toBe('review_failed');
    expect(await readOverrideAudit(id)).toHaveLength(0);
  });

  runDb('no target device reachable: puts the proposal back so the person can retry', async () => {
    const id = await seedFailedProposal(s);
    await withSystemDbAccessContext(() => db.update(devices).set({ status: 'offline' }).where(eq(devices.id, s.deviceId)));
    const token = await tokenFor(s, s.signer, s.signerRoleId);

    const res = await post(`/${id}/override-run`, token, { confirmNoPassingReview: true });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_device_dispatched' });
    const proposal = await readProposal(id);
    expect(proposal).toMatchObject({ status: 'review_failed', decidedBy: null, decidedAt: null, decisionNote: FAILURE });
  });

  runDb('a reviewed proposal is unaffected: 409', async () => {
    const id = await seedFailedProposal(s);
    await withSystemDbAccessContext(() => db.update(scriptProposals).set({ status: 'reviewed', riskTier: 'low' }).where(eq(scriptProposals.id, id)));
    const token = await tokenFor(s, s.signer, s.signerRoleId);

    expect((await post(`/${id}/override-run`, token, { confirmNoPassingReview: true })).status).toBe(409);
    expect((await readProposal(id)).status).toBe('reviewed');
  });
});

describe('POST /:id/override-promote (real Postgres, breeze_app)', () => {
  runDb('saves to the library: the version names the signer and cites no review', async () => {
    const id = await seedFailedProposal(s);
    const token = await tokenFor(s, s.signer, s.signerRoleId);

    const res = await post(`/${id}/override-promote`, token, {
      confirmNoPassingReview: true, name: `Restart spooler ${randomUUID().slice(0, 6)}`, ownerScope: 'organization',
    });

    expect(res.status, await res.clone().text()).toBe(200);
    const { scriptId, versionId } = await res.json() as { scriptId: string; versionId: string };

    const proposal = await readProposal(id);
    expect(proposal).toMatchObject({ status: 'promoted', decidedBy: s.signer.id, promotedScriptId: scriptId, promotedVersionId: versionId });
    expect(proposal.decisionNote).toContain(FAILURE);

    const [script] = await withSystemDbAccessContext(() => db.select().from(scripts).where(eq(scripts.id, scriptId)));
    expect(script).toMatchObject({ orgId: s.orgId });
    const [version] = await withSystemDbAccessContext(() => db.select().from(scriptVersions).where(eq(scriptVersions.id, versionId)));
    expect(version).toMatchObject({
      origin: 'ai_proposal', proposalId: id, reviewId: null, reviewedAt: null, approvedBy: s.signer.id, approvalMethod: 'direct_ui',
    });

    const audit = await readOverrideAudit(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'user', actorId: s.signer.id, result: 'success' });
    expect(audit[0]!.details).toMatchObject({ override: MARKER, decision: 'save_to_library', scriptId, versionId });

    // Nothing ran: a save is not a run.
    const executions = await withSystemDbAccessContext(() => db.select().from(scriptExecutions).where(eq(scriptExecutions.proposalId, id)));
    expect(executions).toHaveLength(0);
  });

  runDb('without scripts:execute: 403, nothing written', async () => {
    const id = await seedFailedProposal(s);
    const token = await tokenFor(s, s.noExecute, s.noExecuteRoleId);

    const res = await post(`/${id}/override-promote`, token, { confirmNoPassingReview: true, name: 'x', ownerScope: 'organization' });

    expect(res.status).toBe(403);
    expect((await readProposal(id)).status).toBe('review_failed');
    expect(await readOverrideAudit(id)).toHaveLength(0);
  });
});
