import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import ScriptVariablePicker, { type ScriptEditorInstance } from './ScriptVariablePicker';

type FakeEditor = {
  executeEdits: ReturnType<typeof vi.fn>;
  getSelection: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  pushUndoStop: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
};

/**
 * A stand-in for the live Monaco instance ScriptForm holds in `editorInstanceRef`.
 * Only the four members the picker touches are implemented; the cast keeps the
 * prop typed against the real `onMount` editor rather than a loosened interface.
 */
function fakeEditor(value: string, selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }): FakeEditor {
  let text = value;
  return {
    executeEdits: vi.fn((_source: string, edits: Array<{ text: string }>) => {
      text = `${text}${edits[0]?.text ?? ''}`;
      return true;
    }),
    getSelection: vi.fn(() => selection),
    getModel: vi.fn(() => ({ getValue: () => text })),
    pushUndoStop: vi.fn(),
    focus: vi.fn(),
  };
}

const variables = [
  { key: 'vendor_token', description: 'Vendor portal token', isSecret: false },
  { key: 'api_password', description: 'Vendor API password', isSecret: true },
];

function renderPicker(editor: FakeEditor | null, onInsert = vi.fn(), content = 'Write-Host') {
  const ref = createRef<ScriptEditorInstance | null>() as { current: ScriptEditorInstance | null };
  ref.current = editor as unknown as ScriptEditorInstance | null;
  render(
    <ScriptVariablePicker
      variables={variables}
      editorRef={ref}
      content={content}
      onInsert={onInsert}
    />,
  );
  return { onInsert };
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /variables/i }));

describe('ScriptVariablePicker', () => {
  it('inserts {{var.key}} into Monaco at the current selection', () => {
    const editor = fakeEditor('Write-Host', {
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 9,
    });
    const { onInsert } = renderPicker(editor);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Vendor portal token/i }));

    expect(editor.executeEdits).toHaveBeenCalledTimes(1);
    const [, edits] = editor.executeEdits.mock.calls[0] as [string, Array<{ range: unknown; text: string }>];
    expect(edits[0].text).toBe('{{var.vendor_token}}');
    // Caret-accurate: the edit targets the live selection, replacing it.
    expect(edits[0].range).toMatchObject({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 9,
    });
    // The form — not the editor — owns the value, so the post-edit model text
    // is handed back for a react-hook-form setValue.
    expect(onInsert).toHaveBeenCalledWith('Write-Host{{var.vendor_token}}');
    expect(editor.focus).toHaveBeenCalled();
  });

  it('marks a secret variable as unusable with a reason', () => {
    const editor = fakeEditor('Write-Host');
    const { onInsert } = renderPicker(editor);

    openMenu();
    const secret = screen.getByRole('menuitem', { name: /Vendor API password/i });
    expect(secret).toBeDisabled();
    // Copy changed in #3409 PR4c-2: a secret is no longer "not yet available",
    // it is bound through a `tenantSecret` PARAMETER instead of a content token.
    expect(secret).toHaveTextContent(/From a secret variable/i);

    fireEvent.click(secret);
    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('appends to the end of the content when the editor has not mounted', () => {
    const { onInsert } = renderPicker(null, vi.fn(), 'Write-Host');

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Vendor portal token/i }));

    expect(onInsert).toHaveBeenCalledWith('Write-Host{{var.vendor_token}}');
  });

  it('shows an empty state instead of an empty menu when no variables exist', () => {
    const ref = { current: null };
    render(
      <ScriptVariablePicker variables={[]} editorRef={ref} content="" onInsert={vi.fn()} />,
    );
    openMenu();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(screen.getByText(/no variables/i)).toBeInTheDocument();
  });
});
