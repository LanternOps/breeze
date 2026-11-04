import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
} from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { urlOriginChanged } from '../../services/credentialOriginBinding';
import { PERMISSIONS } from '../../services/permissions';
import { isS3Configured } from '../../services/s3Storage';
import { TicketImportError } from '../../services/ticketImport/importErrors';
import type { AnyTicketImportModule, SourceCredentials } from '../../services/ticketImport/moduleContract';
import { describeTicketImportModule, getTicketImportModule, listTicketImportModules } from '../../services/ticketImport/moduleRegistry';
import { openSourceCredentials, sealSourceCredentials, sourceCredentialsSchema } from '../../services/ticketImport/sourceCredentials';
import { normalizeSourceBaseUrl } from '../../services/ticketImport/sourceFetch';
import { buildSourceHandle } from '../../services/ticketImport/sourceHandle';
import {
  activeRunOf,
  deleteSource,
  getMappings,
  getSource,
  insertSource,
  listSources,
  lockPrincipalForSource,
  lockSource,
  ownerRequired,
  readSourceForUse,
  replaceMappings,
  revokeSource,
  runActive,
  updateSource,
} from '../../services/ticketImport/sourceStore';
import { callerPartner, idParamSchema, importErrorResponse, sourceCallError } from './shared';

/**
 * Sources, their mappings and the preflight (#8313 W4; spec 2026-10-19 §5.7).
 *
 * Who: every route is a partner-wide admin of the caller's partner
 * (canManagePartnerWidePolicies, in `callerPartner`). Create, edit and
 * mappings are owner-only: the caller owns the source's service principal,
 * the one user who can open its windows (F27). Revoke and delete narrow, so
 * any partner-wide admin may. No route returns the ciphertext.
 *
 * POST /sources, PATCH /sources/:id and POST /sources/:id/preflight call the
 * source (a connect, a catalog) against a tenant-supplied URL, so they are in
 * SELF_MANAGED_DB_CONTEXT_ROUTES: no request transaction is held across the
 * call, and each DB phase opens its own short context.
 */
export const ticketImportSourceRoutes = new Hono();

