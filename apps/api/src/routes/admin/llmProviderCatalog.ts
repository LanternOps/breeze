import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import {
  LlmProviderCatalogError,
  activateRevision,
  createCatalogEntry,
  createRevision,
  getAllCatalogEntriesForAdmin,
  getCatalogRevisionById,
  recordVerification,
  setEntryStatus,
} from '../../services/llmProviderCatalog';
import { runFidelityCheck } from '../../services/llm/providerFidelityHarness';
import { createAuditLogAsync } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { captureException } from '../../services/sentry';

const entryIdParamSchema = z.object({ entryId: z.string().uuid() });
const revisionIdParamSchema = z.object({ revisionId: z.string().uuid() });

const createEntrySchema = z.object({
  slug: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(255),
  notes: z.string().max(4000).optional(),
}).strict();

const modelMapEntrySchema = z.object({
  providerModel: z.string().trim().min(1).max(255),
  inputCentsPerM: z.number().int().min(0),
  outputCentsPerM: z.number().int().min(0),
  cacheReadCentsPerM: z.number().int().min(0),
  cacheWriteCentsPerM: z.number().int().min(0),
}).strict();

const createRevisionSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
  authMode: z.enum(['x-api-key', 'bearer']),
  // Non-empty: the activation gate asks "is every mapped model verified?", and
  // an empty map answers "yes" vacuously — a revision with no models could be
  // created, activated and listed having never passed a fidelity check.
  modelMap: z.record(z.string().min(1), modelMapEntrySchema)
    .refine((map) => Object.keys(map).length > 0, {
      message: 'modelMap must map at least one model',
    }),
  dataNote: z.string().max(4000).optional(),
}).strict();

const activateRevisionSchema = z.object({
  revisionId: z.string().uuid(),
}).strict();

const setStatusSchema = z.object({
  status: z.enum(['draft', 'listed', 'delisted']),
}).strict();

const verifyRevisionSchema = z.object({
  modelId: z.string().min(1).max(255),
  apiKey: z.string().min(1).max(8192),
}).strict();

function mapCatalogError(error: unknown, c: Context) {
  if (error instanceof LlmProviderCatalogError) {
    return c.json({ error: error.message }, error.status);
  }
  throw error;
}

function redactSecret(value: string, secret: string): string {
  return value.includes(secret) ? value.replaceAll(secret, '[redacted]') : value;
}

/**
 * `platformAdminMiddleware` audits every admin request, but only with method +
 * path — which makes list and delist indistinguishable in the trail and records
 * no revision id for an activation. Catalog activation deliberately has no
 * four-eyes approval (see the plan's Deferred item 1), and the audit trail is
 * named as part of that mitigation, so the decisive value belongs in `details`.
 */
function auditCatalogMutation(
  c: Context,
  action: string,
  entryId: string,
  details: Record<string, unknown>,
): void {
  const auth = c.get('auth');
  void createAuditLogAsync({
    orgId: null,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: `platform_admin.llm_provider_catalog.${action}`,
    resourceType: 'llm_provider_catalog',
    resourceId: entryId,
    details,
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header('user-agent'),
    result: 'success',
  });
}

export const llmProviderCatalogAdminRoutes = new Hono();
const llmProviderCatalogMutationRoutes = new Hono();

llmProviderCatalogAdminRoutes.get('/', async (c) => {
  return c.json(await getAllCatalogEntriesForAdmin());
});

llmProviderCatalogMutationRoutes.use('*', requireMfa());

llmProviderCatalogMutationRoutes.post(
  '/',
  zValidator('json', createEntrySchema),
  async (c) => {
    try {
      return c.json(await createCatalogEntry(c.req.valid('json')), 201);
    } catch (error) {
      return mapCatalogError(error, c);
    }
  },
);

