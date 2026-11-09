import { useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';

interface TagEditorProps {
  value: string[];
  max?: number;
  onChange: (tags: string[]) => void;
  /** Read-only: tags render without the remove buttons or the add input. */
  disabled?: boolean;
  'data-testid'?: string;
}

export default function TicketTagEditor({ value, max = 20, onChange, disabled = false, 'data-testid': testId }: TagEditorProps) {
  const { t } = useTranslation('tickets');
  const [input, setInput] = useState('');

  const addTag = () => {
    const trimmed = input.trim().slice(0, 50);
    if (!trimmed || value.includes(trimmed) || value.length >= max) return;
    onChange([...value, trimmed]);
    setInput('');
  };

  return (
    <div data-testid={testId} className="flex flex-wrap gap-1">
      {value.map((tag) => (
        <span key={tag} className="flex items-center gap-0.5 rounded border bg-muted px-1.5 py-0.5 text-xs">
          {tag}
          {!disabled && <button
            type="button"
            data-testid={`ticket-workbench-tag-remove-${tag}`}
            className="ml-0.5 hover:text-destructive"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            aria-label={t('ticketWorkbench.tags.removeTag', { tag })}
          >
            ×
          </button>}
        </span>
      ))}
      {!disabled && value.length < max && (
        <input
          type="text"
          data-testid="ticket-workbench-tag-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addTag(); }
          }}
          onBlur={addTag}
          placeholder={t('ticketWorkbench.tags.addTag')}
          maxLength={50}
          className="rounded border bg-background px-1.5 py-0.5 text-xs outline-hidden focus:ring-1 focus:ring-ring"
          aria-label={t('ticketWorkbench.tags.addTagAria')}
        />
      )}
    </div>
  );
}
