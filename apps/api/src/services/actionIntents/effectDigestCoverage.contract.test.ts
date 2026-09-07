/**
 * Effect-digest COVERAGE contract (2026-08-05 tier3-supervised-four-eyes
 * design §4.1).
 *
 * A `four_eyes` intent can sit for 60 minutes (chat) or 24 hours (mcp_api)
 * between "an approver looked at it" and "it executes". `argument_digest`
 * only proves the intent's arguments didn't change; the CONTENT they
 * reference can drift freely underneath the approval unless
 * services/actionIntents/effectDigest.ts has a resolver that pins it. A
 * four_eyes surface with no resolver is therefore silently unprotected
 * against the exact TOCTOU class this feature exists to close — and nothing
 * flagged it, which is how `manage_invoices:void` shipped four_eyes with no
 * resolver while its three siblings (`issue`, `record_payment`,
 * `void_payment`) all had one.
 *
 * This test makes the omission impossible to repeat: EVERY four_eyes-
 * classified tool/action must either resolve to an EFFECT_DIGEST_RESOLVERS
 * entry, or be listed in DELIBERATELY_UNPINNED below WITH a written reason.
 * Adding a new four_eyes surface fails this test until you make that choice
 * explicitly.
 *
 * No `vi.mock` — like intentReleaseWorker.durable.contract.test.ts and
 * aiGuardrails.approvalScope.contract.test.ts, this needs the REAL registries
 * on both sides (the tier-3 classification tables AND the live resolver map)
 * to be a meaningful contract. Importing effectDigest.ts is safe here because
 * every resolver takes its `Database` as a PARAMETER — nothing in the module
 * opens a connection at import time. (Since #3409 PR4c-1 the import graph does
 * reach '../../db' transitively, via runScriptSnapshot -> tenantVariable-
 * Resolution's `loadTenantVariableScope`; postgres.js constructs its client
 * lazily and connects only on first query, so module load stays inert. This
 * file never invokes a resolver, only `effectDigestResolverKey`.)
 */
import { describe, it, expect } from 'vitest';
import {
  TIER3_FOUR_EYES_ACTIONS, TIER3_FOUR_EYES_TOOLS,
  TIER3_INPUT_AWARE_ACTIONS, TIER3_INPUT_AWARE_TOOLS,
} from '../aiGuardrails';
import { effectDigestResolverKey } from './effectDigest';

/** Expands one shared reason across a family of surfaces that are unpinnable
 * for identical structural reasons (the 20 Google Workspace tools, the
 * restore family). Every surface still carries a reason — the point of the
 * allowlist is that a NEW member has to be added here deliberately, not that
 * each line reads differently. */
const sharedReason = (surfaces: string[], reason: string): Record<string, string> =>
  Object.fromEntries(surfaces.map((surface) => [surface, reason]));

/**
 * four_eyes surfaces that genuinely have nothing pinnable, and WHY.
 *
 * Three recurring shapes:
 *  - EXTERNAL — the thing that drifts lives in someone else's system
 *    (SentinelOne, Microsoft Graph, Google Directory, a Hyper-V host, a
 *    backup vault, the device itself). We cannot hash it without an
 *    approval-time round trip to that provider, which would put a
 *    third-party outage on the intent-creation path.
 *  - NEW-OBJECT — the action's effect is to CREATE a row; there is no
 *    pre-existing target to pin at approval time.
 *  - IMMUTABLE — the addressed row exists but never mutates (and in the
 *    backup case has no `updated_at` at all), so a digest could never differ.
 *
 * A surface whose only local row is an inventory MIRROR (hyperv_vms, patches)
 * is called out explicitly: pinning a mirror's `updated_at` would fail closed
 * on every routine background sync, which is worse than not pinning at all.
 */
