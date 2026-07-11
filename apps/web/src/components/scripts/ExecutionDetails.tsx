import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronDown, ChevronUp, Copy, Check, Clock, CheckCircle, XCircle, Loader2, AlertTriangle, Terminal, AlertOctagon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import type { ScriptExecution, ExecutionStatus } from './ExecutionHistory';

type ExecutionDetailsProps = {
  execution: ScriptExecution;
  isOpen: boolean;
  onClose: () => void;
  timezone?: string;
};

const statusConfig: Record<ExecutionStatus, { label: string; color: string; bgColor: string; icon: typeof CheckCircle }> = {
  pending: { label: 'status.pending', color: 'text-muted-foreground', bgColor: 'bg-muted', icon: Clock },
  running: { label: 'status.running', color: 'text-blue-700 dark:text-blue-400', bgColor: 'bg-blue-500/10', icon: Loader2 },
  completed: { label: 'status.completed', color: 'text-success', bgColor: 'bg-success/10', icon: CheckCircle },
  failed: { label: 'status.failed', color: 'text-destructive', bgColor: 'bg-destructive/10', icon: XCircle },
  timeout: { label: 'status.timeout', color: 'text-warning', bgColor: 'bg-warning/10', icon: AlertTriangle }
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

function OutputSection({
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

export default function ExecutionDetails({
  execution,
  isOpen,
  onClose,
  timezone
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
                  {t(`executionDetails.${statusConfig[execution.status].label}`)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {execution.status === 'running'
                    ? t('executionDetails.statusDescription.running')
                    : execution.status === 'completed'
                      ? t('executionDetails.statusDescription.completed')
                      : execution.status === 'failed'
                        ? t('executionDetails.statusDescription.failed')
                        : execution.status === 'timeout'
                          ? t('executionDetails.statusDescription.timeout')
                          : t('executionDetails.statusDescription.pending')}
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
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t px-6 py-4">
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
