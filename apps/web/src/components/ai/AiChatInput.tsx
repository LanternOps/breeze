import { useState, useRef, useCallback, type ReactNode } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

interface AiChatInputProps {
  onSend: (message: string) => void;
  onInterrupt?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  isInterrupting?: boolean;
  /**
   * Controlled text (#9427): the side panel keeps its draft in aiStore so a
   * refused send can put it back. Pass both or neither; without them the
   * input keeps its own state.
   */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Overrides the idle placeholder (the Wisp home says "Message Wisp"). */
  placeholder?: string;
  /** Rendered inside the field, left of the text (the Wisp home's Link an item button). */
  leftSlot?: ReactNode;
}

const MAX_TEXTAREA_PX = 200;

export default function AiChatInput({
  onSend,
  onInterrupt,
  disabled,
  isStreaming,
  isInterrupting,
  value: controlledValue,
  onValueChange,
  placeholder,
  leftSlot,
}: AiChatInputProps) {
  const { t } = useTranslation("ai");
  const [localValue, setLocalValue] = useState("");
  const controlled = controlledValue !== undefined && onValueChange !== undefined;
  const value = controlled ? controlledValue : localValue;
  const setValue = controlled ? onValueChange : setLocalValue;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isStreaming) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, setValue, disabled, isStreaming, onSend]);

  // Wisp companion W01 (spec §4.1): Enter sends, Shift+Enter is a newline,
  // Cmd/Ctrl+Enter still sends. An Enter that confirms an IME candidate
  // (Japanese, Chinese, Korean input) must never send: `isComposing` covers
  // Chrome and Firefox, keyCode 229 covers Safari, which reports the
  // confirming keydown with isComposing already false.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    handleSubmit();
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_PX)}px`;
    }
  };

  return (
    <div className="bg-background p-3">
      <div className="flex items-end gap-2 rounded-2xl border bg-background px-3 py-2 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
        {leftSlot}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={
            isStreaming
              ? t("aiChatInput.waiting")
              : (placeholder ?? t("aiChatInput.placeholder"))
          }
          disabled={disabled || isStreaming}
          rows={1}
          data-testid="ai-chat-input"
          className="max-h-[200px] min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-hidden disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onInterrupt}
            disabled={isInterrupting || !onInterrupt}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
            title={t("aiChatInput.stopResponse")}
            aria-label={t("aiChatInput.stopResponse")}
            data-testid="ai-chat-stop"
          >
            {isInterrupting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim() || disabled}
            data-testid="ai-chat-send"
            aria-label={t("aiChatInput.send")}
            title={t("aiChatInput.send")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
