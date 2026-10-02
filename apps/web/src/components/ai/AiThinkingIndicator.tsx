import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * W05 (spec §11): never a silent pause while the model reasons. Progress
 * NOTES (thinkingDisplay 'updates') are not carried by the Agent SDK yet
 * (W01 D1), so this shows a state and the elapsed seconds.
 */
export default function AiThinkingIndicator({ thinking }: { thinking: boolean }) {
  const { t } = useTranslation('ai');
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!thinking) { setSeconds(0); return; }
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [thinking]);
  if (!thinking) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground" data-testid="ai-thinking-indicator" role="status" aria-live="polite">
      <Loader2 className="h-3 w-3 animate-spin" />
      {t('aiThinking.label', { seconds })}
    </div>
  );
}
