import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { fetchWithAuth } from '@/stores/auth';
import { useAiModelPickerStore } from '@/stores/aiModelPickerStore';
import { useAiStore } from '@/stores/aiStore';

/** W05 (spec §9.2, §15 #4): a switch that cannot resume is offered as a new chat seeded with a summary. */
export default function AiContinuationPrompt() {
  const { t } = useTranslation('ai');
  const continuation = useAiModelPickerStore((s) => s.continuation);
  const sessionId = useAiStore((s) => s.sessionId);
  const [busy, setBusy] = useState(false);
  // Bound to the chat it came from (Codex review finding 13): another chat
  // never sees, or sends, a message parked for this one.
  if (!continuation || !sessionId || continuation.sourceSessionId !== sessionId) return null;
  const { required, pendingContent } = continuation;

  const onContinue = async () => {
    const choice = useAiModelPickerStore.getState().selection ?? { offeringId: required.target.offeringId! };
    setBusy(true);
    try {
      const result = await runAction<{ data: { sessionId: string } }>({
        request: () => fetchWithAuth(`/ai/sessions/${sessionId}/continue`, {
          method: 'POST',
          body: JSON.stringify({ model: choice }),
        }),
        errorFallback: t('aiContinuation.failed'),
        successMessage: t('aiContinuation.created', { model: required.target.displayName }),
      });
      const newId = result.data.sessionId;
      // The pick was spent creating the new chat; it must not ride on it again.
      useAiModelPickerStore.getState().clearSelection();
      await useAiStore.getState().loadSession(newId);
      // Send only into the chat we just created and actually opened: loadSession
      // resolves normally on failure or when superseded (Codex review finding 13).
      if (useAiStore.getState().sessionId !== newId) {
        // Keep the parked message so the tech can retry or copy it.
        showToast({ type: 'error', message: t('aiContinuation.openFailed') });
        return;
      }
      useAiModelPickerStore.getState().dismissContinuation();
      await useAiStore.getState().sendMessage(pendingContent);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiContinuation.failed') });
      // A non-401 ActionError was already toasted by runAction; the prompt stays open to retry.
    } finally {
      setBusy(false);
    }
  };

  const onKeep = async () => {
    useAiModelPickerStore.getState().clearSelection();
    useAiModelPickerStore.getState().dismissContinuation();
    await useAiStore.getState().sendMessage(pendingContent);
  };

  return (
    <div className="mx-3 mb-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-950/30" data-testid="ai-continuation-prompt" role="alert">
      <p>{t(/* i18n-dynamic */ `aiContinuation.reason.${required.reason}`, { model: required.target.displayName })}</p>
      <p className="mt-1 text-muted-foreground">{t('aiContinuation.messageKept')}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={busy} onClick={onContinue} data-testid="ai-continuation-continue"
          className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50">
          {t('aiContinuation.continue', { model: required.target.displayName })}
        </button>
        <button type="button" disabled={busy} onClick={onKeep} data-testid="ai-continuation-keep"
          className="rounded border px-2 py-1 disabled:opacity-50">
          {t('aiContinuation.keep')}
        </button>
      </div>
    </div>
  );
}
