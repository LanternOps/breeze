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
import { recordActivationTransition } from '../metrics';

const inputSchema = z.object({ tenant_id: z.string().uuid() });

type VerifyOutput =
  | { status: 'pending_email' }
  | { status: 'expired'; remediation: string }
  | { status: 'pending_payment'; api_key: string | null; scope: 'readonly' | 'full'; next_steps: string }
  | { status: 'active'; api_key: string | null; scope: 'readonly' | 'full'; next_steps: string };

const ACTIVE_NEXT_STEPS =
  'Tenant active. Your tenant is now ready for MCP-client connections. When the user adds Breeze as an MCP connector (Claude.ai: Settings → Connectors → Add Breeze, ChatGPT: Connectors tab → Add), the OAuth flow will launch in a browser: they sign into Breeze, approve the connection, and the client receives an access token automatically. No API key to copy. After they complete the browser flow, re-query tools/list — the authenticated surface (send_deployment_invites, configure_defaults, get_fleet_status, ~30 more) will appear. STOP and ask the user to confirm the connector is added before continuing.';

const PENDING_PAYMENT_NEXT_STEPS =
  'Readonly API key issued for backwards compatibility. Call attach_payment_method next — it returns a Stripe Checkout URL. Once the user completes Stripe, verify_tenant will return status=active and fresh next_steps guiding them through the OAuth connector setup (no API key copy-paste needed — the user simply adds the connector in their MCP client and approves in the browser).';

export const verifyTenantTool: BootstrapTool<z.infer<typeof inputSchema>, VerifyOutput> = {
  definition: {
    name: 'verify_tenant',
    description: [
      'Check the activation status of a tenant created via create_tenant. Poll this tool (suggested interval: 5s) until { status: "active" }.',
      'Returns one of:',
      '- { status: "pending_email" } — admin has not clicked the activation link yet.',
      '- { status: "pending_payment", api_key, scope: "readonly", next_steps } — email verified; a readonly API key is minted on the first poll after verification. A readonly API key is also minted for backwards-compatible HTTP/CLI callers; raw-MCP clients (Claude.ai, ChatGPT, Cursor) should follow `next_steps` and use the OAuth connector flow instead.',
      '- { status: "active", api_key, scope: "full", next_steps } — fully activated. api_key is still returned for backwards-compatible HTTP/CLI callers; the recommended path for MCP clients (Claude.ai/ChatGPT/Cursor) is the OAuth connector — see `next_steps`.',
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
        recordActivationTransition('expired');
        return {
          status: 'expired',
          remediation: 'Call create_tenant again with the same admin_email to issue a new activation link.',
        };
      }
      return { status: 'pending_email' };
    }

    // Email verified — resolve the partner's default organization (first org
    // created by createPartner, ordered by createdAt ascending) and look up
    // the MCP-provisioning API key scoped to that org.
    let defaultOrgId: string | null = null;
    let adminUserId: string | null = null;
    let rawKey: string | null = null;

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

    const [byOrg] = await db
      .select({ id: apiKeys.id, scopeState: apiKeys.scopeState })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, defaultOrgId), eq(apiKeys.status, 'active')))
      .limit(1);
    let keyRow = byOrg;

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
      next_steps: partner.paymentMethodAttachedAt ? ACTIVE_NEXT_STEPS : PENDING_PAYMENT_NEXT_STEPS,
    };
  },
};
