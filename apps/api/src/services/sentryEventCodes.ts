/**
 * The closed set of `captureMessage` event codes (BREEZE-18).
 *
 * WHY THIS EXISTS: `scrubEvent` (services/sentry.ts) deletes `message`,
 * `logentry` and `extra` from every outbound event and rebuilds `tags` through
 * an allowlist. A `captureMessage` call that carried no allowlisted tag
 * therefore shipped a completely EMPTY event — no message, no tags, no
 * stacktrace — and Sentry grouped every one of them into a single issue.
 * Measured in production on 2026-08-23: BREEZE-18 held 11,466 occurrences
 * across 27 users (the org's top issue), and 2,610 of its most recent 2,738
 * events (95%) carried zero tags and were untriageable.
 *
 * Every allowlist entry added before this file — `cas_label`, `prior_status`,
 * `db_pool_health_verdict`, `body_limit_rule`, … — was the same problem being
 * rediscovered one incident at a time. `event_code` fixes it once, for every
 * call site, by construction: `captureMessage` requires one and applies it as a
 * tag itself, so no caller can ship a contentless event even by forgetting.
 *
 * RULES for adding a code:
 *   - Add it here first. The type is derived from this array, so a call site
 *     using an unregistered code fails `tsc` — the set cannot drift open.
 *   - It must be a HARDCODED string literal at the call site. Never
 *     interpolate an id, tenant, device, hostname or path into it: the whole
 *     point is a low-cardinality dimension Sentry can group and alert on.
 *     `sentryEventCodes.test.ts` scans the source and fails on interpolation.
 *   - One code per distinct condition, not per module. Two branches an
 *     operator would act on differently deserve two codes.
 *   - snake_case, and short enough to stay under the 128-char bounded-tag
 *     ceiling `isBoundedTagValue` enforces.
 */
