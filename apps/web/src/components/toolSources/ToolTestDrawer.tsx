import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError } from '../../lib/runAction';
import { runClientAction } from '../../lib/runClientAction';
import { Dialog } from '../shared/Dialog';
import { testSourceTool, type ToolSourceToolDto, type ToolTestResult } from './api';

/** Seed the argument editor with the schema's required keys, so the first
 *  thing the user sees is the shape the call actually needs rather than `{}`. */
export function seedInput(schema: Record<string, unknown>): string {
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? ((schema as { required: unknown[] }).required.filter((k): k is string => typeof k === 'string'))
    : [];
  return JSON.stringify(Object.fromEntries(required.map((key) => [key, ''])), null, 2);
}

/**
 * Test-call one Tier-1 (read-only) tool (#5216 W01 PR C). The API refuses a
 * test on anything else, and `testSourceTool` raises a FAILED call — which the
 * route answers with HTTP 200 — as an ActionError, so a failed remote call can
 * never render as a green result here.
 */
export function ToolTestDrawer({
  sourceId,
  tool,
  onClose,
}: {
  sourceId: string;
  tool: ToolSourceToolDto;
  onClose: () => void;
}) {
  const { t } = useTranslation('toolSources');
  const [input, setInput] = useState(() => seedInput(tool.inputSchema));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ToolTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input) as Record<string, unknown>;
    } catch {
      setError(t('test.invalidJson'));
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await runClientAction(() => testSourceTool(fetchWithAuth, sourceId, tool.id, parsed), {
        errorFallback: t('toasts.testFailed'),
        successMessage: t('toasts.testSucceeded'),
      });
      setResult(outcome);
    } catch (err) {
      if (err instanceof ActionError && err.status !== 401) setError(err.message);
      handleActionError(err, t('toasts.testFailed'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('test.title', { tool: tool.qualifiedName })}>
      <div className="space-y-3" data-testid="tool-test-drawer">
        <label className="block text-xs font-medium text-muted-foreground" htmlFor="tool-test-input">
          {t('test.input')}
        </label>
        <textarea
          id="tool-test-input"
          data-testid="tool-test-input"
          rows={6}
          className="w-full rounded-md border bg-background p-2 font-mono text-xs"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        {error && <p data-testid="tool-test-error" className="text-sm text-destructive">{error}</p>}
        {result && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('test.result')}</p>
            <pre data-testid="tool-test-result" className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
              {result.result}
            </pre>
            <p className="mt-1 text-xs text-muted-foreground">{t('test.duration', { ms: result.durationMs })}</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="h-9 rounded-md border px-3 text-sm" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button
            type="button"
            data-testid="tool-test-run"
            disabled={running}
            className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => void run()}
          >
            {running ? t('test.running') : t('test.run')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
