/**
 * Env vars the API reads that are NOT operator-facing connections (spec §1):
 * tuning knobs, job toggles, rollout flags, test/dev hooks. One phrase each.
 * Names only — nothing here is ever read or displayed by the report.
 * The coverage ratchet (envInventory.test.ts) keeps this list honest: a name
 * that stops appearing in apps/api/src fails the "stale" check.
 */
export const INTERNAL_ENV_VARS: Readonly<Record<string, string>> = {
  // ABUSE_*
  ABUSE_HOSTNAME_INDICATORS: 'abuse heuristic tuning list',
  ABUSE_SCRIPT_INDICATORS: 'abuse heuristic tuning list',
  ABUSE_SIGNAL_OVERRIDES: 'abuse heuristic weight overrides',
  // AGENT_*
  AGENT_BINARY_DIR: 'filesystem path',
  AGENT_EDITION_AUTO_MIGRATE_ENABLED: 'agent edition migration toggle',
  AGENT_LOG_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  AGENT_LOG_RETENTION_DAYS: 'data retention window',
  AGENT_LOG_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  AGENT_ORG_RATE_LIMIT_MAX: 'rate limit knob',
  AGENT_ORG_RATE_LIMIT_PER_DEVICE: 'rate limit knob',
  AGENT_ORG_RATE_LIMIT_PER_MIN: 'rate limit knob',
  AGENT_TOKEN_ROTATION_MAX_AGE_DAYS: 'agent token rotation window',
  // AI_*
  AI_COMPUTE_PRICE_MULTIPLIER: 'AI billing price multiplier',
  AI_TOOL_EVAL_KEY: 'dev script (services/llm/__scripts__)',
  // ALERT_*
  ALERT_WORKER_CHUNK_SIZE: 'worker throughput knob',
  ALERT_WORKER_MAX_DEVICES_PER_RUN: 'worker throughput knob',
  // API_*
  API_KEY_PRELOOKUP_RATE_LIMIT: 'rate limit knob',
  API_KEY_PRELOOKUP_RATE_WINDOW_SECONDS: 'rate limit knob',
  API_PORT: 'listen port',
  // APP_*
  APP_VERSION: 'shown as report.version',
  // AUDIT_*
  AUDIT_CHAIN_ANCHOR_ENABLED: 'audit job kill switch',
  AUDIT_CHAIN_VERIFY_ENABLED: 'audit job toggle',
  AUDIT_CHAIN_VERIFY_MODE: 'audit job mode',
  AUDIT_CHAIN_VERIFY_RESCAN_SLICES: 'audit job tuning',
  AUDIT_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  AUDIT_RETENTION_ENABLED: 'audit job toggle',
  AUDIT_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // AUTH_*
  AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED: 'auth rollout switch',
  AUTH_COOKIE_FORCE_SECURE: 'cookie policy override',
  AUTH_COOKIE_SAME_SITE: 'cookie policy override',
  AUTH_LEGACY_INVITE_PREVIEW_PATH: 'legacy route toggle',
  AUTH_REFRESH_RATE_LIMIT: 'rate limit knob',
  AUTH_REFRESH_RATE_WINDOW_SECONDS: 'rate limit knob',
  AUTH_TRANSITION_TEST_CONTROL_SECRET: 'test-only barrier secret',
  // AUTOMATION_*
  AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET: 'legacy compatibility toggle',
  AUTOMATION_WEBHOOK_ALLOW_LOCAL_REPLAY_FALLBACK: 'legacy compatibility toggle',
  // AUTO_*
  AUTO_MIGRATE: 'boot migration toggle',
  // BACKUP_*
  BACKUP_BASE_LEASE_MS: 'timing knob',
  BACKUP_BINARY_DIR: 'filesystem path',
  BACKUP_CRITICAL_DEVICE_TAGS: 'backup criticality tuning',
  BACKUP_GC_GRACE_MS: 'timing knob',
  BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS: 'timing knob',
  BACKUP_GC_MAX_DELETES_PER_RUN: 'worker throughput knob',
  BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS: 'timing knob',
  BACKUP_PUBLISH_MARGIN_MS: 'timing knob',
  BACKUP_RESTORE_PIN_LINGER_MS: 'timing knob',
  // BINARY_*
  BINARY_CHECKSUM_MANIFEST: 'binary checksum manifest override',
  BINARY_VERSION_FILE: 'build metadata path',
  // BMR_*
  BMR_RECOVERY_ADVERTISE_QUERY_TOKEN: 'recovery compatibility toggle',
  BMR_RECOVERY_ALLOW_QUERY_TOKEN: 'recovery compatibility toggle',
  // BREEZE_*
  BREEZE_ALLOW_UNSAFE_DB_ROLE: 'non-production safety opt-out',
  BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'one-time first-boot seed',
  BREEZE_BOOTSTRAP_ADMIN_NAME: 'one-time first-boot seed',
  BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'one-time first-boot seed',
  BREEZE_BUILTIN_MONITORS_AUTOSEED: 'seed toggle',
  BREEZE_INTEGRATION_ALLOW_LEDGER_DRIFT: 'test harness (testUtils)',
  BREEZE_INTEGRATION_LOCK_NOWAIT: 'test harness (testUtils)',
  BREEZE_LEGACY_ALERTING_SWEEP: 'boot sweep opt-out (legacy alerting retirement)',
  BREEZE_PLATFORM_ADMINS: 'platform-admin bootstrap list',
  BREEZE_REGION: 'hosted topology label',
  BREEZE_ROLE: 'process role (api/worker)',
  BREEZE_SEED_E2E_FORCE: 'E2E seed toggle',
  BREEZE_TEST_DB_URL: 'test harness (testUtils)',
  BREEZE_UPGRADE_PREFLIGHT_STRICT: 'upgrade CLI flag',
  // CALLER_*
  CALLER_VERIFICATION_ENABLED: 'feature flag',
  // CANCEL_*
  CANCEL_GRACE_MS: 'timing knob',
  // CHANGE_*
  CHANGE_INGEST_MAX_BODY_BYTES: 'ingest size limit',
  CHANGE_INGEST_MAX_DECOMPRESSED_BYTES: 'ingest size limit',
  CHANGE_INGEST_MAX_ITEMS: 'ingest size limit',
  CHANGE_LOG_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  CHANGE_LOG_RETENTION_DAYS: 'data retention window',
  CHANGE_LOG_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // CHILD_*
  CHILD_ENROLLMENT_KEY_TTL_MINUTES: 'timing knob',
  // CLAUDE_*
  CLAUDE_AGENT_SDK_CLIENT_APP: 'SDK child-process label',
  // COOKIE_*
  COOKIE_FORCE_SECURE: 'cookie policy override',
  COOKIE_SAME_SITE: 'cookie policy override',
  // CSP_*
  CSP_ALLOW_UNSAFE_INLINE: 'CSP tuning',
  CSP_CONNECT_HOSTS: 'CSP tuning',
  // DB_*
  DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: 'database pool/watchdog tuning',
  DB_CONTEXTLESS_WRITE_STRICT: 'database pool/watchdog tuning',
  DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS: 'database pool/watchdog tuning',
  DB_CONTEXT_HELD_WARN_MS: 'database pool/watchdog tuning',
  DB_CONTEXT_TRIPWIRE_STRICT: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_CAPTURE_THROTTLE_MS: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_DISABLED: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_INTERVAL_MS: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_MIN_TIMEOUTS: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_PROBE_TIMEOUT_MS: 'database pool/watchdog tuning',
  DB_POOL_HEALTH_WINDOW_MS: 'database pool/watchdog tuning',
  DB_POOL_MAX: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_CONFIRM_DELAY_MS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_MIN_AGE_MS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_RECLAIM_DISABLED: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_RECLAIM_MAX_PER_PASS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_RECLAIM_TIMEOUT_MS: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_SCANNER_RECLAIM_DISABLED: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_SCAN_DISABLED: 'database pool/watchdog tuning',
  DB_WEDGED_BACKEND_SCAN_INTERVAL_MS: 'database pool/watchdog tuning',
  // DEPLOYMENT_*
  DEPLOYMENT_ENV: 'hosted topology label',
  // DEVICE_*
  DEVICE_COMMAND_QUEUE_LIVE_ONLY_TTL_MINUTES: 'timing knob',
  DEVICE_COMMAND_QUEUE_POWER_STATE_TTL_HOURS: 'timing knob',
  DEVICE_COMMAND_QUEUE_SHORT_TTL_HOURS: 'timing knob',
  DEVICE_COMMAND_QUEUE_TTL_HOURS: 'timing knob',
  DEVICE_METRICS_RETENTION_DAYS: 'data retention window',
  DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS: 'timing knob',
  // DEV_*
  DEV_PUSH_ENABLED: 'developer agent push toggle',
  DEV_PUSH_WORK_DIR: 'filesystem path',
  // E2E_*
  E2E_MODE: 'E2E test mode',
  // EMAIL_*
  EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE: 'sending-domain policy knob',
  EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS: 'sending-domain policy knob',
  EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES: 'sending-domain policy knob',
  EMAIL_DOMAINS_DAILY_SEND_CAP: 'sending-domain policy knob',
  EMAIL_DOMAINS_DENYLIST: 'sending-domain policy knob',
  EMAIL_DOMAINS_MAX_PER_PARTNER: 'sending-domain policy knob',
  EMAIL_DOMAINS_PARTNER_ALLOWLIST: 'sending-domain policy knob',
  // ENABLE_*
  ENABLE_2FA: 'auth policy flag',
  ENABLE_AAD_V3: 'crypto format rollout flag',
  ENABLE_AI_PATCH_TESTING: 'feature flag',
  ENABLE_API_DOCS_UI: 'feature flag',
  ENABLE_REGISTRATION: 'signup policy flag',
  ENABLE_TOOL_SEARCH: 'dev script (services/llm/__scripts__)',
  // ENROLLMENT_*
  ENROLLMENT_KEY_CLEANUP_ENABLED: 'cleanup job toggle',
  ENROLLMENT_KEY_DEFAULT_TTL_MINUTES: 'timing knob',
  ENROLLMENT_KEY_PURGE_AFTER_DAYS: 'data retention window',
  // EVENT_*
  EVENT_DISPATCH_MODE: 'event bus mode',
  EVENT_DISPATCH_QUEUE_SUBSCRIBERS: 'event bus routing',
  EVENT_LOG_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  EVENT_LOG_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  EVENT_LOOP_MONITOR_DISABLED: 'event-loop monitor toggle',
  EVENT_LOOP_MONITOR_INTERVAL_MS: 'event-loop monitor tuning',
  EVENT_LOOP_STARVATION_THROTTLE_MS: 'event-loop monitor tuning',
  EVENT_LOOP_STARVATION_WARN_MS: 'event-loop monitor tuning',
  EVENT_PERMISSION_EPOCH_MODE: 'event bus mode',
  // EVIDENCE_*
  EVIDENCE_STORAGE_ALLOWED_SCHEMES: 'validation allowlist',
  // EXCHANGE_*
  EXCHANGE_RATE_SYNC_ENABLED: 'job toggle',
  // FILESYSTEM_*
  FILESYSTEM_ANALYSIS_AUTO_RESUME_MAX_RUNS: 'agent analysis tuning',
  FILESYSTEM_ANALYSIS_DISK_THRESHOLD: 'agent analysis tuning',
  FILESYSTEM_ANALYSIS_THRESHOLD_COOLDOWN_MINUTES: 'timing knob',
  FILESYSTEM_CLEANUP_PLAN_RETENTION_DAYS: 'data retention window',
  FILESYSTEM_CLEANUP_PREVIEW_RETENTION_DAYS: 'data retention window',
  FILESYSTEM_CLEANUP_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  FILESYSTEM_CLEANUP_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // FRANKFURTER_*
  FRANKFURTER_BASE_URL: 'FX API base override',
  // HELPER_*
  HELPER_BINARY_DIR: 'filesystem path',
  // HTTPS_*
  HTTPS_PROXY: 'egress proxy passthrough',
  // HTTP_*
  HTTP_PROXY: 'egress proxy passthrough',
  // INBOUND_*
  INBOUND_QUEUE_MAX_PER_SEC: 'rate limit knob',
  // INCIDENT_*
  INCIDENT_CORRELATION_INTERVAL_MS: 'timing knob',
  INCIDENT_SLA_MONITOR_INTERVAL_MS: 'timing knob',
  INCIDENT_SLA_P1_MINUTES: 'incident SLA tuning',
  INCIDENT_SLA_P2_MINUTES: 'incident SLA tuning',
  INCIDENT_TIMELINE_ENRICH_INTERVAL_MS: 'timing knob',
  // INSTALLER_*
  INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES: 'timing knob',
  INSTALLER_PARENT_MIN_REMAINING_SECONDS: 'timing knob',
  // INTENT_*
  INTENT_OUTBOX_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  INTENT_OUTBOX_RETENTION_DAYS: 'data retention window',
  INTENT_OUTBOX_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // IP_*
  IP_ALLOWLIST_ENFORCEMENT_MODE: 'enforcement mode',
  IP_HISTORY_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  IP_HISTORY_RETENTION_DAYS: 'data retention window',
  IP_HISTORY_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // IS_*
  IS_HOSTED: 'shown as report.deployMode',
  // LLM_*
  LLM_FIDELITY_API_KEY: 'dev script (services/llm/__scripts__)',
  LLM_FIDELITY_AUTH_MODE: 'dev script (services/llm/__scripts__)',
  LLM_FIDELITY_BASE_URL: 'dev script (services/llm/__scripts__)',
  LLM_FIDELITY_PROVIDER_MODEL: 'dev script (services/llm/__scripts__)',
  // LOGIN_*
  LOGIN_ACCOUNT_LOCKOUT_MAX: 'rate limit knob',
  LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS: 'rate limit knob',
  // LOG_*
  LOG_LEVEL: 'logging verbosity',
  // M365_*
  M365_SYNC_CONCURRENCY: 'worker throughput knob',
  M365_SYNC_MAX_BACKLOG: 'worker throughput knob',
  M365_SYNC_TICK_BATCH: 'worker throughput knob',
  // MACOS_*
  MACOS_INSTALLER_ALLOW_LEGACY_GET_BOOTSTRAP: 'legacy compatibility toggle',
  // MAILGUN_*
  // MANAGED_*
  MANAGED_SOFTWARE_POLICY_MODE: 'enforcement mode',
  // MAX_*
  MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG: 'rate limit knob',
  MAX_ACTIVE_REMOTE_SESSIONS_PER_USER: 'rate limit knob',
  // MCP_*
  MCP_EXECUTE_TOOL_ALLOWLIST: 'MCP tool policy',
  MCP_MAX_SSE_SESSIONS_PER_KEY: 'rate limit knob',
  MCP_MESSAGE_MAX_BODY_BYTES: 'request size limit',
  MCP_MESSAGE_RATE_LIMIT_PER_MINUTE: 'rate limit knob',
  MCP_REQUIRE_EXECUTE_ADMIN: 'MCP tool policy',
  MCP_SESSION_TTL_SECONDS: 'timing knob',
  MCP_SSE_RATE_LIMIT_PER_MINUTE: 'rate limit knob',
  MCP_UNATTENDED_TIER3_PRINCIPALS: 'MCP tool policy',
  MCP_TOOLS_LIST_PAGE_SIZE: 'paging knob',
  MCP_UNKNOWN_SESSION_ALERT_THRESHOLD: 'alert threshold',
  // METRICS_*
  METRICS_ACTIVE_DEVICE_WINDOW_SECONDS: 'timing knob',
  METRICS_FLEET_GAUGE_TIMEOUT_SECONDS: 'timing knob',
  METRICS_FLEET_GAUGE_TTL_SECONDS: 'timing knob',
  METRICS_INCLUDE_ORG_ID: 'metrics label toggle',
  // METRIC_*
  METRIC_ANOMALY_EPISODE_ASSEMBLY_LOOKBACK_HOURS: 'timing knob',
  METRIC_ANOMALY_EPISODE_CLEAN_BUCKETS: 'anomaly episode tuning',
  METRIC_ANOMALY_EPISODE_EXPIRE_HOURS: 'timing knob',
  METRIC_ANOMALY_EPISODE_GAP_MINUTES: 'timing knob',
  METRIC_ANOMALY_EPISODE_MIN_BUCKETS: 'anomaly episode tuning',
  METRIC_ANOMALY_EPISODE_RECURRENCE_DAYS: 'timing knob',
  METRIC_ANOMALY_EPISODE_SNOOZE_DAYS: 'timing knob',
  METRIC_ANOMALY_INCIDENT_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  METRIC_ANOMALY_INCIDENT_RETENTION_DAYS: 'data retention window',
  METRIC_ANOMALY_INCIDENT_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  METRIC_ROLLUP_5M_RETENTION_DAYS: 'data retention window',
  METRIC_ROLLUP_DAILY_RETENTION_DAYS: 'data retention window',
  METRIC_ROLLUP_DELETE_BATCH_SIZE: 'retention sweep batch knob',
  METRIC_ROLLUP_HOURLY_RETENTION_DAYS: 'data retention window',
  METRIC_ROLLUP_MAINTENANCE_CRON: 'job schedule override',
  METRIC_ROLLUP_MAINTENANCE_ENABLED: 'job toggle',
  METRIC_ROLLUP_MAX_DELETE_BATCHES: 'retention sweep batch knob',
  METRIC_ROLLUP_PARTITION_MONTHS_AHEAD: 'partition maintenance tuning',
  METRIC_ROLLUP_PARTITION_MONTHS_BACK: 'partition maintenance tuning',
  // MFA_*
  MFA_FORCE_FOR_PARTNER_ADMIN: 'auth policy flag',
  // ML_*
  ML_DISABLED_FLAGS: 'ML kill switch',
  ML_FEATURES_DISABLED: 'ML kill switch',
  ML_GLOBAL_KILL_SWITCH: 'ML kill switch',
  ML_OUTPUTS_DISABLED: 'ML kill switch',
  ML_OUTPUT_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  ML_OUTPUT_RETENTION_CRON: 'job schedule override',
  ML_OUTPUT_RETENTION_DAYS: 'data retention window',
  ML_OUTPUT_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // MONITOR_*
  MONITOR_EPISODE_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  MONITOR_EPISODE_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // NODE_*
  NODE_ENV: 'runtime mode',
  // NO_*
  NO_PROXY: 'egress proxy passthrough',
  // OAUTH_*
  OAUTH_AUTH_EPOCH_ENFORCE_AFTER: 'OAuth rollout cutoff',
  OAUTH_CLEANUP_ENABLED: 'cleanup job toggle',
  OAUTH_DEBUG: 'debug logging flag',
  // OFFBOARDING_*
  OFFBOARDING_DRAIN_WINDOW_HOURS: 'timing knob',
  // OFFLINE_*
  OFFLINE_DETECTOR_CHUNK_SIZE: 'worker throughput knob',
  OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN: 'worker throughput knob',
  OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES: 'timing knob',
  OFFLINE_DETECTOR_WORKER_CONCURRENCY: 'worker throughput knob',
  // ORG_*
  ORG_ARCHIVE_DEFAULT_RETENTION_DAYS: 'data retention window',
  ORG_MERGE_FENCE_DRAIN_MS: 'timing knob',
  ORG_MERGE_MAX_ROWS: 'org merge safety limit',
  // PAM_*
  PAM_ACTUATOR_ENABLED: 'feature flag',
  PAM_PENDING_REQUEST_TTL_MINUTES: 'timing knob',
  // PARTNER_*
  PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES: 'timing knob',
  PARTNER_API_ENROLLMENT_KEY_WRITE_PARTNER_RATE_LIMIT: 'rate limit knob',
  PARTNER_API_ENROLLMENT_KEY_WRITE_RATE_LIMIT: 'rate limit knob',
  PARTNER_MEETING_URL: 'partner onboarding copy link',
  PARTNER_TRUST_MODE: 'hosted partner trust mode',
  // PATCH_*
  PATCH_REPORT_STORAGE_PATH: 'filesystem path',
  PATCH_TOMBSTONE_PRUNE_AFTER_HOURS: 'data retention window',
  // PENDING_*
  PENDING_ACCOUNT_MEETING_LABEL: 'partner onboarding copy',
  PENDING_ACCOUNT_MEETING_URL: 'partner onboarding copy link',
  // PERIPHERAL_*
  PERIPHERAL_ANOMALY_BLOCKED_THRESHOLD: 'alert threshold',
  // PORTAL_*
  PORTAL_COOKIE_FORCE_SECURE: 'cookie policy override',
  PORTAL_COOKIE_SAME_SITE: 'cookie policy override',
  PORTAL_STATE_BACKEND: 'portal rate-limit store selector',
  // PROCESS_*
  PROCESS_SAMPLE_RETENTION_DAYS: 'data retention window',
  // PROVISION_*
  PROVISION_HANDLE_TTL_MINUTES: 'timing knob',
  // READINESS_*
  READINESS_CACHE_TTL_MS: 'timing knob',
  READINESS_PROBE_TIMEOUT_MS: 'timing knob',
  // RECORDING_*
  RECORDING_URL_ALLOWED_ORIGINS: 'validation allowlist',
  // RECOVERY_*
  RECOVERY_MEDIA_WORK_DIR: 'filesystem path',
  RECOVERY_MINISIGN_BIN: 'filesystem path',
  // REDIS_MEMORY_*
  REDIS_MEMORY_CAPTURE_THROTTLE_MS: 'timing knob',
  REDIS_MEMORY_MONITOR_DISABLED: 'worker job kill switch',
  REDIS_MEMORY_MONITOR_INTERVAL_MS: 'timing knob',
  REDIS_MEMORY_WARN_RATIO: 'alert threshold tuning',
  // REFRESH_*
  REFRESH_FAMILY_ABSOLUTE_TTL_DAYS: 'timing knob',
  REFRESH_ROTATION_GRACE_SECONDS: 'timing knob',
  // RELIABILITY_*
  RELIABILITY_HISTORY_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  RELIABILITY_HISTORY_RETENTION_DAYS: 'data retention window',
  RELIABILITY_HISTORY_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // REMOTE_*
  REMOTE_ACCESS_ADMISSION_MODE: 'remote access rollout mode',
  REMOTE_DESKTOP_FENCE_REQUIRED: 'remote access rollout flag',
  REMOTE_WS_AUTH_MODE: 'remote access rollout mode',
  REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT: 'remote access rollout marker',
  REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT: 'remote access rollout marker',
  REMOTE_WS_REDIS_TOPOLOGY: 'remote access topology assertion',
  // REMOVED_*
  REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN: 'worker throughput knob',
  // REQUIRE_*
  REQUIRE_DB_ON_STARTUP: 'boot strictness flag',
  REQUIRE_REDIS_ON_STARTUP: 'boot strictness flag',
  // S1_*
  S1_SYNC_MAX_PAGES: 'sync paging limit',
  // S3_*
  S3_PRESIGN_TTL: 'timing knob',
  // SCREENSHOT_*
  SCREENSHOT_STORAGE_DIR: 'filesystem path',
  // SCRIPT_*
  SCRIPT_VERIFY_RECONCILE_MIN_AGE_MINUTES: 'timing knob',
  // SECURITY_*
  SECURITY_POSTURE_ON_DEMAND_DEDUPE_WINDOW_MS: 'timing knob',
  SECURITY_POSTURE_WORKER_CONCURRENCY: 'worker throughput knob',
  SECURITY_SCAN_DEVICE_CONCURRENCY_CAP: 'worker throughput knob',
  SECURITY_SCAN_ORG_CONCURRENCY_CAP: 'worker throughput knob',
  SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT: 'worker throughput knob',
  SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS: 'timing knob',
  SECURITY_SCAN_WORKER_CONCURRENCY: 'worker throughput knob',
  SECURITY_SCORE_CHANGE_EVENT_LIMIT: 'worker throughput knob',
  SECURITY_SCORE_CHANGE_PUBLISH_CONCURRENCY: 'worker throughput knob',
  // SENSITIVE_*
  SENSITIVE_DATA_DEVICE_CONCURRENCY_CAP: 'worker throughput knob',
  SENSITIVE_DATA_ORG_CONCURRENCY_CAP: 'worker throughput knob',
  SENSITIVE_DATA_ORG_QUEUE_BACKPRESSURE_LIMIT: 'worker throughput knob',
  SENSITIVE_DATA_REQUIRE_SECOND_APPROVAL: 'approval policy flag',
  SENSITIVE_DATA_SECOND_APPROVAL_TOKEN: 'approval policy secret (names only)',
  SENSITIVE_DATA_THROTTLE_REQUEUE_SECONDS: 'timing knob',
  SENSITIVE_DATA_WORKER_CONCURRENCY: 'worker throughput knob',
  // SERVICE_*
  SERVICE_PROCESS_CHECK_RESULTS_RETENTION_DAYS: 'data retention window',
  // SHUTDOWN_*
  SHUTDOWN_DRAIN_MS: 'timing knob',
  // SIGNUP_*
  SIGNUP_ALLOWED_EMAIL_DOMAINS: 'signup policy list',
  SIGNUP_BUSINESS_EMAIL_CONTACT_URL: 'signup policy copy link',
  SIGNUP_EXTRA_CONSUMER_EMAIL_DOMAINS: 'signup policy list',
  SIGNUP_REQUIRE_BUSINESS_EMAIL: 'signup policy flag',
  // SMTP_*
  // SNMP_*
  SNMP_METRICS_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  SNMP_METRICS_RETENTION_DAYS: 'data retention window',
  SNMP_METRICS_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // SOFTWARE_*
  SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS: 'remediation retry limit',
  SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS: 'worker throughput knob',
  SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED: 'cleanup job toggle',
  SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS: 'data retention window',
  SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED: 'cleanup job toggle',
  SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS: 'timing knob',
  SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS: 'timing knob',
  // SSO_*
  SSO_DOMAIN_VERIFICATION_STRICT: 'SSO policy flag',
  // STALE_*
  STALE_REAPER_MAX_PER_RUN: 'worker throughput knob',
  // SYNTHETIC_*
  SYNTHETIC_TEST_IP_ALLOWLIST: 'synthetic monitor access',
  SYNTHETIC_TEST_TOKEN: 'synthetic monitor secret (names only)',
  // TD_*
  TD_SYNNEX_DIGITAL_BRIDGE_TIMEOUT_MS: 'timing knob',
  // TICKET_*
  TICKET_OUTBOX_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  TICKET_OUTBOX_RETENTION_DAYS: 'data retention window',
  TICKET_OUTBOX_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  // TOPOLOGY_*
  TOPOLOGY_DISABLED: 'feature kill switch',
  // TRUST_*
  TRUST_ACTION_TOKEN_SECRET: 'hosted partner-trust secret (names only)',
  // TURN_*
  TURN_CREDENTIAL_TTL_SECONDS: 'timing knob',
  // UNINSTALL_*
  UNINSTALL_INTENT_DECOMMISSION_HOURS: 'timing knob',
  UNINSTALL_INTENT_REAP_CHUNK_SIZE: 'worker throughput knob',
  UNINSTALL_INTENT_REAP_INTERVAL_MS: 'timing knob',
  UNINSTALL_INTENT_REAP_MAX_DEVICES_PER_RUN: 'worker throughput knob',
  // USER_*
  USER_RISK_ON_DEMAND_DEDUPE_WINDOW_MS: 'timing knob',
  USER_RISK_RETENTION_BATCH_SIZE: 'retention sweep batch knob',
  USER_RISK_RETENTION_CRON: 'job schedule override',
  USER_RISK_RETENTION_DAYS: 'data retention window',
  USER_RISK_RETENTION_MAX_BATCHES: 'retention sweep batch knob',
  USER_RISK_SCAN_CRON: 'job schedule override',
  USER_RISK_TRAINING_DEDUP_HOURS: 'timing knob',
  USER_RISK_WORKER_CONCURRENCY: 'worker throughput knob',
  // VIEWER_*
  VIEWER_BINARY_DIR: 'filesystem path',
  // WINGET_*
  WINGET_BOOTSTRAP_ARTIFACT_DIR: 'filesystem path',
  // WIN_*
  WIN_TEST_VM_SSH_KEY: 'AI patch-test lab VM',
  WIN_TEST_VM_TARGET: 'AI patch-test lab VM',
  // WORKSPACE_*
  WORKSPACE_CONTENT_LLM_MODEL: 'model override',
  // WS_*
  WS_TICKETS_REQUIRE_REDIS: 'remote access strictness flag',
  WS_TICKET_BIND_IP: 'remote access ticket binding flag',
};
