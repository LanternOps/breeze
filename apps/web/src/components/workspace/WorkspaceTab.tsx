import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WorkspaceTabProps {
  id: string;
  title: string;
  isActive: boolean;
  unreadCount: number;
  hasApprovalPending: boolean;
  isStreaming: boolean;
  onSelect: () => void;
  onClose: () => void;
}

export default function WorkspaceTab({
  title,
  isActive,
  unreadCount,
  hasApprovalPending,
  isStreaming,
  onSelect,
  onClose,
}: WorkspaceTabProps) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group relative flex min-w-0 max-w-[200px] items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'border-gray-300 bg-gray-50 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
          : 'border-transparent bg-gray-50/50 text-gray-500 hover:bg-gray-100/50 hover:text-gray-700 dark:bg-gray-900/50 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-300'
      )}
    >
      {/* Streaming indicator */}
      {isStreaming && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-purple-400" />
      )}

      <span className="truncate">{title}</span>

      {/* Unread badge */}
      {unreadCount > 0 && !isActive && (
        <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-purple-600 px-1 text-[10px] font-bold text-white">
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}

      {/* Approval pending dot */}
      {hasApprovalPending && !isActive && (
        <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Approval pending" />
      )}

      {/* Close button */}
      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          'ml-1 shrink-0 rounded p-0.5 transition-colors hover:bg-gray-200 dark:hover:bg-gray-600',
          isActive ? 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200' : 'text-gray-400 opacity-0 group-hover:opacity-100 dark:text-gray-600'
        )}
      >
        <X className="h-3 w-3" />
      </span>
    </button>
  );
}
