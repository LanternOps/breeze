import { useMemo } from 'react';
import {
  Copy,
  ArrowRight,
  Trash2,
  RotateCcw,
  Upload,
  Download,
  X,
  ChevronLeft,
  ChevronRight,
  Clock,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type FileActivity = {
  id: string;
  timestamp: string;
  action: 'copy' | 'move' | 'delete' | 'restore' | 'upload' | 'download' | 'purge';
  paths: string[];
  result: 'success' | 'failure';
  error?: string;
};

export type FileActivityPanelProps = {
  open: boolean;
  onToggle: () => void;
  activities: FileActivity[];
  onClear?: () => void;
};

const actionConfig: Record<
  FileActivity['action'],
  { label: string; icon: typeof Copy; color: string }
> = {
  copy: { label: 'Copy', icon: Copy, color: 'text-blue-400' },
  move: { label: 'Move', icon: ArrowRight, color: 'text-amber-400' },
  delete: { label: 'Delete', icon: Trash2, color: 'text-red-400' },
  restore: { label: 'Restore', icon: RotateCcw, color: 'text-emerald-400' },
  upload: { label: 'Upload', icon: Upload, color: 'text-cyan-400' },
  download: { label: 'Download', icon: Download, color: 'text-green-400' },
  purge: { label: 'Purge', icon: Trash2, color: 'text-red-500' },
};

function timeAgo(dateString: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function truncatePath(path: string, maxLength = 40): string {
  if (path.length <= maxLength) return path;
  const start = path.slice(0, 12);
  const end = path.slice(-Math.max(maxLength - 15, 20));
  return `${start}...${end}`;
}

export default function FileActivityPanel({
  open,
  onToggle,
  activities,
  onClear,
}: FileActivityPanelProps) {
  const sortedActivities = useMemo(
    () =>
      [...activities].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ),
    [activities]
  );

  // Collapsed state: render only the toggle tab
  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex h-24 w-8 items-center justify-center rounded-l-md border border-r-0 border-gray-700 bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
        title="Show activity"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="flex h-full w-[300px] flex-col border-l border-gray-700 bg-gray-800 transition-all">
      {/* Panel header */}
      <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-gray-400" />
          <h3 className="text-sm font-semibold text-gray-200">Activity</h3>
          {activities.length > 0 && (
            <span className="rounded-full bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
              {activities.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {activities.length > 0 && onClear && (
            <button
              type="button"
              onClick={onClear}
              className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
              title="Clear activity"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-gray-700 transition-colors"
            title="Hide activity"
          >
            <ChevronRight className="h-4 w-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Activity list */}
      <div className="flex-1 overflow-auto">
        {sortedActivities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-500">
            <Clock className="mb-2 h-8 w-8" />
            <p className="text-sm">No recent activity</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-700/60">
            {sortedActivities.map((activity) => {
              const config = actionConfig[activity.action];
              const ActionIcon = config.icon;
              const isFailure = activity.result === 'failure';

              return (
                <div
                  key={activity.id}
                  className="px-3 py-2.5 hover:bg-gray-750 hover:bg-gray-700/30 transition-colors"
                >
                  {/* Action + timestamp row */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <ActionIcon className={cn('h-3.5 w-3.5 shrink-0', config.color)} />
                      <span className="text-xs font-medium text-gray-200">
                        {config.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {isFailure ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400"
                          title={activity.error || 'Operation failed'}
                        >
                          <AlertCircle className="h-2.5 w-2.5" />
                          Failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          Success
                        </span>
                      )}
                      <span className="whitespace-nowrap text-[10px] text-gray-500">
                        {timeAgo(activity.timestamp)}
                      </span>
                    </div>
                  </div>

                  {/* Paths */}
                  <div className="mt-1 space-y-0.5">
                    {activity.paths.map((p, i) => (
                      <p
                        key={`${activity.id}-path-${i}`}
                        className="truncate text-[11px] text-gray-400"
                        title={p}
                      >
                        {truncatePath(p)}
                      </p>
                    ))}
                  </div>

                  {/* Error message */}
                  {isFailure && activity.error && (
                    <p
                      className="mt-1 truncate text-[11px] text-red-400/80"
                      title={activity.error}
                    >
                      {activity.error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
