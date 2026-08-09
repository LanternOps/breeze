/**
 * PSA (Professional Services Automation) provider registry — shared grammar.
 *
 * The ONE source of truth for which PSA providers Breeze actually implements
 * (an adapter exists in apps/api/src/services/psa/ and the web UI can offer
 * it). The API route schema, the PSA service layer's provider type, and the
 * web form/list all derive from this list so they can never drift.
 *
 * NOTE: the Postgres `psa_provider` enum is intentionally WIDER than this list
 * (it also contains `halo`, `syncro`, `kaseya`, `other`). Those values predate
 * the route-level zod gate, have no adapter, and cannot be inserted through the
 * API — this list is the gate. Do not add a value here without shipping the
 * corresponding adapter.
 */

import { z } from 'zod';

export const PSA_PROVIDERS = [
  'connectwise',
  'autotask',
  'jira',
  'servicenow',
  'freshservice',
  'zendesk'
] as const;

export const psaProviderIdSchema = z.enum(PSA_PROVIDERS);

export type PsaProviderId = (typeof PSA_PROVIDERS)[number];

/**
 * Providers whose adapter can enumerate companies for organization import
 * (#3246).
 *
 * Lives here rather than in the API service layer because BOTH sides need it:
 * the API gates `POST /psa/connections/:id/import*` on it, and the web UI must
 * only offer the import action for a connection the route would accept — a
 * second hand-maintained copy in `apps/web` is exactly the drift this package
 * exists to prevent.
 *
 * Derived from `PSA_PROVIDERS` via `satisfies`, so a typo or a value that is
 * not a real provider fails to compile. Jira is the one exclusion: it is an
 * issue tracker with no company/account object to map onto an organization.
 * `apps/api/src/services/psa/companyImport.test.ts` asserts this list plus
 * `'jira'` covers `PSA_PROVIDERS` exactly, so ADDING a provider forces an
 * explicit capable/not-capable decision instead of silently defaulting to
 * incapable.
 */
export const ORG_IMPORT_CAPABLE_PSA_PROVIDERS = [
  'connectwise',
  'autotask',
  'freshservice',
  'servicenow',
  'zendesk'
] as const satisfies readonly PsaProviderId[];

export type OrgImportCapablePsaProvider = (typeof ORG_IMPORT_CAPABLE_PSA_PROVIDERS)[number];

export function isOrgImportCapableProvider(
  provider: string
): provider is OrgImportCapablePsaProvider {
  return (ORG_IMPORT_CAPABLE_PSA_PROVIDERS as readonly string[]).includes(provider);
}
