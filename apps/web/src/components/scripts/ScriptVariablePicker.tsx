import { useEffect, useRef, useState, type RefObject } from 'react';
import { Braces } from 'lucide-react';
import type { EditorProps } from '@monaco-editor/react';
import { variableToken } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import type { TenantVariableEntry } from '@/lib/tenantVariableTokens';

/** The live editor handed to `onMount` — the same type ScriptForm's ref holds. */
export type ScriptEditorInstance = Parameters<NonNullable<EditorProps['onMount']>>[0];

export interface ScriptVariablePickerProps {
  /** Offerable variables; secrets render disabled (PR 4 delivers them out-of-band). */
  variables: TenantVariableEntry[];
  /** Live Monaco instance — null before mount and after a loader failure. */
  editorRef: RefObject<ScriptEditorInstance | null>;
  /** Current script content; the insertion target when Monaco is absent. */
  content: string;
  /**
   * Receives the FULL post-insert content. The form owns the value (it lives in
   * react-hook-form, not component state), so the picker never writes it
   * directly — otherwise the AI panel and the picker would fight over it.
   */
  onInsert: (nextContent: string) => void;
}

/**
 * "Variables" menu for the script editor: inserts a `{{var.<key>}}` token at
 * the caret.
 *
 * Insertion goes through `executeEdits` at the live selection rather than
 * string-slicing the content, so it lands where the cursor is (and replaces a
 * selection) inside a Monaco model — `VariableInput`'s `setSelectionRange`
 * approach is `<input>`-only and has no equivalent here.
 */
export default function ScriptVariablePicker({
  variables,
  editorRef,
  content,
  onInsert,
}: ScriptVariablePickerProps) {
  const { t } = useTranslation('scripts');
  const [open, setOpen] = useState(false);
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

  const insert = (key: string) => {
    const token = variableToken(key);
    setOpen(false);
    const editor = editorRef.current;
    if (!editor) {
      // Monaco hasn't mounted (or failed to load) — append rather than drop the
      // click on the floor.
      onInsert(content + token);
      return;
    }
    const selection = editor.getSelection();
    const range = selection ?? {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    };
    // Undo stops around the edit so Ctrl+Z removes the whole token, not the
    // characters Monaco would otherwise merge into the surrounding typing.
    editor.pushUndoStop();
    editor.executeEdits('breeze-variable-picker', [
      { range, text: token, forceMoveMarkers: true },
    ]);
    editor.pushUndoStop();
    const next = editor.getModel()?.getValue();
    if (next !== undefined) onInsert(next);
    editor.focus();
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('scriptForm.variables.insertTitle')}
        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted"
      >
        <Braces className="h-3.5 w-3.5" />
        {t('scriptForm.variables.button')}
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
            variables.map(v => (
              <button
                key={v.key}
                type="button"
                role="menuitem"
                disabled={v.isSecret}
                aria-disabled={v.isSecret || undefined}
                onClick={() => insert(v.key)}
                className="w-full rounded px-2 py-1.5 text-left hover:bg-muted focus:bg-muted focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-transparent"
              >
                <span className="block truncate text-sm text-foreground">
                  {v.description || v.key}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {variableToken(v.key)}
                </span>
                {v.isSecret && (
                  <span className="mt-0.5 block text-[11px] text-amber-600 dark:text-amber-500">
                    {t('scriptForm.variables.secretUnavailable')}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
