import { z } from 'zod';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../../db';
import {
  deviceGroups,
  notificationChannels,
  alertTemplates,
  alertRules,
  partners,
} from '../../../db/schema';
import { requirePaymentMethod } from '../paymentGate';
import { writeAuditEvent, requestLikeFromSnapshot } from '../../../services/auditEvents';
import type { BootstrapTool, BootstrapContext } from '../types';

// ---- Input / output -------------------------------------------------------

const inputSchema = z.object({
  framework: z.enum(['standard', 'cis']).default('standard').optional(),
  risk_level: z.enum(['low', 'standard', 'strict']).default('standard').optional(),
});

type ConfigureDefaultsInput = z.infer<typeof inputSchema>;

interface StepResult {
  created: boolean;
  skipped_reason?: string;
}

export interface ConfigureDefaultsOutput {
  applied: {
    device_group: StepResult;
    alert_policy: StepResult;
    risk_profile: StepResult;
    notification_channel: StepResult;
  };
  errors?: Array<{ step: string; error: string }>;
}

const TOOL_DESCRIPTION = [
  "Apply an opinionated baseline to this tenant in one call:",
  '(1) ensure a default "All Devices" device group exists,',
  '(2) attach a standard alert policy (CPU > 90% for 5m, disk free < 10%, offline > 15m) if built-in templates are available,',
  '(3) set the partner risk profile (low/standard/strict),',
  "(4) add an admin-email notification channel routed to the tenant's primary admin.",
  "Idempotent — calling twice only creates what's missing. Call once after verify_tenant returns active.",
].join(' ');

const DEFAULT_GROUP_NAME = 'All Devices';
const DEFAULT_CHANNEL_NAME = 'Admin Email';

// ---- Step helpers ---------------------------------------------------------

export async function ensureDefaultDeviceGroup(
  orgId: string,
): Promise<StepResult> {
  const existing = await db
    .select({ id: deviceGroups.id })
    .from(deviceGroups)
    .where(
      and(eq(deviceGroups.orgId, orgId), eq(deviceGroups.name, DEFAULT_GROUP_NAME)),
    )
    .limit(1);
  if (existing.length > 0) return { created: false };

  await db.insert(deviceGroups).values({
    orgId,
    name: DEFAULT_GROUP_NAME,
    type: 'static',
  });
  return { created: true };
}

// Built-in template name patterns we try to match, in order. We match case-
// insensitively against alertTemplates.name — if a deployment seeds the
// standard bundle, these names are expected; if not, the step is skipped.
const STANDARD_TEMPLATE_PATTERNS = [
  '%cpu%',
  '%disk%',
  '%offline%',
] as const;

export async function applyStandardAlertPolicy(
  orgId: string,
  _framework: 'standard' | 'cis',
): Promise<StepResult> {
  // Only look at built-in templates (org-agnostic) — deployments without
  // seeded templates will legitimately skip this step.
  const builtIns = await db
    .select({ id: alertTemplates.id, name: alertTemplates.name })
    .from(alertTemplates)
    .where(
      and(
        eq(alertTemplates.isBuiltIn, true),
        or(
          ilike(alertTemplates.name, STANDARD_TEMPLATE_PATTERNS[0]),
          ilike(alertTemplates.name, STANDARD_TEMPLATE_PATTERNS[1]),
          ilike(alertTemplates.name, STANDARD_TEMPLATE_PATTERNS[2]),
        ),
      ),
    );

  if (builtIns.length === 0) {
    return { created: false, skipped_reason: 'no built-in alert templates found' };
  }

  // Which of these already have a rule on this org?
  const templateIds = builtIns.map((t) => t.id);
  const existing = await db
    .select({ templateId: alertRules.templateId })
    .from(alertRules)
    .where(
      and(
        eq(alertRules.orgId, orgId),
        // in(templateId, ...) — avoid import for a 3-element set
        sql`${alertRules.templateId} = ANY(${templateIds})`,
      ),
    );
  const existingSet = new Set(existing.map((r) => r.templateId));

  let createdCount = 0;
  for (const tpl of builtIns) {
    if (existingSet.has(tpl.id)) continue;
    await db.insert(alertRules).values({
      orgId,
      templateId: tpl.id,
      name: `${tpl.name} (baseline)`,
      targetType: 'organization',
      targetId: orgId,
      isActive: true,
    });
    createdCount++;
  }

  if (createdCount === 0) {
    return { created: false };
  }
  return { created: true };
}

