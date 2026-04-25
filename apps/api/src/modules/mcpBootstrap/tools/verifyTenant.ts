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
import { isBootstrapSecretValid } from '../bootstrapSecret';

const inputSchema = z.object({
  tenant_id: z.string().uuid(),
  bootstrap_secret: z.string().min(32).max(128),
});

type VerifyOutput =
  | { status: 'pending_email' }
  | { status: 'expired'; remediation: string }
  | { status: 'pending_payment'; api_key: string | null; scope: 'readonly' | 'full'; next_steps?: string }
  | { status: 'active'; api_key: string | null; scope: 'readonly' | 'full'; next_steps?: string };

export const verifyTenantTool: BootstrapTool<z.infer<typeof inputSchema>, VerifyOutput> = {
  definition: {
    name: 'verify_tenant',
    description: [
      'Check the activation status of a tenant created via create_tenant. Requires the tenant_id and bootstrap_secret returned by create_tenant. Poll this tool at ~30 second intervals until { status: "active" }.',
      'Returns one of:',
      '- { status: "pending_email" } — admin has not clicked the activation link yet.',
      '- { status: "pending_payment", api_key, scope: "readonly", next_steps } — email verified; a readonly API key is minted on the first poll after verification. Call attach_payment_method to unlock mutations. (api_key is for backwards-compatible HTTP/CLI callers — Claude.ai/ChatGPT/Cursor should follow `next_steps` and use the OAuth connector flow instead.)',
      '- { status: "active", api_key, scope: "full", next_steps } — fully activated. The API key value is stable across the pending_payment → active transition (scope is upgraded in place on the existing key row). For MCP clients (Claude.ai/ChatGPT/Cursor) the recommended path is the OAuth connector — see `next_steps`.',
      '- { status: "expired", remediation } — activation window lapsed; call create_tenant again with the same admin_email to reissue.',
      'IMPORTANT — polling discipline: activation requires manual human actions (clicking the email link, completing Stripe identity check). Do not hammer this endpoint. If you get `pending_email` 2-3 times in a row, STOP polling and ask the user to confirm they clicked the email. Same for `pending_payment` after you surface the Stripe URL — stop and wait for the user to say they completed it. Resume polling only after explicit user confirmation.',
      'IMPORTANT: api_key is returned ONLY on the first poll after it is minted. Store it immediately. On subsequent polls, api_key will be null — the key already exists server-side and you should keep using the one you stored.',
      'IMPORTANT — revealing authenticated tools: when api_key is returned, the `next_steps` field tells the user how to wire the key into their MCP client. Relay it verbatim. Do NOT tell the user that send_deployment_invites, configure_defaults, get_fleet_status, etc. do not exist — they DO exist but only appear in tools/list to authenticated callers. After the user reconfigures their connector\'s X-API-Key header, re-query tools/list to discover the full surface.',
      'Rate limit: 60 requests per minute per tenant_id. At the recommended 30s interval this is ample.',
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
        settings: partners.settings,
      })
      .from(partners)
      .where(eq(partners.id, input.tenant_id))
      .limit(1);

    if (!partner) {
      throw new BootstrapError('UNKNOWN_TENANT', 'Tenant not found.');
    }
    if (!isBootstrapSecretValid(partner.settings, input.bootstrap_secret)) {
      throw new BootstrapError('INVALID_BOOTSTRAP_SECRET', 'Invalid bootstrap secret for this tenant.');
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
    const status = partner.paymentMethodAttachedAt ? 'active' : 'pending_payment';

    const nextSteps = status === 'active'
      ? 'Tenant active. For Claude.ai / ChatGPT / Cursor (or any MCP client that supports OAuth): add Breeze as a custom connector and approve the OAuth flow in the browser — no API key copy-paste needed; the client receives an access token automatically. For raw HTTP / CLI callers: paste the api_key returned by this activation flow into the X-API-Key header. Either way, re-query tools/list once authenticated to see the full surface (send_deployment_invites, configure_defaults, get_fleet_status, get_fleet_health, and ~30 more). STOP and ask the user to confirm the connector is wired before continuing.'
      : status === 'pending_payment'
      ? 'Readonly API key issued. You can use it now for read-only calls, but mutating tools are blocked until a payment method is attached. Call attach_payment_method next — it returns a Stripe Checkout URL you should surface to the user for identity verification. Once the user completes Stripe, verify_tenant will return status=active and fresh next_steps guiding both the OAuth connector flow (Claude.ai / ChatGPT / Cursor) and the X-API-Key header alternative for HTTP/CLI callers.'
      : undefined;

    return {
      status,
      api_key: rawKey,
      scope,
      ...(nextSteps ? { next_steps: nextSteps } : {}),
    };
  },
};
