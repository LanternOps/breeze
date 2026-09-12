import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { actionIntents, intentOutbox } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { scriptProposalReviews, scriptProposals } from '../../db/schema/scriptProposals';
import { scriptExecutions, scriptVersions, scripts } from '../../db/schema/scripts';
import { devices } from '../../db/schema/devices';
import { createScriptProposal } from '../../services/scriptProposals';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { PERMISSIONS } from '../../services/permissions';
import { approvalRoutes } from '../../routes/approvals';
import { aiScriptProposalRoutes } from '../../routes/ai/scriptProposals';
import { runScriptVerifyJob } from '../../jobs/scriptVerifyWorker';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions,
} from './db-utils';

/**
 * AI script authoring W03 (#5612) — the human loop against real Postgres as
 * `breeze_app`, through the REAL routes (real JWT + authMiddleware + RLS):
 *
 *  1. the STRICT acknowledgement ceremony on `POST /approvals/:id/approve` —
 *     the typed 422s, and (submitted ∩ strict_hits) persisted on the proposal
 *     inside the same transaction as the approval CAS;
 *  2. `GET /ai/script-proposals/:id` live authorisation (requester vs stranger);
 *  3. `POST /:id/request-changes` denying the claimed intent atomically;
 *  4. `POST /:id/promote` from `verified`: scripts row + v1 version provenance;
 *  5. the verify worker's ladder against a real execution row (exit_code claim,
 *     no device needed) — executed → verified, idempotent second run.
 *
 * The mocked route/unit suites cannot see any of this: they stub the decide
 * core's collaborators wholesale, and the 409-becomes-500 trap (a caught error
 * inside withDbAccessContext poisoning the request tx) only exists on a real
 * connection.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const STRICT_CONTENT = 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Contoso" -Name Enabled -Value 1';

function orgContext(orgId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}

interface Scenario {
  partnerId: string;
  orgId: string;
  requester: { id: string; email: string };
  stranger: { id: string; email: string };
  roleId: string;
  strangerRoleId: string;
  deviceId: string;
}

async function seedScenario(): Promise<Scenario> {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  // Requester: decides their own supervised intent (scripts:execute is the
  // run_script tool permission the supervised re-check reads) and holds
  // scripts:write so the ceremony can pass; MFA comes from the token.
  const role = await withSystemDbAccessContext(() => createRole({ scope: 'organization', orgId: org.id }));
  await withSystemDbAccessContext(() => grantRolePermissions(role.id, [
    PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.SCRIPTS_EXECUTE, PERMISSIONS.SCRIPTS_WRITE, PERMISSIONS.SCRIPTS_READ,
  ]));
  const requester = await withSystemDbAccessContext(() => createUser({
    partnerId: partner.id, orgId: org.id, email: `w03-req-${randomUUID().slice(0, 8)}@example.test`,
  }));
  await withSystemDbAccessContext(() => assignUserToOrganization(requester.id, org.id, role.id));
  // Stranger: same org, no approvals:decide — may not read the proposal.
  const strangerRole = await withSystemDbAccessContext(() => createRole({ scope: 'organization', orgId: org.id }));
  await withSystemDbAccessContext(() => grantRolePermissions(strangerRole.id, [PERMISSIONS.SCRIPTS_READ]));
  const stranger = await withSystemDbAccessContext(() => createUser({
    partnerId: partner.id, orgId: org.id, email: `w03-str-${randomUUID().slice(0, 8)}@example.test`,
  }));
  await withSystemDbAccessContext(() => assignUserToOrganization(stranger.id, org.id, strangerRole.id));
  const site = await withSystemDbAccessContext(() => createSite({ orgId: org.id }));
  const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `w03-agent-${randomUUID()}`, hostname: `w03-host-${randomUUID().slice(0, 6)}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id }));
  return {
    partnerId: partner.id, orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    stranger: { id: stranger.id, email: stranger.email },
    roleId: role.id, strangerRoleId: strangerRole.id, deviceId: device!.id,
  };
}

function authFor(s: Scenario, user: { id: string; email: string }, roleId: string): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([s.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'U', isPlatformAdmin: false },
    token: { sub: user.id, email: user.email, roleId, orgId: s.orgId, partnerId: s.partnerId, scope: 'organization', type: 'access', mfa: true },
    partnerId: s.partnerId, orgId: s.orgId, scope: 'organization', accessibleOrgIds: [s.orgId], orgCondition, canAccessOrg,
  } as AuthContext;
}

async function tokenFor(s: Scenario, user: { id: string; email: string }, roleId: string, mfa: boolean): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id, email: user.email, roleId, orgId: s.orgId, partnerId: s.partnerId,
    scope: 'organization', mfa, aep: 1, mep: 1, sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function app() {
  const a = new Hono();
  a.route('/approvals', approvalRoutes);
  a.route('/ai/script-proposals', aiScriptProposalRoutes);
  return a;
}

async function post(path: string, token: string, body: unknown = {}): Promise<Response> {
  return app().request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function get(path: string, token: string): Promise<Response> {
  return app().request(path, { headers: { Authorization: `Bearer ${token}` } });
}

/** A reviewed, low-risk (→ supervised) proposal with ONE strict hit. */
async function seedReviewedStrictProposal(s: Scenario): Promise<{ proposalId: string; strictHits: string[] }> {
  const auth = { orgId: s.orgId, user: { id: s.requester.id }, principal: { kind: 'user_session' } } as never;
  const { proposal, scan } = await withDbAccessContext(orgContext(s.orgId, s.requester.id), () =>
    createScriptProposal(auth, {
      language: 'powershell', content: STRICT_CONTENT, goal: 'Enable Contoso', expectedEffect: 'Registry value set',
      verification: { kind: 'exit_code', equals: 0 }, deviceIds: [s.deviceId], runAs: 'system', timeoutSeconds: 60,
    }, { kind: 'chat_session', sessionId: null }));
  expect(scan.strictHits.length, 'seed content must match at least one STRICT pattern').toBeGreaterThan(0);
  expect(proposal.status).toBe('proposed');
  await withSystemDbAccessContext(async () => {
    await db.insert(scriptProposalReviews).values({
      orgId: s.orgId, proposalId: proposal.id, reviewerKind: 'model', model: 'test', status: 'completed',
      summary: 'Sets one registry value', riskTier: 'low', goalMatch: 'yes', reversible: true, verificationAdequate: true,
      recommendedAction: 'approve', verdict: { findings: [{ severity: 'warning', text: 'HKLM write' }], blastRadius: ['registry'] },
    });
    await db.update(scriptProposals).set({ status: 'reviewed', riskTier: 'low' }).where(eq(scriptProposals.id, proposal.id));
  });
  return { proposalId: proposal.id, strictHits: scan.strictHits };
}

