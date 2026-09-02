import type { MiddlewareHandler } from 'hono';
import { partnerTrustMode } from '../config/partnerTrustMode';
import type { PartnerTrustState } from '../db/schema/orgs';
import { ANONYMOUS_ACTOR_ID } from './auditEvents';
import { createAuditLog } from './auditService';
import { partnerForDevice, readTrust, writeTrust } from './partnerTrust.repo';

export type GatedCapability = 'remote_control' | 'device_execute' | 'installer_distribute' | 'agent_enroll';
export type TrustDenyCode = 'TRUST_PROBATION' | 'TRUST_RESTRICTED';
export type GateDecision =
  | { allow: true; shadowDenied?: { code: TrustDenyCode; reason: string } }
  | { allow: false; code: TrustDenyCode; capability: GatedCapability; reason: string };
export interface GateContext {
  partnerId: string;
  deviceId?: string;
  orgId?: string;
  userId?: string;
  commandType?: string;
  detail?: Record<string, unknown>;
}

export const PROBATION_ENROLLMENT_CAP = 5;

/** Lifecycle commands are platform-driven and carry no operator-chosen content,
 * target, credential, or binary. Anything else is gated; unknown types fail closed. */
export const LIFECYCLE_COMMAND_TYPES = [
  'agent_rollback_v1',
  'backup_stop',
  'desktop_stream_stop',
  'patch_scan',
  // Lifecycle: cleanup only removes privilege; it does not grant or actuate it.
  'pam_cleanup_v2',
  'refresh_inventory',
  'restart_agent',
  'security_collect_status',
  'self_uninstall',
  'stop_desktop',
  'support_end',
  'terminal_stop',
  'tunnel_close',
  'update_agent',
  'update_watchdog',
  'wake_on_lan',
] as const;

/** Complete inventory of known non-lifecycle command types. Membership is
 * documented and checked by the allowlist test; runtime fails closed. */
export const GATED_COMMAND_TYPES = [
  'actuate_elevation',
  'apply_browser_policy',
  'apply_audit_policy_baseline',
  'apply_cis_remediation',
  'backup_cleanup',
  'backup_list',
  'backup_restore',
  'backup_run',
  'backup_test_restore',
  'backup_verify',
  'bmr_recover',
  'capture_pprof',
  'cancel_reboot',
  'cis_benchmark',
  'collect_audit_policy',
  'collect_boot_performance',
  'collect_evidence',
  'collect_reliability_metrics',
  'collect_software',
  'computer_action',
  'desktop_config',
  'desktop_input',
  'desktop_stream_start',
  'dev_update',
  'download_patches',
  'encrypt_file',
  'encryption_collect_keys',
  'encryption_rotate_key',
  'event_log_get',
  'event_logs_list',
  'event_logs_query',
  'execute_containment',
  'file_copy',
  'file_delete',
  'file_list',
  'file_list_drives',
  'file_mkdir',
  'file_read',
  'file_rename',
  'file_trash_list',
  'file_trash_purge',
  'file_trash_restore',
  'file_write',
  'filesystem_analysis',
  'get_process',
  'get_reboot_status',
  'get_service',
  'hardware_profile',
  'homebrew_bootstrap',
  'hyperv_backup',
  'hyperv_checkpoint',
  'hyperv_discover',
  'hyperv_restore',
  'hyperv_vm_state',
  'http_request',
  'install_patches',
  'kill_process',
  'list_processes',
  'list_services',
  'list_sessions',
  'lock',
  'manage_startup_item',
  'mssql_backup',
  'mssql_discover',
  'mssql_restore',
  'mssql_verify',
  'network_discovery',
  'network_dns_check',
  'network_http_check',
  'network_ping',
  'network_tcp_check',
  'notify_user',
  'pam_apply_v2',
  'peripheral_policy_sync',
  'peripheral_policy_sync_v2',
  'quarantine_file',
  'reboot',
  'reboot_safe_mode',
  'registry_delete',
  'registry_get',
  'registry_key_create',
  'registry_key_delete',
  'registry_keys',
  'registry_set',
  'registry_values',
  'restart_service',
  'rollback_patches',
  'run_script',
  'schedule_reboot',
  'script',
  'script_cancel',
  'script_list_running',
  'secure_delete_file',
  'security_scan',
  'security_threat_quarantine',
  'security_threat_remove',
  'security_threat_restore',
  'sensitive_data_scan',
  'set_auto_update',
  'set_log_level',
  'shutdown',
  'snmp_poll',
  'software_install',
  'software_uninstall',
  'software_update',
  'start_desktop',
  'start_service',
  'stop_service',
  'system_state_collect',
  'take_screenshot',
  'task_disable',
  'task_enable',
  'task_get',
  'task_history',
  'task_run',
  'tasks_list',
  'terminal_data',
  'terminal_resize',
  'terminal_start',
  'tunnel_data',
  'tunnel_open',
  'tray_update',
  'update',
  'vault_configure',
  'vault_status',
  'vault_sync',
  'vm_instant_boot',
  'vm_restore_estimate',
  'vm_restore_from_backup',
  'vss_status',
  'vss_writer_list',
] as const;

