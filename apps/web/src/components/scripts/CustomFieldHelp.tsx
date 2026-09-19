import { useState } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EditorProps } from '@monaco-editor/react';
import { cn } from '@/lib/utils';

type EditorInstance = Parameters<NonNullable<EditorProps['onMount']>>[0];

/** The stdout marker the agent extracts and the API ingests (#4678). */
export const CUSTOM_FIELD_MARKER = '::breeze:custom-fields::';

export const CUSTOM_FIELD_DOCS_URL =
  'https://docs.breezermm.com/features/custom-fields/#writing-custom-fields-from-a-script';

/**
 * A read-then-write example for the editor's current language. Code, not
 * copy, so it is deliberately not translated. Mirrors the three snippets in
 * `apps/docs/.../custom-fields.mdx` and adds CMD.
 */
export function customFieldExampleSnippet(language: string): string {
  switch (language) {
    case 'powershell':
      return [
        '# Read: a parameter named asset_tag (bound to a custom field) arrives as BREEZE_PARAM_<NAME>',
        '$assetTag = $env:BREEZE_PARAM_ASSET_TAG',
        '# Write: print the marker; the field needs "Allow scripts to write this field"',
        "$fields = @{ ram_slot_type = 'DDR5-5600'; free_dimm_slots = 2 }",
        `Write-Output "${CUSTOM_FIELD_MARKER} $($fields | ConvertTo-Json -Compress)"`,
      ].join('\n');
    case 'python':
      return [
        'import json, os',
        '# Read: a parameter named asset_tag (bound to a custom field) arrives as BREEZE_PARAM_<NAME>',
        'asset_tag = os.environ.get("BREEZE_PARAM_ASSET_TAG")',
        '# Write: print the marker; the field needs "Allow scripts to write this field"',
        `print("${CUSTOM_FIELD_MARKER} " + json.dumps({"ram_slot_type": "DDR5-5600", "free_dimm_slots": 2}))`,
      ].join('\n');
    case 'cmd':
      return [
        'REM Read: a parameter named asset_tag (bound to a custom field) arrives as BREEZE_PARAM_<NAME>',
        'set ASSET_TAG=%BREEZE_PARAM_ASSET_TAG%',
        'REM Write: print the marker; the field needs "Allow scripts to write this field"',
        `echo ${CUSTOM_FIELD_MARKER} {"ram_slot_type":"DDR5-5600","free_dimm_slots":2}`,
      ].join('\n');
    case 'bash':
    default:
      return [
        '# Read: a parameter named asset_tag (bound to a custom field) arrives as BREEZE_PARAM_<NAME>',
        'asset_tag="$BREEZE_PARAM_ASSET_TAG"',
        '# Write: print the marker; the field needs "Allow scripts to write this field"',
        `echo '${CUSTOM_FIELD_MARKER} {"ram_slot_type":"DDR5-5600","free_dimm_slots":2}'`,
      ].join('\n');
  }
}

interface CustomFieldHelpProps {
  language: string;
  editorRef: { current: EditorInstance | null };
  content: string;
  onInsert: (next: string) => void;
}

/**
 * Collapsible "Reading and writing custom fields" aside under the script
 * editor (#5233). The binding tooltip on a parameter row is the only other
 * in-context help, and it cannot hold a snippet. Insertion goes through
 * `executeEdits` at the live selection, the same way `ScriptVariablePicker`
 * does, so it lands at the caret inside Monaco and is a single undo stop.
 */
export default function CustomFieldHelp({ language, editorRef, content, onInsert }: CustomFieldHelpProps) {
  const { t } = useTranslation('scripts');
  const [open, setOpen] = useState(false);
  const snippet = customFieldExampleSnippet(language);

  const insert = () => {
    const text = `\n${snippet}\n`;
    const editor = editorRef.current;
    if (!editor) {
      onInsert(content + text);
      return;
    }
    const range = editor.getSelection() ?? { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
    editor.pushUndoStop();
    editor.executeEdits('breeze-custom-field-help', [{ range, text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    const next = editor.getModel()?.getValue();
    if (next !== undefined) onInsert(next);
    editor.focus();
  };

  return (
    <div className="rounded-md border text-sm" data-testid="custom-field-help">
      <button
        type="button"
        data-testid="custom-field-help-toggle"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        {t('scriptForm.customFieldHelp.title')}
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-3" data-testid="custom-field-help-body">
          <p>
            <span className="font-medium">{t('scriptForm.customFieldHelp.readLabel')}</span>{' '}
            {t('scriptForm.customFieldHelp.read')}{' '}
            <code className="rounded bg-muted px-1">BREEZE_PARAM_&lt;KEY&gt;</code>{' '}
            {t('scriptForm.customFieldHelp.readPlaceholders')}{' '}
            <code className="rounded bg-muted px-1">{'{{paramName}}'}</code>.
          </p>
          <p>
            <span className="font-medium">{t('scriptForm.customFieldHelp.writeLabel')}</span>{' '}
            {t('scriptForm.customFieldHelp.write')}{' '}
            <code className="rounded bg-muted px-1">{CUSTOM_FIELD_MARKER} {'{"key": "value"}'}</code>.{' '}
            {t('scriptForm.customFieldHelp.writeGate')}
          </p>
          <p className="text-amber-700 dark:text-amber-500">{t('scriptForm.customFieldHelp.secretCaveat')}</p>
          <pre
            data-testid="custom-field-help-snippet"
            className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs"
          >
            {snippet}
          </pre>
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="custom-field-help-insert"
              onClick={insert}
              className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
            >
              {t('scriptForm.customFieldHelp.insertExample')}
            </button>
            <a
              href={CUSTOM_FIELD_DOCS_URL}
              target="_blank"
              rel="noopener"
              data-testid="custom-field-help-docs"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {t('scriptForm.customFieldHelp.docsLink')}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