async function claimWithIntent(s: Scenario, proposalId: string): Promise<{ intentId: string; approvalRowId: string }> {
  const snap = await createActionIntent(authFor(s, s.requester, s.roleId), {
    toolName: 'run_script', input: { proposalId, deviceIds: [s.deviceId] }, source: 'chat',
    idempotencyKey: `w03-${proposalId}`,
  });
  expect(snap.status).toBe('pending_approval');
  expect(snap.requesterApprovalRequestId).toBeTruthy();
  return { intentId: snap.id, approvalRowId: snap.requesterApprovalRequestId! };
}

async function readProposal(proposalId: string) {
  const [row] = await withSystemDbAccessContext(() => db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  return row!;
}

let s: Scenario;
beforeEach(async () => { s = await seedScenario(); });

describe('STRICT acknowledgement ceremony on decide (real Postgres, breeze_app)', () => {
  runDb('refuses an approve that acknowledges nothing: 422 incomplete, nothing written', async () => {
    const { proposalId, strictHits } = await seedReviewedStrictProposal(s);
    const { intentId, approvalRowId } = await claimWithIntent(s, proposalId);
    const token = await tokenFor(s, s.requester, s.roleId, true);

    const res = await post(`/approvals/${approvalRowId}/approve`, token, {});
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'strict_acknowledgement_incomplete', missing: strictHits });

    const [intent] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(intent!.status).toBe('pending_approval');
    expect((await readProposal(proposalId)).acknowledgedPatterns).toEqual([]);
  });

  runDb('refuses an approve without the MFA claim: 422 not_permitted/mfa', async () => {
    const { proposalId, strictHits } = await seedReviewedStrictProposal(s);
    const { approvalRowId } = await claimWithIntent(s, proposalId);
    const token = await tokenFor(s, s.requester, s.roleId, false);

    const res = await post(`/approvals/${approvalRowId}/approve`, token, { acknowledgedPatterns: strictHits });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'strict_acknowledgement_not_permitted', requirement: 'mfa' });
  });

  runDb('persists (submitted ∩ strict_hits) on the proposal and approves the intent in one transaction', async () => {
    const { proposalId, strictHits } = await seedReviewedStrictProposal(s);
    const { intentId, approvalRowId } = await claimWithIntent(s, proposalId);
    const token = await tokenFor(s, s.requester, s.roleId, true);

    const res = await post(`/approvals/${approvalRowId}/approve`, token, {
      acknowledgedPatterns: [...strictHits, 'Something the content does not match'],
    });
    expect(res.status).toBe(200);

    const proposal = await readProposal(proposalId);
    expect(proposal.acknowledgedPatterns).toEqual(strictHits);
    const [intent] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(intent!.status).toBe('approved');
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ status: approvalRequests.status }).from(approvalRequests).where(eq(approvalRequests.id, approvalRowId)));
    expect(row!.status).toBe('approved');
  });
});

