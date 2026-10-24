import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDocumentV1 } from '@breeze/shared';

/**
 * One-line read-only summary of a flow trigger (#5218). Shared by the detail
 * page and the chat card so the two never describe a trigger differently.
 */
export function TriggerSummary({ trigger }: { trigger: FlowDocumentV1['trigger'] }) {
  const { t } = useTranslation('flows');
  const label = t(/* i18n-dynamic */ `trigger.${trigger.type}`);
  switch (trigger.type) {
    case 'schedule':
      return <>{`${label}: ${trigger.cron} (${trigger.timezone})`}</>;
    case 'event': {
      const pairs = Object.entries(trigger.filter ?? {}).map(([k, v]) => `${k}=${String(v)}`);
      return <>{pairs.length > 0 ? `${label}: ${trigger.event} [${pairs.join(', ')}]` : `${label}: ${trigger.event}`}</>;
    }
    default:
      return <>{label}</>;
  }
}
