import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { TFunction } from 'i18next';
import type { FlowIssue } from '@breeze/shared';

/** Codes whose server message names the thing at fault (a tool, an event, a step id): kept beside the sentence. */
const NAMES_THE_CULPRIT = new Set<FlowIssue['code']>(['tool_not_found', 'event_unknown', 'duplicate_step_id', 'unknown_step_reference']);

/**
 * The reader's-language sentence for a validator issue (#12497). Keyed on the
 * issue's code, never on the English message. A `schema` issue has no finer code,
 * so it is told apart by its JSON pointer; `input_invalid` by the field it points
 * at. Anything unmapped (a new code, an unknown pointer) returns the server's own
 * message, so nothing is ever hidden.
 *
 * `detail` is the server's message, returned only for codes whose message names the
 * thing at fault (a tool, an event, a step id) that the sentence cannot.
 */
export function useDescribeFlowIssue(): (issue: FlowIssue) => { text: string; detail: string | null } {
  const { t } = useTranslation('flows');
  return (issue) => {
    const text = friendly(t, issue);
    return { text, detail: text !== issue.message && NAMES_THE_CULPRIT.has(issue.code) ? issue.message : null };
  };
}

function friendly(t: TFunction, issue: FlowIssue): string {
  const pointer = issue.pointer ?? '';
  switch (issue.code) {
    case 'schema':
      if (pointer === '/name') return t('flowEditor.validation.name');
      if (pointer === '/steps') return t('flowEditor.validation.steps');
      if (pointer === '/trigger/cron') return t('flowEditor.validation.cron');
      if (pointer === '/trigger/timezone') return t('flowEditor.validation.timezone');
      break;
    case 'input_invalid':
      if (/\/input\/scriptId$/.test(pointer)) return t('flowEditor.validation.script');
      if (/\/input\/channelId$/.test(pointer)) return t('flowEditor.validation.channel');
      if (/\/input\/channelIds$/.test(pointer)) return t('flowEditor.validation.channels');
      break;
    case 'duplicate_step_id': return t('flowEditor.validation.duplicateStepId');
    case 'unknown_step_reference': return t('flowEditor.validation.unknownStepReference');
    case 'forward_reference': return t('flowEditor.validation.forwardReference');
    case 'event_unknown': return t('flowEditor.validation.eventUnknown');
    case 'tool_not_found': return t('flowEditor.validation.toolNotFound');
    case 'notify_channel_not_owned': return t('flowEditor.validation.channelNotOwned');
    case 'reference_not_owned': return t('flowEditor.validation.referenceNotOwned');
    case 'device_not_owned': return t('flowEditor.validation.deviceNotOwned');
    case 'webhook_org_resolver_required': return t('flowEditor.validation.resolverRequired');
    case 'webhook_org_resolver_not_allowed': return t('flowEditor.validation.resolverNotAllowed');
    case 'document_too_large': return t('flowEditor.validation.documentTooLarge');
    case 'secret_in_document': return t('flowEditor.validation.secretInDocument');
    default:
      break;
  }
  return issue.message;
}