describe('GET /ai/script-proposals/:id live authorisation', () => {
  runDb('the requester reads the full card; a same-org stranger without approvals:decide is 403', async () => {
    const { proposalId, strictHits } = await seedReviewedStrictProposal(s);
    await claimWithIntent(s, proposalId);

    const mine = await get(`/ai/script-proposals/${proposalId}`, await tokenFor(s, s.requester, s.roleId, true));
    expect(mine.status).toBe(200);
    const dto = await mine.json();
    expect(dto.proposal.strictHits).toEqual(strictHits);
    expect(dto.review.findings).toEqual([{ severity: 'warning', text: 'HKLM write' }]);
    expect(dto.devices.map((d: { id: string }) => d.id)).toEqual([s.deviceId]);
    expect(dto.viewer).toEqual({ canDecide: true, canAcknowledge: true, canPromote: false });

    const theirs = await get(`/ai/script-proposals/${proposalId}`, await tokenFor(s, s.stranger, s.strangerRoleId, true));
    expect(theirs.status).toBe(403);
    expect(await theirs.json()).toEqual({ error: 'forbidden' });
  });
});

describe('POST /ai/script-proposals/:id/request-changes', () => {
  runDb('moves the proposal to changes_requested and rejects the claimed intent atomically', async () => {
    const { proposalId } = await seedReviewedStrictProposal(s);
    const { intentId } = await claimWithIntent(s, proposalId);
    const token = await tokenFor(s, s.requester, s.roleId, true);

    const res = await post(`/ai/script-proposals/${proposalId}/request-changes`, token, { note: 'Target only Contoso' });
    expect(res.status).toBe(200);

    const proposal = await readProposal(proposalId);
    expect(proposal.status).toBe('changes_requested');
    expect(proposal.decisionNote).toBe('Target only Contoso');
    expect(proposal.decidedBy).toBe(s.requester.id);
    const [intent] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(intent!.status).toBe('rejected');
    expect(intent!.errorCode).toBe('changes_requested');
    const outbox = await withSystemDbAccessContext(() => db.select().from(intentOutbox)
      .where(and(eq(intentOutbox.intentId, intentId), eq(intentOutbox.eventType, 'intent_rejected'))));
    expect(outbox).toHaveLength(1);

    // A second request is a clean 409, and the request transaction survived.
    const again = await post(`/ai/script-proposals/${proposalId}/request-changes`, token, { note: 'again' });
    expect(again.status).toBe(409);
  });
});

