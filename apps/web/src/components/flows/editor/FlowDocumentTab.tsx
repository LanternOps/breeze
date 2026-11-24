import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import type { BeforeMount, EditorProps, OnMount } from '@monaco-editor/react';
import '@/lib/i18n';
import { flowDocumentJsonSchema, type FlowIssue } from '@breeze/shared';
import { configureMonacoLoader } from '@/lib/monacoLoader';
import { FlowIssuesPanel } from '../FlowIssuesPanel';
import { parseDocumentText, type ParsedText } from './editorState';
import { locateJsonPointer } from './jsonPointerLocation';

export interface FlowDocumentTabProps {
  /** The document JSON text exactly as the user typed it (parent owns it). */
  text: string;
  onChange: (text: string) => void;
  /** Validation issues from the API; those with a `pointer` (RFC 6901, e.g. "/steps/0/input/scriptId", "/trigger/event") become editor markers. */
  issues: FlowIssue[];
  /** The parent's JSON parse error for `text`, or null. When set, render it inline under data-testid="flow-editor-parse-error". */
  parseError: string | null;
  readOnly?: boolean;
}

export type FlowDocumentParseResult = ParsedText;

/**
 * Parse the Document tab's text. The parent uses this to show a parse error and
 * to block Save. Empty or whitespace-only text is an error (JSON.parse rejects
 * it). The error is the engine's message, e.g. "Unexpected end of JSON input".
 */
export const parseFlowDocumentText = parseDocumentText;

type Monaco = Parameters<BeforeMount>[0];
type MonacoEditorInstance = Parameters<OnMount>[0];
type MarkerData = Parameters<Monaco['editor']['setModelMarkers']>[2][number];

/**
 * Monaco 0.57 moved the JSON language service to a top-level `monaco.json`
 * namespace; its typings declare `monaco.languages.json` as a deprecated stub,
 * though the AMD build still assigns it at runtime. Read both (top level
 * first), and tolerate neither being loaded.
 */
interface JsonLanguageNamespace {
  json?: { jsonDefaults?: { setDiagnosticsOptions?: (options: unknown) => void } };
}

const MARKER_OWNER = 'flow-validation';
const SCHEMA_URI = 'breeze://flow-document.schema.json';

function buildMarkers(monaco: Monaco, text: string, issues: FlowIssue[]): MarkerData[] {
  const firstLineEnd = Math.max(2, (text.split(/\r\n|\r|\n/, 1)[0] ?? '').length + 1);
  return issues
    .filter((issue) => typeof issue.pointer === 'string')
    .map((issue) => {
      const loc = locateJsonPointer(text, issue.pointer as string);
      const severity = issue.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning;
      // An unlocatable pointer (stale text, missing path) still surfaces, on line 1.
      return loc
        ? {
            severity,
            message: issue.message,
            startLineNumber: loc.line,
            startColumn: loc.column,
            endLineNumber: loc.endLine,
            endColumn: loc.endColumn,
          }
        : { severity, message: issue.message, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: firstLineEnd };
    });
}

/**
 * The manual flow editor's "Document" tab: the flow document as raw JSON in
 * Monaco, with schema-driven completion and the API's validation issues as
 * markers. Controlled — the parent owns the text and saving; this component
 * never reformats or recompiles what the user typed.
 */
export function FlowDocumentTab({ text, onChange, issues, parseError, readOnly = false }: FlowDocumentTabProps) {
  const { t } = useTranslation('flows');

  // Dynamic import (not React.lazy/Suspense) to dodge hydration issues during
  // Astro View Transition swaps; reloaded on astro:after-swap like ScriptForm.
  const [MonacoEditor, setMonacoEditor] = useState<ComponentType<EditorProps> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editorMounted, setEditorMounted] = useState(false);
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // Tolerate a throw from dispose() (double-dispose, Monaco edge cases) so it
  // never aborts the reload or leaves a stale ref behind. See #1186.
  const disposeEditor = useCallback(() => {
    try {
      editorRef.current?.dispose();
    } catch (err) {
      console.error('Failed to dispose flow document editor:', err);
    } finally {
      editorRef.current = null;
      setEditorMounted(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadEditor = () => {
      disposeEditor();
      setLoadFailed(false);
      configureMonacoLoader()
        .then(() => import('@monaco-editor/react'))
        .then((mod) => {
          if (!cancelled) setMonacoEditor(() => mod.default);
        })
        .catch((err) => {
          if (!cancelled) {
            console.error('Failed to load flow document editor:', err);
            setLoadFailed(true);
          }
        });
    };
    loadEditor();
    document.addEventListener('astro:after-swap', loadEditor);
    return () => {
      cancelled = true;
      document.removeEventListener('astro:after-swap', loadEditor);
      disposeEditor();
    };
  }, [disposeEditor]);

  // Force a relayout after View Transition navigation completes.
  useEffect(() => {
    const forceLayout = () => requestAnimationFrame(() => editorRef.current?.layout());
    document.addEventListener('astro:page-load', forceLayout);
    return () => document.removeEventListener('astro:page-load', forceLayout);
  }, []);

  const handleBeforeMount = useCallback<BeforeMount>((monaco) => {
    const json =
      (monaco as unknown as JsonLanguageNamespace).json ?? (monaco.languages as unknown as JsonLanguageNamespace).json;
    json?.jsonDefaults?.setDiagnosticsOptions?.({
      validate: true,
      allowComments: false,
      schemas: [{ uri: SCHEMA_URI, fileMatch: ['*'], schema: flowDocumentJsonSchema() }],
    });
  }, []);

  const handleMount = useCallback<OnMount>((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setEditorMounted(true);
  }, []);

  useEffect(() => {
    if (!editorMounted) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, buildMarkers(monaco, text, issues));
  }, [editorMounted, text, issues]);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-md border" data-testid="flow-editor-document">
        {MonacoEditor ? (
          <MonacoEditor
            height="560px"
            language="json"
            value={text}
            onChange={(value) => onChange(value ?? '')}
            beforeMount={handleBeforeMount}
            onMount={handleMount}
            theme="vs-dark"
            options={{
              readOnly,
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              tabSize: 2,
              padding: { top: 12, bottom: 12 },
            }}
          />
        ) : (
          <div>
            <p className="border-b px-3 py-2 text-xs text-muted-foreground" role="status">
              {loadFailed ? t('flowEditor.document.loadError') : t('flowEditor.document.loading')}
            </p>
            <pre
              className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs"
              data-testid="flow-editor-document-fallback"
            >
              {text}
            </pre>
          </div>
        )}
      </div>

      {parseError !== null && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          data-testid="flow-editor-parse-error"
          role="alert"
        >
          <p className="font-medium text-destructive">{t('flowEditor.document.parseError')}</p>
          <code className="mt-1 block break-words font-mono text-xs">{parseError}</code>
        </div>
      )}

      <FlowIssuesPanel issues={issues} />
    </div>
  );
}

export default FlowDocumentTab;
