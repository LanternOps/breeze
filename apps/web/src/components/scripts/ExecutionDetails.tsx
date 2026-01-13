import { useState } from 'react';
import { X, ChevronDown, ChevronUp, Copy, Check, Clock, CheckCircle, XCircle, Loader2, AlertTriangle, Terminal, AlertOctagon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScriptExecution, ExecutionStatus } from './ExecutionHistory';

type ExecutionDetailsProps = {
  execution: ScriptExecution;
  isOpen: boolean;
  onClose: () => void;
};

const statusConfig: Record<ExecutionStatus, { label: string; color: string; bgColor: string; icon: typeof CheckCircle }> = {
  pending: { label: 'Pending', color: 'text-gray-700', bgColor: 'bg-gray-500/10', icon: Clock },
  running: { label: 'Running', color: 'text-blue-700', bgColor: 'bg-blue-500/10', icon: Loader2 },
  completed: { label: 'Completed', color: 'text-green-700', bgColor: 'bg-green-500/10', icon: CheckCircle },
  failed: { label: 'Failed', color: 'text-red-700', bgColor: 'bg-red-500/10', icon: XCircle },
  timeout: { label: 'Timeout', color: 'text-yellow-700', bgColor: 'bg-yellow-500/10', icon: AlertTriangle }
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

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
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
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const isEmpty = !content || content.trim() === '';

  return (
    <div className={cn(
      'rounded-md border',
      variant === 'error' && content && 'border-red-500/40'
    )}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex w-full items-center justify-between px-4 py-3 text-left transition',
          isOpen ? 'border-b' : '',
          variant === 'error' && content ? 'bg-red-500/5' : 'bg-muted/20'
        )}
      >
        <div className="flex items-center gap-2">
          <Icon className={cn(
            'h-4 w-4',
            variant === 'error' && content ? 'text-red-600' : 'text-muted-foreground'
          )} />
          <span className={cn(
            'text-sm font-medium',
            variant === 'error' && content && 'text-red-700'
          )}>
            {title}
          </span>
          {isEmpty && (
            <span className="text-xs text-muted-foreground">(empty)</span>
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
              title="Copy to clipboard"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-600" />
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
            <p className="text-sm text-muted-foreground italic">No output</p>
          ) : (
            <pre className={cn(
              'overflow-x-auto rounded-md p-4 text-sm font-mono whitespace-pre-wrap break-words',
              variant === 'error' ? 'bg-red-500/5 text-red-800' : 'bg-muted/40 text-foreground'
            )}>
              {content}
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
  onClose
}: ExecutionDetailsProps) {
  if (!isOpen) return null;

  const StatusIcon = statusConfig[execution.status].icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-lg border bg-card shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Execution Details</h2>
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
                  {statusConfig[execution.status].label}
                </p>
                <p className="text-sm text-muted-foreground">
                  {execution.status === 'running'
                    ? 'Script is currently executing...'
                    : execution.status === 'completed'
                      ? 'Script completed successfully'
                      : execution.status === 'failed'
                        ? 'Script execution failed'
                        : execution.status === 'timeout'
                          ? 'Script execution timed out'
                          : 'Script is waiting to be executed'}
                </p>
              </div>
            </div>
          </div>

          {/* Metadata Grid */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">Device</p>
              <p className="text-sm font-medium mt-1">{execution.deviceHostname}</p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">Started At</p>
              <p className="text-sm font-medium mt-1">{formatDateTime(execution.startedAt)}</p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">Duration</p>
              <p className="text-sm font-medium mt-1">
                {execution.status === 'running' ? (
                  <span className="flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Running...
                  </span>
                ) : (
                  formatDuration(execution.duration)
                )}
              </p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">Exit Code</p>
              <p className="text-sm font-medium mt-1">
                {execution.exitCode !== undefined ? (
                  <span className={cn(
                    'inline-flex items-center rounded px-2 py-0.5 font-mono',
                    execution.exitCode === 0
                      ? 'bg-green-500/20 text-green-700'
                      : 'bg-red-500/20 text-red-700'
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
              <p className="text-xs font-medium text-muted-foreground">Completed At</p>
              <p className="text-sm font-medium mt-1">{formatDateTime(execution.completedAt)}</p>
            </div>
          )}

          {/* Output Sections */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Output</h3>

            <OutputSection
              title="Standard Output (stdout)"
              content={execution.stdout}
              icon={Terminal}
              defaultOpen={true}
            />

            <OutputSection
              title="Standard Error (stderr)"
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
