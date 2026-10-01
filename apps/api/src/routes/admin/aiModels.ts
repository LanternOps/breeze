// apps/api/src/routes/admin/aiModels.ts
/**
 * AI model registry W01 (#7599): /admin/ai-models, the platform model
 * catalog's operator surface (spec §11). Mounted under platformAdminMiddleware
 * (admin/index.ts); mutations add requireMfa(). Writes go only through
 * updatePlatformModelAdmin, whose rules and DB CHECKs keep:
 * - offered ⇒ priced;
 * - exactly one default, and the default stays offered.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  PROMPT_PROFILES,
  modelRatesSchema,
  optionRatesSchema,
  optionSupportSchema,
  type EffortLevel,
  type ModelLifecycle,
  type ModelRates,
  type OptionRates,
  type OptionSupport,
  type PromptProfile,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { planTypeEnum } from '../../db/schema';
import {
  PlatformModelError,
  listPlatformModels,
  updatePlatformModelAdmin,
  type PlatformModel,
} from '../../services/aiModels/platformModels';
import { deriveCapabilities, type ThinkingMode } from '../../services/aiModels/capabilities';
import { enqueuePlatformModelSync } from '../../jobs/aiModelDiscoveryWorker';
import { createAuditLogAsync } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export interface AdminPlatformModelDto {
  id: string;
  modelId: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  derived: { thinkingMode: ThinkingMode; effortLevels: EffortLevel[]; supportsTools: boolean; supportsVision: boolean };
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
  lifecycle: ModelLifecycle;
  firstSeenAt: string;
  lastSeenAt: string | null;
  updatedAt: string;
}

function toDto(model: PlatformModel): AdminPlatformModelDto {
  return {
    id: model.id,
    modelId: model.modelId,
    displayName: model.displayName,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    derived: deriveCapabilities(model.capabilities),
    rates: model.rates,
    optionRates: model.optionRates,
    optionSupport: model.optionSupport,
    minPlan: model.minPlan,
    promptProfile: model.promptProfile,
    platformOffered: model.platformOffered,
    isPlatformDefault: model.isPlatformDefault,
    lifecycle: model.lifecycle,
    firstSeenAt: model.firstSeenAt.toISOString(),
    lastSeenAt: model.lastSeenAt?.toISOString() ?? null,
    updatedAt: model.updatedAt.toISOString(),
  };
}

const idParamSchema = z.object({ id: z.string().uuid() });

const patchSchema = z.object({
  rates: modelRatesSchema.nullable().optional(),
  optionRates: optionRatesSchema.nullable().optional(),
  optionSupport: optionSupportSchema.optional(),
  minPlan: z.enum(planTypeEnum.enumValues).nullable().optional(),
  promptProfile: z.enum(PROMPT_PROFILES).optional(),
  platformOffered: z.boolean().optional(),
  isPlatformDefault: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' });

function audit(c: Context, action: string, resourceId: string | null, details: Record<string, unknown>): void {
  const auth = c.get('auth');
  void createAuditLogAsync({
    orgId: null,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: `platform_admin.ai_models.${action}`,
    resourceType: 'ai_platform_model',
    ...(resourceId ? { resourceId } : {}),
    details,
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header('user-agent'),
    result: 'success',
  });
}

export const aiModelsAdminRoutes = new Hono();
const mutationRoutes = new Hono();

aiModelsAdminRoutes.get('/', async (c) => {
  const models = await listPlatformModels();
  return c.json({ models: models.map(toDto), planOptions: [...planTypeEnum.enumValues] });
});

mutationRoutes.use('*', requireMfa());

mutationRoutes.post('/refresh', async (c) => {
  // Redis round trip only (no DB, no outbound HTTP), so it runs inline like
  // enqueuePax8Sync in routes/pax8.ts.
  const job = await enqueuePlatformModelSync('manual');
  audit(c, 'refresh_requested', null, { jobId: job.id });
  return c.json({ queued: true, jobId: job.id }, 202);
});

mutationRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema),
  zValidator('json', patchSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    try {
      const { before, after } = await updatePlatformModelAdmin(id, patch);
      // Prices, offer and default are decisive (they move hosted billing), so
      // their before/after values go into the trail.
      audit(c, 'updated', id, {
        modelId: after.modelId,
        changed: Object.keys(patch).sort(),
        before: { rates: before.rates, optionRates: before.optionRates, platformOffered: before.platformOffered, isPlatformDefault: before.isPlatformDefault, minPlan: before.minPlan },
        after: { rates: after.rates, optionRates: after.optionRates, platformOffered: after.platformOffered, isPlatformDefault: after.isPlatformDefault, minPlan: after.minPlan },
      });
      return c.json({ model: toDto(after) });
    } catch (error) {
      if (error instanceof PlatformModelError) return c.json({ error: error.message }, error.status as 400 | 404 | 409);
      throw error;
    }
  },
);

aiModelsAdminRoutes.route('/', mutationRoutes);
