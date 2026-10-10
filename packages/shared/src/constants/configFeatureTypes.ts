/**
 * Canonical list of configuration-policy feature types — the SINGLE SOURCE OF
 * TRUTH shared across api, agent helpers, and web.
 *
 * It lives here (a pure leaf module in `@breeze/shared`, no DB / heavy imports)
 * so every layer can derive from the same list and they cannot silently drift:
 *
 *  - The API re-exports it from `apps/api/src/services/configFeatureTypes.ts`,
 *    and a parity test (`apps/api/src/services/policyBaselineDefaults.test.ts`)
 *    pins canonical plus retired types to the Drizzle `configFeatureTypeEnum`.
 *  - The web layer derives its per-surface unions from `ConfigFeatureType` via
 *    `Exclude<…>` (config-policy editor tabs, device Effective Config tab), so a
 *    new canonical feature type fails to compile until each surface accounts for
 *    it, and runtime parity tests assert the documented exclusions stay honest.
 *    See issue #2004.
 *
 * When adding a feature type: add it here AND to the Drizzle enum in the same
 * change (the api parity test enforces this), then resolve the resulting web
 * compile errors / parity-test failures.
 */
export const CONFIG_FEATURE_TYPES = [
  'patch', 'backup', 'security', 'maintenance',
  'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data',
  'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam', 'onedrive_helper',
  'vulnerability', 'device_lifecycle',
  // Monitor definitions replace the retired alert-rule and watch features.
  'monitors',
  // #6856 — inherited RAID/disk-health collection settings, inline-only.
  'hardware_monitoring',
  // Time sync — inherited NTP/timezone management settings, inline-only.
  'time_sync',
  // #3834 — workload host inventory enumeration settings, inline-only.
  'workload_inventory',
] as const;

export type ConfigFeatureType = typeof CONFIG_FEATURE_TYPES[number];

/**
 * Feature types whose per-feature config is fundamentally org-scoped and
 * cannot be authored on a partner-wide ("all organizations") config policy
 * (org_id NULL, #1724): onedrive_helper settings carry per-tenant M365
 * library mappings, so a partner-wide policy has no owning org to anchor
 * them to. backup left this set with the backup-profiles model (spec
 * 2026-07-13): its settings row is now dual-axis and partner-wide links
 * resolve each device org's default destination at job time.
 *
 * Every other feature type has migrated to partner-wide support as part of
 * epic #2135 (dual-ownership templates, partner-axis update rings, or
 * partner-agnostic inline settings) — this set should stay small and shrink
 * further only when a feature's underlying storage moves off a required
 * org_id (see the partner-wide-first rule in CLAUDE.md).
 *
 * SINGLE SOURCE OF TRUTH for this restriction — consumed by:
 *  - `apps/api/src/routes/configurationPolicies/featureLinks.ts`
 *    (`ORG_SCOPED_ONLY_FEATURES`, write-time 400 rejection)
 *  - `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx`
 *    (gates the feature tab so the UI can't offer an edit that will 400 — #2101)
 * Keeping one list means the API rule and the UI gating can't silently drift.
 */
export const ORG_SCOPED_ONLY_FEATURE_TYPES: ReadonlySet<ConfigFeatureType> = new Set([
  'onedrive_helper',
]);

/** Retired links and their child rows stay in the database for alert history. */
export const RETIRED_CONFIG_FEATURE_TYPES = ['alert_rule', 'monitoring'] as const;
export type RetiredConfigFeatureType = typeof RETIRED_CONFIG_FEATURE_TYPES[number];
export function isRetiredConfigFeatureType(value: unknown): value is RetiredConfigFeatureType {
  return typeof value === 'string' && (RETIRED_CONFIG_FEATURE_TYPES as readonly string[]).includes(value);
}

