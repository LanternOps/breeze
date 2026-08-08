/**
 * Script bundle routes (#3245): /scripts/bundle/{export,preview,import}.
 *
 * Mounted from routes/scripts.ts under `/scripts/bundle` BEFORE the
 * parameterized `/:id` routes, and inherits that router's authMiddleware —
 * this file must not be mounted anywhere else.
 *
 * Security posture (see services/scriptBundle for the full story): a bundle
 * is untrusted input whose contents run as SYSTEM on customer endpoints.
 * These routes carry the same gating as the script write routes they compose
 * (scope + permission + MFA on the write paths), bound the payload at intake,
 * never execute anything, and audit every imported script individually with
 * the bundle's identity so a later abuse finding traces back to the import
 * that introduced it.
 */
import { Hono } from 'hono';
import { createHash } from 'crypto';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE
} from '../services/partnerWideAccess';
import { exportBundle, importBundle, previewBundle } from '../services/scriptBundle';
import { MAX_BUNDLE_SCRIPTS, scriptBundleEnvelopeSchema } from '../services/scriptBundle/schema';

export const scriptBundleRoutes = new Hono();

// Defense in depth: routes/scripts.ts already applies authMiddleware via
// use('*') before mounting this router (so it runs twice on the mounted
// path — harmless, it just re-derives the same context). Having it here too
// keeps this router safe if it is ever mounted standalone (e.g. in tests).
scriptBundleRoutes.use('*', authMiddleware);

const exportQuerySchema = z.object({
  // Comma-separated script ids. Individual ids are guid-validated below.
  ids: z.string().min(1)
});

const bundleTargetFields = {
  // Envelope only — entries are validated PER ENTRY inside the service so one
  // bad entry fails individually instead of rejecting the whole bundle.
  bundle: scriptBundleEnvelopeSchema,
  // Default 'org' — partner-wide fan-out must always be an explicit ask.
  availability: z.enum(['org', 'partner']).default('org'),
  orgId: z.string().guid().optional()
};

const previewBodySchema = z.object(bundleTargetFields);
const importBodySchema = z.object({
  ...bundleTargetFields,
  mode: z.enum(['skip', 'rename', 'new-version'])
});

type PartnerGateAuth = Parameters<typeof canManagePartnerWidePolicies>[0];

/**
 * Route-level fail-fast for `availability: 'partner'` (#3262). The service
 * chokepoint (`resolveScriptCreateScope`) enforces the same capability gate;
 * this check exists so the whole request is rejected up front instead of
 * failing per-entry, and so partner-wide import is only expressible by
 * partner-scope callers (system tokens carry no partnerId to fan out under).
 */
function partnerAvailabilityError(auth: PartnerGateAuth): string | null {
  if (auth.scope !== 'partner' || !canManagePartnerWidePolicies(auth)) {
    return PARTNER_WIDE_WRITE_DENIED_MESSAGE;
  }
  return null;
}

function bundleSha256(bundle: unknown): string {
  return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

// GET /scripts/bundle/export?ids=a,b,c — bundle for the selected scripts,
// scoped to what the caller can already read. Emits no tenancy identifiers
// and no isSystem flag.
scriptBundleRoutes.get(
  '/export',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  zValidator('query', exportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const raw = c.req.valid('query').ids.split(',').map((s) => s.trim()).filter(Boolean);

    if (raw.length === 0 || raw.length > MAX_BUNDLE_SCRIPTS) {
      return c.json({ error: `ids must contain between 1 and ${MAX_BUNDLE_SCRIPTS} script ids` }, 400);
    }
    const parsedIds = z.array(z.string().guid()).safeParse(raw);
    if (!parsedIds.success) {
      return c.json({ error: 'ids must be a comma-separated list of script ids' }, 400);
    }

    const bundle = await exportBundle(auth, parsedIds.data);

    writeRouteAudit(c, {
      orgId: auth.orgId ?? null,
      action: 'script.bundle.export',
      resourceType: 'script_bundle',
      details: {
        requestedIds: parsedIds.data.length,
        exportedScripts: bundle.scripts.length
      }
    });

    return c.json(bundle);
  }
);

// POST /scripts/bundle/preview — annotate entries new/name-conflict. No writes,
// but gated like the import it previews.
scriptBundleRoutes.post(
  '/preview',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('json', previewBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    if (body.availability === 'partner') {
      const err = partnerAvailabilityError({ ...auth, partnerOrgAccess: auth.partnerOrgAccess });
      if (err) return c.json({ error: err }, 403);
    }

    const result = await previewBundle(auth, body.bundle, {
      availability: body.availability,
      orgId: body.orgId
    });
    if ('error' in result) {
      return c.json({ error: result.error }, result.status);
    }

    return c.json(result);
  }
);

// POST /scripts/bundle/import — commit a bundle into the caller's scope.
scriptBundleRoutes.post(
  '/import',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('json', importBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    if (body.availability === 'partner') {
      const err = partnerAvailabilityError({ ...auth, partnerOrgAccess: auth.partnerOrgAccess });
      if (err) return c.json({ error: err }, 403);
    }

    const result = await importBundle(auth, body.bundle, {
      availability: body.availability,
      orgId: body.orgId,
      mode: body.mode
    });
    if ('error' in result) {
      return c.json({ error: result.error }, result.status);
    }

    // Audit every script the import wrote (imported/renamed/versioned; skipped
    // entries wrote nothing), tagged with the bundle's identity.
    const sha256 = bundleSha256(body.bundle);
    for (const entry of result.scripts) {
      if (entry.action === 'skipped') continue;
      writeRouteAudit(c, {
        orgId: result.target.orgId ?? auth.orgId ?? null,
        action: 'script.bundle.import',
        resourceType: 'script',
        resourceId: entry.scriptId,
        resourceName: entry.finalName ?? entry.name,
        details: {
          bundleSha256: sha256,
          bundleScriptCount: body.bundle.scripts.length,
          mode: body.mode,
          availability: body.availability,
          entryAction: entry.action,
          ...(entry.finalName ? { originalName: entry.name } : {})
        }
      });
    }

    return c.json({
      imported: result.imported,
      skipped: result.skipped,
      renamed: result.renamed,
      versioned: result.versioned,
      errors: result.errors,
      scripts: result.scripts
    });
  }
);
