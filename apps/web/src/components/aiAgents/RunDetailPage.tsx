import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ArrowLeft, Bot, Clock, Download, ExternalLink, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { fetchWithAuth } from '../../stores/auth';
import { exportReport, getBrowserTimezone } from '../reports/reportExport';
import { formatDate, formatDateTime, formatTime } from '@/lib/dateTimeFormat';
import { formatCurrency, formatNumber } from '@/lib/i18n/format';
import { badgeClass, runStatusTone, verdictTone } from './statusBadge';
import { EmptyState } from '../shared/EmptyState';
import { AI_SWEEP_KINDS, AI_SWEEP_SEVERITIES } from '@breeze/shared';
import type {
  AiAgentRunDetailDto,
  AiAgentRunLedgerEntryDto,
  AiAgentRunStatus,
  AiAgentRunSweepFindingDto,
  AiAgentRunTicketProposalDto,
  AiAgentRunTraceEntryDto,
  AiSweepKind,
  AiSweepSeverity,
  ExposureBudgetDto,
  NarrativeSection,
  OrgNarrativeReportSummary,
  SweepProposalReason,
  TicketTriageSkip,
} from '@breeze/shared';

interface RunDetailPageProps {
  runId: string;
}

/** Every status NOT in this set is "live" — mirrors RunsListPage's
 * TERMINAL_RUN_STATUSES so both surfaces agree on when a run stops updating. */
const TERMINAL_RUN_STATUSES = new Set<AiAgentRunStatus>([
  'completed', 'failed', 'cancelled', 'expired', 'skipped',
]);
function isLiveRunStatus(status: AiAgentRunStatus): boolean {
  return !TERMINAL_RUN_STATUSES.has(status);
}

const DETAIL_POLL_INTERVAL_MS = 5_000;

/** See RunsListPage's `LiveIndicator` — same decorative-dot + sr-only-label
 * contract, duplicated locally rather than shared since it is a two-line
 * component and these two files intentionally don't share a module. */
function LiveIndicator({ label }: { label: string }) {
  return (
    <span className="ml-1.5 inline-flex items-center" data-testid="run-live-indicator">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * UI critique finding #4: this used to floor everything through
 * `Math.round(ms / 1000)`, so a 250 ms tool call rendered as "0s" — which
 * reads as "took no time at all" rather than "took a quarter of a second".
 * Under a second we print the milliseconds instead; from a second up, the
 * familiar m/s form.
 */
function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function verdictLabel(t: (key: string) => string, value: string | null): string {
  switch (value) {
    case 'remediated':
      return t('aiAgentsPage.runs.verdicts.remediated');
    case 'needs_attention':
      return t('aiAgentsPage.runs.verdicts.needs_attention');
    case 'partial':
      return t('aiAgentsPage.runs.verdicts.partial');
    case 'no_action':
      return t('aiAgentsPage.runs.verdicts.no_action');
    default:
      return t('aiAgentsPage.runs.verdicts.pending');
  }
}

function statusLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case 'queued':
      return t('aiAgentsPage.runs.statuses.queued');
    case 'running':
      return t('aiAgentsPage.runs.statuses.running');
    case 'awaiting_approval':
      return t('aiAgentsPage.runs.statuses.awaiting_approval');
    case 'completed':
      return t('aiAgentsPage.runs.statuses.completed');
    case 'failed':
      return t('aiAgentsPage.runs.statuses.failed');
    case 'cancelled':
      return t('aiAgentsPage.runs.statuses.cancelled');
    case 'expired':
      return t('aiAgentsPage.runs.statuses.expired');
    case 'skipped':
      return t('aiAgentsPage.runs.statuses.skipped');
    default:
      return value;
  }
}

function triggerLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case 'alert':
      return t('aiAgentsPage.runs.triggers.alert');
    case 'manual':
      return t('aiAgentsPage.runs.triggers.manual');
    case 'schedule':
      return t('aiAgentsPage.runs.triggers.schedule');
    case 'ticket':
      return t('aiAgentsPage.runs.triggers.ticket');
    case 'anomaly':
      return t('aiAgentsPage.runs.triggers.anomaly');
    default:
      return value;
  }
}

/** `AiAgentRunLedgerEntryDto.status` (`AiToolStatus`) → i18n label, so the
 * ledger never prints the raw enum token (critique finding #6). */
function ledgerStatusLabel(t: (key: string) => string, value: AiAgentRunLedgerEntryDto['status']): string {
  switch (value) {
    case 'pending':
      return t('aiAgentsRuns.detail.ledger.statuses.pending');
    case 'approved':
      return t('aiAgentsRuns.detail.ledger.statuses.approved');
    case 'executing':
      return t('aiAgentsRuns.detail.ledger.statuses.executing');
    case 'completed':
      return t('aiAgentsRuns.detail.ledger.statuses.completed');
    case 'failed':
      return t('aiAgentsRuns.detail.ledger.statuses.failed');
    case 'rejected':
      return t('aiAgentsRuns.detail.ledger.statuses.rejected');
    default:
      return value;
  }
}

/**
 * Craft-floor fix (nested cards are always wrong) — every in-card empty
 * state below (trace/ledger/intents) used to be a dashed-bordered
 * `EmptyState` nested INSIDE the section's own `rounded-lg border bg-card`
 * card, a border-on-a-border. Rendered as a plain muted note instead: a
 * short title line plus its description, no card of its own. Two separate
 * `<p>` elements (not one concatenated string) so each piece of text is
 * still independently queryable, matching how `EmptyState` exposed them.
 */
