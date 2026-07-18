// The persisted-contract block's admin editor. Split from QuoteEditor.tsx —
// see quoteEditorShared.tsx for the shared save-language plumbing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { type QuoteBlock, type ContractBlockContent } from './quoteTypes';
import { SrSaved } from './quoteEditorShared';

// A persisted `contract` block in the editor. The admin serialization attaches
// the raw authoring fields (content.authoring), so — unlike portal/public — the
// editor can render an editable manual-variable form (PATCH variableValues), an
// explicit "Update to vN" nudge when the pin is behind the latest published
// version, and an inline list of unresolved (empty) manual variables (the
// send-time CONTRACT_VARIABLES_UNRESOLVED equivalent surfaced on the block).
// Without authoring (legacy / uploaded / read-only user) it degrades to a
// read-only summary card.
export function ContractBlockEditor({
  block, canWrite, onEditBlock,
}: {
  block: QuoteBlock;
  canWrite: boolean;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation('billing');
  const c = (block.content ?? {}) as Partial<ContractBlockContent>;
  const authoring = c.authoring;
  const templateName = c.templateName?.trim() || t('quotes.editor.contract.untitledTemplate');
  const versionNumber = c.versionNumber ?? 0;

  const manualVars = useMemo(() => authoring?.declaredVariables.filter((v) => v.kind === 'manual') ?? [], [authoring]);
  const autoVars = useMemo(() => authoring?.declaredVariables.filter((v) => v.kind === 'auto') ?? [], [authoring]);

  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...(authoring?.variableValues ?? {}) }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const flash = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, []);

  // Resync the draft from the server's persisted values after a save's refetch,
  // but only when the user hasn't diverged (same guard as the heading/rich-text
  // drafts): if the local draft no longer matches what we last synced, keep it.
  const lastSynced = useRef(JSON.stringify(authoring?.variableValues ?? {}));
  useEffect(() => {
    const nextStr = JSON.stringify(authoring?.variableValues ?? {});
    setDraft((cur) => (JSON.stringify(cur) === lastSynced.current ? { ...(authoring?.variableValues ?? {}) } : cur));
    lastSynced.current = nextStr;
  }, [authoring]);

  const unfilled = useMemo(
    () => manualVars.filter((v) => !(draft[v.name] ?? '').trim()).map((v) => v.name),
    [manualVars, draft],
  );
  const latestNumber = authoring?.latestPublishedVersionNumber ?? null;
  const latestId = authoring?.latestPublishedVersionId ?? null;
  const canUpdate = latestId != null && latestNumber != null && latestNumber > versionNumber;

  const commit = useCallback(async (versionOverride?: string) => {
    if (!authoring) return;
    const names = manualVars.map((v) => v.name);
    const missing = names.filter((n) => !(draft[n] ?? '').trim());
    if (missing.length > 0) {
      setErrors(Object.fromEntries(missing.map((n) => [n, t('quotes.editor.contract.variableRequired')])));
      return;
    }
    setErrors({});
    const variableValues = Object.fromEntries(names.map((n) => [n, (draft[n] ?? '').trim()]));
    const content: Record<string, unknown> = {
      templateId: authoring.templateId,
      templateVersionId: versionOverride ?? authoring.templateVersionId,
      variableValues,
      ...(c.label?.trim() ? { label: c.label.trim() } : {}),
    };
    setBusy(true);
    try { if (await onEditBlock(block, content)) flash(); } finally { setBusy(false); }
  }, [authoring, manualVars, draft, c.label, block, onEditBlock, flash, t]);

  // No authoring (legacy/uploaded) or read-only user → read-only summary card.
  if (!authoring || !canWrite) {
    return (
      <div className="space-y-2 text-sm" data-testid={`quote-block-contract-content-${block.id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.label?.trim() || templateName}</span>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {t('quotes.editor.contract.pinnedVersion', { version: versionNumber })}
          </span>
        </div>
        {c.label?.trim() && <p className="text-xs text-muted-foreground">{templateName}</p>}
        {!authoring && <p className="text-xs text-muted-foreground">{t('quotes.editor.contract.readOnlyHint')}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm" data-testid={`quote-block-contract-editor-${block.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.label?.trim() || templateName}</span>
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground" data-testid={`quote-block-contract-version-${block.id}`}>
          {t('quotes.editor.contract.pinnedVersion', { version: versionNumber })}
        </span>
        <SrSaved show={saved} testId={`quote-block-contract-saved-${block.id}`} />
        {canUpdate && (
          <button
            type="button"
            onClick={() => void commit(latestId!)}
            disabled={busy}
            data-testid={`quote-block-contract-update-${block.id}`}
            className="ml-auto rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            {t('quotes.editor.contract.updateToVersion', { version: latestNumber })}
          </button>
        )}
      </div>

      {autoVars.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('quotes.editor.contract.autoVariablesTitle')}</p>
          <ul className="space-y-1">
            {autoVars.map((v) => (
              <li
                key={v.name}
                data-testid={`quote-block-contract-auto-${block.id}-${v.name}`}
                className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1 text-xs"
              >
                <span className="font-medium">{v.label ?? v.name}</span>
                <span className="font-mono text-muted-foreground">{`{{${v.name}}}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {manualVars.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('quotes.editor.contract.manualVariablesTitle')}</p>
          {manualVars.map((v) => (
            <div key={v.name}>
              <label htmlFor={`quote-block-contract-var-${block.id}-${v.name}`} className="mb-0.5 block text-xs text-muted-foreground">
                {v.label ?? v.name}
              </label>
              <input
                id={`quote-block-contract-var-${block.id}-${v.name}`}
                type="text"
                value={draft[v.name] ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setDraft((cur) => ({ ...cur, [v.name]: val }));
                  setErrors((cur) => { if (!cur[v.name]) return cur; const next = { ...cur }; delete next[v.name]; return next; });
                }}
                disabled={busy}
                data-testid={`quote-block-contract-var-${block.id}-${v.name}`}
                aria-invalid={errors[v.name] ? true : undefined}
                className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${errors[v.name] ? 'border-destructive' : ''}`}
              />
              {errors[v.name] && (
                <p className="mt-0.5 text-xs text-destructive" data-testid={`quote-block-contract-var-error-${block.id}-${v.name}`}>
                  {errors[v.name]}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {unfilled.length > 0 && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-foreground dark:text-warning" data-testid={`quote-block-contract-unresolved-${block.id}`}>
          {t('quotes.editor.contract.unresolvedWarning', { names: unfilled.join(', ') })}
        </p>
      )}

      {manualVars.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void commit()}
            disabled={busy}
            data-testid={`quote-block-contract-save-${block.id}`}
            className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t('quotes.editor.contract.saveVariables')}
          </button>
        </div>
      )}
    </div>
  );
}