export const SENTRY_EVENT_CODES = [
  // --- middleware -------------------------------------------------------
  /** A request was refused by a body-size limit (global gate or route rule). */
  'body_limit_rejected',
  /** A mobile caller's device id resolved to no `mobile_devices` row. */
  'mobile_device_unresolved',

  // --- database / pool --------------------------------------------------
  /** Pool-health watchdog published a non-healthy verdict. */
  'db_pool_health_degraded',
  /** Pool-health watchdog itself threw while evaluating. */
  'db_pool_health_check_failed',
  /** A `withDbAccessContext` transaction was held past the warn threshold. */
  'db_context_held_too_long',
  /** A write reached Postgres with no DB access context set (#1380 guard). */
  'db_contextless_write',
  /** Slow work ran INSIDE a held DB access context (#1105 tripwire). */
  'db_operation_inside_held_context',
  /** A compare-and-set write that expected rows affected zero (BREEZE-X). */
  'db_write_expecting_rows_zero',

  // --- process health ---------------------------------------------------
  /** The event loop was starved past the configured threshold (#3022). */
  'event_loop_starvation',

  // --- jobs -------------------------------------------------------------
  /** NVD pagination stopped before the feed's reported total (#2470). */
  'nvd_pagination_truncated',
  /** NVD pagination finished without the feed ever reporting a total. */
  'nvd_pagination_no_total',
  /** A CVE feed sync skipped an abnormal share of its entries. */
  'cve_feed_high_skip_rate',
  /** The FX provider returned rows the sync could not use. */
  'exchange_rate_rows_rejected',

  // --- software / catalog -----------------------------------------------
  /** A software version was stored with an undetermined installer type. */
  'software_version_installer_type_unknown',
  /** A software upload discarded a malformed `supportedOs` field. */
  'software_upload_malformed_supported_os',
  /** The catalog-polish fact guard caught the model inventing a numeric spec. */
  'catalog_polish_fact_over_claim',

  // --- mobile -----------------------------------------------------------
  /** Push registration lost a race and the phone gets no notifications. */
  'mobile_push_registration_conflict',
  /** Push registration fell back to a push-derived device id (#2913). */
  'mobile_push_registration_fallback',

  // --- integrations -----------------------------------------------------
  /** QuickBooks home-currency capture lost its compare-and-set (benign race). */
  'accounting_home_currency_cas_lost',
  /** The Intuit webhook route was reached with QBO_WEBHOOK_VERIFIER_TOKEN unset. */
  'accounting_webhook_verifier_token_missing',
  /** Inbound mail arrived with no usable provider sender-auth verdict. */
  'inbound_email_sender_auth_unverified',
  /** Inbound mail lost the message-id claim race and duplicated a ticket. */
  'inbound_email_claim_race_lost',
  /** No usable platform LLM key is configured on this deployment. */
  'llm_platform_key_missing',
  /** The LLM egress audit queue shed rows — the audit trail has gaps (#3922). */
  'llm_egress_audit_queue_shed',

  // --- ai spend / billing -----------------------------------------------
  /** The billing service's AI-credit check failed; the gate fell open. */
  'ai_billing_credits_check_failed',
  /** A platform-funded AI deduction did not land — that spend went unbilled. */
  'ai_billing_credits_deduct_failed',
  /** An org reached the AI billing path with no partner row to bill. */
  'ai_billing_org_partner_missing',
  /** A rejected partner AI key could not be stamped (config moved under us). */
  'ai_partner_key_error_stamp_stale',

  // --- backup -----------------------------------------------------------
  /** A backup result matched no job row (deleted, or invisible under RLS). */
  'backup_result_job_not_found',
  /** A backup result's reported org disagreed with the job row's org. */
  'backup_result_org_divergence',
  /** Snapshots are unattributable because two orgs share a destination. */
  'backup_snapshot_ambiguous_destination',

  // --- agent binary serving ---------------------------------------------
  /** No promoted `agent_versions` row, so downloads fall back to the
   *  env-resolved release and may fail client-side checksums (#3499). */
  'agent_promoted_version_missing',

  // --- device lifecycle -------------------------------------------------
  /** The device cascade could not read the caller's prior `lock_timeout`. */
  'device_deletion_lock_timeout_unreadable',
  /** The device cascade ran without holding the parent `devices` row lock. */
  'device_deletion_parent_lock_missing',
  /** Auto edition migration (#4072) dispatched its script to at least one stranded device this process lifetime. */
  'agent_edition_auto_migration_dispatched',

  // --- mcp transport ----------------------------------------------------
  /** A principal presented an `Mcp-Session-Id` owned by someone else (MED-1). */
  'mcp_session_principal_mismatch',
  /** Unknown/expired `Mcp-Session-Id` rate spiked — suspect session-store loss (#3744). */
  'mcp_session_unknown_rate_high',

  // --- retention --------------------------------------------------------
  /**
   * A retention sweep hit its batch cap with rows still eligible (#4343). If
   * this repeats nightly for one table, that table is growing faster than its
   * job can prune it — raise the job's batch-size / max-batches knobs.
   */
  'retention_backlog_remaining',
] as const;

/**
 * Required discriminator on every `captureMessage`. A string-literal union
 * rather than `string` so `tsc` — not a lint, not review — is what rejects an
 * unregistered or interpolated code.
 */
export type SentryEventCode = (typeof SENTRY_EVENT_CODES)[number];

const REGISTERED_EVENT_CODES: ReadonlySet<string> = new Set(SENTRY_EVENT_CODES);

/**
 * Runtime backstop for the type. Compiled JS, `any`-typed test doubles and
 * `ee/` extensions can all reach `captureMessage` without `tsc` having checked
 * the argument, and an unbounded value here would defeat the grouping this
 * whole mechanism exists to provide.
 */
export function isRegisteredSentryEventCode(value: unknown): value is SentryEventCode {
  return typeof value === 'string' && REGISTERED_EVENT_CODES.has(value);
}
