import type { AiOperatorTaskState } from '@breeze/shared';

type Translator = (key: string) => string;

/**
 * Shared between `OperatorTaskDetail` and `OperatorTaskActivityFeed` — both
 * surfaces show the same task-state badge, and duplicating this 11-case
 * switch in two files would let them drift out of sync as new states are
 * added. Literal switch (not a dynamic `${...}` key) so the i18n key-usage
 * scanner can see every key — same convention as RunDetailPage's
 * `skipItemLabel`/`skipReasonLabel` (issue #4462).
 */
export function taskStateLabel(t: Translator, state: AiOperatorTaskState): string {
  switch (state) {
    case 'queued': return t('aiOperator:taskState.queued');
    case 'running': return t('aiOperator:taskState.running');
    case 'waiting': return t('aiOperator:taskState.waiting');
    case 'paused': return t('aiOperator:taskState.paused');
    case 'stopping': return t('aiOperator:taskState.stopping');
    case 'completed': return t('aiOperator:taskState.completed');
    case 'partial': return t('aiOperator:taskState.partial');
    case 'handed_off': return t('aiOperator:taskState.handedOff');
    case 'cancelled': return t('aiOperator:taskState.cancelled');
    case 'failed': return t('aiOperator:taskState.failed');
    case 'expired': return t('aiOperator:taskState.expired');
    default: return state;
  }
}

/**
 * Display label for an effect tool name. DISPLAY ONLY: it says nothing about
 * whether a tool runs automatically or by hand — that is the server's answer
 * (`plannedEffectTools` / `degradedEffectTools` / `degradedEffects`), rendered
 * as sent. An unknown tool shows its raw name rather than a guess.
 */
export function effectToolLabel(t: Translator, tool: string): string {
  switch (tool) {
    case 'google_set_vacation': return t('aiOperator:effectTool.googleSetVacation');
    case 'google_set_forwarding': return t('aiOperator:effectTool.googleSetForwarding');
    case 'google_add_mail_delegate': return t('aiOperator:effectTool.googleAddMailDelegate');
    case 'google_remove_from_group': return t('aiOperator:effectTool.googleRemoveFromGroup');
    case 'google_remove_license': return t('aiOperator:effectTool.googleRemoveLicense');
    case 'google_account_wipe_mobile_device': return t('aiOperator:effectTool.googleAccountWipeMobileDevice');
    case 'google_signout': return t('aiOperator:effectTool.googleSignout');
    case 'google_suspend_user': return t('aiOperator:effectTool.googleSuspendUser');
    case 'm365_set_auto_reply': return t('aiOperator:effectTool.m365SetAutoReply');
    case 'm365_remove_from_group': return t('aiOperator:effectTool.m365RemoveFromGroup');
    case 'm365_remove_license': return t('aiOperator:effectTool.m365RemoveLicense');
    case 'm365_retire_intune_device': return t('aiOperator:effectTool.m365RetireIntuneDevice');
    case 'm365_revoke_sessions': return t('aiOperator:effectTool.m365RevokeSessions');
    case 'm365_disable_user': return t('aiOperator:effectTool.m365DisableUser');
    // identity_onboarding (W07 R2b)
    case 'm365_create_user': return t('aiOperator:effectTool.m365CreateUser');
    case 'm365_assign_license': return t('aiOperator:effectTool.m365AssignLicense');
    case 'm365_add_to_group': return t('aiOperator:effectTool.m365AddToGroup');
    case 'google_move_ou': return t('aiOperator:effectTool.googleMoveOu');
    case 'google_assign_license': return t('aiOperator:effectTool.googleAssignLicense');
    case 'google_add_to_group': return t('aiOperator:effectTool.googleAddToGroup');
    default: return tool;
  }
}

export type EffectProviderKey = 'google' | 'm365' | 'breeze' | 'other';

/** The provider a tool name belongs to, read off its prefix (spec §4.1's per-provider grouping). */
export function effectToolProvider(tool: string): EffectProviderKey {
  if (tool.startsWith('google_')) return 'google';
  if (tool.startsWith('m365_')) return 'm365';
  return 'other';
}

/**
 * Provider display name. Product names are never translated
 * (`locales/TERMINOLOGY.md`), so these are constants, not catalog keys.
 */
export function providerLabel(provider: EffectProviderKey | 'breeze'): string {
  switch (provider) {
    case 'google': return 'Google Workspace';
    case 'm365': return 'Microsoft 365';
    case 'breeze': return 'Breeze';
    default: return provider;
  }
}
