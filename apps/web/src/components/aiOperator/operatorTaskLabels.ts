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
    case 'queued': return t('taskState.queued');
    case 'running': return t('taskState.running');
    case 'waiting': return t('taskState.waiting');
    case 'paused': return t('taskState.paused');
    case 'stopping': return t('taskState.stopping');
    case 'completed': return t('taskState.completed');
    case 'partial': return t('taskState.partial');
    case 'handed_off': return t('taskState.handedOff');
    case 'cancelled': return t('taskState.cancelled');
    case 'failed': return t('taskState.failed');
    case 'expired': return t('taskState.expired');
    default: return state;
  }
}