describe('script-verify worker + promote (real rows)', () => {
  runDb('executed → verified on an exit_code claim, idempotent, then promote lands provenance', async () => {
    const { proposalId, strictHits } = await seedReviewedStrictProposal(s);
    const { approvalRowId } = await claimWithIntent(s, proposalId);
    const token = await tokenFor(s, s.requester, s.roleId, true);
    expect((await post(`/approvals/${approvalRowId}/approve`, token, { acknowledgedPatterns: strictHits })).status).toBe(200);

    // Simulate the dispatch + result ingest: an executed proposal with a
    // completed, exit-0 execution row. The exit_code claim needs no device.
    const [execution] = await withSystemDbAccessContext(async () => {
      await db.update(scriptProposals).set({ status: 'executed' }).where(eq(scriptProposals.id, proposalId));
      return db.insert(scriptExecutions).values({
        orgId: s.orgId, deviceId: s.deviceId, sourceKind: 'proposal', proposalId, scriptId: null,
        status: 'completed', exitCode: 0, stdout: 'ok', triggerType: 'manual',
        language: 'powershell', timeoutSeconds: 60, runAs: 'system', contentDigest: 'a'.repeat(64),
        // #5645: the run's method, as the release stamps it — a lane run here,
        // so promotion below must NOT read as four_eyes.
        approvedBy: s.requester.id, approvalMethod: 'unattended_reviewer_gated',
        startedAt: new Date(), completedAt: new Date(),
      } as never).returning({ id: scriptExecutions.id });
    });

    expect(await runScriptVerifyJob({ proposalId, executionId: execution!.id, attempt: 1 })).toBe('verified');
    let proposal = await readProposal(proposalId);
    expect(proposal.status).toBe('verified');
    expect(proposal.verifiedAt).toBeInstanceOf(Date);
    expect((proposal.verificationResult as { outcome: string }).outcome).toBe('verified');

    // Idempotent: a duplicate job after the verdict is a no-op.
    expect(await runScriptVerifyJob({ proposalId, executionId: execution!.id, attempt: 1 })).toBe('unknown');

    const detail = await get(`/ai/script-proposals/${proposalId}`, token);
    expect((await detail.json()).viewer.canPromote).toBe(true);

    const promoted = await post(`/ai/script-proposals/${proposalId}/promote`, token, {
      name: 'Enable Contoso', ownerScope: 'organization',
    });
    expect(promoted.status).toBe(201);
    const { scriptId, versionId } = await promoted.json();

    await withSystemDbAccessContext(async () => {
      const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId));
      expect(script!.origin).toBe('ai_proposal');
      expect(script!.originProposalId).toBe(proposalId);
      expect(script!.orgId).toBe(s.orgId);
      expect(script!.acknowledgedSecurityPatterns).toEqual(strictHits);
      expect(script!.securityAcknowledgedBy).toBe(s.requester.id);
      expect(script!.version).toBe(1);
      const [version] = await db.select().from(scriptVersions).where(eq(scriptVersions.id, versionId));
      expect(version!.version).toBe(1);
      expect(version!.origin).toBe('ai_proposal');
      expect(version!.proposalId).toBe(proposalId);
      expect(version!.reviewId).not.toBeNull();
      expect(version!.approvedBy).toBe(s.requester.id);
      // #5645: the promoted version carries the RUN's method, not a constant.
      expect(version!.approvalMethod).toBe('unattended_reviewer_gated');
    });
    proposal = await readProposal(proposalId);
    expect(proposal.status).toBe('promoted');
    expect(proposal.promotedScriptId).toBe(scriptId);
    expect(proposal.promotedVersionId).toBe(versionId);

    // Promoting twice is refused at the read gate (viewer.canPromote is false
    // once the proposal is `promoted`), no second script.
    const again = await post(`/ai/script-proposals/${proposalId}/promote`, token, { name: 'X', ownerScope: 'organization' });
    expect(again.status).toBe(403);
    const scriptRows = await withSystemDbAccessContext(() => db.select({ id: scripts.id }).from(scripts).where(eq(scripts.originProposalId, proposalId)));
    expect(scriptRows).toHaveLength(1);
  });

  runDb('a final unknown after three attempts leaves executed as verification_failed with outcome unknown', async () => {
    const { proposalId } = await seedReviewedStrictProposal(s);
    const [execution] = await withSystemDbAccessContext(async () => {
      await db.update(scriptProposals).set({ status: 'executed' }).where(eq(scriptProposals.id, proposalId));
      // status 'timeout' + no exit code → the exit_code claim is `unknown`.
      return db.insert(scriptExecutions).values({
        orgId: s.orgId, deviceId: s.deviceId, sourceKind: 'proposal', proposalId, scriptId: null,
        status: 'timeout', exitCode: null, stdout: null, triggerType: 'manual',
        language: 'powershell', timeoutSeconds: 60, runAs: 'system', contentDigest: 'a'.repeat(64),
        startedAt: new Date(),
      } as never).returning({ id: scriptExecutions.id });
    });
    expect(await runScriptVerifyJob({ proposalId, executionId: execution!.id, attempt: 3 })).toBe('unknown');
    const proposal = await readProposal(proposalId);
    expect(proposal.status).toBe('verification_failed');
    expect((proposal.verificationResult as { outcome: string; attempts: number })).toMatchObject({ outcome: 'unknown', attempts: 3 });
  });
});
