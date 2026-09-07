import type { Organization } from '../stores/orgStore';

/**
 * How an organization's lifecycle status is named and coloured.
 *
 * Lives in `lib/` rather than on the organizations page for the same reason
 * `fetchAllOrganizations` does: a second reader — the organization RECORD
 * header (#5075) — needs the same pill, and importing it from the page
 * component would pull the entire settings page into the record's bundle.
 * `OrganizationsPage` re-exports both, so it stays the documented home of the
 * status contract and its tests.
 */
export const statusLabelKeys: Record<Organization['status'], string> = {
  active: 'organizationsPage.status.active',
  trial: 'organizationsPage.status.trial',
  suspended: 'organizationsPage.status.suspended',
  churned: 'organizationsPage.status.churned',
  offboarding: 'organizationsPage.status.offboarding',
  merging: 'organizationsPage.status.merging',
  archived: 'organizationsPage.status.archived',
  purging: 'organizationsPage.status.purging',
};

export const statusColors: Record<Organization['status'], string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  trial: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  suspended: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  churned: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  offboarding: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400',
  merging: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
  archived: 'border-gray-500/30 bg-gray-500/10 text-gray-700 dark:text-gray-400',
  purging: 'border-red-400/30 bg-red-400/10 text-red-600 dark:text-red-300',
};