const DELIBERATELY_UNPINNED: Record<string, string> = {
  // --- NEW-OBJECT: nothing exists at approval time -------------------------
  'manage_organizations:create_org':
    'Creates a brand-new organization. The tool takes no id argument at all — there is no pre-existing row to hash.',
  create_remote_session:
    'NEW-OBJECT: inserts a `remote_sessions` row. The only pre-existing row it touches is `devices`, for an access check, and a device row is not the thing being acted on.',
  request_elevation:
    'NEW-OBJECT: inserts an `elevation_requests` row. Takes no PAM policy/rule id — `pam_rules` are matched implicitly by the device org/site at evaluation time, so there is no addressable policy row the approver signed off on.',
  'manage_patches:rollback':
    'NEW-OBJECT: writes a `patch_rollbacks` row. The addressed `patches` row is a GLOBAL vendor catalog entry re-synced on a schedule, so its `updated_at` churns independently of anything the approver saw — pinning it would fail closed on routine syncs.',
  'manage_policy_feature_link:add':
    'NEW-OBJECT: inserts a `config_policy_feature_links` row (RMM-QA-176 D9). `configPolicyId` addresses the PARENT policy, which is not the thing being created — there is no pre-existing link row whose content the approver signed off on. The sibling `update`, which DOES address an existing link, is pinned by an EFFECT_DIGEST_RESOLVERS entry rather than exempted here.',

  // --- EXTERNAL: the drift happens in another system -----------------------
  ...sharedReason(
    ['manage_hyperv_checkpoints:delete', 'manage_hyperv_checkpoints:apply'],
    'EXTERNAL: the checkpoint is named by `checkpointName` and lives on the Hyper-V host (dispatched via the Go agent). The only local row (`hyperv_vms`, via `vmId`) is an inventory mirror whose `updated_at` bumps on every sync.',
  ),
  ...sharedReason(
    ['s1_threat_action', 's1_threat_action:rollback', 's1_isolate_device'],
    'EXTERNAL: threat/isolation state lives in SentinelOne. `threatIds`/`deviceIds` are ARRAYS and may carry SentinelOne-native ids rather than Breeze UUIDs, so there is no single local row to address even for the mirrored `s1_threats` table.',
  ),
  computer_control:
    'EXTERNAL: synchronous input injection against the live device via the Go agent. Nothing in our DB is the write target and there is no persisted state to hash.',
  ...sharedReason(
    ['m365_disable_user', 'm365_reset_password'],
    'EXTERNAL: the target is a Microsoft Graph user object. Pinning it would require a Graph round trip at intent creation, putting a third-party outage on the creation path.',
  ),
  ...sharedReason(
    [
      'google_reset_password', 'google_reset_2sv',
      'google_set_forwarding', 'google_disable_forwarding',
      'google_add_mail_delegate', 'google_remove_mail_delegate',
      'google_suspend_user', 'google_offboard_user', 'google_wipe_mobile_device',
      'google_restore_user', 'google_signout', 'google_set_vacation',
      'google_update_user', 'google_share_calendar', 'google_move_ou',
      'google_rename_user', 'google_add_to_group', 'google_remove_from_group',
      'google_assign_license', 'google_remove_license',
    ],
    'EXTERNAL: the target is a Google Directory / Gmail object addressed by `userEmail`. Same rationale as the M365 pair — no local row, and pinning would need a provider round trip at creation.',
  ),

  // --- IMMUTABLE target -----------------------------------------------------
  ...sharedReason(
    [
      'restore_snapshot', 'restore_as_vm', 'instant_boot_vm',
      'restore_mssql_database', 'restore_hyperv_vm',
    ],
    'IMMUTABLE: the addressed `backup_snapshots` row is write-once (the table has no `updated_at` column at all) and the effect lands in the backup vault / on the agent / on a hypervisor. A snapshot cannot drift, so a digest could never differ.',
  ),
  restore_c2c_items:
    'IMMUTABLE + NEW-OBJECT: `itemIds` is an array addressing write-once `c2c_backup_items`, and the restore itself inserts a new `c2c_backup_jobs` row and executes against the SaaS provider.',
};

