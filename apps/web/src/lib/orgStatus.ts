import type { Organization } from '../stores/orgStore';

/**
 * How an organization's lifecycle status is named and coloured.
 *
 * Lives in `lib/` rather than on the organizations page for the same reason
 * `fetchAllOrganizations` does: a second reader — the organization RECORD
 * header (#5075) — needs the same pill, and importing it from the page
 * component would pull the entire settings page into the record's bundle.
 * `OrganizationsPage` re-exports both, so it stays the documented home of the
 * status contract and its tests. The header OrgSwitcher reads the same map,
 * so one status is one colour everywhere on screen.
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

/**
 * Semantic tokens only (`success` / `warning` / `destructive` / `muted`), so
 * each status keeps the meaning its colour has everywhere else in the app and
 * dark mode themes itself. Trial is deliberately neutral: it is a lifecycle
 * stage, not a health state, and on the brand colour it read as a link.
 */
export const statusColors: Record<Organization['status'], string> = {
  active: 'border-success/30 bg-success/10 text-success',
  trial: 'border-border bg-muted text-foreground',
  suspended: 'border-warning/40 bg-warning/10 text-warning-strong',
  churned: 'border-destructive/30 bg-destructive/10 text-destructive',
  offboarding: 'border-warning/40 bg-warning/10 text-warning-strong',
  merging: 'border-border bg-muted text-muted-foreground',
  archived: 'border-border bg-muted text-muted-foreground',
  purging: 'border-destructive/30 bg-destructive/10 text-destructive',
};

/** Pill classes for a status the client does not know (legacy `inactive`,
 *  a value newer than this build): neutral, never an empty class list. */
export const FALLBACK_STATUS_CLASS = 'border-border bg-muted text-muted-foreground';
