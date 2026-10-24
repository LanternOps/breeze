import { useState, useRef, useCallback } from "react";
import { Send, Loader2, Square } from "lucide-react";
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
}

export default function AiChatInput({
  onSend,
  onInterrupt,
  disabled,
  isStreaming,
  isInterrupting,
  value: controlledValue,
  onValueChange,
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    }
  };

  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={
            isStreaming
              ? t("aiChatInput.waiting")
              : t("aiChatInput.placeholder")
          }
          disabled={disabled || isStreaming}
          rows={1}
          className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            onClick={onInterrupt}
            disabled={isInterrupting || !onInterrupt}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
            title={t("aiChatInput.stopResponse")}
          >
            {isInterrupting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!value.trim() || disabled}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {isStreaming
          ? t("aiChatInput.thinking")
          : t("aiChatInput.sendShortcut")}
      </p>
    </div>
  );
}