export async function setRiskProfile(
  partnerId: string,
  level: 'low' | 'standard' | 'strict',
): Promise<StepResult> {
  const [row] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const current = (row?.settings ?? {}) as Record<string, unknown>;
  if (current.riskProfile === level) {
    return { created: false };
  }
  const next = { ...current, riskProfile: level };
  await db.update(partners).set({ settings: next }).where(eq(partners.id, partnerId));
  return { created: true };
}

export async function addNotificationChannel(
  orgId: string,
  opts: { kind: 'email'; target: string },
): Promise<StepResult> {
  const existing = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.orgId, orgId),
        eq(notificationChannels.name, DEFAULT_CHANNEL_NAME),
      ),
    )
    .limit(1);
  if (existing.length > 0) return { created: false };

  await db.insert(notificationChannels).values({
    orgId,
    name: DEFAULT_CHANNEL_NAME,
    type: opts.kind,
    config: { recipients: [opts.target] },
    enabled: true,
  });
  return { created: true };
}

// ---- Handler --------------------------------------------------------------

async function configureDefaultsHandler(
  input: ConfigureDefaultsInput,
  ctx: BootstrapContext,
): Promise<ConfigureDefaultsOutput> {
  if (!ctx.apiKey) {
    throw new Error('configure_defaults: ctx.apiKey missing — tool must run behind auth');
  }
  const { partnerId, id: apiKeyId, partnerAdminEmail, defaultOrgId } = ctx.apiKey;
  const framework = input.framework ?? 'standard';
  const riskLevel = input.risk_level ?? 'standard';

  const applied: ConfigureDefaultsOutput['applied'] = {
    device_group: { created: false },
    alert_policy: { created: false },
    risk_profile: { created: false },
    notification_channel: { created: false },
  };
  const errors: Array<{ step: string; error: string }> = [];

  // Each step is best-effort: a failure in one must not prevent the others.
  try {
    applied.device_group = await ensureDefaultDeviceGroup(defaultOrgId);
  } catch (err) {
    errors.push({ step: 'device_group', error: err instanceof Error ? err.message : String(err) });
  }
  try {
    applied.alert_policy = await applyStandardAlertPolicy(defaultOrgId, framework);
  } catch (err) {
    errors.push({ step: 'alert_policy', error: err instanceof Error ? err.message : String(err) });
  }
  try {
    applied.risk_profile = await setRiskProfile(partnerId, riskLevel);
  } catch (err) {
    errors.push({ step: 'risk_profile', error: err instanceof Error ? err.message : String(err) });
  }
  try {
    applied.notification_channel = await addNotificationChannel(defaultOrgId, {
      kind: 'email',
      target: partnerAdminEmail,
    });
  } catch (err) {
    errors.push({ step: 'notification_channel', error: err instanceof Error ? err.message : String(err) });
  }

  const auditShim = requestLikeFromSnapshot({
    ip: ctx.ip ?? undefined,
    userAgent: ctx.userAgent ?? undefined,
  });
  writeAuditEvent(auditShim, {
    orgId: defaultOrgId,
    actorType: 'api_key',
    actorId: apiKeyId,
    action: 'bootstrap.configure_defaults',
    resourceType: 'partner',
    resourceId: partnerId,
    result: errors.length === 0 ? 'success' : 'failure',
    errorMessage: errors.length > 0 ? errors.map((e) => `${e.step}: ${e.error}`).join('; ') : undefined,
    details: {
      mcp_origin: true,
      framework,
      risk_level: riskLevel,
      applied: {
        device_group: applied.device_group.created,
        alert_policy: applied.alert_policy.created,
        risk_profile: applied.risk_profile.created,
        notification_channel: applied.notification_channel.created,
      },
    },
  });

  const out: ConfigureDefaultsOutput = { applied };
  if (errors.length > 0) out.errors = errors;
  return out;
}

export const configureDefaultsTool: BootstrapTool<
  ConfigureDefaultsInput,
  ConfigureDefaultsOutput
> = {
  definition: {
    name: 'configure_defaults',
    description: TOOL_DESCRIPTION,
    inputSchema,
  },
  handler: requirePaymentMethod(configureDefaultsHandler),
};
