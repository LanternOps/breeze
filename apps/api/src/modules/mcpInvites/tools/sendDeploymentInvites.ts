import { z } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../../../db';
import { deploymentInvites, partners } from '../../../db/schema';
import { mintChildEnrollmentKey } from '../../../routes/enrollmentKeys';
import { rateLimiter } from '../../../services/rate-limit';
import { getRedis } from '../../../services/redis';
import { buildDeploymentInviteEmail } from '../../../services/deploymentInviteEmail';
import { getEmailService } from '../../../services/email';
import { writeAuditEvent, requestLikeFromSnapshot } from '../../../services/auditEvents';
import type { BootstrapTool, BootstrapContext } from '../types';
import { BootstrapError } from '../types';

const FREE_TIER_DEVICE_CAP = 25;
const INVITE_RATE_LIMIT = 50;
const INVITE_RATE_WINDOW_SECONDS = 3600;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHILD_KEY_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days for an invite-linked installer

const inputSchema = z.object({
  emails: z.array(z.string().email().max(254)).min(1).max(FREE_TIER_DEVICE_CAP),
  custom_message: z.string().max(500).optional(),
  // os_targets is accepted but currently unused — OS detection happens at
  // the /i/:short_code landing page based on the recipient's user-agent.
  // Kept on the schema for forward-compat with per-recipient OS overrides.
  os_targets: z.enum(['win', 'mac', 'linux', 'auto']).default('auto'),
});

type SendInput = z.infer<typeof inputSchema>;

export interface SendDeploymentInvitesOutput {
  invites_sent: number;
  invite_ids: string[];
  skipped_duplicates: number;
  failures?: Array<{ email: string; error: string }>;
}

const TOOL_DESCRIPTION =
  'Sends install-link emails to a list of staff. Requires an active tenant. If the tenant is inactive (`partner.status != \'active\'`), the call returns 402 with the configured billing URL the user must visit.';

async function sendDeploymentInvitesHandler(
  input: SendInput,
  ctx: BootstrapContext,
): Promise<SendDeploymentInvitesOutput> {
  if (!ctx.apiKey) {
    throw new Error('send_deployment_invites: ctx.apiKey missing — tool must run behind auth');
  }
  const { partnerId, id: apiKeyId, partnerAdminEmail } = ctx.apiKey;

  // Rate limit FIRST, before any DB writes. Per-tenant (partner) limiter.
  const rl = await rateLimiter(
    getRedis(),
    `mcp:invites:tenant:${partnerId}`,
    INVITE_RATE_LIMIT,
    INVITE_RATE_WINDOW_SECONDS,
  );
  if (!rl.allowed) {
    throw new BootstrapError(
      'RATE_LIMITED',
      `Invite rate limit exceeded for this tenant (${INVITE_RATE_LIMIT} per hour). Try again after ${rl.resetAt.toISOString()}.`,
    );
  }

  // Dedupe: drop any recipient that was already invited in the last 24h.
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const recent = await db
    .select({ email: deploymentInvites.invitedEmail })
    .from(deploymentInvites)
    .where(
      and(
        eq(deploymentInvites.partnerId, partnerId),
        gt(deploymentInvites.sentAt, since),
      ),
    );
  const recentSet = new Set(recent.map((r) => r.email.toLowerCase()));

  const toSendRaw: string[] = [];
  const seenInBatch = new Set<string>();
  for (const email of input.emails) {
    const normalized = email.toLowerCase();
    if (recentSet.has(normalized)) continue;
    if (seenInBatch.has(normalized)) continue; // dedupe within the same call
    seenInBatch.add(normalized);
    toSendRaw.push(email);
  }
  const skipped = input.emails.length - toSendRaw.length;

  if (toSendRaw.length === 0) {
    return { invites_sent: 0, invite_ids: [], skipped_duplicates: skipped };
  }

  // Look up the tenant display name for the email template.
  const [partner] = await db
    .select({ name: partners.name })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  if (!partner) {
    throw new BootstrapError('UNKNOWN_TENANT', 'Partner row missing for authenticated API key.');
  }

  const emailSvc = getEmailService();
  if (!emailSvc) {
    throw new BootstrapError(
      'EMAIL_UNAVAILABLE',
      'Email service is not configured on this deployment; cannot send invites.',
    );
  }

  const base = process.env.PUBLIC_ACTIVATION_BASE_URL;
  if (!base) {
    throw new Error('PUBLIC_ACTIVATION_BASE_URL not configured');
  }

  const auditShim = requestLikeFromSnapshot({
    ip: ctx.ip ?? undefined,
    userAgent: ctx.userAgent ?? undefined,
  });

  const inviteIds: string[] = [];
  const failures: Array<{ email: string; error: string }> = [];

  // Per-recipient best-effort: one bad email shouldn't abort the batch.
  // Failures are audited and returned in `failures` so the caller can decide
  // whether to retry. The child key for a failed send is left in place (it
  // will expire on its own); we avoid cascade deletes to keep the happy-path
  // simple and auditable.
  for (const email of toSendRaw) {
    try {
      const child = await mintChildEnrollmentKey({
        partnerId,
        expiresInSeconds: CHILD_KEY_TTL_SECONDS,
        maxUsage: 1,
        nameSuffix: email.toLowerCase(),
      });

      const installUrl = `${base.replace(/\/$/, '')}/i/${child.shortCode}`;
      const tmpl = buildDeploymentInviteEmail({
        orgName: partner.name,
        adminEmail: partnerAdminEmail,
        installUrl,
        customMessage: input.custom_message,
      });

      await emailSvc.sendEmail({
        to: email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      });

      const [row] = await db
        .insert(deploymentInvites)
        .values({
          partnerId,
          orgId: child.orgId,
          enrollmentKeyId: child.id,
          invitedEmail: email.toLowerCase(),
          invitedByApiKeyId: apiKeyId,
          customMessage: input.custom_message ?? null,
          status: 'sent',
        })
        .returning({ id: deploymentInvites.id });

      if (!row) {
        throw new Error('insert deployment_invites returned no row');
      }
      inviteIds.push(row.id);

      writeAuditEvent(auditShim, {
        orgId: child.orgId,
        actorType: 'api_key',
        actorId: apiKeyId,
        action: 'invite.sent',
        resourceType: 'deployment_invite',
        resourceId: row.id,
        result: 'success',
        details: {
          mcp_origin: true,
          recipient_domain: email.split('@')[1] ?? null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ email, error: message });
      writeAuditEvent(auditShim, {
        orgId: null,
        actorType: 'api_key',
        actorId: apiKeyId,
        action: 'invite.sent',
        resourceType: 'deployment_invite',
        result: 'failure',
        errorMessage: message,
        details: {
          mcp_origin: true,
          recipient_domain: email.split('@')[1] ?? null,
        },
      });
    }
  }

  const result: SendDeploymentInvitesOutput = {
    invites_sent: inviteIds.length,
    invite_ids: inviteIds,
    skipped_duplicates: skipped,
  };
  if (failures.length > 0) result.failures = failures;
  return result;
}

export const sendDeploymentInvitesTool: BootstrapTool<SendInput, SendDeploymentInvitesOutput> = {
  definition: {
    name: 'send_deployment_invites',
    description: TOOL_DESCRIPTION,
    inputSchema,
  },
  handler: sendDeploymentInvitesHandler,
};
