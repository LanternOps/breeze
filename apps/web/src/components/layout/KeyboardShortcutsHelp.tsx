import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { useUiStore } from '../../stores/uiStore';
import { CREATE_SHORTCUTS, GO_TO_SHORTCUTS, type CreateShortcut, type GoToShortcut } from '../../lib/keyboard/goToShortcuts';

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
      {children}
    </kbd>
  );
}

function ChordSection({ id, prefix, title, hint, then, rows, testId, label }: {
  id: string;
  prefix: string;
  title: string;
  hint: string;
  then: string;
  rows: readonly (GoToShortcut | CreateShortcut)[];
  testId: string;
  label: (row: GoToShortcut | CreateShortcut) => string;
}) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">{hint}</p>
      <dl className="space-y-1.5">
        {rows.map((s) => (
          <div key={s.key} data-testid={testId} className="flex items-center justify-between gap-3 text-sm">
            <dd className="min-w-0 text-foreground">{label(s)}</dd>
            <dt className="flex shrink-0 items-center gap-1">
              <Kbd>{prefix}</Kbd>
              <span className="text-[11px] text-muted-foreground">{then}</span>
              <Kbd>{s.key}</Kbd>
            </dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The "?" cheat sheet. Open state lives in the ui store so the global shortcut
 * hook and the command palette's quick action can both open it. The go-to
 * and create rows are generated from the same tables the chord handler uses, so the card
 * can never advertise a key that does nothing.
 */
export default function KeyboardShortcutsHelp() {
  const { t } = useTranslation('common');
  const open = useUiStore((s) => s.isShortcutsHelpOpen);
  const close = useUiStore((s) => s.closeShortcutsHelp);
  const [mod, setMod] = useState('Ctrl');

  useEffect(() => {
    if (typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)) setMod('⌘');
  }, []);

  const general: Array<{ keys: string[]; label: string }> = [
    { keys: [`${mod}+K`], label: t('layout.shortcuts.search') },
    { keys: ['/'], label: t('layout.shortcuts.searchSlash') },
    { keys: [mod === '⌘' ? '⌥1–9' : 'Alt+1–9'], label: t('layout.shortcuts.paletteNumber') },
    { keys: ['['], label: t('layout.shortcuts.cycleSidebar') },
    { keys: [`${mod}+Shift+H`], label: t('layout.shortcuts.help') },
    { keys: ['?'], label: t('layout.shortcuts.showThis') },
    { keys: ['Esc'], label: t('layout.shortcuts.close') },
  ];

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('layout.shortcuts.title')}
      labelledBy="keyboard-shortcuts-title"
      maxWidth="2xl"
      className="p-6"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 id="keyboard-shortcuts-title" className="text-lg font-semibold">
          {t('layout.shortcuts.title')}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label={t('actions.close')}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <section aria-labelledby="keyboard-shortcuts-general">
          <h3 id="keyboard-shortcuts-general" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('layout.shortcuts.general')}
          </h3>
          <dl className="space-y-1.5">
            {general.map((row) => (
              <div key={row.keys.join('+')} className="flex items-center justify-between gap-3 text-sm">
                <dd className="min-w-0 text-foreground">{row.label}</dd>
                <dt className="flex shrink-0 items-center gap-1">
                  {row.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
                </dt>
              </div>
            ))}
          </dl>
        </section>

        <div className="space-y-6">
          <ChordSection
            id="keyboard-shortcuts-goto"
            prefix="g"
            title={t('layout.shortcuts.goTo')}
            hint={t('layout.shortcuts.goToHint')}
            then={t('layout.shortcuts.then')}
            rows={GO_TO_SHORTCUTS}
            testId="shortcut-goto"
            label={(s) => t(/* i18n-dynamic */ s.labelKey)}
          />
          <ChordSection
            id="keyboard-shortcuts-create"
            prefix="c"
            title={t('layout.shortcuts.create')}
            hint={t('layout.shortcuts.createHint')}
            then={t('layout.shortcuts.then')}
            rows={CREATE_SHORTCUTS}
            testId="shortcut-create"
            label={(s) => t(/* i18n-dynamic */ s.labelKey)}
          />
        </div>
      </div>

      <p className="mt-5 text-xs text-muted-foreground">{t('layout.shortcuts.typingNote')}</p>
    </Dialog>
  );
}