/**
 * Execution-target field-provenance tiering — classifies every feature type by what a device
 * gains from its own assignment for a `device_group`-level policy it only
 * qualifies for because the group's rules key on a high-value agent-reported
 * field, e.g. `hostname`/`tags`/`custom.*` (see `apps/api/src/services/
 * executionTargetGating.ts`: such a group is refused as an execution target
 * because the device's own report decides its membership).
 *
 * The test is "does this feature grant the device a capability it does not
 * already have on itself," not "does this feature
 * execute/install/deliver something." Conflating the two would
 * misclassify `patch`/`backup` as execution_gated.
 *
 * - `protective` — the feature only RESTRICTS or DETECTS on the device it
 *   applies to, or delivers nothing the device doesn't already have on
 *   itself (hardening, DNS/firewall posture,
 *   peripheral/USB control, monitoring, compliance/vulnerability/
 *   sensitive-data scanning, log collection, alert-rule thresholds,
 *   informational lifecycle/warranty state, patch ring/schedule metadata,
 *   backup profile/destination references). Dropping the assignment for a
 *   refused group would silently turn a real protection OFF (or silently
 *   stop real patching/backups) for a device that never asked to be
 *   excluded, so these feature types are NEVER gated: they keep
 *   applying regardless of which fields the group's rules match on.
 * - `execution_gated` — the feature GRANTS the device a capability it does
 *   not already have on itself (runs automations or scripts,
 *   elevates privilege, opens a remote-access session, delivers a
 *   credential/secret, delivers admin-authored package content that may
 *   embed secrets, or suppresses detection while it runs). A device that
 *   self-selects into a group assigned one of these is picking up something
 *   it was never meant to have; falling back to "no grant" is the safe
 *   default, so these stay behind the execution-target gate.
 *
 * A `Record<ConfigFeatureType, …>` (not a partial map) so the compiler forces
 * a classification decision the moment a new feature type is added —
 * `configFeatureTypes.test.ts` in `@breeze/shared` additionally asserts this
 * at runtime for callers that only see the type erased.
 */
export const CONFIG_POLICY_FEATURE_TRUST_TIER: Record<ConfigFeatureType, 'protective' | 'execution_gated'> = {
  // execution_gated — installs/deploys software, runs code, elevates
  // privilege, opens remote access, or delivers a credential/secret.
  software_policy: 'execution_gated', // can deliver arbitrary admin-authored package/script content, which may embed secrets — unlike patch's fixed vendor-update payload
  automation: 'execution_gated', // executes scripts/automations on the device
  remote_access: 'execution_gated', // grants WebRTC/VNC/remote-tools session capability
  pam: 'execution_gated', // privileged elevation rules
  onedrive_helper: 'execution_gated', // delivers OneDrive helper library-mapping/credential config
  helper: 'execution_gated', // Breeze Assist technician/AI-chat capability grants on the device
  maintenance: 'execution_gated', // grants suppression of alerting/monitoring for the window — capability to evade detection, not merely a restriction

  // protective — restricts the device or only detects/reports; never grants a
  // capability, so a dropped assignment can only ever leave the device MORE
  // exposed to normal baseline behavior, never less.
  security: 'protective', // hardening/DNS-filtering/firewall posture — restricts only
  compliance: 'protective', // compliance scan evaluation (remediation dispatch is a separate, already-gated path — see policyEvaluationService.ts)
  event_log: 'protective', // log collection tuning — detection/forensics only
  sensitive_data: 'protective', // sensitive-data discovery scanning — detection only
  peripheral_control: 'protective', // USB/peripheral device control — restricts only ("not enforced" = peripherals unrestricted, the unsafe direction)
  vulnerability: 'protective', // vulnerability correlation/scanning — detection only
  device_lifecycle: 'protective', // informational lifecycle status — no execution capability
  monitors: 'protective', // monitor definitions — detection only
  hardware_monitoring: 'protective', // RAID/disk-health collection — detection only
  time_sync: 'protective', // NTP/timezone enforcement settings — no execution capability
  workload_inventory: 'protective', // opt-in, read-only enumeration of containers/VMs — nothing executes, installs or receives a secret
  warranty: 'protective', // informational warranty alerts — no execution capability
  // A device that self-selects into a group
  // gains nothing new from patch/backup that it doesn't already have as an
  // already-controlled device, so dropping either for a refused group only
  // creates a silent-regression risk (unpatched/unbacked-up real fleets).
  patch: 'protective', // resolves to ring/schedule metadata only — no credential delivered; dropping it silently unpatches real hostname/tag-ringed fleets
  backup: 'protective', // resolves to a backup-profile/destination REFERENCE, not storage credentials — dropping it silently stops backups for real hostname/tag-keyed groups
};

export const EXECUTION_GATED_FEATURE_TYPES: ReadonlySet<ConfigFeatureType> = new Set(
  CONFIG_FEATURE_TYPES.filter((ft) => CONFIG_POLICY_FEATURE_TRUST_TIER[ft] === 'execution_gated'),
);

export function isExecutionGatedFeatureType(featureType: ConfigFeatureType): boolean {
  return CONFIG_POLICY_FEATURE_TRUST_TIER[featureType] === 'execution_gated';
}
