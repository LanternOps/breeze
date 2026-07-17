import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createContractTemplateSchema,
  updateContractTemplateSchema,
  createTemplateVersionSchema,
} from '@breeze/shared';
import {
  listTemplates,
  createTemplate,
  getTemplate,
  updateTemplate,
  archiveTemplate,
  createDraftVersion,
  createUploadedVersion,
  getTemplateVersion,
  publishVersion,
  deriveTemplateOwnership,
  ContractTemplateServiceError,
  PartnerWideWriteDeniedError,
  type TemplateRow,
  type VersionRow,
  type TemplateDTO,
  type VersionSummaryDTO,
} from '../../services/contractTemplateService';

export const contractTemplateRoutes = new Hono();

const scopes = requireScope('partner', 'organization', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);

const idParam = z.object({ id: z.string().guid() });
const versionIdParam = idParam.extend({ versionId: z.string().guid() });
const listQuery = z.object({ includeArchived: z.coerce.boolean().optional() });

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function authFrom(c: { get: (k: string) => unknown }): AuthContext {
  return c.get('auth') as AuthContext;
}

/** Mirrors contracts.ts's handleContractError — the two error classes the service throws map to their own status/code. */
function handleTemplateError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: err.message }, 403);
  throw err;
}

/**
 * Strips the binary fileData column out of a version row before it goes over
 * JSON — an authored version's bodyHtml survives (source of "authored: body"
 * in the route contract); an uploaded version is left as metadata only
 * (mime/byteSize/sha256/declaredVariables etc, no bodyHtml, no bytes). Also
 * folds the raw orgId/partnerId pair into `ownerScope` via
 * deriveTemplateOwnership so web consumers get the discriminated shape
 * instead of re-deriving it from two independent nullable fields.
 */
function serializeVersion(v: VersionRow): VersionSummaryDTO {
  const { fileData: _fileData, ...rest } = v;
  return deriveTemplateOwnership(rest);
}

/** Folds a template row's raw orgId/partnerId pair into `ownerScope` — see serializeVersion. */
function serializeTemplate(t: TemplateRow): TemplateDTO {
  return deriveTemplateOwnership(t);
}

contractTemplateRoutes.get('/', scopes, readPerm, zValidator('query', listQuery), async (c) => {
  try {
    const { includeArchived } = c.req.valid('query');
    const templates = await listTemplates(authFrom(c), { includeArchived });
    const data = templates.map(({ latestVersion, ...template }) => ({
      ...serializeTemplate(template),
      latestVersion: latestVersion ? deriveTemplateOwnership(latestVersion) : null,
    }));
    return c.json({ data });
  } catch (err) {
    return handleTemplateError(c, err);
  }
});

contractTemplateRoutes.post('/', scopes, writePerm, zValidator('json', createContractTemplateSchema), async (c) => {
  try {
    const template = await createTemplate(authFrom(c), c.req.valid('json'));
    return c.json({ data: serializeTemplate(template) });
  } catch (err) {
    return handleTemplateError(c, err);
  }
});

contractTemplateRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const { versions, ...template } = await getTemplate(authFrom(c), id);
    return c.json({ data: { ...serializeTemplate(template), versions: versions.map(serializeVersion) } });
  } catch (err) {
    return handleTemplateError(c, err);
  }
});

contractTemplateRoutes.patch(
  '/:id',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('json', updateContractTemplateSchema),
  async (c) => {
    try {
      const { id } = c.req.valid('param');
      const template = await updateTemplate(authFrom(c), id, c.req.valid('json'));
      return c.json({ data: serializeTemplate(template) });
    } catch (err) {
      return handleTemplateError(c, err);
    }
  }
);

contractTemplateRoutes.post('/:id/archive', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    await archiveTemplate(authFrom(c), id);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return handleTemplateError(c, err);
  }
});

contractTemplateRoutes.post(
  '/:id/versions',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('json', createTemplateVersionSchema),
  async (c) => {
    try {
      const { id } = c.req.valid('param');
      const version = await createDraftVersion(authFrom(c), id, c.req.valid('json'));
      return c.json({ data: serializeVersion(version) });
    } catch (err) {
      return handleTemplateError(c, err);
    }
  }
);

// POST /:id/versions/upload — multipart PDF upload (new draft version, sourceType='uploaded').
// 10MB cap + application/pdf declared content-type are enforced here; the
// %PDF- magic-byte check (and a second 10MB cap check on the decoded buffer)
// happens in createUploadedVersion — defense in depth, but a different split
// than catalog.ts's image upload: there, the magic-byte sniff (sniffImageMime)
// runs at the ROUTE level and the service does no byte-format check of its
// own. Here the sniff is pushed into the service instead, so any future
// caller of createUploadedVersion can't skip it by bypassing this route.
contractTemplateRoutes.post(
  '/:id/versions/upload',
  scopes,
  writePerm,
  zValidator('param', idParam),
  bodyLimit({
    maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: 'File exceeds the 10MB upload limit' }, 413),
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    try {
      let body: Record<string, unknown>;
      try {
        body = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: 'Invalid multipart body' }, 400);
      }
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'file field is required' }, 400);
      if (file.size === 0) return c.json({ error: 'file is empty' }, 400);
      if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'File exceeds the 10MB upload limit' }, 400);
      if (file.type !== 'application/pdf') {
        return c.json({ error: 'File must be a PDF (application/pdf)' }, 400);
      }
      const data = Buffer.from(await file.arrayBuffer());
      const version = await createUploadedVersion(authFrom(c), id, { data, mime: file.type });
      return c.json({ data: serializeVersion(version) });
    } catch (err) {
      return handleTemplateError(c, err);
    }
  }
);

contractTemplateRoutes.post(
  '/:id/versions/:versionId/publish',
  scopes,
  writePerm,
  zValidator('param', versionIdParam),
  async (c) => {
    try {
      const { id, versionId } = c.req.valid('param');
      const version = await publishVersion(authFrom(c), id, versionId);
      return c.json({ data: serializeVersion(version) });
    } catch (err) {
      return handleTemplateError(c, err);
    }
  }
);

// GET /:id/versions/:versionId — authored versions carry bodyHtml; uploaded
// versions come back as metadata only (see serializeVersion).
contractTemplateRoutes.get('/:id/versions/:versionId', scopes, readPerm, zValidator('param', versionIdParam), async (c) => {
  try {
    const { id, versionId } = c.req.valid('param');
    const version = await getTemplateVersion(authFrom(c), id, versionId);
    return c.json({ data: serializeVersion(version) });
  } catch (err) {
    return handleTemplateError(c, err);
  }
});

// GET /:id/versions/:versionId/file — streams the uploaded PDF's raw bytes.
// 404s with a JSON error body if the version has no file, e.g. an authored
// version — this route only exists for uploaded ones.
contractTemplateRoutes.get(
  '/:id/versions/:versionId/file',
  scopes,
  readPerm,
  zValidator('param', versionIdParam),
  async (c) => {
    try {
      const { id, versionId } = c.req.valid('param');
      const version = await getTemplateVersion(authFrom(c), id, versionId);
      if (version.sourceType !== 'uploaded' || !version.fileData) {
        return c.json({ error: 'Version has no uploaded file' }, 404);
      }
      return new Response(new Uint8Array(version.fileData), {
        status: 200,
        headers: {
          'Content-Type': version.mime ?? 'application/pdf',
          'Content-Length': String(version.byteSize ?? version.fileData.length),
          'Cache-Control': 'private, max-age=300',
        },
      });
    } catch (err) {
      return handleTemplateError(c, err);
    }
  }
);
