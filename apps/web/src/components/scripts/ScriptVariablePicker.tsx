import { type RefObject } from 'react';
import type { EditorProps } from '@monaco-editor/react';
import { variableToken } from '@breeze/shared';
import type { TenantVariableEntry } from '@/lib/tenantVariableTokens';
import TenantVariableMenu from './TenantVariableMenu';

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
 * The menu itself lives in `TenantVariableMenu` — shared with the PR3
 * parameter-binding key picker, which needs the same rows (and the same
 * disabled-secret rule) but stores a bare key. This component is only the
 * Monaco insertion half.
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
  const insert = (key: string) => {
    const token = variableToken(key);
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

  return <TenantVariableMenu variables={variables} onSelect={insert} />;
}
