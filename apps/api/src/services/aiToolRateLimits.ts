/**
 * Per-tool AI/MCP rate-limit multiplier (#6476).
 *
 * `TOOL_RATE_LIMITS` (services/aiGuardrails.ts) is the brake on a runaway
 * model: `run_script` 5 per 5 min, `network_discovery` 2 per 10 min, and so
 * on. A weaker self-hosted model retries and re-plans more than Claude does, so
 * it hits those buckets first. The only knob exposed is one scalar,
 * `toolRateLimitMultiplier` (integer 1–10, default 1), stored with the AI
 * budget settings (`ai_budgets.tool_rate_limit_multiplier` + partner
 * `settings.aiBudgets.toolRateLimitMultiplier`) and merged by the existing
 * partner-wins rule in services/effectiveSettings.ts.
 *
 * Invariant: the multiplier can only RAISE a limit. Anything that is not an
 * integer in [1, 10] is treated as 1, so a bad stored value tightens back to
 * the shipped limits rather than loosening or removing them.
 *
 * The Redis counter stays keyed per user per tool (`ai:tool:<user>:<tool>`)
 * across orgs; the org of the CURRENT call picks the multiplier. A user who
 * works in two orgs with different multipliers shares one counter, and each
 * call is judged against its own org's ceiling.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, withSystemDbAccessContext } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { partners } from '../db/schema/orgs';
import { getEffectiveAiBudget } from './effectiveSettings';

export const TOOL_RATE_LIMIT_MULTIPLIER_MIN = 1;
export const TOOL_RATE_LIMIT_MULTIPLIER_MAX = 10;
export const TOOL_RATE_LIMIT_MULTIPLIER_DEFAULT = 1;

/**
 * Write-side validation for both homes (org PUT /ai/budget, partner PATCH
 * settings.aiBudgets). Out-of-range is REJECTED (400), never clamped, so a
 * caller is told their value did not take.
 */
export const toolRateLimitMultiplierSchema = z
  .number()
  .int()
  .min(TOOL_RATE_LIMIT_MULTIPLIER_MIN)
  .max(TOOL_RATE_LIMIT_MULTIPLIER_MAX);

