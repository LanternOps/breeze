import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../../../db';
import { partnerActivations } from '../../../db/schema';
import { createPartner, findRecentMcpPartnerByAdminEmail } from '../../../services/partnerCreate';
import { rateLimiter } from '../../../services/rate-limit';
import { getRedis } from '../../../services/redis';
import { validateBusinessEmail, loadOverridesFromEnv } from '@breeze/shared';
import { sendActivationEmail } from '../../../services/activationEmail';
import { writeAuditEvent, requestLikeFromSnapshot } from '../../../services/auditEvents';
import type { BootstrapTool } from '../types';
import { BootstrapError } from '../types';
import { recordActivationTransition } from '../metrics';

const inputSchema = z.object({
  org_name: z.string().min(2).max(64),
  admin_email: z.string().email().max(254),
  admin_name: z.string().min(1).max(128),
  region: z.enum(['us', 'eu']),
});

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000;

type CreateTenantOutput = { tenant_id: string; activation_status: 'pending_email' };

export const createTenantTool: BootstrapTool<z.infer<typeof inputSchema>, CreateTenantOutput> = {
  definition: {
    name: 'create_tenant',
    description: [
      'Create a brand-new Breeze tenant for an organization. This is the entry point for agent-driven Breeze setup.',
      'Accepts an org name, an admin email (must be a business email — free-provider and disposable-email domains are rejected), a name, and a region ("us" or "eu" — must match the MCP endpoint you are connected to).',
      'Returns a tenant_id. No API key is issued yet. An activation email is sent to the admin. Call verify_tenant(tenant_id) to poll for activation status; once the admin clicks the link, verify_tenant will return a readonly API key that you use for subsequent calls. To unlock mutations (invites, configuration), the admin must attach a payment method via attach_payment_method.',
      'If you get INVALID_EMAIL with reason "free_provider" or "disposable", ask the user for a business email.',
      'If you get REGION_MISMATCH, connect to the correct regional MCP endpoint.',
    ].join(' '),
    inputSchema,
  },
  handler: async (input, ctx): Promise<CreateTenantOutput> => {
    if (input.region !== ctx.region) {
      throw new BootstrapError(
        'REGION_MISMATCH',
        `This endpoint serves region "${ctx.region}" but create_tenant was called with region "${input.region}".`,
      );
    }

    const emailCheck = validateBusinessEmail(input.admin_email, loadOverridesFromEnv());
    if (!emailCheck.ok) {
      throw new BootstrapError(
        'INVALID_EMAIL',
        `Admin email rejected: ${emailCheck.reason}. Use a business email (not gmail/outlook/etc., not disposable).`,
      );
    }

    const redis = getRedis();
    const ip = ctx.ip ?? 'unknown';
    const domain = input.admin_email.split('@')[1]!.toLowerCase();

    // Ordering: cheapest (per-IP) → domain → global. Short-circuit on first denial.
    if (!(await rateLimiter(redis, `mcp:bootstrap:ip:${ip}`, 3, 3600)).allowed) {
      throw new BootstrapError('RATE_LIMITED', 'Per-IP rate limit exceeded.');
    }
    if (!(await rateLimiter(redis, `mcp:bootstrap:domain:${domain}`, 5, 86400)).allowed) {
      throw new BootstrapError('RATE_LIMITED', 'Per-email-domain rate limit exceeded.');
    }
    if (!(await rateLimiter(redis, `mcp:bootstrap:global`, 200, 3600)).allowed) {
      throw new BootstrapError('RATE_LIMITED', 'Global signup rate limit exceeded. Try again in an hour.');
    }

    // Idempotency: if a recent MCP-origin partner matches email + org_name,
    // reuse it and mint a fresh activation token rather than creating a duplicate.
    const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
    const existing = await findRecentMcpPartnerByAdminEmail(input.admin_email, input.org_name, since);
    if (existing) {
      await issueActivationToken(existing.id, input.admin_email);
      recordActivationTransition('pending_email');
      return { tenant_id: existing.id, activation_status: 'pending_email' };
    }

    const result = await createPartner({
      orgName: input.org_name,
      adminEmail: input.admin_email,
      adminName: input.admin_name,
      passwordHash: null,
      origin: { mcp: true, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined },
    });

    await issueActivationToken(result.partnerId, input.admin_email);

    const reqLike = requestLikeFromSnapshot({
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    writeAuditEvent(reqLike, {
      orgId: null,
      actorType: 'system',
      action: 'partner.mcp_provisioned',
      resourceType: 'partner',
      resourceId: result.partnerId,
      result: 'success',
      details: {
        mcp_origin: true,
        tool_name: 'create_tenant',
        ip: ctx.ip,
        ua: ctx.userAgent,
      },
    });

    recordActivationTransition('pending_email');
    return { tenant_id: result.partnerId, activation_status: 'pending_email' };
  },
};

async function issueActivationToken(partnerId: string, adminEmail: string): Promise<void> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await db.insert(partnerActivations).values({
    partnerId,
    tokenHash,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  await sendActivationEmail({ to: adminEmail, rawToken, partnerId });
}
