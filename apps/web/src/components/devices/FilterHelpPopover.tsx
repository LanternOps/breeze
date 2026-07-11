// FilterHelpPopover — toggled by `?` key (spec 4.12). Documents the keyboard
// shortcuts. Render is controlled by parent (open prop) so the global key
// handler can flip it without a ref-passing dance.
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const SHORTCUTS: Array<{ id: string; keys: string; description: string }> = [
  { id: 'focus', keys: '/', description: 'Focus the filter bar' },
  { id: 'save', keys: 'Ctrl+S', description: 'Save current filter' },
  { id: 'close', keys: 'Esc', description: 'Close open popover' },
  { id: 'navigate', keys: '← / →', description: 'Navigate chips when bar focused' },
  { id: 'help', keys: '?', description: 'Show this help' }
];

export interface FilterHelpPopoverProps {
  open: boolean;
  onClose: () => void;
}

export function FilterHelpPopover({ open, onClose }: FilterHelpPopoverProps) {
  const { t } = useTranslation('devices');
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label={t('filterHelpPopover.ariaLabel')}
      data-testid="filter-help-popover"
      className="fixed bottom-4 right-4 z-50 w-72 rounded-md border bg-popover p-3 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">{t('filterHelpPopover.title')}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('filterHelpPopover.closeHelp')}
          data-testid="filter-help-close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {SHORTCUTS.map(s => (
          <li key={s.keys} className="flex items-center justify-between gap-2 text-xs">
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">{s.keys}</kbd>
            <span className="text-muted-foreground">{t(`filterHelpPopover.shortcuts.${s.id}`, { defaultValue: s.description })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