// Per-tool rate limits: { limit, windowSeconds }
export const TOOL_RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  execute_command: { limit: 10, windowSeconds: 300 },
  run_script: { limit: 5, windowSeconds: 300 },
  // Deliberately looser than run_script: a stop is the safe direction, and a
  // rate limit that blocks a tech's assistant from halting a runaway script is
  // worse than the burst it prevents.
  cancel_script_execution: { limit: 20, windowSeconds: 300 },
  security_scan: { limit: 3, windowSeconds: 600 },
  network_discovery: { limit: 2, windowSeconds: 600 },
  file_operations: { limit: 20, windowSeconds: 300 },
  manage_services: { limit: 10, windowSeconds: 300 },
  s1_isolate_device: { limit: 5, windowSeconds: 600 },
  s1_threat_action: { limit: 5, windowSeconds: 600 },
  analyze_disk_usage: { limit: 10, windowSeconds: 300 },
  disk_cleanup: { limit: 3, windowSeconds: 600 },
  // Per TOOL, not per action (checkToolRateLimit keys on the tool name), and
  // `run` returns immediately while the model polls `status` on this same
  // counter — spec §9.1's "2 per hour" would exhaust after the first poll and
  // lock the model out of the run it just started. 30/h leaves room for a
  // catalog, a run and a poll every few minutes. The safety on `run` is the
  // Tier 3 supervised approval; the single-run-per-device claim in
  // startSystemCleanupRun refuses a second run while one is in flight.
  system_cleanup: { limit: 30, windowSeconds: 3600 },
  manage_startup_items: { limit: 5, windowSeconds: 600 },
  manage_scheduled_tasks: { limit: 10, windowSeconds: 300 },
  take_screenshot: { limit: 10, windowSeconds: 300 },
  analyze_screen: { limit: 10, windowSeconds: 300 },
  computer_control: { limit: 20, windowSeconds: 300 },
  // Fleet tools — per-tool rate limits
  manage_deployments: { limit: 10, windowSeconds: 600 },
  manage_patches: { limit: 15, windowSeconds: 300 },
  manage_groups: { limit: 20, windowSeconds: 300 },
  manage_maintenance_windows: { limit: 15, windowSeconds: 300 },
  manage_automations: { limit: 10, windowSeconds: 600 },
  manage_alert_rules: { limit: 15, windowSeconds: 300 },
  manage_service_monitors: { limit: 15, windowSeconds: 300 },
  generate_report: { limit: 10, windowSeconds: 300 },
  // Brain device context tools
  set_device_context: { limit: 20, windowSeconds: 300 },
  resolve_device_context: { limit: 20, windowSeconds: 300 },
  // Event log tools
  search_logs: { limit: 30, windowSeconds: 300 },
  get_log_trends: { limit: 20, windowSeconds: 300 },
  detect_log_correlations: { limit: 10, windowSeconds: 300 },
  // One export is a full table scan's worth of work — far below search_logs'
  // 30/5min on purpose.
  export_dataset: { limit: 5, windowSeconds: 300 },
  // Agent log tools
  set_agent_log_level: { limit: 5, windowSeconds: 600 },
  capture_agent_pprof: { limit: 3, windowSeconds: 600 },
  // Configuration policy tools
  get_configuration_policy: { limit: 30, windowSeconds: 300 },
  manage_configuration_policy: { limit: 20, windowSeconds: 300 },
  configuration_policy_compliance: { limit: 30, windowSeconds: 300 },
  apply_configuration_policy: { limit: 10, windowSeconds: 300 },
  remove_configuration_policy_assignment: { limit: 10, windowSeconds: 300 },
  // Playbook tools
  execute_playbook: { limit: 5, windowSeconds: 600 },
  manage_processes: { limit: 15, windowSeconds: 300 },
  // Tags and registry tools
  manage_tags: { limit: 20, windowSeconds: 300 },
  registry_operations: { limit: 15, windowSeconds: 300 },
  // Backup tools
  trigger_backup: { limit: 5, windowSeconds: 600 },
  restore_snapshot: { limit: 3, windowSeconds: 600 },
  restore_as_vm: { limit: 3, windowSeconds: 900 },
  instant_boot_vm: { limit: 3, windowSeconds: 900 },
  trigger_mssql_backup: { limit: 5, windowSeconds: 600 },
  restore_mssql_database: { limit: 3, windowSeconds: 900 },
  verify_mssql_backup: { limit: 5, windowSeconds: 600 },
  manage_hyperv_vm: { limit: 10, windowSeconds: 300 },
  trigger_hyperv_backup: { limit: 5, windowSeconds: 900 },
  restore_hyperv_vm: { limit: 3, windowSeconds: 900 },
  manage_hyperv_checkpoints: { limit: 5, windowSeconds: 600 },
  trigger_vault_sync: { limit: 10, windowSeconds: 600 },
  configure_vault: { limit: 10, windowSeconds: 300 },
  trigger_c2c_sync: { limit: 10, windowSeconds: 300 },
  restore_c2c_items: { limit: 5, windowSeconds: 600 },
  configure_backup_sla: { limit: 10, windowSeconds: 300 },
  execute_dr_plan: { limit: 3, windowSeconds: 900 },
  manage_dr_plan: { limit: 10, windowSeconds: 300 },
  // Monitoring tools
  query_monitors: { limit: 30, windowSeconds: 300 },
  manage_monitors: { limit: 10, windowSeconds: 300 },
  get_service_monitoring_status: { limit: 30, windowSeconds: 300 },
  // Integration & webhook tools
  test_webhook: { limit: 5, windowSeconds: 300 },
  // AI agent governance — a grant is a rare, deliberate act.
  manage_ai_agents: { limit: 5, windowSeconds: 3600 },
  // Agent version & remote session tools
  trigger_agent_upgrade: { limit: 5, windowSeconds: 600 },
  trigger_agent_restart: { limit: 5, windowSeconds: 600 },
  create_remote_session: { limit: 10, windowSeconds: 300 },
  // Notification channel & saved filter tools
  manage_delivery: { limit: 10, windowSeconds: 300 },
  manage_notification_channels: { limit: 10, windowSeconds: 300 },
  manage_saved_filters: { limit: 15, windowSeconds: 300 },
  // CIS hardening tools
  get_cis_compliance: { limit: 30, windowSeconds: 300 },
  get_cis_device_report: { limit: 30, windowSeconds: 300 },
  apply_cis_remediation: { limit: 10, windowSeconds: 600 },
  // Huntress integration tools
  sync_huntress_data: { limit: 10, windowSeconds: 300 },
  // User risk tools
  assign_security_training: { limit: 10, windowSeconds: 300 },
  // Registration-debt payoff: rate limits for newly-permissioned tools.
  execute_containment: { limit: 5, windowSeconds: 600 },       // mirrors s1_isolate_device
  collect_evidence: { limit: 10, windowSeconds: 300 },          // mirrors take_screenshot-class dispatch
  remediate_software_violation: { limit: 10, windowSeconds: 600 }, // mirrors apply_cis_remediation
};

