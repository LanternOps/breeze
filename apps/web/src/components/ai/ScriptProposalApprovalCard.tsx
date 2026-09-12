import { useEffect, useMemo, useState, type ComponentType } from 'react';
import type { EditorProps } from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';
import { useScriptProposal } from '@/hooks/useScriptProposal';
import { requestScriptProposalChanges } from '@/lib/api/scriptProposals';
import { ActionError } from '@/lib/runAction';
import { configureMonacoLoader } from '@/lib/monacoLoader';
import SaveProposalToLibraryDialog from './SaveProposalToLibraryDialog';

const COLLAPSE_AFTER_LINES = 40;

const RISK_CLASS: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export interface ScriptProposalApprovalCardProps {
  proposalId: string;
  /** Called with the acknowledged STRICT descriptions. The PARENT owns the
   *  approve call, because the approve endpoint differs per surface
   *  (AiApprovalDialog decides an intent, the inbox decides an approval row). */
  onApprove?: (acknowledgedPatterns: string[]) => void;
  onReject?: () => void;
  /** Hide the decision footer on a read-only surface (e.g. a promoted
   *  proposal, or a four-eyes card the viewer cannot decide themself). */
  readOnly?: boolean;
  onChanged?: () => void;
}

/** `cap('info') -> 'Info'` — matches the `severity<Cap>` i18n key suffix. */
function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Renders the author's Zod-union verification claim as one sentence. Falls
 *  back to the raw `kind` for a shape this hasn't been taught yet — never
 *  throws on an unrecognized union member. */
function describeClaim(claim: unknown): string {
  if (!claim || typeof claim !== 'object') return String(claim ?? '');
  const obj = claim as Record<string, unknown>;
  const kind = typeof obj.kind === 'string' ? obj.kind : 'unknown';
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  const path = typeof obj.path === 'string' ? obj.path : undefined;
  switch (kind) {
    case 'service_running':
      return name ? `Service "${name}" is running` : 'A service is running';
    case 'process_running':
      return name ? `Process "${name}" is running` : 'A process is running';
    case 'file_exists':
      return path ? `File "${path}" exists` : 'A file exists';
    case 'registry_value':
      return path ? `Registry value at "${path}" matches the expected value` : 'A registry value matches';
    case 'exit_code':
      return 'The script exits with code 0';
    case 'none':
      return 'No automated verification';
    default:
      return kind;
  }
}

/** Whole minutes remaining until `iso`, floored at `0m` once it has passed. */
function formatRemaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const minutes = Math.max(0, Math.floor(ms / 60000));
  return `${minutes}m`;
}

/**
 * Read-only script body. Monaco is dynamically imported (mirrors
 * ScriptForm.tsx / monacoLoader.ts) so it never lands in the eager bundle, and
 * self-hosted via `configureMonacoLoader()` so it never reaches
 * cdn.jsdelivr.net (CSP, #1023). Renders a plain `<pre>` — the SAME text the
 * editor would show — until the chunk resolves, and permanently if it never
 * does, so the script content is never gated behind Monaco actually loading.
 */