function InCardEmpty({ title, description, testId }: { title: string; description: string; testId?: string }) {
  return (
    <div className="mt-2" data-testid={testId}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

/** The same ledger entry, stacked, for viewports below `md` (UI critique
 *  finding #5 — the ledger had no mobile layout, unlike the sweep findings
 *  table it sits beside on this page). Mirrors `SweepFindingCard`'s divided
 *  list, not a nested bordered card. */
function LedgerEntryCard({
  entry,
  index,
  t,
}: {
  entry: AiAgentRunLedgerEntryDto;
  index: number;
  t: (key: string) => string;
}) {
  return (
    <li data-testid={`run-detail-ledger-card-${index}`} className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{entry.toolName}</span>
        <span className="text-xs text-muted-foreground">{ledgerStatusLabel(t, entry.status)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{formatDuration(entry.durationMs)}</span>
        <span>{formatDateTime(entry.createdAt)}</span>
      </div>
      {/* Finding #3 — destructive tone only when there IS an error; a
          healthy row's em dash must not read as an error too. */}
      {entry.errorMessage && (
        <p className="mt-1 text-xs text-destructive" data-testid={`run-detail-ledger-card-${index}-error`}>
          {entry.errorMessage}
        </p>
      )}
    </li>
  );
}

/**
 * The ledger's body, rendered twice like the sweep findings above: stacked
 * cards below `md`, a table from `md` up. Shared by both the collapsed
 * (`<details>`, finding #2) and plain rendering paths below so the two never
 * drift from each other.
 */
function LedgerTable({ ledger, t }: { ledger: AiAgentRunLedgerEntryDto[]; t: (key: string) => string }) {
  return (
    <>
      <ul className="mt-2 divide-y md:hidden" data-testid="run-detail-ledger-cards">
        {ledger.map((entry, index) => (
          <LedgerEntryCard key={index} entry={entry} index={index} t={t} />
        ))}
      </ul>
      <div className="mt-2 hidden overflow-x-auto md:block" data-testid="run-detail-ledger-table-wrapper">
        <table className="min-w-full divide-y text-sm" data-testid="run-detail-ledger">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-2">{t('aiAgentsPage.runs.detail.ledger.columns.tool')}</th>
              <th className="px-2 py-2">{t('aiAgentsPage.runs.detail.ledger.columns.status')}</th>
              <th className="px-2 py-2">{t('aiAgentsPage.runs.detail.ledger.columns.duration')}</th>
              <th className="px-2 py-2">{t('aiAgentsPage.runs.detail.ledger.columns.started')}</th>
              <th className="px-2 py-2">{t('aiAgentsPage.runs.detail.ledger.columns.error')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {ledger.map((entry, index) => (
              <tr key={index}>
                <td className="px-2 py-2 font-medium">{entry.toolName}</td>
                <td className="px-2 py-2 text-muted-foreground">{ledgerStatusLabel(t, entry.status)}</td>
                <td className="px-2 py-2 text-muted-foreground">{formatDuration(entry.durationMs)}</td>
                <td className="px-2 py-2 text-muted-foreground">{formatDateTime(entry.createdAt)}</td>
                {/* Finding #3 — was unconditionally `text-destructive`, so a
                    healthy row's em dash read as an error too. */}
                <td className={`px-2 py-2 ${entry.errorMessage ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {entry.errorMessage ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * `action_intents.status` → i18n label (UI critique finding #2). The eight
 * values come from `actionIntentStatusEnum`
 * (apps/api/src/db/schema/actionIntents.ts); five of them already have a
 * label on the ledger's `AiToolStatus` map and two more on the run-status
 * map, so this deliberately REUSES those keys rather than minting a parallel
 * set that would drift from them in translation.
 */
function intentStatusLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case 'pending_approval':
      return t('aiAgentsPage.runs.statuses.awaiting_approval');
    case 'approved':
      return t('aiAgentsRuns.detail.ledger.statuses.approved');
    case 'executing':
      return t('aiAgentsRuns.detail.ledger.statuses.executing');
    case 'completed':
      return t('aiAgentsRuns.detail.ledger.statuses.completed');
    case 'failed':
      return t('aiAgentsRuns.detail.ledger.statuses.failed');
    case 'rejected':
      return t('aiAgentsRuns.detail.ledger.statuses.rejected');
    case 'expired':
      return t('aiAgentsPage.runs.statuses.expired');
    case 'cancelled':
      return t('aiAgentsPage.runs.statuses.cancelled');
    default:
      return value;
  }
}

/**
 * UI critique finding #1 — the run summary is the AGENT'S OWN ACCOUNT of what
 * it found, and the model writes it in markdown. Rendering it as one flat
 * paragraph printed literal `**hostname**` and ran `1. **Failed backup**
 * (high)` into the surrounding prose.
 *
 * The renderer is the app's existing one (`react-markdown`, already used by
 * AiChatMessages/ScriptAiMessages) restricted to a safe subset. Two
 * properties are load-bearing:
 *
 *  - NO `rehype-raw`, and `skipHtml`. react-markdown 10 does NOT drop raw HTML
 *    nodes by default — without `rehype-raw` it converts them to plain TEXT
 *    (a model-authored `<img onerror=…>` renders as the literal escaped
 *    string, never becomes markup, so it was never an XSS risk either way),
 *    but that still puts the raw tag soup on screen as noise. `skipHtml`
 *    drops those nodes outright instead of rendering their source as text.
 *    `dangerouslySetInnerHTML` remains forbidden here for the same reason it
 *    is forbidden on the narrative section — neither renderer ever hands the
 *    model's own string to `innerHTML`.
 *  - `allowedElements` is a strict allowlist (paragraphs, emphasis, inline
 *    code, code blocks, both list kinds, links); `unwrapDisallowed` keeps the
 *    TEXT of anything else (a heading, a table cell) instead of dropping
 *    content.
 */
const SUMMARY_ALLOWED_ELEMENTS = ['p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'br', 'a'];

/** Only `http(s)` survives as a link; every other scheme (`javascript:`,
 *  `data:`, a bare relative path) renders as its own label text. */
function isSafeHttpUrl(href: string | undefined): boolean {
  return typeof href === 'string' && /^https?:\/\//i.test(href);
}

function RunSummaryMarkdown({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      allowedElements={SUMMARY_ALLOWED_ELEMENTS}
      unwrapDisallowed
      skipHtml
      components={{
        p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ children }) => (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
        ),
        pre: ({ children }) => (
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-[0.9em]">{children}</pre>
        ),
        ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
        a: ({ href, children }) =>
          isSafeHttpUrl(href) ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              {children}
            </a>
          ) : (
            <>{children}</>
          ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function traceKindLabel(t: (key: string) => string, kind: AiAgentRunTraceEntryDto['kind']): string {
  switch (kind) {
    case 'executed':
      return t('aiAgentsPage.runs.detail.trace.kinds.executed');
    case 'proposed':
      return t('aiAgentsPage.runs.detail.trace.kinds.proposed');
    case 'denied':
      return t('aiAgentsPage.runs.detail.trace.kinds.denied');
    default:
      return kind;
  }
}

function traceResultLabel(t: (key: string) => string, result: 'ok' | 'failed'): string {
  return result === 'ok' ? t('aiAgentsPage.runs.detail.trace.result.ok') : t('aiAgentsPage.runs.detail.trace.result.failed');
}

function executionLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case 'succeeded':
      return t('aiAgentsPage.runs.detail.trace.execution.succeeded');
    case 'failed':
      return t('aiAgentsPage.runs.detail.trace.execution.failed');
    case 'timeout':
      return t('aiAgentsPage.runs.detail.trace.execution.timeout');
    default:
      return t('aiAgentsPage.runs.detail.trace.execution.unknown');
  }
}

function verificationLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case 'passed':
      return t('aiAgentsPage.runs.detail.trace.verification.passed');
    case 'failed':
      return t('aiAgentsPage.runs.detail.trace.verification.failed');
    case 'inconclusive':
      return t('aiAgentsPage.runs.detail.trace.verification.inconclusive');
    default:
      return t('aiAgentsPage.runs.detail.trace.verification.skipped');
  }
}

function traceEntryBadgeClass(kind: AiAgentRunTraceEntryDto['kind']): string {
  switch (kind) {
    case 'executed':
      return badgeClass('info', { size: 'sm' });
    case 'proposed':
      return badgeClass('warning', { size: 'sm' });
    case 'denied':
      return badgeClass('danger', { size: 'sm' });
    default:
      return badgeClass('neutral', { size: 'sm' });
  }
}

/**
 * The stitched execution-trace entry row. `entry` is the SAFE projection
 * (`AiAgentRunTraceEntryDto`) — no field on any of its three variants can
 * ever carry a raw tool input/output, by construction (see the DTO file's
 * header comment). `intentsById` links a `proposed` entry with an
 * `intentId` onward to `/approvals`, never to the intent's own content.
 *
 * UI critique finding #6: the DTO carries a `durationMs` for an `executed`
 * entry but NO timestamp field on any of the three trace-entry variants
 * (`AiAgentRunTraceEntryDto` in packages/shared/src/types/aiAgentRuns.ts) —
 * there is nothing here to format. Rendering a start time is therefore out
 * of scope for this component; it needs a wire-level field added first.
 */
function TraceEntryRow({
  entry,
  index,
  t,
}: {
  entry: AiAgentRunTraceEntryDto;
  index: number;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <li data-testid={`run-detail-trace-entry-${index}`} className="flex flex-col gap-1 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={traceEntryBadgeClass(entry.kind)}>
          {traceKindLabel(t, entry.kind)}
        </span>
        <span className="font-medium">{entry.tool}</span>
        {entry.kind !== 'denied' && entry.action && (
          <span className="text-sm text-muted-foreground">{entry.action}</span>
        )}
      </div>

      {entry.kind === 'executed' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{traceResultLabel(t, entry.result)}</span>
          <span>·</span>
          <span>{formatDuration(entry.durationMs)}</span>
          {entry.execution && (
            <>
              <span>·</span>
              <span>{executionLabel(t, entry.execution)}</span>
            </>
          )}
          {entry.verification && (
            <>
              <span>·</span>
              <span>{verificationLabel(t, entry.verification)}</span>
            </>
          )}
          {entry.verifyDetail && <span className="w-full">{entry.verifyDetail}</span>}
          {(entry.actOpKey || entry.actTargetName) && (
            <span className="w-full" data-testid={`run-detail-trace-entry-${index}-target`}>
              {[entry.actOpKey, entry.actTargetName].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      )}

      {entry.kind === 'proposed' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {entry.downgradeReason && <span>{entry.downgradeReason}</span>}
          {entry.intentError && <span className="text-destructive">{entry.intentError}</span>}
          {entry.intentId && (
            <a
              href="/approvals"
              data-testid={`run-detail-intent-link-${entry.intentId}`}
              className="text-primary hover:underline"
            >
              {t('aiAgentsPage.runs.detail.trace.viewApproval')}
            </a>
          )}
        </div>
      )}

      {entry.kind === 'denied' && (
        <p className="text-xs text-muted-foreground">{entry.reason}</p>
      )}
    </li>
  );
}

/**
 * Phase 2 wave P2-2 (#4189) — the sweep-findings surfaces.
 *
 * Same leak-impossible contract as the trace above: `AiAgentRunSweepDto` is
 * the SAFE projection (packages/shared/src/types/aiAgentRuns.ts), so nothing
 * rendered here can be a raw tool input/output. `evidence` is the bounded
 * scalar map the finding schema enforces and is rendered as a `<dl>` of
 * term/value pairs (never `JSON.stringify`d, which is how an unexpectedly
 * nested value would end up dumped verbatim into the DOM) — a `<dl>` rather
 * than a flattened "k: v · k: v" string so a screen reader gets real
 * term/value structure instead of one opaque run of text.
 */
const SWEEP_SEVERITY_BADGE: Record<AiSweepSeverity, string> = {
  critical: badgeClass('danger', { size: 'sm' }),
  high: badgeClass('warning', { size: 'sm' }),
  medium: badgeClass('warning', { size: 'sm' }),
  low: badgeClass('info', { size: 'sm' }),
  info: badgeClass('neutral', { size: 'sm' }),
};

/**
 * Every `reason` a non-created sweep proposal can carry (the gate order in
 * `projectSweep`/`sweepProposals`, #4189 Task 7), keyed to itself so `satisfies
 * Record<SweepProposalReason, true>` fails to compile if this map ever falls
 * out of sync with the shared union (#4458) — a member added or removed from
 * `SweepProposalReason` without a matching update here is a missing/excess
 * property error, not a silent runtime gap.
 */
const SWEEP_PROPOSAL_REASON_TOKENS = {
  device_not_in_evidence: true,
  device_not_in_org: true,
  not_allowlisted: true,
  no_eligible_approvers: true,
  intent_error: true,
  max_actions_per_run: true,
} satisfies Record<SweepProposalReason, true>;

/**
 * Checked before the dynamic `t()` so an unrecognized token renders as itself
 * rather than as a raw `aiAgentsPage.runs.sweep.reasons.<token>` key path.
 */
const SWEEP_PROPOSAL_REASONS: readonly string[] = Object.keys(SWEEP_PROPOSAL_REASON_TOKENS);

/**
 * Checked before the dynamic `t()` so an unrecognized kind/severity (e.g. a
 * newer sweeper build reporting a kind this build's registry doesn't know
 * about yet) renders as the raw token rather than as an untranslated
 * `aiAgentsPage.runs.sweep.kinds.<token>`/`...severities.<token>` key path —
 * same contract as `SWEEP_PROPOSAL_REASONS` above.
 */
const SWEEP_KIND_TOKENS: readonly string[] = AI_SWEEP_KINDS;
const SWEEP_SEVERITY_TOKENS: readonly string[] = AI_SWEEP_SEVERITIES;

function sweepKindLabel(t: (key: string) => string, kind: AiSweepKind): string {
  if (!SWEEP_KIND_TOKENS.includes(kind)) return kind;
  return t(/* i18n-dynamic */ `aiAgentsPage.runs.sweep.kinds.${kind}`);
}

function sweepSeverityLabel(t: (key: string) => string, severity: AiSweepSeverity): string {
  if (!SWEEP_SEVERITY_TOKENS.includes(severity)) return severity;
  return t(/* i18n-dynamic */ `aiAgentsPage.runs.sweep.severities.${severity}`);
}

function sweepReasonLabel(t: (key: string) => string, reason: SweepProposalReason | null): string {
  if (!reason) return '—';
  if (!SWEEP_PROPOSAL_REASONS.includes(reason)) return reason;
  return t(/* i18n-dynamic */ `aiAgentsPage.runs.sweep.reasons.${reason}`);
}

/**
 * UI critique finding #2 — evidence keys the sweep loaders happen to use
 * (`knownExploited`, `mountPoint`, `osType`) are internal field names, not
 * something an operator should have to decode on a reading surface.
 *
 * Only the keys where sentence-casing produces the WRONG answer are curated
 * here — acronyms (`cveIds` → "Cve ids"), units (`freeGb` → "Free gb"), and
 * a handful whose plain-English name differs from the column
 * (`mountPoint` → "Volume"). Everything else falls through to
 * `sentenceCaseKey`, which turns any camelCase or snake_case key into
 * readable English on its own — a curated entry for those would be pure
 * translation debt.
 */
const EVIDENCE_LABELLED_KEYS: ReadonlySet<string> = new Set([
  'mountPoint', 'serviceName', 'configName',
  'usedPercent', 'percentUsed', 'freeGb', 'totalGb',
  'lastSeenAt', 'lastSeenDays', 'checkedAt',
  'cveIds', 'cveCount', 'osType', 'openCriticalCount',
  // Review finding — a per-finding CVE the model calls out by itself (not
  // the aggregate `cveIds`/`cveCount` a sweep loader emits) still needs a
  // curated label: `sentenceCaseKey`'s acronym fallback below cannot turn
  // "cveId" into "CVE" on its own without also mangling "Id" into "ID",
  // which the rest of the page spells lower-case (see `isOpaqueIdValue`).
  'cveId', 'cvssScore',
]);

/** Short tokens that read as gibberish once sentence-cased (`Cve`, `Ip`,
 *  `Mac`) because they are actually acronyms. Used only by the fallback
 *  below, for evidence keys with no entry in `EVIDENCE_LABELLED_KEYS` — a
 *  model can author evidence field names freely (see `sweepFindings.ts`),
 *  so this cannot be an exhaustive dictionary of every possible key, only of
 *  the short word-stems worth preserving in upper case. Deliberately a small,
 *  literal set rather than "any short word": acronym-casing an ordinary
 *  short English word (`auto`, `type`, `name`) would be just as wrong as the
 *  bug this fixes. */
const ACRONYM_WORDS: ReadonlySet<string> = new Set(['cve', 'cvss', 'kev', 'ip', 'mac', 'os', 'smart']);

/** `camelCase` / `snake_case` → `Sentence case`, upper-casing any word that
 *  matches `ACRONYM_WORDS` instead of folding it into the rest of the
 *  sentence (e.g. `ipAddress` → "IP address", not "Ip address"). */
function sentenceCaseKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .map((word) => (ACRONYM_WORDS.has(word) ? word.toUpperCase() : word));
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function evidenceLabel(t: (key: string) => string, key: string): string {
  if (EVIDENCE_LABELLED_KEYS.has(key)) {
    return t(/* i18n-dynamic */ `aiAgentsRuns.detail.evidence.labels.${key}`);
  }
  return sentenceCaseKey(key);
}

/** A bare uuid tells an operator nothing and cannot be acted on. The one
 *  identifier that CAN be turned into a destination is the device id, and
 *  that is already the Device column's link target — so every opaque id is
 *  dropped here rather than printed. `deviceVulnerabilityIds` arrives as a
 *  comma-joined list, hence the per-part test. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isOpaqueIdValue(value: string | number | boolean | null): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return value.split(',').every((part) => UUID_RE.test(part.trim()));
}

const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatEvidenceValue(t: (key: string) => string, value: string | number | boolean | null): string {
  if (value === null) return '—';
  // `common:labels.yes`/`.no` rather than a private pair: this is shared
  // vocabulary (locales/README.md), and minting a second copy would drift.
  if (typeof value === 'boolean') {
    return value ? t('common:labels.yes') : t('common:labels.no');
  }
  if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(value) : '—';
  if (ISO_DATE_TIME_RE.test(value)) return formatDateTime(value);
  if (ISO_DATE_RE.test(value)) return formatDate(value);
  return value;
}

/**
 * UI critique finding #4 — a sweep loader occasionally hands over the
 * LITERAL string `"null"`/`"undefined"` (a stringified missing value, not a
 * real JS `null`) or an empty string. `formatEvidenceValue` above only
 * special-cases real `null`; these string forms fell through to the raw
 * `return value` branch and rendered as visible "Error count: null" noise.
 * The row is dropped entirely rather than shown as "—" — a real `null`
 * already means "no value" and keeps showing the dash; this is only for the
 * string forms that were never a value in the first place.
 */
function isAbsentEvidenceString(value: string | number | boolean | null): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'null' || normalized === 'undefined';
}

/** The bounded scalar evidence map, rendered as `<dt>`/`<dd>` pairs — never a
 * JSON dump, and never a flattened "k: v" string a screen reader would read
 * as one undifferentiated run of text. */
function SweepEvidenceList({
  evidence,
  testId,
  t,
}: {
  evidence: AiAgentRunSweepFindingDto['evidence'];
  testId: string;
  t: (key: string) => string;
}) {
  const entries = Object.entries(evidence).filter(
    ([key, value]) =>
      // `deviceName`/`hostname` are excluded alongside `deviceId`: once
      // `SweepFindingDevice` falls back to one of them for the Device
      // column (finding #4 below), repeating it as a generic evidence row
      // would duplicate the same fact under a raw-looking key.
      key !== 'deviceId'
      && key !== 'deviceName'
      && key !== 'hostname'
      && !isOpaqueIdValue(value)
      && !isAbsentEvidenceString(value),
  );
  if (entries.length === 0) return null;
  return (
    <dl className="mt-1 space-y-0.5 text-xs" data-testid={testId}>
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-1">
          <dt className="text-muted-foreground">{evidenceLabel(t, key)}:</dt>
          <dd>{formatEvidenceValue(t, value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The findings are rendered twice — as table rows from `md` up, as a stacked
 * list below it (UI critique finding #7: at 390px the six-column table
 * collapsed to two visible columns and ~250px-tall rows). Tailwind's `hidden`
 * is `display:none`, so exactly one of the two is in the accessibility tree
 * at any viewport. The two variants share every sub-component below and
 * differ only in their test ids, which this table keeps in one place.
 */
type SweepVariant = 'row' | 'card';

interface SweepTestIds {
  finding: (index: number) => string;
  device: (index: number) => string;
  evidence: (index: number) => string;
  proposal: (index: number) => string;
  proposalLink: (index: number) => string;
  permissionsLink: (index: number) => string;
}

const SWEEP_TEST_IDS: Record<SweepVariant, SweepTestIds> = {
  row: {
    finding: (i) => `ai-agent-run-sweep-finding-${i}`,
    device: (i) => `ai-agent-run-sweep-finding-${i}-device`,
    evidence: (i) => `ai-agent-run-sweep-finding-${i}-evidence`,
    proposal: (i) => `ai-agent-run-sweep-finding-${i}-proposal`,
    proposalLink: (i) => `ai-agent-run-sweep-proposal-link-${i}`,
    permissionsLink: (i) => `ai-agent-run-sweep-permissions-link-${i}`,
  },
  card: {
    finding: (i) => `ai-agent-run-sweep-finding-card-${i}`,
    device: (i) => `ai-agent-run-sweep-finding-card-${i}-device`,
    evidence: (i) => `ai-agent-run-sweep-finding-card-${i}-evidence`,
    proposal: (i) => `ai-agent-run-sweep-finding-card-${i}-proposal`,
    proposalLink: (i) => `ai-agent-run-sweep-card-proposal-link-${i}`,
    permissionsLink: (i) => `ai-agent-run-sweep-card-permissions-link-${i}`,
  },
};

/**
 * UI critique finding #4 — the Device column showed an em dash even when the
 * sweep's own evidence carried a name for the device (`deviceName`, or
 * `hostname` for a loader that used the other convention); only the resolved
 * `finding.deviceHostname` join was ever consulted. Falls back to whichever
 * evidence key is present before giving up.
 */
function evidenceHostnameFallback(evidence: AiAgentRunSweepFindingDto['evidence']): string | null {
  const deviceName = evidence.deviceName;
  if (typeof deviceName === 'string' && deviceName.trim() !== '') return deviceName;
  const hostname = evidence.hostname;
  if (typeof hostname === 'string' && hostname.trim() !== '') return hostname;
  return null;
}

/** A finding's device, as a link to the device itself when the sweep resolved
 *  one — the id is otherwise a dead end (UI critique finding #2). */
function SweepFindingDevice({ finding }: { finding: AiAgentRunSweepFindingDto }) {
  const hostname = finding.deviceHostname ?? evidenceHostnameFallback(finding.evidence);
  if (!hostname) return <>—</>;
  if (!finding.deviceId) return <>{hostname}</>;
  return (
    <a href={`/devices/${finding.deviceId}`} className="text-primary hover:underline">
      {hostname}
    </a>
  );
}

/**
 * UI critique finding #3: a proposal that did NOT become an approval is the
 * one thing on this page an operator can act on, and it used to render as
 * muted grey text in the far-right column with nowhere to go. It now carries
 * warning tone, and the `not_allowlisted` case — the only reason with a
 * direct fix — links to the agent's own permissions.
 */
function sweepProposalToneClass(proposal: AiAgentRunSweepFindingDto['proposal']): string {
  if (proposal === null) return 'text-muted-foreground';
  if (proposal.disposition === 'intent_created') return '';
  return 'text-amber-700 dark:text-amber-400';
}

function SweepProposalContent({
  finding,
  index,
  agentId,
  ids,
  t,
}: {
  finding: AiAgentRunSweepFindingDto;
  index: number;
  agentId: string;
  ids: SweepTestIds;
  t: (key: string) => string;
}) {
  const { proposal } = finding;
  if (proposal === null) return <>—</>;
  if (proposal.disposition === 'intent_created') {
    return (
      <a href="/approvals" data-testid={ids.proposalLink(index)} className="text-primary hover:underline">
        {t('aiAgentsPage.runs.sweep.proposalCreated')}
      </a>
    );
  }
  return (
    <>
      <span>{sweepReasonLabel(t, proposal.reason)}</span>
      {proposal.reason === 'not_allowlisted' && (
        <a
          href={`/settings/ai-agents#agent=${agentId}`}
          data-testid={ids.permissionsLink(index)}
          className="ml-1.5 font-medium text-primary hover:underline"
        >
          {t('aiAgentsRuns.detail.sweep.reviewPermissions')}
        </a>
      )}
    </>
  );
}

function SweepFindingRow({
  finding,
  index,
  agentId,
  t,
}: {
  finding: AiAgentRunSweepFindingDto;
  index: number;
  agentId: string;
  t: (key: string) => string;
}) {
  const ids = SWEEP_TEST_IDS.row;

  return (
    <tr data-testid={ids.finding(index)} className="align-top">
      <td className="px-2 py-2 whitespace-nowrap">{sweepKindLabel(t, finding.kind)}</td>
      <td className="px-2 py-2">
        <span className={SWEEP_SEVERITY_BADGE[finding.severity] ?? badgeClass('neutral', { size: 'sm' })}>
          {sweepSeverityLabel(t, finding.severity)}
        </span>
      </td>
      <td className="px-2 py-2 text-muted-foreground" data-testid={ids.device(index)}>
        <SweepFindingDevice finding={finding} />
      </td>
      <td className="px-2 py-2 font-medium">{finding.title}</td>
      <td className="px-2 py-2 text-muted-foreground">
        <span>{finding.detail}</span>
        <SweepEvidenceList evidence={finding.evidence} testId={ids.evidence(index)} t={t} />
      </td>
      <td
        className={`px-2 py-2 ${sweepProposalToneClass(finding.proposal)}`}
        data-testid={ids.proposal(index)}
      >
        <SweepProposalContent finding={finding} index={index} agentId={agentId} ids={ids} t={t} />
      </td>
    </tr>
  );
}

/** The same finding, stacked, for viewports below `md`. A divided list rather
 *  than nested bordered cards — the sweep section is already a card. */
function SweepFindingCard({
  finding,
  index,
  agentId,
  t,
}: {
  finding: AiAgentRunSweepFindingDto;
  index: number;
  agentId: string;
  t: (key: string) => string;
}) {
  const ids = SWEEP_TEST_IDS.card;

  return (
    <li data-testid={ids.finding(index)} className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={SWEEP_SEVERITY_BADGE[finding.severity] ?? badgeClass('neutral', { size: 'sm' })}>
          {sweepSeverityLabel(t, finding.severity)}
        </span>
        <span className="text-xs text-muted-foreground">{sweepKindLabel(t, finding.kind)}</span>
        <span className="text-xs text-muted-foreground" data-testid={ids.device(index)}>
          <SweepFindingDevice finding={finding} />
        </span>
      </div>
      <p className="mt-1.5 text-sm font-medium">{finding.title}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{finding.detail}</p>
      <SweepEvidenceList evidence={finding.evidence} testId={ids.evidence(index)} t={t} />
      {/* Review finding — this used to render unconditionally: a bare "—"
          for a finding with no proposal at all (the table's other columns
          all sit under a header; this line had none), and no name for what
          kind of fact it was when a proposal WAS present. Reuse the table's
          own column header key rather than mint a second "Proposal" string,
          and drop the line entirely rather than print a dash — a finding
          the sweep judged fine as-is (`disk_pressure` at 94% is a finding,
          not necessarily an action) has nothing to report here. */}
      {finding.proposal !== null && (
        <p className={`mt-1.5 text-xs ${sweepProposalToneClass(finding.proposal)}`} data-testid={ids.proposal(index)}>
          <span className="font-medium text-foreground">{t('aiAgentsPage.runs.sweep.columns.proposal')}: </span>
          <SweepProposalContent finding={finding} index={index} agentId={agentId} ids={ids} t={t} />
        </p>
      )}
    </li>
  );
}

/**
 * Phase 2 wave P2-3 (#4190) — the weekly org narrative a `narrative`-profile
 * run produced (`AiAgentRunNarrativeDto`).
 *
 * Same leak-impossible contract as the sweep and trace sections above: the
 * DTO is the SAFE projection, so nothing here can be a raw tool payload. Two
 * rendering rules matter and are load-bearing:
 *
 *  - Every string lands as a TEXT NODE. React escapes those, so a bullet the
 *    model wrote can never become markup — `dangerouslySetInnerHTML` is
 *    forbidden on this surface, which is precisely why the DTO ships the
 *    structured `sections` rather than the derived markdown blob.
 *  - Section titles come from the DTO, not from this catalog. The SERVER
 *    attaches them (`NARRATIVE_SECTION_TITLES`), so the run detail and the
 *    generated PDF name the same eight sections identically — a second,
 *    locally translated set would drift from the customer-facing document.
 */
function NarrativeSectionBlock({
  section,
  index,
}: {
  section: NarrativeSection;
  index: number;
}) {
  return (
    <div data-testid={`ai-agent-run-narrative-section-${section.key}`} className="space-y-1">
      <h3 className="text-sm font-medium">{section.title}</h3>
      {section.bullets.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`ai-agent-run-narrative-section-${index}-empty`}>
          —
        </p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          {section.bullets.map((bullet, bulletIndex) => (
            <li key={bulletIndex}>{bullet}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function draftKindLabel(t: (key: string) => string, kind: 'reply' | 'resolution_note'): string {
  return kind === 'reply'
    ? t('aiAgentsPage.runs.triage.draftKinds.reply')
    : t('aiAgentsPage.runs.triage.draftKinds.resolutionNote');
}

/** Issue #4462 — literal switch (not a dynamic key) so the i18n key-usage
 *  scanner can see every key, same convention as `draftKindLabel` above. */
function skipItemLabel(t: (key: string) => string, item: TicketTriageSkip['item']): string {
  switch (item) {
    case 'fields': return t('aiAgentsPage.runs.triage.skipped.item.fields');
    case 'link': return t('aiAgentsPage.runs.triage.skipped.item.link');
    case 'note': return t('aiAgentsPage.runs.triage.skipped.item.note');
    case 'draft-reply': return t('aiAgentsPage.runs.triage.skipped.item.draftReply');
    case 'draft-resolution': return t('aiAgentsPage.runs.triage.skipped.item.draftResolution');
    default: return item;
  }
}

/** Same literal-switch convention as `skipItemLabel` just above. */
function skipReasonLabel(t: (key: string) => string, reason: TicketTriageSkip['reason']): string {
  switch (reason) {
    case 'no_fields_proposed': return t('aiAgentsPage.runs.triage.skipped.reason.noFieldsProposed');
    case 'below_confidence_floor': return t('aiAgentsPage.runs.triage.skipped.reason.belowConfidenceFloor');
    case 'human_set': return t('aiAgentsPage.runs.triage.skipped.reason.humanSet');
    case 'no_device_proposed': return t('aiAgentsPage.runs.triage.skipped.reason.noDeviceProposed');
    case 'device_already_linked': return t('aiAgentsPage.runs.triage.skipped.reason.deviceAlreadyLinked');
    case 'no_draft_reply': return t('aiAgentsPage.runs.triage.skipped.reason.noDraftReply');
    case 'no_draft_resolution': return t('aiAgentsPage.runs.triage.skipped.reason.noDraftResolution');
    case 'resolution_note_exists': return t('aiAgentsPage.runs.triage.skipped.reason.resolutionNoteExists');
    case 'max_actions_per_run': return t('aiAgentsPage.runs.triage.skipped.reason.maxActionsPerRun');
    case 'intent_error': return t('aiAgentsPage.runs.triage.skipped.reason.intentError');
    case 'ticket_not_found': return t('aiAgentsPage.runs.triage.skipped.reason.ticketNotFound');
    default: return reason;
  }
}

/**
 * P2-4 (#4191, Task 12) — a `triage`-profile run's ticket proposal
 * (`AiAgentRunTicketProposalDto`). Same safe-projection posture as the sweep
 * and narrative sections above: every field on this DTO is already
 * display-safe by construction (`mapTicketProposal`, runTrace.ts — named-field
 * projection, no raw tool payload).
 *
 * `intentIds` only names ids; the STATUS shown for each comes from the run's
 * own `intents` array (already fetched for the "Linked approvals" section
 * below) rather than being duplicated onto the proposal DTO — a live
 * cross-reference by id, falling back to the bare id if the run's intents
 * projection ever disagrees with it (defensive only; in practice
 * `intentIds` is populated FROM the same `action_intents` rows).
 *
 * UI critique finding #6: `fields.categoryId.value` is a raw internal
 * category UUID — the DTO carries no resolved category name anywhere
 * (`TicketTriageProposal` in packages/shared/src/types/ticketTriage.ts only
 * ever ships `{ value, confidence }`). Rather than leak that id to the user,
 * it is hidden; only the confidence is shown, with a note that the name
 * could not be resolved on this surface.
 */
function TicketProposalSection({
  proposal,
  intents,
  t,
}: {
  proposal: AiAgentRunTicketProposalDto;
  intents: AiAgentRunDetailDto['intents'];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const intentsById = new Map(intents.map((intent) => [intent.id, intent]));
  const hasFields = proposal.fields && (proposal.fields.categoryId || proposal.fields.priority);
  const hasDevice = proposal.device && (proposal.device.hostname || proposal.device.serial);

  return (
    <section data-testid="ai-agent-run-triage" className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.triage.title')}</h2>

      <p className="mt-2 text-sm" data-testid="ai-agent-run-triage-summary">
        {proposal.summary}
      </p>

      {hasFields && (
        <div className="mt-3 space-y-1" data-testid="ai-agent-run-triage-fields">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.fieldsTitle')}
          </h3>
          <ul className="space-y-1 text-sm">
            {proposal.fields?.categoryId && (
              <li data-testid="ai-agent-run-triage-field-categoryId">
                <span className="font-medium">{t('aiAgentsRuns.detail.triage.categoryLabel')}</span>
                {': '}
                <span className="text-muted-foreground">{t('aiAgentsRuns.detail.triage.categoryUnresolved')}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  {t('aiAgentsPage.runs.triage.confidence', {
                    value: Math.round(proposal.fields.categoryId.confidence * 100),
                  })}
                </span>
              </li>
            )}
            {proposal.fields?.priority && (
              <li data-testid="ai-agent-run-triage-field-priority">
                <span className="font-medium">{t('aiAgentsPage.runs.triage.fields.priority')}</span>
                {': '}
                <span>{proposal.fields.priority.value}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  {t('aiAgentsPage.runs.triage.confidence', {
                    value: Math.round(proposal.fields.priority.confidence * 100),
                  })}
                </span>
              </li>
            )}
          </ul>
        </div>
      )}

      {hasDevice && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="ai-agent-run-triage-device">
          {t('aiAgentsPage.runs.triage.device', {
            value: [proposal.device?.hostname, proposal.device?.serial].filter(Boolean).join(' / '),
          })}
        </p>
      )}

      {proposal.draftReply && (
        <div className="mt-3" data-testid="ai-agent-run-triage-draft-reply">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.draftReplyTitle')}
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{proposal.draftReply}</p>
        </div>
      )}

      {proposal.draftResolutionNote && (
        <div className="mt-3" data-testid="ai-agent-run-triage-draft-resolution">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.draftResolutionTitle')}
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{proposal.draftResolutionNote}</p>
        </div>
      )}

      {proposal.notes && proposal.notes.length > 0 && (
        <div className="mt-3" data-testid="ai-agent-run-triage-notes">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.notesTitle')}
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {proposal.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {proposal.intentIds && proposal.intentIds.length > 0 && (
        <div className="mt-3" data-testid="ai-agent-run-triage-intents">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.intentsTitle')}
          </h3>
          <ul className="mt-1 space-y-1 text-sm">
            {proposal.intentIds.map((intentId) => {
              const intent = intentsById.get(intentId);
              return (
                <li
                  key={intentId}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`ai-agent-run-triage-intent-${intentId}`}
                >
                  <span className="font-medium">{intent?.actionName ?? intentId}</span>
                  <span className="text-xs text-muted-foreground">
                    {intent ? intentStatusLabel(t, intent.status) : t('aiAgentsPage.runs.triage.intentUnknown')}
                  </span>
                </li>
              );
            })}
          </ul>
          {/* #4468: every intentId above resolves to the SAME /approvals
              inbox — a link repeated once per row added nothing over a
              single link for the whole batchable set, and read as N
              separate destinations rather than one. */}
          <a
            href="/approvals"
            data-testid="ai-agent-run-triage-intents-approvals-link"
            className="mt-1 inline-block text-primary hover:underline"
          >
            {t('aiAgentsPage.runs.detail.intents.viewAll')}
          </a>
        </div>
      )}

      {proposal.draftsWritten && proposal.draftsWritten.length > 0 && (
        <div className="mt-3" data-testid="ai-agent-run-triage-drafts-written">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.draftsWrittenTitle')}
          </h3>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {proposal.draftsWritten.map((draft) => (
              <li key={draft.draftId} data-testid={`ai-agent-run-triage-draft-${draft.draftId}`}>
                {draftKindLabel(t, draft.kind)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {proposal.skipped && proposal.skipped.length > 0 && (
        <div className="mt-3" data-testid="ai-agent-run-triage-skipped">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.skippedTitle')}
          </h3>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {proposal.skipped.map((skip, index) => (
              <li
                key={`${skip.item}-${index}`}
                data-testid={`ai-agent-run-triage-skipped-${skip.item}`}
              >
                <span className="font-medium text-foreground">{skipItemLabel(t, skip.item)}</span>
                {': '}
                {skipReasonLabel(t, skip.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ExposureBudgetCard({ orgId, kind, t }: { orgId: string; kind: string; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const [budget, setBudget] = useState<ExposureBudgetDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setUnavailable(false);
      try {
        const params = new URLSearchParams({ orgId, kind });
        const response = await fetchWithAuth(`/ai/agents/exposure-budget?${params.toString()}`);
        if (cancelled) return;
        if (!response.ok) {
          setUnavailable(true);
          return;
        }
        const body = (await response.json()) as { data?: ExposureBudgetDto };
        if (cancelled) return;
        if (!body.data) {
          setUnavailable(true);
          return;
        }
        setBudget(body.data);
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, kind]);

  // UI critique finding #5: a readout of "0 of 0 devices" is not a fact worth
  // a card — the org has no recorded exposure and no allowance in the window,
  // so every figure below it is zero. Drop the whole card rather than print a
  // row of zeroes the operator has to interpret.
  if (!loading && !unavailable && budget && budget.distinctDevices === 0 && budget.allowance === 0) {
    return null;
  }

  return (
    <div data-testid="run-detail-budget-card" className="rounded-lg border bg-card p-4">
      {/* Sibling to the other top-level sections (sweep/narrative/trace/
          ledger/intents all use h2) — was h3, which produced an h1 → h3 → h2
          document-outline gap (critique finding #5). */}
      <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.detail.budget.title')}</h2>

      {loading && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="run-detail-budget-loading">
          {t('aiAgentsPage.runs.detail.budget.loading')}
        </p>
      )}

      {!loading && unavailable && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="run-detail-budget-unavailable">
          {t('aiAgentsPage.runs.detail.budget.unavailable')}
        </p>
      )}

      {!loading && !unavailable && budget && (
        <div className="mt-2 space-y-1 text-sm">
          <p>{t('aiAgentsPage.runs.detail.budget.devices', { count: budget.distinctDevices, allowance: budget.allowance })}</p>
          <p>
            {t('aiAgentsPage.runs.detail.budget.decisionsToday', {
              count: budget.policyDecisionsToday,
              max: budget.maxPolicyDecisionsPerDay,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('aiAgentsPage.runs.detail.budget.caption', { hours: budget.windowHours })}
          </p>
          {budget.accountingMode === 'partial' && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="run-detail-budget-partial-note">
              {t('aiAgentsPage.runs.detail.budget.partialNote')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Wave 6 PR 1 (#3828) — the execution-trace run detail: `GET
 * /ai/agents/runs/:runId`. Renders the stitched `AiAgentRunDetailDto` — the
 * run header, the SAFE trace timeline, the tool-execution ledger, linked
 * approvals, and (when the run's agent kind is still resolvable) the org's
 * exposure-budget readout. Nothing on this page can ever be a raw tool
 * input/output — the DTO union makes that impossible by construction (see
 * `packages/shared/src/types/aiAgentRuns.ts`).
 *
 * UI critique fix: while `run.status` is still live (queued/running/
 * awaiting_approval), the page silently re-fetches every
 * `DETAIL_POLL_INTERVAL_MS` — without flipping the full-page `loading` state,
 * which would otherwise blank the whole page every 5 seconds — so an
 * in-flight run's trace/ledger/status update without a manual reload.
 * Polling stops once the run reaches a terminal status and pauses while the
 * tab is hidden.
 */
export default function RunDetailPage({ runId }: RunDetailPageProps) {
  const { t } = useTranslation('settings');
  const [run, setRun] = useState<AiAgentRunDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notFound, setNotFound] = useState(false);
  const [downloadingNarrative, setDownloadingNarrative] = useState(false);
  const [narrativeDownloadError, setNarrativeDownloadError] = useState<string>();

  // Monotonic request id shared by `load` and `refreshSilently` (review
  // finding P2-2, #4187 critique — same pattern as RunsListPage's
  // `fetchPage`/`pollListSilently`): whichever of the two started most
  // recently wins, so a poll response that resolves after a newer `load()`
  // (e.g. the user hit Retry, or the runId changed) can't regress the page,
  // and out-of-order poll responses can't either.
  const requestIdRef = useRef(0);
  // Guards every setState here against firing after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setLoading(true);
    setError(undefined);
    setNotFound(false);
    try {
      const response = await fetchWithAuth(`/ai/agents/runs/${runId}`);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (response.status === 404) {
        setNotFound(true);
        return;
      }
      if (!response.ok) {
        setError(t('aiAgentsPage.runs.detail.errors.load'));
        return;
      }
      const body = (await response.json()) as { data?: AiAgentRunDetailDto };
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (!body.data) {
        setError(t('aiAgentsPage.runs.detail.errors.load'));
        return;
      }
      setRun(body.data);
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError(t('aiAgentsPage.runs.detail.errors.load'));
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false);
    }
  }, [runId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Background poll: refetches the run detail without touching `loading` (a
   * silent refresh — flipping `loading` here would blank the whole page on
   * every tick). Best-effort: a failed poll just tries again next tick,
   * leaving whatever is currently on screen alone. Shares `requestIdRef`
   * with `load` (review finding P2-2) so an older response landing after a
   * newer one — from either function — is discarded instead of overwriting
   * fresher data; `mountedRef` guards against setting state after unmount.
   */
  const refreshSilently = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    try {
      const response = await fetchWithAuth(`/ai/agents/runs/${runId}`);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (!response.ok) return;
      const body = (await response.json()) as { data?: AiAgentRunDetailDto };
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (body.data) setRun(body.data);
    } catch {
      // Best-effort background refresh; keep showing the last good data.
    }
  }, [runId]);

  useEffect(() => {
    if (!run || !isLiveRunStatus(run.status)) return undefined;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSilently();
    }, DETAIL_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [run?.status, refreshSilently]);

  /**
   * UI critique finding #7 — the browser tab title was a static "Run Detail"
   * (set in the Astro page shell) no matter which run was open, so a user
   * with several run tabs open couldn't tell them apart. Set once the run
   * has loaded; no [id].astro-level i18n precedent exists for this title to
   * follow (checked: every AI Agents page passes a hardcoded English
   * `DashboardLayout title`), so the static shell title is left alone and
   * this effect overwrites it as soon as data is available.
   */
  useEffect(() => {
    if (!run) return;
    const agent = run.agentName ?? t('aiAgentsPage.runs.noAgent');
    const started = run.startedAt ? formatDate(run.startedAt) : '—';
    document.title = t('aiAgentsRuns.detail.pageTitle', { agent, started });
  }, [run, t]);

  /**
   * Phase 2 wave P2-3 (#4190) — "Download PDF" on the narrative section.
   *
   * The report-run download route answers JSON (`{ type, format, data }`) and
   * authenticates from the `Authorization` header only, so a plain `<a href>`
   * to `narrative.downloadPath` is doubly dead: an unauthenticated browser
   * navigation 401s, and an authenticated one would save the raw snapshot
   * instead of a PDF. Mirror `ReportsList`'s "Open latest": fetch the snapshot
   * with the bearer token, then render the PDF client-side via jsPDF.
   *
   * Read-only, so no `runAction` wrapper — failure surfaces inline next to the
   * button (the same shape `ReportsList` uses for its download errors).
   */
  const handleDownloadNarrative = useCallback(async () => {
    const reportRunId = run?.narrative?.reportRunId;
    if (!reportRunId) return;
    setDownloadingNarrative(true);
    setNarrativeDownloadError(undefined);
    try {
      const response = await fetchWithAuth(`/reports/runs/${reportRunId}/download`);
      if (!response.ok) {
        throw new Error(t('aiAgentsPage.runs.narrative.downloadFailed'));
      }
      const payload = (await response.json()) as {
        type?: string;
        data?: { rows?: unknown[]; summary?: unknown };
      };
      await exportReport(payload.data?.rows ?? [], {
        format: 'pdf',
        reportType: payload.type ?? 'ai_org_narrative',
        timezone: getBrowserTimezone(),
        summary: payload.data?.summary as OrgNarrativeReportSummary | undefined,
      });
    } catch {
      setNarrativeDownloadError(t('aiAgentsPage.runs.narrative.downloadFailed'));
    } finally {
      setDownloadingNarrative(false);
    }
  }, [run, t]);

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="run-detail-loading">
        {t('aiAgentsPage.runs.detail.loading')}
      </p>
    );
  }

  if (notFound) {
    return (
      <EmptyState
        testId="run-detail-not-found"
        title={t('aiAgentsPage.runs.detail.notFound')}
        description={t('aiAgentsRuns.detail.notFoundDescription')}
        secondary={
          <a href="/ai-agents/runs" className="text-primary hover:underline">
            {t('aiAgentsPage.runs.detail.back')}
          </a>
        }
      />
    );
  }

  if (error || !run) {
    return (
      <div data-testid="run-detail-error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error ?? t('aiAgentsPage.runs.detail.errors.load')}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('aiAgentsPage.runs.retry')}
        </button>
      </div>
    );
  }

  const durationMs = run.startedAt && run.finishedAt
    ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
    : null;
  const runIsLive = isLiveRunStatus(run.status);

  /**
   * UI critique finding #1c — everything this run left for a human to look
   * at: sweep findings and tool calls it proposed but could not run.
   * `no_action` is computed from the run's own remediation outcome, so a
   * sweep that found six problems and proposed nothing it was allowed to
   * execute still rolls up as "no action" — which the header must not
   * present as "nothing to see here".
   *
   * Review finding #6: a `denied` trace entry is NOT a finding — for a
   * read-only profile (verdict/sweep/narrative/triage) it's the guardrail
   * working as intended, logged for every mutating tool the model even
   * attempted (`runLoop.ts`'s `enforceReadOnlyProfile`). Counting it here
   * inflated "N findings to review" with denials the operator never needs to
   * act on; a `proposed` entry (one the run WOULD have executed if it had
   * permission/budget) is the only trace kind that belongs alongside sweep
   * findings.
   */
  // Server-computed by the same helper the runs list uses
  // (`services/aiAgents/runFindings.ts`), so the two surfaces cannot badge
  // one run with different numbers.
  const findingsToReview = run.findingsToReview;
  // Same rule as the runs list's `findingsOverrideActive`: any verdict that
  // is not already an attention-tone one understates a run that left
  // findings behind, so the findings count takes the badge and the verdict
  // becomes secondary text.
  const verdictUnderstatesFindings =
    findingsToReview > 0 && verdictTone(run.runVerdict ?? '') !== 'danger';

  /**
   * UI critique finding #2 — "Execution trace" and "Tool executions" can
   * render the exact same single row under two different status
   * vocabularies (an `executed` trace kind vs. an `AiToolStatus`). When
   * every ledger row lines up 1:1, in order, with an `executed` trace entry
   * for the same tool, the ledger collapses under the trace instead of
   * repeating it. Any mismatch (a ledger row the trace lost, reordering, a
   * different tool) falls back to rendering both in full — this is a
   * display-only convenience, never a claim that the two are semantically
   * identical.
   */
  const executedTraceTools = run.trace
    .filter((entry): entry is Extract<AiAgentRunTraceEntryDto, { kind: 'executed' }> => entry.kind === 'executed')
    .map((entry) => entry.tool);
  const ledgerMatchesTrace =
    run.ledger.length > 0
    && executedTraceTools.length === run.ledger.length
    && executedTraceTools.every((tool, index) => tool === run.ledger[index].toolName);

  /**
   * UI critique finding #5 — the exposure budget is a per-device allowance.
   * A run that never touched a device (a ticket-triage or narrative run) has
   * no exposure to report, and the card rendered "0 of 0 devices".
   */
  const runTouchedDevices = run.deviceId !== null
    || (run.sweep?.findings.some((finding) => finding.deviceId !== null) ?? false);

  return (
    <div className="space-y-6" data-testid="run-detail-page">
      <a href="/ai-agents/runs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('aiAgentsPage.runs.detail.back')}
      </a>

      <div data-testid="run-detail-header" className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Bot className="h-5 w-5 text-muted-foreground" />
          {/* UI critique finding #7 — the h1 used to be the bare agent name
              (indistinguishable from a device/org page's own h1), with no
              visible sense of WHICH run this is beyond the URL. */}
          <h1 className="text-xl font-semibold tracking-tight">
            {t('aiAgentsRuns.detail.header.title', { agent: run.agentName ?? t('aiAgentsPage.runs.noAgent') })}
          </h1>
          <span className="text-sm font-normal text-muted-foreground" data-testid="run-detail-header-started">
            <span className="sr-only">{t('aiAgentsRuns.detail.header.startedLabel')}</span>
            {run.startedAt ? formatTime(run.startedAt) : '—'}
          </span>
          <span
            className={badgeClass(runStatusTone(run.status), { size: 'sm' })}
            aria-live={runIsLive ? 'polite' : undefined}
          >
            {statusLabel(t, run.status)}
          </span>
          {runIsLive && <LiveIndicator label={t('aiAgentsRuns.live.label')} />}
          {/* Review finding #7: `run-detail-verdict-badge` is a stable
              wrapper present in BOTH branches, not just the plain-verdict
              one — a consumer that always looks for "the verdict badge" must
              never see it vanish just because the findings override fired.
              The findings badge keeps its own nested testid for callers that
              specifically want to assert the override is showing. */}
          <span data-testid="run-detail-verdict-badge">
            {verdictUnderstatesFindings ? (
              <span data-testid="run-detail-findings-badge" className={badgeClass('warning', { size: 'sm' })}>
                {t('aiAgentsRuns.detail.findings.badge', { count: findingsToReview })}
              </span>
            ) : (
              <span className={badgeClass(verdictTone(run.runVerdict ?? ''), { size: 'sm' })}>
                {verdictLabel(t, run.runVerdict)}
              </span>
            )}
          </span>
          {/* P2-4 (#4191, Task 12) — the detail DTO carries no `profile`
              field (unlike the list item), so `ticketProposal !== null` is
              the discriminator, same as the sweep/narrative sections below
              gating on their own null-checked field. */}
          {run.ticketProposal && (
            <span data-testid="run-detail-profile-triage" className={badgeClass('muted', { size: 'sm' })}>
              {t('aiAgentsPage.runs.profile.triage')}
            </span>
          )}
        </div>

        {/* The status row's supporting line: how long the run took, plus the
            machine verdict when the badge above had to override it (UI
            critique findings #1c and #4). */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1" data-testid="run-detail-header-duration">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{t('aiAgentsPage.runs.detail.labels.duration')}</span>
            {formatDuration(durationMs)}
          </span>
          {/* UI critique finding #8 — the verdict badge above and this
              demoted-verdict line sat with no connective, reading as two
              unrelated facts rather than "the machine's own call, which the
              findings above override". */}
          {verdictUnderstatesFindings && (
            <span data-testid="run-detail-verdict-secondary">
              {t('aiAgentsRuns.detail.header.machineVerdict', { verdict: verdictLabel(t, run.runVerdict) })}
            </span>
          )}
        </div>

        {/* UI critique finding #1 — the summary at `max-w-prose` inside the
            full-width header card left ~660px of dead space beside it at
            `lg`. Two-column the body there: summary left, metadata dl
            right — only when there IS a summary to sit beside; a
            summary-less run keeps the dl at full width. */}
        <div
          data-testid="run-detail-header-body"
          className={run.summary ? 'mt-4 lg:flex lg:items-start lg:gap-8' : ''}
        >
          {run.summary && (
            <section className="lg:max-w-prose lg:flex-1" aria-labelledby="run-detail-summary-heading">
              <h2
                id="run-detail-summary-heading"
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t('aiAgentsRuns.detail.summary.title')}
              </h2>
              <div
                className="mt-1.5 max-w-prose text-sm leading-relaxed text-foreground"
                data-testid="run-detail-summary"
              >
                <RunSummaryMarkdown markdown={run.summary} />
              </div>
            </section>
          )}

          <dl
            data-testid="run-detail-meta"
            className={`grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4 ${
              run.summary ? 'mt-4 lg:mt-0 lg:w-72 lg:flex-none lg:grid-cols-2' : 'mt-4'
            }`}
          >
            <div>
              <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.labels.device')}</dt>
              <dd>{run.deviceHostname ?? t('aiAgentsPage.runs.detail.labels.noDevice')}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.labels.trigger')}</dt>
              <dd>{triggerLabel(t, run.triggerKind)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.labels.cost')}</dt>
              <dd>{formatCurrency(run.costCents / 100)}</dd>
            </div>
            {/* Duration lives in the status row above (UI critique finding
                #4) — repeating it here would double-mark the same fact. */}
            <div>
              <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.labels.queuedAt')}</dt>
              <dd>{formatDateTime(run.queuedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.labels.startedAt')}</dt>
              <dd>{run.startedAt ? formatDateTime(run.startedAt) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.labels.finishedAt')}</dt>
              <dd>{run.finishedAt ? formatDateTime(run.finishedAt) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.labels.turnCount')}</dt>
              <dd>{formatNumber(run.turnCount)}</dd>
            </div>
          </dl>
        </div>

        {/* Wave 6 PR 4 (#3828, Task 4) — anomaly-triggered runs are
            device-bound (unlike ticket runs), so `deviceId` is always set
            alongside `anomalyIncidentId` in practice; the guard covers the
            same "moved/deleted reads as absent" edge case the API applies. */}
        {run.anomalyIncidentId && run.deviceId && (
          <a
            href={`/devices/${run.deviceId}#anomalies`}
            data-testid="run-detail-anomaly-link"
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-sky-700 hover:underline dark:text-sky-400"
          >
            {t('aiAgentsPage.runs.detail.anomalyLink')}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}

        {(run.budgetExceeded || run.wallClockExceeded || run.maxTurnsExceeded) && (
          <div className="mt-3 flex flex-wrap gap-2" data-testid="run-detail-flags">
            {run.budgetExceeded && (
              <span className={badgeClass('warning', { size: 'sm' })}>
                {t('aiAgentsPage.runs.detail.flags.budgetExceeded')}
              </span>
            )}
            {run.wallClockExceeded && (
              <span className={badgeClass('warning', { size: 'sm' })}>
                {t('aiAgentsPage.runs.detail.flags.wallClockExceeded')}
              </span>
            )}
            {run.maxTurnsExceeded && (
              <span className={badgeClass('warning', { size: 'sm' })}>
                {t('aiAgentsPage.runs.detail.flags.maxTurnsExceeded')}
              </span>
            )}
          </div>
        )}
      </div>

      {run.orgId && run.agentKind && runTouchedDevices && (
        <ExposureBudgetCard orgId={run.orgId} kind={run.agentKind} t={t} />
      )}

      {/* Phase 2 wave P2-4 (#4191, Task 12) — a `triage`-profile run's
          ticket proposal. Null for every other profile, so the whole
          section is absent rather than empty for them (same contract as
          the sweep/narrative sections below). */}
      {run.ticketProposal && (
        <TicketProposalSection proposal={run.ticketProposal} intents={run.intents} t={t} />
      )}

      {/* Phase 2 wave P2-2 (#4189) — a `sweep`-profile run's findings. Null
          for every `full`/`verdict`-profile run, so the whole section is
          absent rather than empty for them. */}
      {run.sweep && (
        <section data-testid="ai-agent-run-sweep" className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.sweep.title')}</h2>

          {/* UI critique finding #1 — this used to be a single comma-joined
              sentence ("Checks: a, b, c, …") that ran to ~220ch for a
              six-check sweep. A wrapped chip row reads at a glance and never
              needs a measure cap. */}
          {run.sweep.kinds.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="ai-agent-run-sweep-kinds">
              <span className="text-xs font-medium text-muted-foreground">
                {t('aiAgentsRuns.detail.sweep.checksLabel')}
              </span>
              {run.sweep.kinds.map((kind) => (
                <span key={kind} className={badgeClass('neutral', { size: 'sm' })}>
                  {sweepKindLabel(t, kind)}
                </span>
              ))}
            </div>
          )}

          {/* UI critique finding #1 — the summary had no measure cap and ran
              to ~188ch lines at the header card's full width. */}
          <p className="mt-2 max-w-prose text-sm" data-testid="ai-agent-run-sweep-summary">
            {run.sweep.summary}
          </p>

          {run.sweep.evidenceTruncated && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid="ai-agent-run-sweep-truncated">
              {t('aiAgentsPage.runs.sweep.evidenceTruncated')}
            </p>
          )}

          {run.sweep.findings.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('aiAgentsPage.runs.sweep.empty')}</p>
          ) : (
            <>
              {/* Below `md` the six-column table degraded into two visible
                  columns behind a horizontal scrollbar (UI critique finding
                  #7); the stacked list carries the same finding in reading
                  order instead. Exactly one of the two is displayed — and
                  therefore exposed to assistive tech — at any viewport. */}
              <ul className="mt-3 divide-y md:hidden" data-testid="ai-agent-run-sweep-finding-cards">
                {run.sweep.findings.map((finding, index) => (
                  <SweepFindingCard key={index} finding={finding} index={index} agentId={run.agentId} t={t} />
                ))}
              </ul>
              <div
                className="mt-3 hidden overflow-x-auto md:block"
                data-testid="ai-agent-run-sweep-findings-table-wrapper"
              >
                <table className="min-w-full divide-y text-sm" data-testid="ai-agent-run-sweep-findings">
                  <caption className="sr-only">{t('aiAgentsRuns.detail.sweep.caption')}</caption>
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-2">{t('aiAgentsPage.runs.sweep.columns.kind')}</th>
                      <th className="px-2 py-2">{t('aiAgentsPage.runs.sweep.columns.severity')}</th>
                      <th className="px-2 py-2">{t('aiAgentsPage.runs.sweep.columns.device')}</th>
                      <th className="px-2 py-2">{t('aiAgentsPage.runs.sweep.columns.title')}</th>
                      <th className="px-2 py-2">{t('aiAgentsPage.runs.sweep.columns.detail')}</th>
                      <th className="px-2 py-2">{t('aiAgentsPage.runs.sweep.columns.proposal')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {run.sweep.findings.map((finding, index) => (
                      <SweepFindingRow key={index} finding={finding} index={index} agentId={run.agentId} t={t} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {/* Phase 2 wave P2-3 (#4190) — a `narrative`-profile run's weekly org
          narrative. Null for every full/verdict/sweep run, so the whole
          section is absent rather than empty for them. */}
      {run.narrative && (
        <section data-testid="ai-agent-run-narrative" className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.narrative.title')}</h2>

          <p className="mt-2 text-sm font-medium" data-testid="ai-agent-run-narrative-headline">
            {run.narrative.headline}
          </p>

          {run.narrative.periodStart && run.narrative.periodEnd && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="ai-agent-run-narrative-period">
              {t('aiAgentsPage.runs.narrative.period', {
                // Date-only: the window is a calendar week, so a wall-clock
                // time on either end is noise the reader has to skip past.
                start: formatDate(run.narrative.periodStart),
                end: formatDate(run.narrative.periodEnd),
              })}
            </p>
          )}

          {run.narrative.contextTruncated && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid="ai-agent-run-narrative-truncated">
              {t('aiAgentsPage.runs.narrative.truncatedNote')}
            </p>
          )}

          <div className="mt-3 space-y-3" data-testid="ai-agent-run-narrative-sections">
            {run.narrative.sections.map((section, index) => (
              <NarrativeSectionBlock key={section.key} section={section} index={index} />
            ))}
          </div>

          {run.narrative.reportRunId && (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <a
                href="/reports"
                data-testid="ai-agent-run-narrative-report-link"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                {t('aiAgentsPage.runs.narrative.openReport')}
                <ExternalLink className="h-3 w-3" />
              </a>
              <button
                type="button"
                onClick={() => void handleDownloadNarrative()}
                disabled={downloadingNarrative}
                data-testid="ai-agent-run-narrative-download"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline disabled:opacity-50"
              >
                {downloadingNarrative ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
                {t('aiAgentsPage.runs.narrative.download')}
              </button>
            </div>
          )}

          {narrativeDownloadError && (
            <p className="mt-2 text-xs text-destructive" data-testid="ai-agent-run-narrative-download-error">
              {narrativeDownloadError}
            </p>
          )}
        </section>
      )}

      <div className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.detail.trace.title')}</h2>
        {/* UI critique finding #6: "Execution trace" and "Tool executions" can
            render the same single row, so each says what it is FOR. Only when
            populated — the empty state already explains the absence, and
            saying both would double-mark it. */}
        {run.trace.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="run-detail-trace-description">
            {t('aiAgentsRuns.detail.trace.description')}
          </p>
        )}
        {run.trace.length === 0 ? (
          <InCardEmpty
            testId="run-detail-trace-empty"
            title={t('aiAgentsPage.runs.detail.trace.empty')}
            description={t('aiAgentsRuns.detail.trace.emptyDescription')}
          />
        ) : (
          <ul data-testid="run-detail-trace" className="mt-2">
            {run.trace.map((entry, index) => (
              <TraceEntryRow key={`${entry.kind}-${index}`} entry={entry} index={index} t={t} />
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.detail.ledger.title')}</h2>
        {run.ledger.length === 0 ? (
          <InCardEmpty
            testId="run-detail-ledger-empty"
            title={t('aiAgentsPage.runs.detail.ledger.empty')}
            description={t('aiAgentsRuns.detail.ledger.emptyDescription')}
          />
        ) : ledgerMatchesTrace ? (
          // Finding #2 — every row here already appeared, in the same
          // order, as an `executed` trace entry above. Collapsed rather
          // than duplicated; still fully present for anyone who opens it.
          <details className="mt-2" data-testid="run-detail-ledger-details">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t('aiAgentsRuns.detail.ledger.collapsedSummary', { count: run.ledger.length })}
            </summary>
            <LedgerTable ledger={run.ledger} t={t} />
          </details>
        ) : (
          <>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="run-detail-ledger-description">
              {t('aiAgentsRuns.detail.ledger.description')}
            </p>
            <LedgerTable ledger={run.ledger} t={t} />
          </>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.detail.intents.title')}</h2>
        {run.intents.length === 0 ? (
          <InCardEmpty
            testId="run-detail-intents-empty"
            title={t('aiAgentsPage.runs.detail.intents.empty')}
            description={t('aiAgentsRuns.detail.intents.emptyDescription')}
          />
        ) : (
          <ul data-testid="run-detail-intents" className="mt-2 space-y-1 text-sm">
            {run.intents.map((intent) => (
              <li key={intent.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{intent.actionName}</span>
                <span className="text-xs text-muted-foreground">{intentStatusLabel(t, intent.status)}</span>
                <a href="/approvals" className="text-primary hover:underline">
                  {t('aiAgentsPage.runs.detail.intents.viewAll')}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
