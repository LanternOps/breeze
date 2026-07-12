import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square } from 'lucide-react';
import { useScriptAiStore } from '@/stores/scriptAiStore';

export default function ScriptAiInput() {
  const { t } = useTranslation('scripts');
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, isStreaming, interruptResponse, sessionId } = useScriptAiStore();

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [input]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput('');
    await sendMessage(trimmed);
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="border-t bg-background p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={sessionId ? t('scriptAiInput.placeholder.ready') : t('scriptAiInput.placeholder.opening')}
          disabled={!sessionId}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={interruptResponse}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-destructive/10 text-destructive hover:bg-destructive/20"
            title={t('scriptAiInput.actions.stopGenerating')}
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || !sessionId}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            title={t('scriptAiInput.actions.sendMessage')}
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
