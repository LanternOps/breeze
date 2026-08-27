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
  modelMap: z.record(z.string().min(1), modelMapEntrySchema),
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

    try {
      const result = await runFidelityCheck({
        baseUrl: revision.baseUrl,
        authMode: revision.authMode,
        providerModel: mappedModel.providerModel,
        apiKey,
      });
      const safeResult = {
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

      return c.json(safeResult);
    } catch {
      return c.json({ error: 'Fidelity check failed.' }, 502);
    }
  },
);

llmProviderCatalogAdminRoutes.route('/', llmProviderCatalogMutationRoutes);