llmProviderCatalogMutationRoutes.post(
  '/:entryId/revisions',
  zValidator('param', entryIdParamSchema),
  zValidator('json', createRevisionSchema),
  async (c) => {
    const { entryId } = c.req.valid('param');
    const data = c.req.valid('json');
    const auth = c.get('auth');
    try {
      return c.json(await createRevision({
        entryId,
        ...data,
        createdBy: auth.user.id,
      }), 201);
    } catch (error) {
      return mapCatalogError(error, c);
    }
  },
);

llmProviderCatalogMutationRoutes.post(
  '/:entryId/activate',
  zValidator('param', entryIdParamSchema),
  zValidator('json', activateRevisionSchema),
  async (c) => {
    const { entryId } = c.req.valid('param');
    const { revisionId } = c.req.valid('json');
    try {
      await activateRevision({ entryId, revisionId });
      auditCatalogMutation(c, 'revision_activated', entryId, { revisionId });
      return c.json({ success: true });
    } catch (error) {
      return mapCatalogError(error, c);
    }
  },
);

llmProviderCatalogMutationRoutes.patch(
  '/:entryId/status',
  zValidator('param', entryIdParamSchema),
  zValidator('json', setStatusSchema),
  async (c) => {
    const { entryId } = c.req.valid('param');
    const { status } = c.req.valid('json');
    try {
      await setEntryStatus({ entryId, status });
      auditCatalogMutation(c, 'status_changed', entryId, { status });
      return c.json({ success: true });
    } catch (error) {
      return mapCatalogError(error, c);
    }
  },
);

llmProviderCatalogMutationRoutes.post(
  '/revisions/:revisionId/verify',
  zValidator('param', revisionIdParamSchema),
  zValidator('json', verifyRevisionSchema),
  async (c) => {
    const { revisionId } = c.req.valid('param');
    const { modelId, apiKey } = c.req.valid('json');
    const revision = await getCatalogRevisionById(revisionId);
    if (!revision) {
      return c.json({ error: 'Catalog revision not found.' }, 404);
    }

    const mappedModel = revision.modelMap[modelId];
    if (!mappedModel) {
      return c.json({ error: 'Model is not mapped by this revision.' }, 400);
    }

    // Deliberately two separate try blocks. A single one around both would
    // report an internal DB write failure to the operator as a 502 "the
    // provider failed its fidelity check", which is a different diagnosis and
    // sends them to the wrong place. Neither branch may echo the transient key,
    // so the error itself is never returned — only Sentry'd.
    let safeResult: {
      passed: boolean;
      steps: Array<{ name: string; ok: boolean; detail?: string }>;
      harnessVersion: string;
    };
    try {
      const result = await runFidelityCheck({
        baseUrl: revision.baseUrl,
        authMode: revision.authMode,
        providerModel: mappedModel.providerModel,
        apiKey,
      });
      safeResult = {
        passed: result.passed,
        steps: result.steps.map((step) => ({
          ...step,
          name: redactSecret(step.name, apiKey),
          ...(step.detail === undefined
            ? {}
            : { detail: redactSecret(step.detail, apiKey) }),
        })),
        harnessVersion: redactSecret(result.harnessVersion, apiKey),
      };
    } catch (error) {
      captureException(error, undefined, {
        route: 'admin.llm_provider_catalog.verify',
        stage: 'fidelity_check',
      });
      return c.json({ error: 'Fidelity check failed.' }, 502);
    }

    try {
      await recordVerification({
        revisionId,
        modelId,
        passed: safeResult.passed,
        detail: {
          steps: safeResult.steps,
          harnessVersion: safeResult.harnessVersion,
        },
        verifiedBy: c.get('auth').user.id,
      });
    } catch (error) {
      captureException(error, undefined, {
        route: 'admin.llm_provider_catalog.verify',
        stage: 'record_verification',
      });
      return c.json({ error: 'Could not record the verification result.' }, 500);
    }

    return c.json(safeResult);
  },
);

llmProviderCatalogAdminRoutes.route('/', llmProviderCatalogMutationRoutes);
