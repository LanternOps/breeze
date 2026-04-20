import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../db';
import {
  partners,
  partnerActivations,
  apiKeys,
  organizations,
  partnerUsers,
} from '../../../db/schema';
import { rateLimiter } from '../../../services/rate-limit';
import { getRedis } from '../../../services/redis';
import { mintApiKey } from '../../../services/apiKeys';
import type { BootstrapTool } from '../types';
import { BootstrapError } from '../types';

const inputSchema = z.object({ tenant_id: z.string().uuid() });

type VerifyOutput =
  | { status: 'pending_email' }
  | { status: 'expired'; remediation: string }
  | { status: 'pending_payment'; api_key: string | null; scope: 'readonly' | 'full' }
  | { status: 'active'; api_key: string | null; scope: 'readonly' | 'full' };

export const verifyTenantTool: BootstrapTool<z.infer<typeof inputSchema>, VerifyOutput> = {
  definition: {
    name: 'verify_tenant',
    description: [
      'Check the activation status of a tenant created via create_tenant. Poll this tool (suggested interval: 5s) until { status: "active" }.',
      'Returns one of:',
      '- { status: "pending_email" } — admin has not clicked the activation link yet.',
      '- { status: "pending_payment", api_key, scope: "readonly" } — email verified; a readonly API key is minted on the first poll after verification. Use it as the Authorization Bearer token for read-only MCP calls. Call attach_payment_method to unlock mutations.',
      '- { status: "active", api_key, scope: "full" } — fully activated. The API key value is stable across the pending_payment → active transition (scope is upgraded in place on the existing key row).',
      '- { status: "expired", remediation } — activation window lapsed; call create_tenant again with the same admin_email to reissue.',
      'IMPORTANT: api_key is returned ONLY on the first poll after it is minted. Store it immediately. On subsequent polls, api_key will be null — the key already exists server-side and you should keep using the one you stored.',
      'Polling rate: 60 requests per minute per tenant_id. Slow down to ~1 poll per second.',
    ].join(' '),
    inputSchema,
  },
  handler: async (input): Promise<VerifyOutput> => {
    const rl = await rateLimiter(getRedis(), `mcp:verify:tenant:${input.tenant_id}`, 60, 60);
    if (!rl.allowed) {
      throw new BootstrapError('RATE_LIMITED', 'Polling rate limit exceeded; slow down to ~1 per second.');
    }

    const [partner] = await db
      .select({
        id: partners.id,
        emailVerifiedAt: partners.emailVerifiedAt,
        paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
      })
      .from(partners)
      .where(eq(partners.id, input.tenant_id))
      .limit(1);

    if (!partner) {
      throw new BootstrapError('UNKNOWN_TENANT', 'Tenant not found.');
    }

    // Email not yet verified → either pending_email or expired.
    if (!partner.emailVerifiedAt) {
      const [latest] = await db
        .select({
          expiresAt: partnerActivations.expiresAt,
          consumedAt: partnerActivations.consumedAt,
        })
        .from(partnerActivations)
        .where(eq(partnerActivations.partnerId, partner.id))
        .orderBy(desc(partnerActivations.createdAt))
        .limit(1);

      if (latest && !latest.consumedAt && latest.expiresAt < new Date()) {
        return {
          status: 'expired',
          remediation: 'Call create_tenant again with the same admin_email to issue a new activation link.',
        };
      }
      return { status: 'pending_email' };
    }

    // Email verified — look up the MCP-provisioning API key (if any).
    const [existingKey] = await db
      .select({ id: apiKeys.id, scopeState: apiKeys.scopeState })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, partner.id), eq(apiKeys.status, 'active')))
      .limit(1);

    // Fallback for existingKey lookup: apiKeys are scoped by org_id, not
    // partner_id. We try partner.id first (defensive, in case future migrations
    // introduce a partner_id column), then fall back to the partner's default
    // organization id. For now, look up the default org and search there too.
    let keyRow = existingKey;
    let defaultOrgId: string | null = null;
    let adminUserId: string | null = null;
    let rawKey: string | null = null;

    if (!keyRow) {
      // Resolve the partner's default organization (first org created by
      // createPartner — ordered by createdAt ascending).
      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, partner.id))
        .limit(1);
      if (!org) {
        throw new BootstrapError(
          'TENANT_INCOMPLETE',
          'Tenant has no default organization; cannot mint API key.',
        );
      }
      defaultOrgId = org.id;

      // Re-check with the real org scope.
      const [byOrg] = await db
        .select({ id: apiKeys.id, scopeState: apiKeys.scopeState })
        .from(apiKeys)
        .where(and(eq(apiKeys.orgId, defaultOrgId), eq(apiKeys.status, 'active')))
        .limit(1);
      keyRow = byOrg;
    }

    if (!keyRow) {
      // Need an admin user id for api_keys.created_by (NOT NULL).
      const [link] = await db
        .select({ userId: partnerUsers.userId })
        .from(partnerUsers)
        .where(eq(partnerUsers.partnerId, partner.id))
        .limit(1);
      if (!link) {
        throw new BootstrapError(
          'TENANT_INCOMPLETE',
          'Tenant has no partner admin user; cannot mint API key.',
        );
      }
      adminUserId = link.userId;

      const minted = await mintApiKey({
        partnerId: partner.id,
        defaultOrgId: defaultOrgId!,
        createdByUserId: adminUserId,
        name: 'MCP Provisioning',
        scopeState: partner.paymentMethodAttachedAt ? 'full' : 'readonly',
        scopes: ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'],
        source: 'mcp_provisioning',
      });
      keyRow = {
        id: minted.id,
        scopeState: partner.paymentMethodAttachedAt ? 'full' : 'readonly',
      };
      rawKey = minted.rawKey;
    }

    // Upgrade in place on first `active` poll.
    if (partner.paymentMethodAttachedAt && keyRow.scopeState === 'readonly') {
      await db
        .update(apiKeys)
        .set({ scopeState: 'full' })
        .where(eq(apiKeys.id, keyRow.id));
      keyRow = { ...keyRow, scopeState: 'full' };
    }

    const scope = keyRow.scopeState as 'readonly' | 'full';
    return {
      status: partner.paymentMethodAttachedAt ? 'active' : 'pending_payment',
      api_key: rawKey,
      scope,
    };
  },
};
