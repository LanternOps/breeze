import type { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { PG_UUID_REGEX } from '../utils/uuid';
import { resolveImportPartnerId } from './importScope';
import {
  ContactValidationError,
  createContact,
  deleteContact,
  findContactOrgId,
  listContacts,
  updateContact,
} from '../services/contacts/crud';
import { commitContactImport, previewContactImport } from '../services/contacts/import';
import { contactCreateAuditEvent, writeContactAudit, writeContactImportAudits } from '../services/contacts/audit';
import {
  commitContactImportRowSchema,
  contactImportRowSchema,
  createContactSchema,
  updateContactSchema,
} from '../services/contacts/schemas';
import { MAX_IMPORT_ROWS, type ContactImportContext } from '../services/contacts/types';

/**
 * First-class organization contacts (#3258, epic #3249 Phase 3): CRUD plus the
 * dedicated preview/commit importer.
 *
 * Registered ONTO `orgRoutes` rather than mounted as its own app, matching
 * routes/orgPortalSettings.ts, orgPortalUsers.ts and orgTicketSettings.ts — it
 * inherits orgRoutes' authMiddleware that way, and mounting at the top-level
 * api app would silently skip auth.
 *
 * Handlers are thin: validation beyond the wire shape, the legacy-jsonb
 * re-projection, and the audit event shapes all live in services/contacts/*,
 * because the `add_contact` AI tool reaches the same services without passing
 * through any of these routes.
 */

const listQuerySchema = z.object({
  /** The literal 'none' selects org-level contacts; a uuid pins to that site. */
  siteId: z.union([z.literal('none'), z.string().guid()]).optional(),
  role: z.string().min(1).max(64).optional(),
});

const previewImportSchema = z.object({
  partnerId: z.string().guid().optional(),
  rows: z.array(contactImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

const commitImportSchema = z.object({
  partnerId: z.string().guid().optional(),
  rows: z.array(commitContactImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

/**
 * Resolve the organization named in the path, 404-ing on anything the caller
 * cannot reach. Duplicated from the sibling org sub-route files per the pattern
 * established there, with one deliberate difference: the reach check covers
 * ORGANIZATION scope too, because contact reads admit org-scoped tokens and
 * `canAccessOrg` is false for any org outside the token's allowlist.
 */
async function resolveAccessibleOrg(c: any): Promise<{ id: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  // Shape-check before the database: `id` feeds a uuid column, where a
  // non-UUID raises 22P02 — an uncaught 500 any caller could pump.
  if (!PG_UUID_REGEX.test(id)) return c.json({ error: 'Organization not found' }, 404);
  if (auth.scope !== 'system' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }
  const rows = await db.select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt))).limit(1);
  if (!rows[0]) return c.json({ error: 'Organization not found' }, 404);
  return { id };
}

/**
 * Resolve the organization owning the contact named in the path. The
 * `/contacts/:contactId` routes carry no organization, so reach is re-asserted
 * here; "not visible" and "not yours" both collapse to 404.
 */
async function resolveContactOrg(c: any): Promise<{ contactId: string; orgId: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const contactId = c.req.param('contactId')!;
  if (!PG_UUID_REGEX.test(contactId)) return c.json({ error: 'Contact not found' }, 404);

  const orgId = await findContactOrgId(db, contactId);
  if (!orgId) return c.json({ error: 'Contact not found' }, 404);
  if (auth.scope !== 'system' && !auth.canAccessOrg(orgId)) {
    return c.json({ error: 'Contact not found' }, 404);
  }
  return { contactId, orgId };
}

/**
 * The importer resolves organization names within ONE partner, so a partner is
 * required. An organization-scoped token carries one, and its single-org
 * allowlist bounds the writes, so it is admitted per spec S4.
 */
function resolveImportContext(
  auth: AuthContext,
  bodyPartnerId: string | undefined,
): ContactImportContext | { error: string; status: 400 | 403 } {
  const resolved = resolveImportPartnerId(auth, bodyPartnerId, 'contacts');
  if ('error' in resolved) return resolved;

  // The caller's own organization allowlist travels with the request: the
  // importer writes in a SYSTEM db context, so RLS is not the boundary there.
  // Null is system scope (unrestricted); for an organization token this is the
  // single org, which is what makes admitting that scope safe — rows naming any
  // other organization come back `org-not-found` and write nothing.
  return { partnerId: resolved.partnerId, accessibleOrgIds: auth.accessibleOrgIds ?? null };
}

function actorFrom(c: any): { userId: string | null } {
  return { userId: (c.get('auth') as AuthContext).user?.id ?? null };
}

/** A service refusal is the caller's fault, so it is a 400 rather than a 500. */
function validationResponse(c: any, err: unknown): Response | null {
  if (!(err instanceof ContactValidationError)) return null;
  return c.json({ error: err.message, code: err.code }, 400);
}

export function registerOrgContactsRoutes(orgRoutes: Hono) {
  // RULING (review round 2): the gate is ORGS_READ / ORGS_WRITE plus MFA on
  // every write, per spec S4 — deliberately NOT a `requireOrgReadUnlessOwnOrg`
  // shortcut that would admit any organization-scoped caller to their own org's
  // contacts regardless of grants. Contacts are customer PII, so an org user
  // who was never granted organizations:read gets an honest, fail-closed 403
  // rather than an implicit grant derived from their token's scope.
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  // ── Import ────────────────────────────────────────────────────────────────
  // Registered before `/contacts/:contactId` for readability; the methods do
  // not overlap, so ordering is not load-bearing.

  orgRoutes.post(
    '/contacts/import/preview',
    requireScope('organization', 'partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', previewImportSchema),
    async (c) => {
      const auth = c.get('auth') as AuthContext;
      const { rows, partnerId: bodyPartnerId } = c.req.valid('json');
      const ctx = resolveImportContext(auth, bodyPartnerId);
      if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);

      return c.json({ rows: await previewContactImport(rows, ctx) });
    },
  );

  orgRoutes.post(
    '/contacts/import',
    requireScope('organization', 'partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', commitImportSchema),
    async (c) => {
      const auth = c.get('auth') as AuthContext;
      const { rows, partnerId: bodyPartnerId } = c.req.valid('json');
      const ctx = resolveImportContext(auth, bodyPartnerId);
      if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);

      const summary = await commitContactImport(rows, ctx, actorFrom(c));

      // commitContactImport writes no audit events of its own — it has no Hono
      // context — so every route that commits an import must write them here.
      writeContactImportAudits(c, { summary, source: 'contact_import' });

      // Always 200, including a partial success: the web caller consumes this
      // through runAction, which reads a failure body as a hard failure and
      // would hide the rows that DID import.
      return c.json(summary);
    },
  );

  // ── CRUD ──────────────────────────────────────────────────────────────────

  orgRoutes.get(
    '/organizations/:id/contacts',
    requireScope('organization', 'partner', 'system'),
    requireOrgRead,
    zValidator('query', listQuerySchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const { siteId, role } = c.req.valid('query');

      const data = await listContacts(db, org.id, {
        ...(siteId === undefined ? {} : { siteId: siteId === 'none' ? null : siteId }),
        ...(role ? { role } : {}),
      });
      return c.json({ data });
    },
  );

  orgRoutes.post(
    '/organizations/:id/contacts',
    requireScope('organization', 'partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', createContactSchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const body = c.req.valid('json');

      let contact;
      try {
        // orgId last: the PATH names the organization, never the body.
        contact = await createContact(db, { ...body, orgId: org.id }, actorFrom(c));
      } catch (err) {
        return validationResponse(c, err) ?? Promise.reject(err);
      }

      // Shared with the add_contact AI tool via contactCreateAuditEvent, so
      // the two CREATE audit payloads cannot drift (review finding).
      const createEvent = contactCreateAuditEvent(contact);
      writeContactAudit(c, {
        orgId: org.id,
        action: createEvent.action,
        contactId: createEvent.resourceId,
        contactName: createEvent.resourceName,
        details: createEvent.details,
      });
      return c.json({ data: contact }, 201);
    },
  );

  orgRoutes.patch(
    '/contacts/:contactId',
    requireScope('organization', 'partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', updateContactSchema),
    async (c) => {
      const resolved = await resolveContactOrg(c);
      if (resolved instanceof Response) return resolved;
      const body = c.req.valid('json');

      let contact;
      try {
        contact = await updateContact(db, resolved.contactId, resolved.orgId, body, actorFrom(c));
      } catch (err) {
        return validationResponse(c, err) ?? Promise.reject(err);
      }
      // Lost a race with a concurrent delete between the two statements.
      if (!contact) return c.json({ error: 'Contact not found' }, 404);

      writeContactAudit(c, {
        orgId: resolved.orgId,
        action: 'contact.update',
        contactId: contact.id,
        contactName: contact.name,
        details: { changedFields: Object.keys(body) },
      });
      return c.json({ data: contact });
    },
  );

  orgRoutes.delete(
    '/contacts/:contactId',
    requireScope('organization', 'partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    async (c) => {
      const resolved = await resolveContactOrg(c);
      if (resolved instanceof Response) return resolved;

      const contact = await deleteContact(db, resolved.contactId, resolved.orgId, actorFrom(c));
      if (!contact) return c.json({ error: 'Contact not found' }, 404);

      writeContactAudit(c, {
        orgId: resolved.orgId,
        action: 'contact.delete',
        contactId: contact.id,
        contactName: contact.name,
        details: { isPrimary: contact.isPrimary },
      });
      return c.json({ success: true });
    },
  );
}
