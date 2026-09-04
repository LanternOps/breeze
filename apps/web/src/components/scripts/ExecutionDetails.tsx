import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronDown, ChevronUp, Copy, Check, Loader2, Terminal, AlertOctagon, ListChecks, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import type { ScriptExecution, ScriptCustomFieldWriteResult } from './ExecutionHistory';
import { executionDetailStatusConfig as statusConfig } from './executionStatus';

type ExecutionDetailsProps = {
  execution: ScriptExecution;
  isOpen: boolean;
  onClose: () => void;
  timezone?: string;
  // #4885 — "Run again": re-open the execute flow pre-filled with this
  // execution's device + parameters. Omitted entirely (no button rendered)
  // where the host page has nowhere to send it.
  onRunAgain?: (execution: ScriptExecution) => void;
};

function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '-';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatDateTime(dateString: string, timezone?: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return formatUserDateTime(date, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: tz
  });
}

function normalizeOutput(raw: string): string {
  let s = raw;
  // Strip surrounding quotes from double-serialized JSON strings
  if (s.startsWith('"') && s.endsWith('"')) {
    try { s = JSON.parse(s); } catch { /* not valid JSON, leave as-is */ }
  }
  // Convert literal escape sequences to actual characters
  s = s.replace(/\\r\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return s;
}

export function OutputSection({
  title,
  content,
  icon: Icon,
  defaultOpen = true,
  variant = 'default'
}: {
  title: string;
  content?: string;
  icon: typeof Terminal;
  defaultOpen?: boolean;
  variant?: 'default' | 'error';
}) {
  const { t } = useTranslation('scripts');
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const normalized = content ? normalizeOutput(content) : content;

  const handleCopy = async () => {
    if (!normalized) return;
    try {
      await navigator.clipboard.writeText(normalized!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const isEmpty = !normalized || normalized.trim() === '';

  return (
    <div className={cn(
      'rounded-md border',
      variant === 'error' && normalized && 'border-destructive/40'
    )}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex w-full items-center justify-between px-4 py-3 text-left transition',
          isOpen ? 'border-b' : '',
          variant === 'error' && normalized ? 'bg-destructive/5' : 'bg-muted/20'
        )}
      >
        <div className="flex items-center gap-2">
          <Icon className={cn(
            'h-4 w-4',
            variant === 'error' && normalized ? 'text-destructive' : 'text-muted-foreground'
          )} />
          <span className={cn(
            'text-sm font-medium',
            variant === 'error' && normalized && 'text-destructive'
          )}>
            {title}
          </span>
          {isEmpty && (
            <span className="text-xs text-muted-foreground">{t('executionDetails.output.emptyMarker')}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isEmpty && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleCopy();
              }}
              className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted"
              title={t('executionDetails.actions.copyToClipboard')}
            >
              {copied ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <Copy className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          )}
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>
      {isOpen && (
        <div className="p-4">
          {isEmpty ? (
            <p className="text-sm text-muted-foreground italic">{t('executionDetails.output.noOutput')}</p>
          ) : (
            <pre className={cn(
              'overflow-x-auto rounded-md p-4 text-sm font-mono whitespace-pre-wrap wrap-break-word',
              variant === 'error' ? 'bg-destructive/5 text-destructive' : 'bg-muted/40 text-foreground'
            )}>
              {normalized}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * #2698 — the per-run outcome of the script custom-field write-back. Renders
 * nothing when the execution emitted no `::breeze:custom-fields::` marker
 * (`result` is null/undefined). Rejections are always shown when present,
 * even if nothing was applied — a silently-rejected write is exactly the
 * failure mode this panel exists to surface.
 */
export function CustomFieldWriteSummarySection({
  result
}: {
  result?: ScriptCustomFieldWriteResult | null;
}) {
  const { t } = useTranslation('scripts');
  if (!result) return null;

  // Defensive: the API's declared type guarantees both arrays, but this
  // value is unvalidated `response.json()` output (ScriptExecutionsPage's
  // detail fetch spreads it straight into state) — a version-skewed or
  // partially-serialized payload missing one array must not crash the
  // whole detail modal.
  const applied = result.applied ?? [];
  const rejected = result.rejected ?? [];
  const hasApplied = applied.length > 0;
  const hasRejected = rejected.length > 0;

  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ListChecks className="h-4 w-4 text-muted-foreground" />
        {t('executionDetails.customFields.title')}
      </h3>
      <div className="rounded-md border">
        <div className="space-y-3 p-4">
          <div data-testid="exec-custom-fields-applied">
            <p className="text-xs font-medium text-muted-foreground">
              {t('executionDetails.customFields.applied')}
            </p>
            {hasApplied ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {applied.map((key) => (
                  <code
                    key={key}
                    className="rounded bg-success/15 px-1.5 py-0.5 text-xs text-success"
                  >
                    {key}
                  </code>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-sm italic text-muted-foreground">
                {t('executionDetails.customFields.none')}
              </p>
            )}
          </div>
          {hasRejected && (
            <div data-testid="exec-custom-fields-rejected">
              <p className="text-xs font-medium text-muted-foreground">
                {t('executionDetails.customFields.rejected')}
              </p>
              <ul className="mt-1 space-y-1">
                {rejected.map((r) => (
                  <li key={r.key} className="text-sm">
                    <code className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive">
                      {r.key}
                    </code>
                    <span className="ml-2 text-muted-foreground">
                      {t(
                        /* i18n-dynamic */ `executionDetails.customFields.reasons.${r.reason}`,
                        { defaultValue: r.reason }
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ExecutionDetails({
  execution,
  isOpen,
  onClose,
  timezone,
  onRunAgain
}: ExecutionDetailsProps) {
  const { t } = useTranslation('scripts');
  if (!isOpen) return null;

  const StatusIcon = statusConfig[execution.status].icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-lg border bg-card shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{t('executionDetails.title')}</h2>
            <p className="text-sm text-muted-foreground">{execution.scriptName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Status Banner */}
          <div className={cn(
            'rounded-md p-4',
            statusConfig[execution.status].bgColor
          )}>
            <div className="flex items-center gap-3">
              <StatusIcon className={cn(
                'h-6 w-6',
                statusConfig[execution.status].color,
                execution.status === 'running' && 'animate-spin'
              )} />
              <div>
                <p className={cn(
                  'text-lg font-semibold',
                  statusConfig[execution.status].color
                )}>
                  {t(/* i18n-dynamic */ `executionDetails.${statusConfig[execution.status].label}`)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(/* i18n-dynamic */ `executionDetails.statusDescription.${execution.status}`)}
                </p>
              </div>
            </div>
          </div>

          {/* Metadata Grid */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">{t('common:labels.device')}</p>
              <p className="text-sm font-medium mt-1">{execution.deviceHostname}</p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">{t('executionDetails.fields.startedAt')}</p>
              <p className="text-sm font-medium mt-1">{formatDateTime(execution.startedAt, timezone)}</p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">{t('executionDetails.fields.duration')}</p>
              <p className="text-sm font-medium mt-1">
                {execution.status === 'running' ? (
                  <span className="flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('executionDetails.status.running')}
                  </span>
                ) : (
                  formatDuration(execution.duration)
                )}
              </p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">{t('executionDetails.fields.exitCode')}</p>
              <p className="text-sm font-medium mt-1">
                {execution.exitCode !== undefined ? (
                  <span className={cn(
                    'inline-flex items-center rounded px-2 py-0.5 font-mono',
                    execution.exitCode === 0
                      ? 'bg-success/15 text-success'
                      : 'bg-destructive/15 text-destructive'
                  )}>
                    {execution.exitCode}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </p>
            </div>
          </div>

          {execution.completedAt && (
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">{t('executionDetails.fields.completedAt')}</p>
              <p className="text-sm font-medium mt-1">{formatDateTime(execution.completedAt, timezone)}</p>
            </div>
          )}

          {/* Output Sections */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">{t('executionDetails.output.title')}</h3>

            <OutputSection
              title={t('executionDetails.output.stdout')}
              content={execution.stdout}
              icon={Terminal}
              defaultOpen={true}
            />

            <OutputSection
              title={t('executionDetails.output.stderr')}
              content={execution.stderr}
              icon={AlertOctagon}
              defaultOpen={!!execution.stderr}
              variant="error"
            />
          </div>

          <CustomFieldWriteSummarySection result={execution.customFieldResult} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          {onRunAgain && (
            <button
              type="button"
              data-testid="execution-run-again"
              onClick={() => onRunAgain(execution)}
              className="inline-flex h-10 items-center gap-1.5 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
            >
              <RotateCcw className="h-4 w-4" />
              {t('executionDetails.actions.runAgain')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {t('common:actions.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