/**
 * Every four_eyes-classified surface, as `tool` or `tool:action`.
 *
 * Mirrors intentReleaseWorker.durable.contract.test.ts's superset construction
 * and its rationale: the input-aware surfaces (TIER3_INPUT_AWARE_*) resolve
 * four_eyes only on SOME inputs and are invisible to the static tables by
 * construction, but they still need pinning coverage on the branch where they
 * DO resolve four_eyes — so they are folded in. Including a surface that
 * turns out never to be four_eyes only makes this check stricter, never wrong.
 */
function enumerateFourEyesSurfaces(): string[] {
  const surfaces = new Set<string>();
  for (const [tool, actions] of Object.entries(TIER3_FOUR_EYES_ACTIONS)) {
    for (const action of actions) surfaces.add(`${tool}:${action}`);
  }
  for (const tool of TIER3_FOUR_EYES_TOOLS) surfaces.add(tool);
  for (const pair of TIER3_INPUT_AWARE_ACTIONS) surfaces.add(pair);
  for (const tool of TIER3_INPUT_AWARE_TOOLS) surfaces.add(tool);
  return [...surfaces].sort();
}

/** `tool:action` → resolver key, or null when nothing resolves. Uses the real
 * precedence (tool:action beats whole-tool) via effectDigest.ts's own helper
 * so the two can't drift. */
function resolverFor(surface: string): string | null {
  const [tool, action] = surface.includes(':') ? surface.split(':') : [surface, undefined];
  return effectDigestResolverKey(tool!, action);
}

describe('effect-digest coverage: every four_eyes surface is pinned or explicitly exempted', () => {
  const surfaces = enumerateFourEyesSurfaces();

  it('has surfaces to check (guards against an accidentally-empty fixture)', () => {
    expect(surfaces.length).toBeGreaterThan(10);
  });

  it('every four_eyes surface either has an effect-digest resolver or a DELIBERATELY_UNPINNED reason', () => {
    const uncovered = surfaces.filter(
      (surface) => resolverFor(surface) === null && !DELIBERATELY_UNPINNED[surface],
    );
    expect(
      uncovered,
      `these four_eyes surfaces have NO effect-digest resolver and no written exemption — an ` +
        `approver signs off on a REFERENCE and the referenced content can drift for up to 24h ` +
        `before release with nothing detecting it. Either add a resolver to ` +
        `EFFECT_DIGEST_RESOLVERS (services/actionIntents/effectDigest.ts) or add an entry to ` +
        `DELIBERATELY_UNPINNED in this file explaining why nothing is pinnable: ` +
        `${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('every DELIBERATELY_UNPINNED entry carries a non-trivial written reason', () => {
    const thin = Object.entries(DELIBERATELY_UNPINNED)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([surface]) => surface);
    expect(thin, `these exemptions need a real explanation, not a placeholder: ${thin.join(', ')}`).toEqual([]);
  });

  // Keeps the allowlist honest in the other direction: an exemption that is no
  // longer needed (a resolver was added, or the surface stopped being
  // four_eyes) is stale documentation asserting something false.
  it('has no stale DELIBERATELY_UNPINNED entries', () => {
    const stale = Object.keys(DELIBERATELY_UNPINNED).filter(
      (surface) => !surfaces.includes(surface) || resolverFor(surface) !== null,
    );
    expect(
      stale,
      `these exemptions are stale — the surface either now HAS a resolver or is no longer ` +
        `four_eyes-classified. Remove them: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  // The specific regression that motivated this file: `void` was classified
  // four_eyes alongside issue/record_payment/void_payment (aiGuardrails.ts's
  // TIER3_FOUR_EYES_ACTIONS) but shipped with no resolver, even though it
  // takes the same `invoiceId` its siblings do.
  it('all four approval-gated manage_invoices actions resolve to a pinning resolver', () => {
    for (const action of ['issue', 'void', 'record_payment', 'void_payment']) {
      expect(resolverFor(`manage_invoices:${action}`)).toBe(`manage_invoices:${action}`);
    }
  });
});
