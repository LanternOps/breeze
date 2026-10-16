/**
 * #5016 — how long after an automatic edition migration is dispatched its
 * side effects are attributed to the migration rather than to anything else.
 *
 * Two readers, kept on one constant so they cannot drift apart:
 *  - the per-org canary (agentEditionAutoMigrate.ts): a device still reporting
 *    its OLD edition after this long survived the attempt and no longer holds
 *    the org's other stranded devices;
 *  - the uninstall-intent reaper (jobs/offlineDetector.ts): the migration's own
 *    `msiexec /x` stamps an uninstall intent, and an intent stamped inside
 *    [dispatched, dispatched + window] is the migration's, not a real removal,
 *    so it is never auto-decommissioned.
 *
 * It must outlast the whole dance: the script's 1800s budget covers download,
 * pin-verify and the hand-off, after which the detached stage waits for the
 * agent to release the command before uninstalling. 2h leaves wide margin; a
 * margin too wide only slows an org's rollout down.
 *
 * A Postgres interval literal (used as `${...}::interval`).
 */
export const EDITION_MIGRATION_SETTLE_INTERVAL = '2 hours';
