import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * The reader's-language name of a notification channel type, for the pickers on
 * the Automations pages (#12497). The names are the ones the notification
 * channel list already shows; a type this build does not know is shown as is.
 */
export function useChannelTypeLabel(): (type: string) => string {
  const { t } = useTranslation('alerts');
  return useCallback((type: string) => {
    switch (type) {
      case 'email': return t('notificationChannelList.channelType.email');
      case 'slack': return t('notificationChannelList.channelType.slack');
      case 'teams': return t('notificationChannelList.channelType.teams');
      case 'pagerduty': return t('notificationChannelList.channelType.pagerduty');
      case 'webhook': return t('notificationChannelList.channelType.webhook');
      case 'sms': return t('notificationChannelList.channelType.sms');
      case 'pushover': return t('notificationChannelList.channelType.pushover');
      default: return type;
    }
  }, [t]);
}
