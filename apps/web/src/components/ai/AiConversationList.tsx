import { Loader2, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import WorkspaceSessionChips from "../workspace/WorkspaceSessionChips";
import { MIN_SEARCH_CHARS, type ConversationRow, type ConversationSurface } from "./useAiConversationSource";

export interface AiConversationListProps {
  rows: ConversationRow[];
  currentSessionId: string | null;
  /** The host decides what a pick means (switch, open, or move). */
  onPick: (row: ConversationRow) => void;
  surface: ConversationSurface;
  query: string;
  onQueryChange: (query: string) => void;
  isLoading: boolean;
  isSearching: boolean;
  error: string | null;
}

/** The label a row carries when the OTHER surface of this document holds it. */
const openElsewhereKey = (surface: ConversationSurface, openIn: ConversationRow["openIn"]) =>
  surface === "panel" && openIn === "workspace"
    ? "aiConversationMove.openInAssistant"
    : surface === "workspace" && openIn === "panel"
      ? "aiConversationMove.openInPanel"
      : null;

/**
 * #9840 W4 (spec §3.7): the one conversation list, rendered by the side
 * panel's History and by the workspace picker. One search box; each row
 * carries the org chip (Gate B #13) and the generic "Device" chip (Gate B #9)
 * through W3's WorkspaceSessionChips, and says when the other surface holds
 * the conversation.
 */
export default function AiConversationList({
  rows,
  currentSessionId,
  onPick,
  surface,
  query,
  onQueryChange,
  isLoading,
  isSearching,
  error,
}: AiConversationListProps) {
  const { t } = useTranslation("ai");
  const searching = query.length >= MIN_SEARCH_CHARS;
  const busy = searching ? isSearching : isLoading;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t("aiChatSidebar.searchPlaceholder")}
            aria-label={t("aiChatSidebar.searchPlaceholder")}
            data-testid="ai-conversation-search"
            className="w-full rounded-md border bg-muted py-1.5 pl-8 pr-3 text-xs text-foreground placeholder-muted-foreground outline-hidden focus:border-primary"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {busy && (
          <div className="flex items-center justify-center py-8" data-testid="ai-conversation-loading">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!busy && error && rows.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground" data-testid="ai-conversation-error">
            {t("common:states.error")}
          </p>
        )}

        {!busy && !error && rows.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {searching ? t("aiChatSidebar.noResults") : t("aiChatSidebar.noConversations")}
          </p>
        )}

        {rows.map((row) => {
          const elsewhere = openElsewhereKey(surface, row.openIn);
          const current = row.id === currentSessionId;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onPick(row)}
              data-testid="ai-conversation-row"
              data-session-id={row.id}
              aria-current={current ? "true" : undefined}
              className={`w-full border-b px-4 py-3 text-left transition-colors hover:bg-muted ${
                current ? "bg-muted border-l-2 border-l-primary" : ""
              }`}
            >
              <span className="block truncate text-xs font-medium text-foreground">
                {row.title || t("aiChatSidebar.untitledConversation")}
              </span>
              {row.matchedContent && (
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{row.matchedContent}</span>
              )}
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground/60">
                  {new Date(row.createdAt).toLocaleDateString()}
                </span>
                {elsewhere && (
                  <span
                    className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                    data-testid="ai-conversation-open-elsewhere"
                  >
                    {t(elsewhere)}
                  </span>
                )}
              </span>
              <span className="mt-1 block empty:hidden">
                <WorkspaceSessionChips
                  orgId={row.orgId}
                  deviceLabel={row.deviceId ? t("aiConversationMove.device") : null}
                  m365ConnectionId={null}
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
