/**
 * Whether an organization row belongs to the ARCHIVE LIFECYCLE — the read-only
 * set the Archived section renders and the read-only detail panes serve.
 *
 * Keyed on the API's `archived` flag rather than on `status === 'archived'`.
 * The flag means "read through the READ ONLY archived door"
 * (`apps/api/src/services/archivedOrgReads.ts`), and since #4166 that door also
 * serves an org mid-ARCHIVE-drain (`status: 'offboarding'` with
 * `offboardingTarget: 'archive'`) — a row that is just as unwritable, because
 * it is outside `computeAccessibleOrgIds` and every mutation against it 404s,
 * but that is still uninstalling agents rather than settled.
 *
 * Keying read-onlyness on the status string instead left exactly that row
 * rendering Edit / Archive / Merge affordances and a settings form whose every
 * save could only fail. `status === 'archived'` stays as a second arm so a row
 * reaching the UI from a path that never sets the flag still renders read-only.
 *
 * Deliberately structural (`status: string`) rather than typed to one page's
 * `Organization`: the org list and the single-org settings page carry different
 * row shapes, and duplicating the predicate per shape is how the two allowlists
 * behind #4166 drifted apart in the first place.
 */
export function isArchiveLifecycleOrg(org: {
  status: string;
  archived?: boolean | undefined;
} | null | undefined): boolean {
  if (!org) return false;
  return org.archived === true || org.status === 'archived';
}
