import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Braces } from 'lucide-react';
import { variableToken } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { TenantVariableEntry } from '@/lib/tenantVariableTokens';

export interface TenantVariableMenuProps {
  /** Offerable variables. Selectability is decided by {@link selectable}. */
  variables: TenantVariableEntry[];
  /**
   * Receives the KEY, never a token. Callers that want `{{var.<key>}}` build it
   * with `variableToken` themselves — the parameter-binding picker stores the
   * bare key, so the menu cannot be the thing that decides the shape.
   */
  onSelect: (key: string) => void;
  /**
   * Secondary line under each row. Defaults to the `{{var.<key>}}` token, which
   * is what the content editor inserts; the key picker passes identity.
   */
  formatDetail?: (key: string) => string;
  /**
   * Which rows can be picked. Defaults to "everything except a secret" — the
   * content editor and the plain `tenantVariable` binding both reject secrets.
   * The `tenantSecret` binding (#3409 PR4c-2) inverts it (`v => v.isSecret`),
   * which is why this is a predicate rather than a boolean flag: exactly one
   * rule decides both the `disabled` attribute and the reason line, so the two
   * can never disagree.
   */
  selectable?: (variable: TenantVariableEntry) => boolean;
  /**
   * Secondary reason line for a row, rendered in amber. Defaults to the
   * secret-unavailable copy for secret rows and nothing for the rest.
   */
  disabledReason?: (variable: TenantVariableEntry) => string | undefined;
  /** Trigger contents. Defaults to the Braces icon + the "Variables" label. */
  trigger?: ReactNode;
  triggerTitle?: string;
  triggerClassName?: string;
}

/**
 * The shared "pick a tenant variable" dropdown (#3409).
 *
 * Extracted from `ScriptVariablePicker` when PR3 added parameter bindings: the
 * two surfaces need the SAME menu — same ordering, same disabled-secret row
 * with its amber reason — but different payloads (a `{{var.x}}` token at the
 * caret vs. a bare key stored on a parameter definition). Only the payload and
 * the trigger chrome are parameterised; the row rendering and the
 * outside-click / Escape behaviour are shared so a secret can never become
 * selectable on one surface but not the other.
 */
export default function TenantVariableMenu({
  variables,
  onSelect,
  formatDetail = variableToken,
  selectable = variable => !variable.isSecret,
  disabledReason,
  trigger,
  triggerTitle,
  triggerClassName,
}: TenantVariableMenuProps) {
  const { t } = useTranslation('scripts');
  const [open, setOpen] = useState(false);
  const reasonFor =
    disabledReason ??
    ((variable: TenantVariableEntry) =>
      variable.isSecret ? t('scriptForm.variables.secretUnavailable') : undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerTitle ?? t('scriptForm.variables.insertTitle')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted',
          triggerClassName
        )}
      >
        {trigger ?? (
          <>
            <Braces className="h-3.5 w-3.5" />
            {t('scriptForm.variables.button')}
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-0 z-50 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border bg-card p-1 shadow-lg"
        >
          {variables.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t('scriptForm.variables.empty')}
            </p>
          ) : (
            variables.map(v => {
              const canSelect = selectable(v);
              const reason = reasonFor(v);
              return (
                <button
                  key={v.key}
                  type="button"
                  role="menuitem"
                  disabled={!canSelect}
                  aria-disabled={!canSelect || undefined}
                  onClick={() => {
                    setOpen(false);
                    onSelect(v.key);
                  }}
                  className="w-full rounded px-2 py-1.5 text-left hover:bg-muted focus:bg-muted focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-transparent"
                >
                  <span className="block truncate text-sm text-foreground">
                    {v.description || v.key}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {formatDetail(v.key)}
                  </span>
                  {reason && (
                    <span className="mt-0.5 block text-[11px] text-amber-600 dark:text-amber-500">
                      {reason}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