const lifecycle = new Set<string>(LIFECYCLE_COMMAND_TYPES);
export function isLifecycleCommand(type: string): boolean {
  return lifecycle.has(type);
}

export async function partnerIdForDevice(deviceId: string): Promise<string | null> {
  return partnerForDevice(deviceId);
}

export async function loadTrustState(partnerId: string): Promise<{
  trustState: PartnerTrustState;
  probationEnrollments: number;
} | null> {
  return readTrust(partnerId);
}

function decide(
  cap: GatedCapability,
  row: { trustState: PartnerTrustState; probationEnrollments: number },
  ctx: GateContext,
): { code: TrustDenyCode; reason: string } | null {
  if (row.trustState === 'trusted') return null;
  const code: TrustDenyCode = row.trustState === 'restricted' ? 'TRUST_RESTRICTED' : 'TRUST_PROBATION';
  switch (cap) {
    case 'agent_enroll': {
      if (row.trustState === 'restricted') return { code, reason: 'restricted' };
      const enrollmentCount = typeof ctx.detail?.probationEnrollments === 'number'
        ? ctx.detail.probationEnrollments
        : row.probationEnrollments;
      return enrollmentCount >= PROBATION_ENROLLMENT_CAP
        ? { code, reason: 'probation_enrollment_cap' }
        : null;
    }
    case 'device_execute':
      if (ctx.commandType && isLifecycleCommand(ctx.commandType)) return null;
      return { code, reason: row.trustState === 'restricted' ? 'restricted' : 'probation_default_deny' };
    default:
      return { code, reason: row.trustState === 'restricted' ? 'restricted' : 'probation_default_deny' };
  }
}

export async function evaluateCapability(cap: GatedCapability, ctx: GateContext): Promise<GateDecision> {
  const mode = partnerTrustMode();
  if (mode === 'off') return { allow: true };
  const row = await readTrust(ctx.partnerId);
  if (!row) return { allow: true };
  const denial = decide(cap, row, ctx);
  if (!denial) return { allow: true };
  await createAuditLog({
    orgId: ctx.orgId ?? null,
    actorType: ctx.userId ? 'user' : 'system',
    actorId: ctx.userId ?? ANONYMOUS_ACTOR_ID,
    action: 'partner.trust.capability_denied',
    resourceType: 'partner',
    resourceId: ctx.partnerId,
    result: mode === 'enforce' ? 'denied' : 'success',
    details: {
      mode,
      capability: cap,
      code: denial.code,
      reason: denial.reason,
      deviceId: ctx.deviceId ?? null,
      commandType: ctx.commandType ?? null,
      probationEnrollments: typeof ctx.detail?.probationEnrollments === 'number'
        ? ctx.detail.probationEnrollments
        : null,
      stage: typeof ctx.detail?.stage === 'string' ? ctx.detail.stage : null,
      via: typeof ctx.detail?.via === 'string' ? ctx.detail.via : null,
    },
  });
  if (mode === 'shadow') return { allow: true, shadowDenied: denial };
  return { allow: false, code: denial.code, capability: cap, reason: denial.reason };
}

export function trustDenyBody(d: Extract<GateDecision, { allow: false }>, reviewRequested: boolean) {
  return {
    error: d.code,
    capability: d.capability,
    reason: d.reason,
    reviewRequested,
    meetingUrl: process.env.PARTNER_MEETING_URL ?? null,
  };
}

/** Route-level convenience: friendly early 403. The chokepoints remain the control. */
export function requireCapability(cap: GatedCapability): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) return next();
    const d = await evaluateCapability(cap, {
      partnerId: auth.partnerId,
      userId: auth.user?.id,
      orgId: auth.orgId ?? undefined,
    });
    if (!d.allow) {
      const row = await readTrust(auth.partnerId);
      return c.json(trustDenyBody(d, !!row?.trustReviewRequestedAt), 403);
    }
    return next();
  };
}

export async function setTrustState(
  partnerId: string,
  next: PartnerTrustState,
  reason: string,
  actorUserId: string | null,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  const before = await readTrust(partnerId);
  await writeTrust(partnerId, next, reason, actorUserId);
  await createAuditLog({
    orgId: null,
    actorType: actorUserId ? 'user' : 'system',
    actorId: actorUserId ?? ANONYMOUS_ACTOR_ID,
    action: next === 'trusted'
      ? 'partner.trust.promoted'
      : next === 'restricted'
        ? 'partner.trust.restricted'
        : 'partner.trust.probation',
    resourceType: 'partner',
    resourceId: partnerId,
    result: 'success',
    details: { from: before?.trustState ?? null, to: next, reason, ...evidence },
  });
}