/**
 * Clamp-free validation: an integer in [1, 10] passes through; anything else
 * (0, negatives, 11+, fractions, strings, null) becomes 1. Missing
 * (undefined/null) is the normal "not configured" case and is silent; any
 * other invalid value is logged, because it means a stored setting bypassed
 * the write-side validation.
 */
export function normalizeToolRateLimitMultiplier(value: unknown, source = 'unknown'): number {
  if (value === undefined || value === null) return TOOL_RATE_LIMIT_MULTIPLIER_DEFAULT;
  if (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= TOOL_RATE_LIMIT_MULTIPLIER_MIN
    && value <= TOOL_RATE_LIMIT_MULTIPLIER_MAX
  ) {
    return value;
  }
  console.warn(
    `[aiToolRateLimits] Ignoring invalid toolRateLimitMultiplier ${JSON.stringify(value)} from ${source}; `
    + `using ${TOOL_RATE_LIMIT_MULTIPLIER_DEFAULT} (valid range ${TOOL_RATE_LIMIT_MULTIPLIER_MIN}-${TOOL_RATE_LIMIT_MULTIPLIER_MAX}).`,
  );
  return TOOL_RATE_LIMIT_MULTIPLIER_DEFAULT;
}

/**
 * The limit actually enforced for a shipped `baseLimit`: ceil(base × m).
 * Re-normalizes `multiplier` so no caller can pass a value that lowers the
 * limit, and floors at `baseLimit` as a second guard.
 */
export function scaleToolRateLimit(baseLimit: number, multiplier: number): number {
  const m = normalizeToolRateLimitMultiplier(multiplier, 'scaleToolRateLimit');
  return Math.max(baseLimit, Math.ceil(baseLimit * m));
}

export interface ToolRateLimitScope {
  /** The org the current call runs in (chat session org / MCP API key org). */
  orgId: string | null;
  /**
   * Fallback when there is no org — a partner-scope MCP caller (OAuth bearer,
   * or an API key with no org). Uses the partner's own `aiBudgets` value.
   */
  partnerId?: string | null;
}

async function readPartnerMultiplier(partnerId: string): Promise<unknown> {
  const row = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .then((rows) => rows[0]),
  );
  const settings = row?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const budgets = (settings as Record<string, unknown>).aiBudgets;
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) return undefined;
  return (budgets as Record<string, unknown>).toolRateLimitMultiplier;
}

/**
 * Effective multiplier for the current call. Never throws: a failed lookup
 * falls back to 1 (the shipped limits), which keeps every limit enforced —
 * failing closed here would instead block every rate-limited tool on a DB blip,
 * a regression against the pre-#6476 behaviour that read no settings at all.
 */
export async function resolveToolRateLimitMultiplier(scope: ToolRateLimitScope): Promise<number> {
  try {
    if (scope.orgId) {
      // Self-context like checkAiRateLimit: the chat tool callback runs outside
      // the request's DB context; inside a request this reuses the ambient one.
      const budget = await withSystemDbAccessContext(() => getEffectiveAiBudget(scope.orgId!));
      return normalizeToolRateLimitMultiplier(budget.toolRateLimitMultiplier, `org ${scope.orgId}`);
    }
    if (scope.partnerId) {
      const raw = await readPartnerMultiplier(scope.partnerId);
      return normalizeToolRateLimitMultiplier(raw, `partner ${scope.partnerId}`);
    }
  } catch (err) {
    console.warn(
      `[aiToolRateLimits] Could not load toolRateLimitMultiplier (org ${scope.orgId ?? '-'}, partner ${scope.partnerId ?? '-'}); `
      + 'enforcing the shipped limits.',
      err,
    );
  }
  return TOOL_RATE_LIMIT_MULTIPLIER_DEFAULT;
}

export interface EffectiveToolRateLimit {
  toolName: string;
  /** The shipped TOOL_RATE_LIMITS value. */
  baseLimit: number;
  /** What checkToolRateLimit enforces under `multiplier`. */
  limit: number;
  windowSeconds: number;
}

/** Every TOOL_RATE_LIMITS entry with the limit enforced under `multiplier`. */
export function listEffectiveToolRateLimits(multiplier: number): EffectiveToolRateLimit[] {
  return Object.entries(TOOL_RATE_LIMITS).map(([toolName, cfg]) => ({
    toolName,
    baseLimit: cfg.limit,
    limit: scaleToolRateLimit(cfg.limit, multiplier),
    windowSeconds: cfg.windowSeconds,
  }));
}
