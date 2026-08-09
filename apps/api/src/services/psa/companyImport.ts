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
  /** Max NEW companies to return. Defaults to `PSA_COMPANY_LIST_CAP`. */
  limit?: number;
  /**
   * External ids already linked to this provider for this partner.
   *
   * These are dropped BEFORE the cap is applied, which is what makes a PSA
   * larger than the cap importable at all. Previously the walk always restarted
   * at page 1, so after importing the first 1000 of 1500 companies a re-preview
   * returned the SAME 1000 (every one a `link-match`) and zero new rows — the
   * remaining 500 were reachable only through the CSV import this feature
   * exists to replace. Skipping what is already linked means each successive
   * preview surfaces the next batch until the PSA is exhausted.
   */
  alreadyLinkedExternalIds?: ReadonlySet<string>;
}

export interface PsaCompanyListing {
  rows: ImportRow[];
  /**
   * True when the cap, the wall-clock budget, or the page guard clipped the
   * list. The route MUST forward this to the UI: importing the first 1000 of
   * 1500 companies leaves the rest unlinked.
   */
  truncated: boolean;
  /** Why the walk stopped short — the UI wording differs per cause. */
  truncationReason?: 'cap' | 'time-budget' | 'page-guard';
  /** Companies read from the PSA before filtering. */
  fetched: number;
  /** Skipped because they are already linked to this provider. */
  alreadyLinked: number;
  /** Skipped because the PSA record had no usable id or name. */
  malformed: number;
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

/**
 * Max organization name the commit route's zod schema accepts.
 *
 * The seam itself already clamps to this width when it writes
 * (`clamp(group.organization, 255)`), but the WIRE schema rejects instead — so
 * a single PSA company with an over-long name would preview cleanly and then
 * 400 the ENTIRE commit batch, with no per-row remedy available to the user.
 * Clamping at the mapping boundary keeps the batch importable and matches what
 * the database would have stored anyway.
 */
const MAX_ORGANIZATION_NAME = 255;

/** `PSACompany` → `ImportRow`. Exported for direct unit testing of the mapping. */
export function psaCompanyToImportRow(
  company: PSACompany,
  system: OrgImportCapablePsaProvider
): ImportRow {
  return {
    organization: company.name.slice(0, MAX_ORGANIZATION_NAME),
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
  const {
    provider,
    client,
    limit = PSA_COMPANY_LIST_CAP,
    alreadyLinkedExternalIds
  } = options;

  // Fail here rather than at the adapter: the capability list is the contract
  // the route and the web UI both read, so an incapable provider must never get
  // as far as an outbound request.
  if (!isOrgImportCapableProvider(provider)) {
    throw new PsaCapabilityError(provider, 'organization import');
  }

  const system: OrgImportCapablePsaProvider = provider;

  async function listCompanies(_ctx: OrgImportContext): Promise<PsaCompanyListing> {
    // `ctx.partnerId` is unused: the connection was already resolved and
    // authorized by the route, which also supplied `alreadyLinkedExternalIds`
    // for that partner. The partner scoping of the resulting rows is applied by
    // the seam itself (previewOrgImport/commitOrgImport take partnerId
    // directly). Kept in the signature to satisfy the seam.
    //
    // The adapter is asked for `limit` NEW companies. Because already-linked
    // ids are filtered inside the walk (see `skipExternalIds`), the cap counts
    // only rows the tech can actually act on.
    const { companies, truncated, truncationReason, alreadyLinked, malformed } =
      await client.getCompanies({ limit, skipExternalIds: alreadyLinkedExternalIds });

    return {
      rows: companies.map((company) => psaCompanyToImportRow(company, system)),
      truncated,
      ...(truncationReason ? { truncationReason } : {}),
      // What the PSA actually handed us, before any filtering — the honest
      // denominator for "N of M companies" in the UI.
      fetched: companies.length + alreadyLinked + malformed,
      alreadyLinked,
      malformed
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
