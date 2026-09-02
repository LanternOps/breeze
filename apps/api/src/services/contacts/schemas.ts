/**
 * Wire schemas for the contact routes and the contact importer (#3258).
 *
 * These are the WIRE shape only. The invariants that depend on stored state —
 * "the merged row still has an identifier", "this site belongs to this org" —
 * live in `./crud`, because the `add_contact` AI tool reaches the service
 * without passing through a route validator.
 *
 * Deliberately NOT exported here: the array wrapper with `.max(MAX_IMPORT_ROWS)`.
 * The routes apply their own, so this module never imports the pipeline barrel
 * that route suites mock wholesale.
 */

import { z } from 'zod';
import { CONTACT_ROLES } from './types';

/** Mirrors `contacts_identifiable_chk`. */
export function hasIdentifier(
  value: { name?: unknown; email?: unknown; phone?: unknown; mobile?: unknown },
): boolean {
  return [value.name, value.email, value.phone, value.mobile].some(
    (field) => typeof field === 'string' && field.trim() !== '',
  );
}

export const IDENTIFIER_REQUIRED_MESSAGE =
  'A contact needs at least one of name, email, phone, or mobile';

/**
 * `nullish` on every optional field: a PATCH clears a value with an explicit
 * null, which is a different intent from omitting the key.
 */
const contactFields = {
  siteId: z.string().guid().nullish(),
  name: z.string().max(255).nullish(),
  // The empty string is accepted as "clear this" rather than rejected as an
  // invalid address, matching importRowContactSchema in the org importer.
  email: z.union([z.string().email().max(320), z.literal(''), z.null()]).optional(),
  phone: z.string().max(64).nullish(),
  mobile: z.string().max(64).nullish(),
  title: z.string().max(255).nullish(),
  roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length).optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().max(5000).nullish(),
};

export const createContactSchema = z
  .object(contactFields)
  .refine(hasIdentifier, { message: IDENTIFIER_REQUIRED_MESSAGE });

/**
 * A patch cannot be checked for identifiers on its own — the merged row is what
 * has to satisfy the constraint, and only the service can see that. All this
 * asserts is that the patch says something.
 */
export const updateContactSchema = z
  .object(contactFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No updates provided' });

/**
 * One import row. `name` is optional for the same reason the column is
 * nullable; the identifier refinement is what keeps an empty row out.
 *
 * The base object is kept separate so the commit variant can extend it — a
 * refined schema is no longer extensible.
 */
const importRowFields = z
  .object({
    organizationId: z.string().guid().optional(),
    organization: z.string().min(1).max(255).optional(),
    site: z.string().min(1).max(255).optional(),
    name: z.string().max(255).optional(),
    email: z.union([z.string().email().max(320), z.literal('')]).optional(),
    phone: z.string().max(64).optional(),
    mobile: z.string().max(64).optional(),
    title: z.string().max(255).optional(),
    roles: z.array(z.string().min(1).max(64)).max(16).optional(),
    externalId: z.string().min(1).max(255).optional(),
    externalSystem: z.string().min(1).max(64).optional(),
  });

export const contactImportRowSchema = importRowFields
  .refine(hasIdentifier, { message: IDENTIFIER_REQUIRED_MESSAGE });

/**
 * A row as submitted to a COMMIT: the annotation the client saw, and the
 * contact it saw the row match. Both are checked against freshly re-derived
 * state, so a stale acknowledgement is refused rather than applied.
 *
 * `conflict` and `org-not-found` are absent from the enum on purpose — neither
 * is a state a client can acknowledge into a write.
 */
export const commitContactImportRowSchema = importRowFields
  .extend({
    expectedAnnotation: z.enum(['create', 'link-match', 'email-match', 'name-match']).optional(),
    expectedContactId: z.string().guid().optional(),
  })
  .refine(hasIdentifier, { message: IDENTIFIER_REQUIRED_MESSAGE });
