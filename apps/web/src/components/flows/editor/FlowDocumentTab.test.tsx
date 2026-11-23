// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { flowDocumentJsonSchema, type FlowIssue } from '@breeze/shared';

const { fakeMonaco, fakeEditor, fakeModel, editorProps } = vi.hoisted(() => {
  const fakeModel = { id: 'model-1' };
  const fakeEditor = { getModel: () => fakeModel, dispose: () => {}, layout: () => {} };
  const fakeMonaco = {
    editor: { setModelMarkers: (() => {}) as (...args: unknown[]) => void },
    MarkerSeverity: { Error: 8, Warning: 4 },
    languages: { json: { jsonDefaults: { setDiagnosticsOptions: (() => {}) as (...args: unknown[]) => void } } },
  };
  const editorProps: { last: Record<string, unknown> | null } = { last: null };
  return { fakeMonaco, fakeEditor, fakeModel, editorProps };
});

vi.mock('@/lib/monacoLoader', () => ({
  configureMonacoLoader: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@monaco-editor/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  function MockEditor(props: {
    value?: string;
    language?: string;
    onChange?: (v: string | undefined) => void;
    beforeMount?: (m: unknown) => void;
    onMount?: (e: unknown, m: unknown) => void;
    options?: Record<string, unknown>;
  }) {
    editorProps.last = props as Record<string, unknown>;
    const mounted = React.useRef(false);
    if (!mounted.current) {
      mounted.current = true;
      props.beforeMount?.(fakeMonaco);
    }
    React.useEffect(() => {
      props.onMount?.(fakeEditor, fakeMonaco);
    }, []);
    return React.createElement('textarea', {
      'data-testid': 'mock-monaco',
      value: props.value ?? '',
      readOnly: !!props.options?.readOnly,
      onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
    });
  }
  return { __esModule: true, default: MockEditor, loader: { config: vi.fn() } };
});

import { FlowDocumentTab, parseFlowDocumentText } from './FlowDocumentTab';

const DOC = [
  '{',
  '  "trigger": { "type": "manual" },',
  '  "steps": [',
  '    {',
  '      "id": "run",',
  '      "tool": "run_script",',
  '      "input": {',
  '        "scriptId": "not-a-script"',
  '      }',
  '    }',
  '  ]',
  '}',
].join('\n');

const ISSUES: FlowIssue[] = [
  { code: 'reference_not_owned', severity: 'error', message: 'Script not found', stepId: 'run', pointer: '/steps/0/input/scriptId' },
  { code: 'event_unknown', severity: 'warning', message: 'Pointer goes nowhere', pointer: '/trigger/event' },
  { code: 'tool_blocked', severity: 'error', message: 'No pointer at all' },
];

describe('FlowDocumentTab', () => {
  beforeEach(() => {
    fakeMonaco.editor.setModelMarkers = vi.fn();
    fakeMonaco.languages.json.jsonDefaults.setDiagnosticsOptions = vi.fn();
    editorProps.last = null;
  });

  it('issues with pointers become markers and panel rows', async () => {
    render(<FlowDocumentTab text={DOC} onChange={() => {}} issues={ISSUES} parseError={null} />);
    expect(screen.getByTestId('flow-editor-document')).toBeTruthy();
    await screen.findByTestId('mock-monaco');
    const setModelMarkers = fakeMonaco.editor.setModelMarkers as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(setModelMarkers).toHaveBeenCalled());
    const [model, owner, markers] = setModelMarkers.mock.calls.at(-1)!;
    expect(model).toBe(fakeModel);
    expect(owner).toBe('flow-validation');
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      severity: 8,
      message: 'Script not found',
      startLineNumber: 8,
      startColumn: 21,
      endLineNumber: 8,
      endColumn: 35,
    });
    // An unlocatable pointer lands on line 1, with Warning severity.
    expect(markers[1]).toMatchObject({ severity: 4, message: 'Pointer goes nowhere', startLineNumber: 1, endLineNumber: 1 });

    expect(screen.getByTestId('flow-issue-reference_not_owned')).toBeTruthy();
    expect(screen.getByTestId('flow-issue-event_unknown')).toBeTruthy();
    expect(screen.getByTestId('flow-issue-tool_blocked')).toBeTruthy();
    expect(editorProps.last?.language).toBe('json');
  });

  it('recomputes markers when issues change', async () => {
    const { rerender } = render(<FlowDocumentTab text={DOC} onChange={() => {}} issues={ISSUES} parseError={null} />);
    await screen.findByTestId('mock-monaco');
    const setModelMarkers = fakeMonaco.editor.setModelMarkers as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(setModelMarkers).toHaveBeenCalled());
    rerender(<FlowDocumentTab text={DOC} onChange={() => {}} issues={[]} parseError={null} />);
    await waitFor(() => expect(setModelMarkers.mock.calls.at(-1)![2]).toEqual([]));
  });

  it('registers the flow document JSON schema with Monaco', async () => {
    render(<FlowDocumentTab text={DOC} onChange={() => {}} issues={[]} parseError={null} />);
    await screen.findByTestId('mock-monaco');
    const setDiagnosticsOptions = fakeMonaco.languages.json.jsonDefaults.setDiagnosticsOptions as ReturnType<typeof vi.fn>;
    expect(setDiagnosticsOptions).toHaveBeenCalledWith({
      validate: true,
      allowComments: false,
      schemas: [{ uri: 'breeze://flow-document.schema.json', fileMatch: ['*'], schema: flowDocumentJsonSchema() }],
    });
  });

  it('a JSON parse error blocks save', () => {
    expect(parseFlowDocumentText('{')).toMatchObject({ ok: false });
    const bad = parseFlowDocumentText('{');
    expect(bad.ok === false && bad.error.length > 0).toBe(true);
    expect(parseFlowDocumentText('')).toMatchObject({ ok: false });
    expect(parseFlowDocumentText('   \n')).toMatchObject({ ok: false });
    expect(parseFlowDocumentText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });

    render(
      <FlowDocumentTab text="{" onChange={() => {}} issues={[]} parseError="Unexpected end of JSON input" />,
    );
    const err = screen.getByTestId('flow-editor-parse-error');
    expect(err.textContent).toContain('Unexpected end of JSON input');
  });

  it('renders no parse error when parseError is null', () => {
    render(<FlowDocumentTab text={DOC} onChange={() => {}} issues={[]} parseError={null} />);
    expect(screen.queryByTestId('flow-editor-parse-error')).toBeNull();
  });

  it('saving from the Document tab sends the document unchanged', async () => {
    const onChange = vi.fn();
    render(<FlowDocumentTab text={DOC} onChange={onChange} issues={[]} parseError={null} />);
    const editor = await screen.findByTestId('mock-monaco');
    // No CR here: jsdom's textarea normalises CRLF in its value, which would
    // test jsdom, not this component.
    const odd = '{\n\t"steps" :[ ],   "trigger":{"type":"manual"}  ,"version":1   \n}\n\n';
    fireEvent.change(editor, { target: { value: odd } });
    expect(onChange).toHaveBeenCalledWith(odd);
    expect(onChange.mock.calls.at(-1)![0]).toBe(odd);

    // Straight through Monaco's onChange (bypassing the textarea): CRLF survives
    // untouched, and Monaco's `undefined` becomes ''.
    const editorOnChange = editorProps.last?.onChange as (v: string | undefined) => void;
    const crlf = '{\r\n  "version": 1,\r\n  "steps": []\r\n}\r\n';
    editorOnChange(crlf);
    expect(onChange.mock.calls.at(-1)![0]).toBe(crlf);
    editorOnChange(undefined);
    expect(onChange.mock.calls.at(-1)![0]).toBe('');
  });

  it('passes readOnly through to Monaco', async () => {
    render(<FlowDocumentTab text={DOC} onChange={() => {}} issues={[]} parseError={null} readOnly />);
    await screen.findByTestId('mock-monaco');
    expect((editorProps.last?.options as Record<string, unknown>).readOnly).toBe(true);
  });

  it('shows a plain fallback of the text before Monaco loads', () => {
    render(<FlowDocumentTab text={DOC} onChange={() => {}} issues={[]} parseError={null} />);
    // Synchronously after render, the dynamic import has not resolved yet.
    expect(screen.getByTestId('flow-editor-document-fallback').textContent).toBe(DOC);
  });
});
