/**
 * AI script authoring W06 (#5618) — live-DB coverage that the mocked unit
 * suites cannot see: dispatching a proposal-backed script against real
 * Postgres actually lands an `ai.script.executed` audit_logs row carrying
 * the dispatch-time provenance snapshot (scriptDispatch.ts), and that row
 * is picked up by the device activity feed's real resource-arm query
 * (routes/devices/events.ts) under the same partial-index predicate the
 * rest of the feed relies on — not just a mocked assertion that the right
 * SQL fragments were built.
 */
import './setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { getTestDb } from './setup';
import { withSystemDbAccessContext } from '../../db';
import { auditLogs, devices, scriptProposals } from '../../db/schema';
import { assignUserToOrganization, createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions } from './db-utils';
import { dispatchScriptToDevice } from '../../services/scriptDispatch';
import { createScriptProposal } from '../../services/scriptProposals';
import { loadProposalRow } from '../../services/scriptProposals/queries';
import { proposalDispatchSnapshot } from '../../services/scriptProposals/dispatchSnapshot';
import { eventsRoutes } from '../../routes/devices/events';
import { createAccessToken } from '../../services/jwt';

async function seedReviewedProposal(orgId: string, deviceId: string) {
  const auth = { orgId, user: { id: null }, principal: { kind: 'user_session' } } as never;
  const { proposal } = await withSystemDbAccessContext(() =>
    createScriptProposal(
      auth,
      {
        language: 'bash', content: 'echo restart-spooler', goal: 'Restart the print spooler',
        expectedEffect: 'Print spooler restarts', verification: { kind: 'exit_code', equals: 0 },
        deviceIds: [deviceId], runAs: 'system', timeoutSeconds: 60,
      },
      { kind: 'chat_session', sessionId: null },
    ),
  );
  await withSystemDbAccessContext(() =>
    getTestDb()
      .update(scriptProposals)
      .set({ status: 'reviewed', riskTier: 'low' })
      .where(eq(scriptProposals.id, proposal.id)),
  );
  return proposal.id;
}

describe('AI-authored dispatch — audit row lands and the device feed sees it (live Postgres)', () => {
  it('writes an ai.script.executed audit row from the dispatch provenance, and the device events route returns it', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const approver = await createUser({ partnerId: partner.id, orgId: org.id });

    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site!.id,
        // Real, DB-required agentId — the SNAPSHOT below nulls it so dispatch
        // takes the "no agent connected" path deterministically, same as
        // scriptSecretDelivery.integration.test.ts.
        agentId: randomUUID(),
        hostname: `ai-audit-feed-${randomUUID().slice(0, 8)}`,
        osType: 'linux',
        osVersion: '24.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        enrolledAt: new Date(),
      })
      .returning();

    const proposalId = await seedReviewedProposal(org.id, device!.id);
    const proposal = await loadProposalRow(proposalId);
    expect(proposal).not.toBeNull();
    const snapshot = proposalDispatchSnapshot(proposal!, [device!.id]);

    const dispatch = await withSystemDbAccessContext(() =>
      dispatchScriptToDevice({
        device: {
          id: device!.id, orgId: device!.orgId, osType: device!.osType, status: device!.status,
          agentId: null as unknown as string, hostname: device!.hostname, siteId: device!.siteId,
          customFields: device!.customFields,
        },
        source: { kind: 'proposal', proposal: proposal!, snapshot },
        triggerType: 'manual',
        createdBy: approver.id,
        runAs: proposal!.runAs,
        timeoutSeconds: proposal!.timeoutSeconds,
        provenance: {
          approvedBy: approver.id,
          approvalMethod: 'supervised_self',
          reviewRiskTier: 'low',
          reviewSummary: 'Restarts the print spooler service.',
        },
      }),
    );
    expect(dispatch.ok).toBe(true);
    if (!dispatch.ok) return;

    // 1. The audit row lands with the dispatch-time snapshot — never a live
    // read of script_proposals (the plan's stated architecture).
    // createAuditLogAsync is fire-and-forget (void, not awaited by
    // dispatchScriptToDevice), so poll for the row rather than assuming it
    // has already landed the instant dispatch's own promise resolves.
    const findRow = async () => {
      const rows = await withSystemDbAccessContext(() =>
        getTestDb().select().from(auditLogs).where(eq(auditLogs.action, 'ai.script.executed')),
      );
      return rows.find((r) => r.resourceId === device!.id);
    };
    await expect.poll(findRow, { timeout: 5000, interval: 100 }).toBeDefined();
    const row = await findRow();
    expect(row).toBeDefined();
    expect(row!.orgId).toBe(org.id);
    expect(row!.actorType).toBe('user');
    expect(row!.initiatedBy).toBe('ai');
    expect(row!.result).toBe('dispatched');
    expect(row!.details).toMatchObject({
      proposalId,
      sourceKind: 'proposal',
      approvalMethod: 'supervised_self',
      reviewRiskTier: 'low',
      reviewSummary: 'Restarts the print spooler service.',
      executionId: dispatch.executionId,
    });

    // 2. The device activity feed's real route + query returns this row —
    // proves it clears the resource-arm predicate (org_id + resource_id),
    // not just that the write happened. `setupTestEnvironment` always mints
    // its own org, so a token scoped to THIS test's org is built directly.
    const role = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
    await assignUserToOrganization(approver.id, org.id, role.id);
    const token = await createAccessToken({
      sub: approver.id, email: approver.email, roleId: role.id, orgId: org.id, partnerId: partner.id,
      scope: 'organization', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
    });

    const app = new Hono();
    app.route('/devices', eventsRoutes);
    const res = await app.request(`/devices/${device!.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const feedRow = (body.data as Array<{ action: string; details: Record<string, unknown> | null }>).find(
      (e) => e.action === 'ai.script.executed',
    );
    expect(feedRow).toBeDefined();
    expect(feedRow!.details).toMatchObject({ proposalId });
  });
});
