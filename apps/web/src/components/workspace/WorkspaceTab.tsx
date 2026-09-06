import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface WorkspaceTabProps {
  id: string;
  title: string;
  isActive: boolean;
  unreadCount: number;
  hasApprovalPending: boolean;
  isStreaming: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
}

const tabShellClassName = (isActive: boolean) =>
  cn(
    "group relative flex min-w-0 max-w-[200px] items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-2 text-sm font-medium transition-colors",
    isActive
      ? "border-gray-300 bg-gray-50 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      : "border-transparent bg-gray-50/50 text-gray-500 hover:bg-gray-100/50 hover:text-gray-700 dark:bg-gray-900/50 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-300",
  );

export default function WorkspaceTab({
  title,
  isActive,
  unreadCount,
  hasApprovalPending,
  isStreaming,
  onSelect,
  onClose,
  onRename,
}: WorkspaceTabProps) {
  const { t } = useTranslation("ai");
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    setDraftTitle(title);
    setIsEditing(true);
  };

  const commitRename = () => {
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== title) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const cancelRename = () => {
    setDraftTitle(title);
    setIsEditing(false);
  };

  // An <input> cannot be a descendant of the tab's <button> (invalid HTML —
  // interactive content inside interactive content), so the editing state
  // renders a plain <div> shell instead of swapping content inside the button.
  if (isEditing) {
    return (
      <div className={tabShellClassName(isActive)} data-testid="workspace-tab-editing">
        {isStreaming && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-purple-400" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
          maxLength={255}
          aria-label={t("workspaceTab.renameLabel")}
          data-testid="workspace-tab-rename-input"
          className="min-w-0 max-w-[150px] rounded border border-purple-400 bg-white px-1 py-0.5 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-purple-500 dark:border-purple-500 dark:bg-gray-800 dark:text-gray-100"
        />
      </div>
    );
  }

  return (
    <button
      onClick={onSelect}
      className={tabShellClassName(isActive)}
      data-testid="workspace-tab"
    >
      {/* Streaming indicator */}
      {isStreaming && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-purple-400" />
      )}

      <span
        className="truncate"
        data-testid="workspace-tab-title"
        title={t("workspaceTab.renameHint")}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEditing();
        }}
      >
        {title}
      </span>

      {/* Unread badge */}
      {unreadCount > 0 && !isActive && (
        <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-purple-600 px-1 text-[10px] font-bold text-white">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}

      {/* Approval pending dot */}
      {hasApprovalPending && !isActive && (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
          title={t("workspaceTab.approvalPending")}
        />
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
          "ml-1 shrink-0 rounded p-0.5 transition-colors hover:bg-gray-200 dark:hover:bg-gray-600",
          isActive
            ? "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
            : "text-gray-400 opacity-0 group-hover:opacity-100 dark:text-gray-600",
        )}
      >
        <X className="h-3 w-3" />
      </span>
    </button>
  );
}