function ReadOnlyScript({ language, content }: { language: string; content: string }) {
  const [Editor, setEditor] = useState<ComponentType<EditorProps> | null>(null);

  useEffect(() => {
    let cancelled = false;
    configureMonacoLoader()
      .then(() => import('@monaco-editor/react'))
      .then((mod) => {
        if (!cancelled) setEditor(() => mod.default);
      })
      .catch(() => {
        // Stay on the <pre> fallback — the content is still fully readable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Editor) {
    return (
      <pre className="max-h-[300px] overflow-auto rounded bg-gray-900 px-3 py-2 text-xs text-gray-200">
        {content}
      </pre>
    );
  }

  return (
    <Editor
      height="300px"
      language={language}
      value={content}
      theme="vs-dark"
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}

export default function ScriptProposalApprovalCard({
  proposalId,
  onApprove,
  onReject,
  readOnly = false,
  onChanged,
}: ScriptProposalApprovalCardProps) {
  const { t } = useTranslation(['ai', 'approvals', 'common']);
  const { data, loading, error, reload } = useScriptProposal(proposalId);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);

  const strictHits = data?.proposal.strictHits ?? [];
  const lineCount = useMemo(() => data?.proposal.content.split('\n').length ?? 0, [data?.proposal.content]);
  const collapsible = lineCount > COLLAPSE_AFTER_LINES;
  const collapsed = collapsible && !expanded;

  // Approve is gated on the FULL acknowledgement set AND on the viewer's live
  // ability to acknowledge. The server re-checks both (422
  // strict_acknowledgement_not_permitted / _incomplete) — this only stops the
  // user wasting a ceremony on a request that will be refused.
  const allAcked = strictHits.every((h) => acked.has(h));
  const approveDisabled = submitting || (strictHits.length > 0 && (!allAcked || !data?.viewer.canAcknowledge));

  const submitNote = async () => {
    const trimmed = note.trim();
    if (!trimmed) {
      setNoteError(t('ai:scriptProposal.noteRequired'));
      return;
    }
    setSubmitting(true);
    try {
      await requestScriptProposalChanges(proposalId, trimmed);
      setNoteOpen(false);
      setNote('');
      reload();
      onChanged?.();
    } catch (err) {
      // 401 lets the auth redirect handle it; any non-ActionError needs its
      // own surface because runAction only toasts the ones it produced.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) setNoteError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div data-testid="script-proposal-loading">{t('common:states.loading')}</div>;
  if (error || !data) {
    return (
      <div data-testid="script-proposal-error" role="alert">
        {error ?? t('common:states.error')}
      </div>
    );
  }

  const tier = data.review?.riskTier ?? data.proposal.riskTier ?? 'medium';
  const verificationKeyByOutcome: Record<string, string> = {
    pending: 'ai:scriptProposal.verificationPending',
    verified: 'ai:scriptProposal.verified',
    verification_failed: 'ai:scriptProposal.verificationFailed',
    unknown: 'ai:scriptProposal.verificationUnknown',
  };

  return (
    <section data-testid="script-proposal-card" className="rounded-lg border border-border p-4">
      {/* Risk band + reviewer summary */}
      <div
        data-testid={`script-proposal-risk-${tier}`}
        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${RISK_CLASS[tier] ?? RISK_CLASS.medium}`}
      >
        {t(/* i18n-dynamic */ `approvals:risk.${tier}`)}
      </div>
      {data.review?.summary && (
        <p data-testid="script-proposal-summary" className="mt-2 text-sm">
          {data.review.summary}
        </p>
      )}

      {/* Author's claims */}
      <dl className="mt-3 grid gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{t('ai:scriptProposal.goal')}</dt>
          <dd data-testid="script-proposal-goal">{data.proposal.goal}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('ai:scriptProposal.expectedEffect')}</dt>
          <dd data-testid="script-proposal-expected-effect">{data.proposal.expectedEffect}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('ai:scriptProposal.verificationClaim')}</dt>
          <dd data-testid="script-proposal-verification">{describeClaim(data.proposal.verification)}</dd>
        </div>
        {data.proposal.rollbackNote && (
          <div>
            <dt className="text-xs text-muted-foreground">{t('ai:scriptProposal.rollback')}</dt>
            <dd data-testid="script-proposal-rollback">{data.proposal.rollbackNote}</dd>
          </div>
        )}
      </dl>

      {/* Reviewer findings */}
      {(data.review?.findings.length ?? 0) > 0 && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">{t('ai:scriptProposal.findings')}</p>
          <ul className="mt-1 space-y-1">
            {data.review!.findings.map((f, i) => (
              <li key={i} data-testid={`script-proposal-finding-${i}`} data-severity={f.severity} className="text-sm">
                <span className="font-semibold">
                  {t(/* i18n-dynamic */ `ai:scriptProposal.severity${cap(f.severity)}`)}
                </span>{' '}
                {f.text}
                {typeof f.lineRef === 'number' ? ` (L${f.lineRef})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Advisory chips — labelled advisory because NOTHING enforces
          blastRadius; it is the reviewer's judgment, not a guardrail. */}
      {(data.review?.blastRadius.length ?? 0) > 0 && (
        <div data-testid="script-proposal-blast-radius" className="mt-3 flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">{t('ai:scriptProposal.blastRadius')}</span>
          {data.review!.blastRadius.map((b) => (
            <span key={b} className="rounded bg-muted px-2 py-0.5 text-xs">
              {b}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground">{t('ai:scriptProposal.touches')}</span>
        {data.proposal.touchClasses.map((c) => (
          <span key={c} data-testid={`script-proposal-touch-${c}`} className="rounded bg-muted px-2 py-0.5 text-xs">
            {c}
          </span>
        ))}
      </div>

      {/* Devices */}
      <div className="mt-3">
        <span className="text-xs text-muted-foreground">{t('ai:scriptProposal.devices')}</span>
        <div data-testid="script-proposal-devices" className="mt-1 flex flex-wrap gap-1">
          {data.devices.map((d) => (
            <span key={d.id} data-testid={`script-proposal-device-${d.id}`} className="rounded bg-muted px-2 py-0.5 text-xs">
              {d.hostname}
            </span>
          ))}
        </div>
      </div>

      {/* Body — read-only Monaco, collapsed past COLLAPSE_AFTER_LINES lines */}
      <div className="mt-3">
        <div
          data-testid="script-proposal-body"
          data-collapsed={String(collapsed)}
          className={collapsed ? 'max-h-64 overflow-hidden' : ''}
        >
          <ReadOnlyScript language={data.proposal.language} content={data.proposal.content} />
        </div>
        {collapsible && (
          <button
            type="button"
            data-testid="script-proposal-body-toggle"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-xs text-blue-500 underline hover:text-blue-400"
          >
            {expanded ? t('ai:scriptProposal.hideCode') : t('ai:scriptProposal.showCode')}
          </button>
        )}
      </div>

      {/* STRICT acknowledgements */}
      {strictHits.length > 0 && (
        <fieldset className="mt-3 rounded-md border border-border p-2" data-testid="script-proposal-acknowledgements">
          <legend className="px-1 text-xs font-medium">{t('ai:scriptProposal.acknowledgeTitle')}</legend>
          {!data.viewer.canAcknowledge && (
            <p data-testid="script-proposal-ack-requirement" className="text-xs text-amber-700 dark:text-amber-300">
              {t('ai:scriptProposal.acknowledgeRequirement')}
            </p>
          )}
          {strictHits.map((hit, i) => (
            <label key={hit} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                data-testid={`script-proposal-ack-${i}`}
                disabled={!data.viewer.canAcknowledge}
                checked={acked.has(hit)}
                onChange={(e) =>
                  setAcked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(hit);
                    else next.delete(hit);
                    return next;
                  })
                }
              />
              <span>{hit}</span>
            </label>
          ))}
          {!allAcked && data.viewer.canAcknowledge && (
            <p className="text-xs text-muted-foreground">{t('ai:scriptProposal.acknowledgeIncomplete')}</p>
          )}
        </fieldset>
      )}

      <p data-testid="script-proposal-expiry" className="mt-3 text-xs text-muted-foreground">
        {t('ai:scriptProposal.expiresIn', { duration: formatRemaining(data.proposal.expiresAt) })}
      </p>

      {/* Verification state — makes the reason Save-to-library is absent
          visible instead of mysterious. */}
      <p data-testid="script-proposal-verification-state" className="mt-1 text-xs text-muted-foreground">
        {t(
          /* i18n-dynamic */ verificationKeyByOutcome[data.verification.outcome] ??
            'ai:scriptProposal.verificationUnknown',
        )}
      </p>

      {!readOnly && data.viewer.canDecide && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            data-testid="script-proposal-approve-button"
            disabled={approveDisabled}
            onClick={() => onApprove?.(strictHits.filter((h) => acked.has(h)))}
            className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500 disabled:opacity-50"
          >
            {t('ai:aiApprovalDialog.approve')}
          </button>
          <button
            type="button"
            data-testid="script-proposal-request-changes-button"
            onClick={() => setNoteOpen(true)}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
          >
            {t('ai:scriptProposal.requestChanges')}
          </button>
          <button
            type="button"
            data-testid="script-proposal-reject-button"
            onClick={() => onReject?.()}
            className="flex items-center gap-1.5 rounded-md bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            {t('ai:aiApprovalDialog.reject')}
          </button>
        </div>
      )}

      {noteOpen && (
        <div className="mt-2">
          <textarea
            data-testid="script-proposal-note-input"
            value={note}
            placeholder={t('ai:scriptProposal.notePlaceholder')}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteError(null);
            }}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          {noteError && (
            <p data-testid="script-proposal-note-error" className="text-xs text-destructive">
              {noteError}
            </p>
          )}
          <button
            type="button"
            data-testid="script-proposal-request-changes-submit"
            disabled={submitting}
            onClick={() => void submitNote()}
            className="mt-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('ai:scriptProposal.sendBack')}
          </button>
        </div>
      )}

      {/* Save to library — status-gated (spec §4.8 / D5): the button appears
          only once the proposal has actually run and verified, and is then
          ENABLED on the viewer's own canPromote so a read-only viewer still
          sees why the action is unavailable rather than the button vanishing. */}
      {data.proposal.status === 'verified' && (
        <div className="mt-3">
          <button
            type="button"
            data-testid="script-proposal-save-to-library"
            disabled={!data.viewer.canPromote}
            onClick={() => setPromoteOpen(true)}
            className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('ai:scriptProposal.saveToLibrary')}
          </button>
        </div>
      )}
      {promoteOpen && (
        <SaveProposalToLibraryDialog
          proposalId={proposalId}
          goal={data.proposal.goal}
          onClose={() => setPromoteOpen(false)}
          onPromoted={() => reload()}
        />
      )}
    </section>
  );
}
