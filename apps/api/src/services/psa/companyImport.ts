/**
 * PSA company import source (#3246).
 *
 * The first implementation of the org-import seam's `OrgImportSource`
 * (services/orgImport/types.ts): it turns a PSA connection's companies into
 * `ImportRow`s that `previewOrgImport` / `commitOrgImport` consume unchanged.
 *
 * ── Dedupe identity ──────────────────────────────────────────────────────────
 * Rows are stamped with `externalSystem = <provider slug>` (e.g. 'connectwise'),
 * matching the `'quickbooks'` convention already used by the accounting source.
 * The seam's link table `organization_external_links` is unique on
 * `(partner_id, system, external_id)`, so the effective dedupe key here is
 * (partner, provider slug, PSA company id).
 *
 * That deliberately keys on the PROVIDER, not on the connection id — a settled
 * decision with a real consequence: it assumes ONE instance per provider per
 * partner. An MSP with two separate ConnectWise tenants under one partner would
 * see company id "42" from both collapse onto the same Breeze organization.
 * The alternative (`connectwise:<connectionId>`) would make the same PSA
 * re-imported through a recreated connection look brand-new and duplicate every
 * organization — a far worse and irreversible failure. Single-instance is the
 * overwhelmingly common MSP shape, and cross-source dedupe (a CSV import that
 * wrote `system='connectwise'` must match a later PSA import) only works when
 * the system value is the stable provider slug. Revisit only with a migration
 * that rewrites existing link rows.
 *
 * ── Lossy-upward mapping ─────────────────────────────────────────────────────
 * `PSACompany` carries only {id, name, externalId}. There is no site, timezone,
 * address, or contact, so every imported organization takes the seam's
 * default-site path: one site named after the organization, timezone UTC.
 * Enriching later is additive; nothing here needs to change.
 */

import type { ImportRow, OrgImportContext, OrgImportSource } from '../orgImport/types';
import {
  PSA_COMPANY_LIST_CAP,
  PsaCapabilityError,
  isOrgImportCapableProvider,
  type OrgImportCapablePsaProvider,
  type PSACompany,
  type PSAProvider
} from './types';

export interface PsaCompanyImportOptions {
  /** Provider slug of the resolved connection — becomes `externalSystem`. */
  provider: string;
  /** Adapter built from the connection's decrypted credentials. */
  client: Pick<PSAProvider, 'getCompanies'>;
  /** Max companies to pull. Defaults to `PSA_COMPANY_LIST_CAP`. */
  limit?: number;
}

export interface PsaCompanyListing {
  rows: ImportRow[];
  /**
   * True when the cap clipped the company list. The route MUST forward this to
   * the UI: importing the first 1000 of 1500 companies leaves the remaining
   * 500 unlinked, and a later import of the same PSA would then have no link
   * rows to match against for the ones that were never fetched.
   */
  truncated: boolean;
}

/**
 * A PSA-backed org-import source bound to one resolved connection.
 *
 * Extends `OrgImportSource` rather than replacing it: `list()` satisfies the
 * declared seam exactly, and `listCompanies()` is the richer call the route
 * actually uses.
 *
 * WHY BOTH — seam friction worth knowing about: `OrgImportSource.list()` is
 * typed `Promise<ImportRow[]>`, which has nowhere to put `truncated`. Widening
 * the seam to `{ rows, truncated }` is very likely the right long-term shape
 * (every remote source paginates; CSV would simply always report false), but
 * that is a cross-module contract change and this PR declined to make it
 * silently as a side effect of the first implementation. So the seam is honored
 * as written and the extra signal rides alongside it.
 */
export interface PsaCompanyImportSource extends OrgImportSource {
  system: OrgImportCapablePsaProvider;
  listCompanies(ctx: OrgImportContext): Promise<PsaCompanyListing>;
}

/** `PSACompany` → `ImportRow`. Exported for direct unit testing of the mapping. */
export function psaCompanyToImportRow(
  company: PSACompany,
  system: OrgImportCapablePsaProvider
): ImportRow {
  return {
    organization: company.name,
    // `externalId` is the vendor's stable UID; `id` is the same value for every
    // current adapter, but prefer the explicit field and fall back so a future
    // adapter that distinguishes them cannot silently produce an unkeyed row.
    externalId: company.externalId ?? company.id,
    externalSystem: system
  };
}

export function createPsaCompanyImportSource(
  options: PsaCompanyImportOptions
): PsaCompanyImportSource {
  const { provider, client, limit = PSA_COMPANY_LIST_CAP } = options;

  // Fail here rather than at the adapter: the capability list is the contract
  // the route and the web UI both read, so an incapable provider must never get
  // as far as an outbound request.
  if (!isOrgImportCapableProvider(provider)) {
    throw new PsaCapabilityError(provider, 'organization import');
  }

  const system: OrgImportCapablePsaProvider = provider;

  async function listCompanies(_ctx: OrgImportContext): Promise<PsaCompanyListing> {
    // `ctx.partnerId` is unused: the connection was already resolved and
    // authorized by the route, and the partner scoping of the resulting rows is
    // applied by the seam itself (previewOrgImport/commitOrgImport take
    // partnerId directly). Kept in the signature to satisfy the seam.
    const { companies, truncated } = await client.getCompanies({ limit });

    return {
      rows: companies.map((company) => psaCompanyToImportRow(company, system)),
      truncated
    };
  }

  return {
    system,
    listCompanies,
    async list(ctx: OrgImportContext): Promise<ImportRow[]> {
      const { rows } = await listCompanies(ctx);
      return rows;
    }
  };
}
