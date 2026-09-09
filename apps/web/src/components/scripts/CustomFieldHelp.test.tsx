import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import CustomFieldHelp, { customFieldExampleSnippet, CUSTOM_FIELD_MARKER } from './CustomFieldHelp';
import en from '@/locales/en/scripts.json';

// #5233: the script editor's only custom-field help told users to PATCH the
// API with an API key. The supported path is the stdout marker.
describe('CustomFieldHelp (#5233)', () => {
  it('drops the stale PATCH-plus-API-key advice from the binding tooltip and names the env var', () => {
    const help = en.scriptForm.parameterBinding.fieldHelp;
    expect(help).not.toMatch(/PATCH/i);
    expect(help).not.toMatch(/API key/i);
    expect(help).toContain('BREEZE_PARAM_');
    expect(help).toContain(CUSTOM_FIELD_MARKER);
  });

  it('renders the read syntax, the write marker, the secret caveat, and a docs link', () => {
    render(<CustomFieldHelp language="powershell" editorRef={{ current: null }} content="" onInsert={vi.fn()} />);
    fireEvent.click(screen.getByTestId('custom-field-help-toggle'));
    const body = screen.getByTestId('custom-field-help-body');
    expect(body.textContent).toContain('BREEZE_PARAM_');
    expect(body.textContent).toContain(CUSTOM_FIELD_MARKER);
    expect(body.textContent).toMatch(/never write a secret/i);
    const link = screen.getByTestId('custom-field-help-docs') as HTMLAnchorElement;
    expect(link.href).toContain('docs.breezermm.com/features/custom-fields/');
  });

  it('shows a snippet for the editor language and swaps it when the language changes', () => {
    const { rerender } = render(<CustomFieldHelp language="powershell" editorRef={{ current: null }} content="" onInsert={vi.fn()} />);
    fireEvent.click(screen.getByTestId('custom-field-help-toggle'));
    expect(screen.getByTestId('custom-field-help-snippet').textContent).toContain('$env:BREEZE_PARAM_');
    rerender(<CustomFieldHelp language="bash" editorRef={{ current: null }} content="" onInsert={vi.fn()} />);
    expect(screen.getByTestId('custom-field-help-snippet').textContent).toContain('$BREEZE_PARAM_');
    expect(screen.getByTestId('custom-field-help-snippet').textContent).not.toContain('$env:');
    rerender(<CustomFieldHelp language="python" editorRef={{ current: null }} content="" onInsert={vi.fn()} />);
    expect(screen.getByTestId('custom-field-help-snippet').textContent).toContain('os.environ');
  });

  it('every language snippet emits the marker with a valid JSON object', () => {
    for (const lang of ['powershell', 'bash', 'python', 'cmd']) {
      const snippet = customFieldExampleSnippet(lang);
      expect(snippet, lang).toContain(CUSTOM_FIELD_MARKER);
    }
    // The bash/cmd/python forms print a literal JSON object — parse it.
    for (const lang of ['bash', 'cmd']) {
      const line = customFieldExampleSnippet(lang).split('\n').find(l => l.includes(CUSTOM_FIELD_MARKER))!;
      const json = line.slice(line.indexOf(CUSTOM_FIELD_MARKER) + CUSTOM_FIELD_MARKER.length).replace(/["']\s*$/, '').replace(/\\"/g, '"').trim();
      expect(() => JSON.parse(json), `${lang}: ${json}`).not.toThrow();
    }
  });

  it('appends the example when Monaco is not mounted', () => {
    const onInsert = vi.fn();
    render(<CustomFieldHelp language="bash" editorRef={{ current: null }} content={'echo hi\n'} onInsert={onInsert} />);
    fireEvent.click(screen.getByTestId('custom-field-help-toggle'));
    fireEvent.click(screen.getByTestId('custom-field-help-insert'));
    expect(onInsert).toHaveBeenCalledTimes(1);
    const next = onInsert.mock.calls[0][0] as string;
    expect(next.startsWith('echo hi\n')).toBe(true);
    expect(next).toContain(CUSTOM_FIELD_MARKER);
  });

  it('inserts at the live selection through executeEdits when Monaco is mounted', () => {
    const onInsert = vi.fn();
    const editor = {
      getSelection: vi.fn(() => ({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 })),
      pushUndoStop: vi.fn(),
      executeEdits: vi.fn(),
      getModel: vi.fn(() => ({ getValue: () => 'MODEL' })),
      focus: vi.fn()
    };
    render(<CustomFieldHelp language="python" editorRef={{ current: editor as never }} content="" onInsert={onInsert} />);
    fireEvent.click(screen.getByTestId('custom-field-help-toggle'));
    fireEvent.click(screen.getByTestId('custom-field-help-insert'));
    expect(editor.executeEdits).toHaveBeenCalledTimes(1);
    expect(editor.executeEdits.mock.calls[0][1][0].text).toContain(CUSTOM_FIELD_MARKER);
    expect(editor.pushUndoStop).toHaveBeenCalledTimes(2);
    expect(onInsert).toHaveBeenCalledWith('MODEL');
    expect(editor.focus).toHaveBeenCalled();
  });
});
