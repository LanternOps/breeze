/**
 * The organization row as the settings surfaces see it (the org list page and
 * the archive / merge modals). Lived on `OrganizationList.tsx` until that
 * table component was retired as dead code; the type is what every consumer
 * actually imported.
 */
export type Organization = {
  id: string;
  name: string;
  status: 'active' | 'trial' | 'suspended' | 'churned' | 'offboarding' | 'merging' | 'archived' | 'purging';
  /**
   * Absent when the caller is organization-scoped: that branch of
   * `GET /orgs/organizations` returns a deliberately minimal projection
   * (id/name/slug/status) because those users reach the route without
   * `organizations:read`. Optional here so the renderer has to decide what to
   * show rather than interpolating `undefined` into a label (#3699).
   *
   * Mirrors `org_type` (apps/api/src/db/schema/orgs.ts). The partner/system
   * branch of `GET /orgs/organizations` spreads the full row so this is
   * present in practice for that branch; kept optional because the
   * organization-scoped projection above omits it. Consumers that need to
   * exclude the hidden `quick_support` org (e.g. the merge survivor picker)
   * check this rather than assuming the list already filtered it out.
   */
  type?: 'customer' | 'internal' | 'quick_support';
  deviceCount?: number;
  createdAt: string;
  /**
   * Set (`true`) only on rows read through the archived-org list/detail door
   * (`GET /orgs/organizations?includeArchived=true`, `archivedOrgReads.ts`).
   * Absent on every ordinary live row — never `false`.
   *
   * It means "read through the READ ONLY archived door", NOT literally
   * `status === 'archived'`: since #4166 the door also serves an org mid-ARCHIVE
   * drain (`status: 'offboarding'`, `offboardingTarget: 'archive'`), which is
   * equally read-only but is still uninstalling agents. Branch on THIS flag for
   * read-onlyness and on `status` for what to display — see
   * `isArchiveLifecycleOrg` in `lib/archiveLifecycle.ts`.
   */
  archived?: true;
  /** ISO timestamp, or `null` for "kept indefinitely" — only meaningful when `archived`. */
  purgeAt?: string | null;
  /**
   * Which terminal status an `offboarding` drain is headed for. `'archive'` is
   * the reversible archive drain (Restore aborts it); `'churn'` is the
   * one-way churn exit. Present on the full partner/system row projection;
   * absent from the organization-scoped minimal projection.
   */
  offboardingTarget?: string | null;
};
