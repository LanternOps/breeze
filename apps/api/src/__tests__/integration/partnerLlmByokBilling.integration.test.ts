import './setup';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { aiCostUsage, aiSessions, partnerLlmConfigs } from '../../db/schema';
import { recordUsageFromSdkResult } from '../../services/aiCostTracker';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

describe('partner LLM BYOK billing split', () => {
  runDb('records partner-key usage without calling the billing-service deduct endpoint', async () => {
    const { partner, org, session } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      await db.insert(partnerLlmConfigs).values({
        partnerId: partner.id,
        apiKeyEncrypted: 'enc:integration-key',
        keyLast4: 'test',
        keyFingerprint: `integration-${crypto.randomUUID()}`,
        status: 'active',
      });
      const [session] = await db
        .insert(aiSessions)
        .values({
          orgId: org.id,
          model: 'claude-sonnet-4-6',
          type: 'general',
        })
        .returning({ id: aiSessions.id });
      return { partner, org, session: session! };
    });

    const previousBillingUrl = process.env.BILLING_SERVICE_URL;
    const previousBillingKey = process.env.BILLING_SERVICE_API_KEY;
    process.env.BILLING_SERVICE_URL = 'https://billing.internal';
    process.env.BILLING_SERVICE_API_KEY = 'billing-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    try {
      await withDbAccessContext(orgContext(org.id), () =>
        recordUsageFromSdkResult(session.id, org.id, {
          total_cost_usd: 0.1234,
          usage: { input_tokens: 5_000, output_tokens: 2_000 },
          num_turns: 1,
          model: 'claude-sonnet-4-6',
        }, 'partner_key'),
      );

      const rows = await withSystemDbAccessContext(() =>
        db
          .select({
            billingSource: aiCostUsage.billingSource,
            totalCostCents: aiCostUsage.totalCostCents,
          })
          .from(aiCostUsage)
          .where(and(
            eq(aiCostUsage.orgId, org.id),
            eq(aiCostUsage.period, 'daily'),
          )),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ billingSource: 'partner_key', totalCostCents: 12.34 });
      expect(fetchSpy).not.toHaveBeenCalled();

      await withDbAccessContext(orgContext(org.id), () =>
        recordUsageFromSdkResult(session.id, org.id, {
          total_cost_usd: 0.1234,
          usage: { input_tokens: 5_000, output_tokens: 2_000 },
          num_turns: 1,
          model: 'claude-sonnet-4-6',
        }, 'platform'),
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://billing.internal/api/internal/partners/${partner.id}/ai-credits/deduct`,
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      fetchSpy.mockRestore();
      if (previousBillingUrl === undefined) delete process.env.BILLING_SERVICE_URL;
      else process.env.BILLING_SERVICE_URL = previousBillingUrl;
      if (previousBillingKey === undefined) delete process.env.BILLING_SERVICE_API_KEY;
      else process.env.BILLING_SERVICE_API_KEY = previousBillingKey;
    }
  });
});