const readGate = [
  requireScope('partner'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
] as const;
const writeGate = [
  requireScope('partner'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
] as const;

const labelSchema = z.string().trim().min(1).max(64);
const baseUrlSchema = z.string().trim().min(1).max(2048);
const optionsSchema = z.record(z.string(), z.unknown());

const createSchema = z.object({
  module: z.string().min(1).max(32),
  label: labelSchema,
  baseUrl: baseUrlSchema,
  credentials: sourceCredentialsSchema,
  principalId: z.string().guid(),
  options: optionsSchema.optional(),
}).strict();

const updateSchema = z.object({
  label: labelSchema.optional(),
  baseUrl: baseUrlSchema.optional(),
  credentials: sourceCredentialsSchema.optional(),
}).strict().refine((v) => v.label !== undefined || v.baseUrl !== undefined || v.credentials !== undefined, 'Nothing to change');

const mappingsSchema = z.object({
  orgs: z.array(z.object({
    sourceOrgKey: z.string().trim().min(1).max(255).nullable(),
    sourceOrgName: z.string().max(255).nullable().optional(),
    orgId: z.string().guid(),
  }).strict()).max(1000),
  categories: z.array(z.object({
    sourceGroupKey: z.string().trim().min(1).max(255),
    sourceGroupName: z.string().max(255).nullable().optional(),
    categoryId: z.string().guid(),
  }).strict()).max(1000),
  options: optionsSchema.optional(),
}).strict();

function moduleOrError(id: string): AnyTicketImportModule {
  const module = getTicketImportModule(id);
  if (!module) throw new TicketImportError('TICKET_IMPORT_MODULE_UNKNOWN', `No ticket import module '${id}'`, 400);
  return module;
}

function parseOptions(module: AnyTicketImportModule, raw: unknown): Record<string, unknown> {
  const parsed = module.optionsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new TicketImportError('TICKET_IMPORT_INVALID_OPTIONS', 'The module options are not valid', 400, {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return (parsed.data ?? {}) as Record<string, unknown>;
}

function normalizedUrl(raw: string): string {
  const result = normalizeSourceBaseUrl(raw);
  if (!result.ok) throw new TicketImportError('TICKET_IMPORT_INVALID_URL', `The source URL is not allowed: ${result.reason}`, 400);
  return result.url;
}

/** The live test of a credential (spec §5.7): the module's connect, with no DB context held. */
async function connectOrError(module: AnyTicketImportModule, input: {
  sourceId: string;
  baseUrl: string;
  credentials: SourceCredentials;
  options: Record<string, unknown>;
}) {
  try {
    return await module.connect(buildSourceHandle(input));
  } catch (error) {
    if (!(error instanceof TicketImportError)) {
      console.warn('[ticketImports] connect failed', { module: module.id, error: error instanceof Error ? error.name : 'unknown' });
    }
    throw error instanceof TicketImportError ? error : sourceCallError(error);
  }
}

ticketImportSourceRoutes.get('/modules', ...readGate, async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  return c.json({ data: listTicketImportModules().map(describeTicketImportModule) });
});

ticketImportSourceRoutes.get('/sources', ...readGate, async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  return c.json({ data: await listSources(caller.partnerId) });
});

ticketImportSourceRoutes.post('/sources', ...writeGate, zValidator('json', createSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { auth, partnerId } = caller;
  const input = c.req.valid('json');
  try {
    const module = moduleOrError(input.module);
    const options = parseOptions(module, input.options);
    const baseUrl = normalizedUrl(input.baseUrl);
    // Fail fast before calling the source; re-checked under the lock below.
    await withAuthDbAccessContext(auth, () => lockPrincipalForSource({ partnerId, principalId: input.principalId, ownerUserId: auth.user.id }));
    // The id is generated before sealing: the credential's AAD is bound to it.
    const sourceId = randomUUID();
    const report = await connectOrError(module, { sourceId, baseUrl, credentials: input.credentials, options });
    const credentialsEncrypted = sealSourceCredentials(sourceId, input.credentials);
    const view = await withAuthDbAccessContext(auth, async () => {
      await lockPrincipalForSource({ partnerId, principalId: input.principalId, ownerUserId: auth.user.id });
      await insertSource({
        id: sourceId,
        partnerId,
        module: module.id,
        label: input.label,
        baseUrl,
        credentialsEncrypted,
        principalId: input.principalId,
        createdBy: auth.user.id,
        options,
      });
      return getSource(partnerId, sourceId);
    });
    writeRouteAudit(c as never, {
      orgId: null,
      action: 'ticket_import.source_created',
      resourceType: 'ticket_import_source',
      resourceId: sourceId,
      resourceName: input.label,
      details: { partnerId, module: module.id, baseUrl, partnerServicePrincipalId: input.principalId },
    });
    return c.json({ data: view, connect: report }, 201);
  } catch (error) {
    return importErrorResponse(c, error);
  }
});

ticketImportSourceRoutes.get('/sources/:id', ...readGate, zValidator('param', idParamSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { id } = c.req.valid('param');
  const view = await getSource(caller.partnerId, id);
  if (!view) return c.json({ error: 'Ticket import source not found', code: 'TICKET_IMPORT_SOURCE_NOT_FOUND' }, 404);
  return c.json({ data: { ...view, mappings: await getMappings(caller.partnerId, id) } });
});

ticketImportSourceRoutes.patch('/sources/:id', ...writeGate, zValidator('param', idParamSchema), zValidator('json', updateSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { auth, partnerId } = caller;
  const { id } = c.req.valid('param');
  const input = c.req.valid('json');
  try {
    const current = await withAuthDbAccessContext(auth, () => readSourceForUse(partnerId, id));
    if (!current) throw new TicketImportError('TICKET_IMPORT_SOURCE_NOT_FOUND', 'Ticket import source not found', 404);
    if (current.view.ownerUserId !== auth.user.id) throw ownerRequired();
    const module = moduleOrError(current.view.module);

    const baseUrl = input.baseUrl !== undefined ? normalizedUrl(input.baseUrl) : current.view.baseUrl;
    const urlChanged = baseUrl !== current.view.baseUrl;
    // A credential never follows its source to a new origin (F21).
    if (urlChanged && urlOriginChanged(current.view.baseUrl, baseUrl) && !input.credentials) {
      throw new TicketImportError(
        'TICKET_IMPORT_CREDENTIALS_REQUIRED',
        'A new source origin needs new credentials',
        400,
      );
    }
    const connectionChanges = urlChanged || input.credentials !== undefined;
    if (connectionChanges) {
      const active = await withAuthDbAccessContext(auth, () => activeRunOf(id));
      if (active) throw runActive(active);
    }

    // The live test, with what the source will use from now on.
    let report: Awaited<ReturnType<typeof connectOrError>> | null = null;
    const credentials = input.credentials
      ?? (urlChanged && current.credentialsEncrypted ? openSourceCredentials(id, current.credentialsEncrypted) : null);
    if (connectionChanges && credentials) {
      report = await connectOrError(module, { sourceId: id, baseUrl, credentials, options: current.view.options });
    }
    const credentialsEncrypted = input.credentials ? sealSourceCredentials(id, input.credentials) : undefined;

    const view = await withAuthDbAccessContext(auth, async () => {
      const locked = await lockSource(partnerId, id);
      if (locked.ownerUserId !== auth.user.id) throw ownerRequired();
      if (locked.baseUrl !== current.view.baseUrl) {
        throw new TicketImportError('TICKET_IMPORT_SOURCE_CHANGED', 'The source changed meanwhile; reload it', 409);
      }
      if (connectionChanges) {
        const active = await activeRunOf(id);
        if (active) throw runActive(active);
      }
      await updateSource({
        partnerId,
        sourceId: id,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(urlChanged ? { baseUrl } : {}),
        ...(credentialsEncrypted ? { credentialsEncrypted } : {}),
      });
      return getSource(partnerId, id);
    });
    writeRouteAudit(c as never, {
      orgId: null,
      action: 'ticket_import.source_updated',
      resourceType: 'ticket_import_source',
      resourceId: id,
      resourceName: view?.label ?? null,
      details: {
        partnerId,
        changed: [
          ...(input.label !== undefined ? ['label'] : []),
          ...(urlChanged ? ['baseUrl'] : []),
          ...(input.credentials ? ['credentials'] : []),
        ],
        ...(urlChanged ? { baseUrl } : {}),
        reconnected: Boolean(input.credentials && current.view.revokedAt),
      },
    });
    return c.json({ data: view, ...(report ? { connect: report } : {}) });
  } catch (error) {
    return importErrorResponse(c, error);
  }
});

ticketImportSourceRoutes.post('/sources/:id/revoke', ...writeGate, zValidator('param', idParamSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { id } = c.req.valid('param');
  try {
    const result = await revokeSource(caller.partnerId, id, caller.auth.user.id);
    if (!result.alreadyRevoked) {
      writeRouteAudit(c as never, {
        orgId: null,
        action: 'ticket_import.source_revoked',
        resourceType: 'ticket_import_source',
        resourceId: id,
        details: { partnerId: caller.partnerId },
      });
    }
    return c.json({ data: await getSource(caller.partnerId, id), alreadyRevoked: result.alreadyRevoked });
  } catch (error) {
    return importErrorResponse(c, error);
  }
});

ticketImportSourceRoutes.delete('/sources/:id', ...writeGate, zValidator('param', idParamSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { id } = c.req.valid('param');
  try {
    const view = await getSource(caller.partnerId, id);
    await deleteSource(caller.partnerId, id);
    writeRouteAudit(c as never, {
      orgId: null,
      action: 'ticket_import.source_deleted',
      resourceType: 'ticket_import_source',
      resourceId: id,
      resourceName: view?.label ?? null,
      details: { partnerId: caller.partnerId, partnerServicePrincipalId: view?.principalId ?? null },
    });
    return c.json({ success: true });
  } catch (error) {
    return importErrorResponse(c, error);
  }
});

ticketImportSourceRoutes.post('/sources/:id/preflight', ...writeGate, zValidator('param', idParamSchema), async (c) => {
  const caller = callerPartner(c);
  if ('response' in caller) return caller.response;
  const { auth, partnerId } = caller;
  const { id } = c.req.valid('param');
  try {
    const current = await withAuthDbAccessContext(auth, () => readSourceForUse(partnerId, id));
    if (!current) throw new TicketImportError('TICKET_IMPORT_SOURCE_NOT_FOUND', 'Ticket import source not found', 404);
    if (!current.credentialsEncrypted) {
      throw new TicketImportError('TICKET_IMPORT_SOURCE_REVOKED', 'The source is revoked; reconnect it with new credentials first', 409);
    }
    const module = moduleOrError(current.view.module);
    const handle = buildSourceHandle({
      sourceId: id,
      baseUrl: current.view.baseUrl,
      credentials: openSourceCredentials(id, current.credentialsEncrypted),
      options: current.view.options,
    });
    let connect;
    let catalog;
    try {
      connect = await module.connect(handle);
      catalog = await module.catalog(handle);
    } catch (error) {
      throw sourceCallError(error);
    }
    return c.json({ data: { connect, catalog, objectStorage: { configured: isS3Configured() } } });
  } catch (error) {
    return importErrorResponse(c, error);
  }
});

ticketImportSourceRoutes.put(
  '/sources/:id/mappings',
  ...writeGate,
  zValidator('param', idParamSchema),
  zValidator('json', mappingsSchema),
  async (c) => {
    const caller = callerPartner(c);
    if ('response' in caller) return caller.response;
    const { auth, partnerId } = caller;
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    try {
      const source = await lockSource(partnerId, id);
      if (source.ownerUserId !== auth.user.id) throw ownerRequired();
      const module = moduleOrError(source.module);
      const options = input.options !== undefined ? parseOptions(module, input.options) : source.options;
      await replaceMappings({
        partnerId,
        sourceId: id,
        options,
        mappings: {
          orgs: input.orgs.map((m) => ({ sourceOrgKey: m.sourceOrgKey, sourceOrgName: m.sourceOrgName ?? null, orgId: m.orgId })),
          categories: input.categories.map((m) => ({
            sourceGroupKey: m.sourceGroupKey,
            sourceGroupName: m.sourceGroupName ?? null,
            categoryId: m.categoryId,
          })),
        },
      });
      writeRouteAudit(c as never, {
        orgId: null,
        action: 'ticket_import.mappings_changed',
        resourceType: 'ticket_import_source',
        resourceId: id,
        details: {
          partnerId,
          orgMaps: input.orgs.length,
          fallbackOrgId: input.orgs.find((m) => m.sourceOrgKey === null)?.orgId ?? null,
          categoryMaps: input.categories.length,
          optionsChanged: input.options !== undefined,
        },
      });
      return c.json({ data: { ...(await getSource(partnerId, id)), mappings: await getMappings(partnerId, id) } });
    } catch (error) {
      return importErrorResponse(c, error);
    }
  },
);
