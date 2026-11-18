import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { continueInSidePanel } from '@/stores/aiConversationHandoff';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';

/**
 * #9427 W3: "Continue in side panel" from the tab menu, the header and the
 * error banner. One move at a time; replacing a busy side-panel conversation
 * asks first (continueInSidePanel decides when).
 */
export function useContinueInPanel() {
  const { t } = useTranslation('ai');
  const [pendingConfirm, setPendingConfirm] = useState<((ok: boolean) => void) | null>(null);
  const moving = useRef(false);

  const continueInPanel = useCallback((tabId: string) => {
    if (moving.current) return;
    moving.current = true;
    continueInSidePanel(tabId, {
      confirm: () => new Promise<boolean>((resolve) => setPendingConfirm(() => resolve)),
    })
      .catch((err) => {
        console.error('[Workspace] Continue in side panel failed:', err);
        showToast({ type: 'error', message: t('aiConversationMove.notAvailable') });
      })
      .finally(() => { moving.current = false; });
  }, [t]);

  const settle = (ok: boolean) => {
    pendingConfirm?.(ok);
    setPendingConfirm(null);
  };

  const replaceDialog = (
    <ConfirmDialog
      open={pendingConfirm !== null}
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
      title={t('aiConversationMove.continueInPanel')}
      message={t('aiConversationMove.replaceConfirm')}
      confirmLabel={t('aiConversationMove.continueInPanel')}
      variant="warning"
      confirmTestId="workspace-replace-panel-confirm"
    />
  );

  return { continueInPanel, replaceDialog };
}
