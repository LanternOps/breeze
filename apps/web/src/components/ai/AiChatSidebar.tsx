import { useEffect, useState, useCallback, useRef } from "react";
import {
  X,
  MessageSquare,
  Plus,
  History,
  ArrowLeft,
  Flag,
  Building2,
  ExternalLink,
  Sparkles,
} from "lucide-react";
import { isActiveGrant, useAiStore, type WispState } from "@/stores/aiStore";
import { useJwtClaims } from "@/lib/authScope";
import { useWispEnabled } from "@/lib/wispVisibility";
import { fetchWispThread, isNoActiveGrant } from "@/lib/wispGrant";
import { useEntitlement } from "@/hooks/useEntitlement";
import { useOnWindowReturn } from "@/hooks/useOnWindowReturn";
import { moveToAssistant } from "@/stores/aiConversationHandoff";
import { usePermissions } from "@/lib/permissions";
import AiChatMessages from "./AiChatMessages";
import AiChatInput from "./AiChatInput";
import AiModelPicker from "./AiModelPicker";
import AiThinkingIndicator from "./AiThinkingIndicator";
import AiTurnModelBadge from "./AiTurnModelBadge";
import AiContinuationPrompt from "./AiContinuationPrompt";
import { noSessionOrgId, useAiModelPickerStore } from "@/stores/aiModelPickerStore";
import { useOrgStore } from "@/stores/orgStore";
import AiContextBadge from "./AiContextBadge";
import AiCostIndicator from "./AiCostIndicator";
import AiConversationList from "./AiConversationList";
import { useAiConversationSource, type ConversationRow } from "./useAiConversationSource";
import { useContinueInPanel } from "../workspace/useContinueInPanel";
import { showToast } from "../shared/Toast";
import BuyCreditsLink from "./BuyCreditsLink";
import WispThreadHeader from "./WispThreadHeader";
import WispThreadAttachments from "./WispThreadAttachments";
import { useTranslation } from "react-i18next";
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type GrantLookup =
  | { kind: "idle" }
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "active"; grant: NonNullable<WispState> };

/**
 * The caller's active Wisp grant the panel can speak under: the partner-wide
 * grant first, then one scoped to the organization selected in the header
 * (the order WispLinkButton uses). A 404 `no_active_grant` is the ordinary
 * "no grant here"; any other failure is reported as `failed` and the panel
 * stays Breeze AI without offering "Meet Wisp" — nothing about it fails
 * loudly (Review Focus 2).
 */
async function lookUpActiveGrant(orgId: string | null): Promise<GrantLookup> {
  let failed = false;
  for (const scope of orgId ? [null, orgId] : [null]) {
    try {
      const state = await fetchWispThread(scope);
      if (isActiveGrant(state)) return { kind: "active", grant: state };
    } catch (err) {
      if (isNoActiveGrant(err)) continue;
      console.warn("[AiChatSidebar] could not read the Wisp thread; staying Breeze AI", err);
      failed = true;
    }
  }
  return failed ? { kind: "failed" } : { kind: "none" };
}

export default function AiChatSidebar() {
  const { t } = useTranslation("ai");
  const {
    isOpen,
    toggle,
    close,
    messages,
    chatRuns,
    isStreaming,
    thinking,
    turnModel,
    isLoading,
    error,
    errorCode,
    pageContext,
    pendingApproval,
    pendingPlan,
    activePlan,
    approvalMode,
    isPaused,
    sessionId,
    hydratedSessionId,
    showHistory,
    sendMessage,
    approveExecution,
    clearPendingApproval,
    approvePlan,
    abortPlan,
    pauseAi,
    createSession,
    closeSession,
    clearError,
    toggleHistory,
    loadSession,
    switchSession,
    interruptResponse,
    isInterrupting,
    isFlagged,
    flagSession,
    unflagSession,
    m365Connections,
    selectedM365ConnectionId,
    boundM365ConnectionId,
    loadM365Connections,
    setSelectedM365Connection,
    composerDraft,
    setComposerDraft,
    wisp,
    enterWispMode,
    topologySiteId,
    joinedMidResponse,
    recheckPendingApproval,
  } = useAiStore();
  // #9431: an approval card may have been decided in another window meanwhile.
  useOnWindowReturn(() => recheckPendingApproval?.());
  const [wispAttachmentsOpen, setWispAttachmentsOpen] = useState(false);
  const wispScopeOrgName = useOrgStore((s) =>
    wisp?.scopeOrgId ? (s.organizations ?? []).find((o) => o.id === wisp.scopeOrgId)?.name ?? null : null,
  );
  // #6396: every own-session route requires ai_sessions:use; a role without it
  // (Org Viewer, billing roles) gets no sidebar rather than a shell that 403s.
  // Hooks above/below still run unconditionally — only the render is gated.
  const { can } = usePermissions();
  const canUseAi = can("ai_sessions", "use");

  const restoredSessionIdRef = useRef<string | null>(null);

  // Keyboard shortcut: Cmd+Shift+A to toggle. With Shift held, `e.key` is "A"
  // (capital), so compare case-insensitively (#9613).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        if (canUseAi) toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle, canUseAi]);

  // Restore session history when sidebar opens with a persisted sessionId
  useEffect(() => {
    if (!isOpen || !sessionId) {
      restoredSessionIdRef.current = null;
      return;
    }

    // A session this tab created (or already loaded) is authoritative in
    // memory. Re-fetching it here raced the first send: the restore landed
    // after the optimistic user message was appended — before the server had
    // persisted that row — and replaced it with empty history (#6933).
    if (hydratedSessionId === sessionId) return;

    // Prevent fetch loops when a valid session has no messages yet.
    // Load persisted session content at most once per open/session pair.
    if (
      messages.length === 0 &&
      !isLoading &&
      restoredSessionIdRef.current !== sessionId
    ) {
      restoredSessionIdRef.current = sessionId;
      void loadSession(sessionId);
    }
  }, [isOpen, sessionId, hydratedSessionId, messages.length, isLoading, loadSession]);

  // A sidebar opened with no session still offers the model menu (W05).
  // A partner-scope token has no org of its own, so the menu is fetched for the
  // org a new chat would land in (page device's org, else the selected org).
  const selectedOrgId = useOrgStore((s) => s.currentOrgId);
  const menuOrgId = noSessionOrgId(pageContext, selectedOrgId);
  useEffect(() => {
    if (isOpen && !sessionId && !useAiModelPickerStore.getState().choices) {
      void useAiModelPickerStore.getState().load({ orgId: menuOrgId });
    }
  }, [isOpen, sessionId, menuOrgId]);

  // Load M365 customer connections when the sidebar opens
  useEffect(() => {
    if (isOpen) loadM365Connections();
  }, [isOpen, loadM365Connections]);

  // W05 (#10136, spec §7 + §11 decision 4): the grant decides the voice — no
  // toggle. Asked only where a grant can exist: the server has Wisp on, the
  // token is partner-scoped (grants are partner-staff only) and the plan
  // carries `wisp`. Org tokens never ask the partner route at all.
  const jwtClaims = useJwtClaims();
  const partnerToken = jwtClaims.status === "resolved" && jwtClaims.claims.scope === "partner";
  const wispServerOn = useWispEnabled({ enabled: partnerToken });
  const wispEntitlement = useEntitlement("wisp");
  const wispEligible = canUseAi && partnerToken && wispServerOn && wispEntitlement.state === "enabled";
  const [grantLookup, setGrantLookup] = useState<GrantLookup>({ kind: "idle" });
  // The selected org ("" = none) the panel last asked about; null = ask on the next open.
  const grantLookupKeyRef = useRef<string | null>(null);

  // Once per page and selected org, the first time the panel is open with
  // every gate passed (a failed read is asked again on the next open). An
  // active grant gives a panel with no conversation the Wisp voice at once.
  // A conversation already open (a restored chat — its own Wisp state comes
  // back through the store's rehydrate — or a device task being created) is
  // never abandoned for it: the next new conversation starts on the grant.
  useEffect(() => {
    if (!isOpen || !wispEligible) return;
    const key = selectedOrgId ?? "";
    if (grantLookupKeyRef.current === key) return;
    grantLookupKeyRef.current = key;
    if (useAiStore.getState().wisp) return;
    void lookUpActiveGrant(selectedOrgId).then((result) => {
      // The org changed while this was in flight: the newer lookup owns the answer.
      if (grantLookupKeyRef.current !== key) return;
      if (result.kind === "failed") grantLookupKeyRef.current = null;
      setGrantLookup(result);
      if (result.kind !== "active") return;
      const now = useAiStore.getState();
      if (now.wisp || now.sessionId || now.isLoading) return;
      void now.enterWispMode(result.grant);
    });
  }, [isOpen, wispEligible, selectedOrgId]);

  // Wisp is on here but there is no active grant (none, paused, ended, or the
  // plan lacks Wisp): point at the home, which explains and starts or resumes one.
  const showMeetWisp =
    !wisp &&
    canUseAi &&
    partnerToken &&
    wispServerOn &&
    (wispEntitlement.state === "locked" || (wispEntitlement.state === "enabled" && grantLookup.kind === "none"));

  const boundConnection = boundM365ConnectionId
    ? m365Connections.find((conn) => conn.id === boundM365ConnectionId)
    : null;

  const handleNewConversation = useCallback(async () => {
    await closeSession();
    // Leaving a plain conversation where Wisp can run: the new one takes the
    // grant as it is NOW. Re-read, never the lookup from when the panel
    // opened — a grant revoked, paused or expired since then must start a
    // plain chat (and offer Meet Wisp), not a session the server refuses.
    if (!wisp && wispEligible) {
      const result = await lookUpActiveGrant(selectedOrgId);
      setGrantLookup(result);
      if (result.kind === "active") {
        await enterWispMode(result.grant);
        return;
      }
    }
    await createSession();
  }, [closeSession, createSession, enterWispMode, wisp, wispEligible, selectedOrgId]);

  if (!canUseAi) return null;

  return (
    <>
      {/* Sidebar panel */}
      <div
        data-testid="ai-chat-sidebar"
        // Collapsed, the panel slides off-screen via transform but stays
        // mounted (transition:persist). `inert` + pointer-events-none make the
        // off-canvas shell truly non-interactive so it can't intercept clicks
        // meant for page content on wide layouts, and its (off-viewport) Close
        // control drops out of the focus/hit-test order (#1419).
        inert={!isOpen}
        className={`fixed right-0 top-0 z-40 flex h-full w-[400px] flex-col border-l bg-card transition-transform duration-300 ${
          isOpen ? "translate-x-0 shadow-2xl" : "translate-x-full pointer-events-none"
        }`}
      >
        {/* Header — one flat surface with the panel (no stacked card-on-card
            backgrounds); the bottom border alone separates it. */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            {showHistory ? (
              <button
                onClick={toggleHistory}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : (
              <MessageSquare className="h-4 w-4 text-primary" />
            )}
            <span className="text-sm font-semibold text-foreground">
              {showHistory
                ? t("aiChatSidebar.history")
                : wisp
                  ? t("wisp.title")
                  : t("aiChatSidebar.title")}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {!showHistory && (
              <button
                onClick={toggleHistory}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t("aiChatSidebar.conversationHistory")}
                data-testid="ai-chat-history-toggle"
              >
                <History className="h-4 w-4" />
              </button>
            )}
            {/* #9427 W3: hidden for topology investigations (D4) and Wisp threads (the workspace has no Wisp controls). */}
            {!showHistory && sessionId && topologySiteId === null && !wisp && (
              <button
                onClick={() => void moveToAssistant(sessionId, { draft: composerDraft })}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t("aiConversationMove.openInAssistant")}
                aria-label={t("aiConversationMove.openInAssistant")}
                data-testid="ai-open-in-assistant"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
            )}
            {!showHistory && sessionId && (
              <button
                onClick={handleNewConversation}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t("aiChatSidebar.newConversation")}
                data-testid="ai-chat-new-conversation"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
            {!showHistory && sessionId && (
              <button
                onClick={() => (isFlagged ? unflagSession() : flagSession())}
                className={`rounded p-1.5 transition-colors ${
                  isFlagged
                    ? "text-amber-400 hover:bg-muted hover:text-amber-300"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                title={
                  isFlagged
                    ? t("aiChatSidebar.unflagConversation")
                    : t("aiChatSidebar.flagConversation")
                }
              >
                <Flag
                  className="h-4 w-4"
                  fill={isFlagged ? "currentColor" : "none"}
                />
              </button>
            )}
            <button
              onClick={close}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("aiChatSidebar.closeShortcut")}
              data-testid="ai-chat-close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {showHistory ? (
          /* History panel — mounted only while open, so its query resets on close. */
          <AiChatHistory currentSessionId={sessionId} onSwitch={switchSession} />
        ) : (
          /* Chat panel */
          <>
            {/* Cost indicator */}
            <AiCostIndicator enabled={isOpen} isStreaming={isStreaming} />

            {/* M365 customer selector — only when starting a new session */}
            {!sessionId && m365Connections.length > 0 && (
              <div className="flex items-center gap-2 border-b px-4 py-2">
                <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <select
                  value={selectedM365ConnectionId ?? ""}
                  onChange={(e) =>
                    setSelectedM365Connection(e.target.value || null)
                  }
                  className="w-full rounded-md border bg-muted px-2 py-1 text-xs text-foreground outline-hidden focus:border-primary"
                  aria-label={t("aiChatSidebar.m365Customer")}
                >
                  <option value="">{t("aiChatSidebar.noM365Customer")}</option>
                  {m365Connections.map((conn) => (
                    <option key={conn.id} value={conn.id}>
                      {conn.customerDisplayName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Bound M365 customer badge */}
            {sessionId && boundConnection && (
              <div className="flex items-center gap-1.5 border-b bg-muted/40 px-4 py-2">
                <Building2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate text-xs font-medium text-foreground">
                  {boundConnection.customerDisplayName}
                </span>
              </div>
            )}

            {/* Wisp thread: scope, focus, grant controls; attachments behind a disclosure.
                The brief, what needs you and the links live on the Wisp home (W08 #9921). */}
            {wisp && (
              <>
                <WispThreadHeader
                  wisp={wisp}
                  orgName={wispScopeOrgName}
                  wideningAvailable={wisp.wideningAvailable}
                />
                <div className="flex items-center justify-between gap-2 border-b px-4 py-1.5">
                  <button
                    type="button"
                    data-testid="wisp-attachments-toggle"
                    aria-expanded={wispAttachmentsOpen}
                    onClick={() => setWispAttachmentsOpen((open) => !open)}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    {t("wisp.attachments.title")}
                  </button>
                  <a
                    href="/wisp"
                    data-testid="wisp-sidebar-open-home"
                    className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    {t("wisp.sidebar.openHome")}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </div>
                {wispAttachmentsOpen && (
                  <div className="border-b px-4 py-2">
                    <WispThreadAttachments key={wisp.threadId} wisp={wisp} />
                  </div>
                )}
              </>
            )}

            {/* Context badge */}
            {pageContext && (
              <div className="border-b px-4 py-2">
                <AiContextBadge context={pageContext} />
              </div>
            )}

            {/* Error banner */}
            {error && (
              <div className="flex items-center justify-between border-b border-red-800/50 bg-red-900/20 px-4 py-2">
                <span className="text-xs text-red-400">{error}</span>
                {errorCode === "credits_exhausted" && (
                  <BuyCreditsLink className="ml-2 shrink-0 text-xs font-medium text-red-300 underline underline-offset-2 hover:text-red-200" />
                )}
                <button
                  onClick={clearError}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  {t("aiChatSidebar.dismiss")}
                </button>
              </div>
            )}

            {/* #9427: attached to a running turn whose replay was too large to send. */}
            {joinedMidResponse && (
              <div className="border-b px-4 py-1.5 text-xs text-muted-foreground" data-testid="ai-joined-mid-response">
                {t("aiConversationMove.joinedMidResponse")}
              </div>
            )}

            {/* Messages area */}
            <AiChatMessages
              messages={messages}
              chatRuns={chatRuns}
              pendingApproval={pendingApproval}
              pendingPlan={pendingPlan}
              activePlan={activePlan}
              approvalMode={approvalMode}
              isPaused={isPaused}
              onApprove={(id) => approveExecution(id, true)}
              onReject={(id) => approveExecution(id, false)}
              onApprovePlan={approvePlan}
              onAbortPlan={abortPlan}
              onPauseAi={pauseAi}
              onSendQuickAction={sendMessage}
              onIntentDecided={clearPendingApproval}
              assistantLabel={wisp ? t("wisp.title") : undefined}
            />

            {/* Continuation prompt, what ran, thinking, model menu (W05) */}
            <AiContinuationPrompt />
            <AiTurnModelBadge turnModel={turnModel} />
            <AiThinkingIndicator thinking={isStreaming && !!thinking} />
            <AiModelPicker disabled={isStreaming} />

            {/* Input */}
            <AiChatInput
              onSend={sendMessage}
              value={composerDraft}
              onValueChange={setComposerDraft}
              onInterrupt={interruptResponse}
              disabled={isLoading}
              isStreaming={isStreaming}
              isInterrupting={isInterrupting}
            />

            {showMeetWisp && (
              <div className="border-t px-4 py-2">
                <a
                  href="/wisp"
                  data-testid="wisp-sidebar-meet"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  {t("wisp.sidebar.meetWisp")}
                </a>
              </div>
            )}
          </>
        )}
      </div>

      {/* Backdrop overlay when open on small screens */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={close}
        />
      )}
    </>
  );
}

/**
 * #9840 W4 (spec §3.7): the side panel's History — the shared conversation
 * list. A row a workspace tab holds moves here through W3's
 * continueInSidePanel (adopt first, the tab closes only after 'ok', a busy
 * panel asks first, never a DELETE); any other row is a switchSession, as
 * before (closed search hits and topology investigations included).
 */
function AiChatHistory({
  currentSessionId,
  onSwitch,
}: {
  currentSessionId: string | null;
  onSwitch: (sessionId: string) => Promise<void>;
}) {
  const { t } = useTranslation("ai");
  const { items, query, setQuery, isLoading, isSearching, error } = useAiConversationSource({ surface: "panel" });
  const { continueInPanel, replaceDialog } = useContinueInPanel();

  const pick = useCallback(
    (row: ConversationRow) => {
      if (row.openIn !== "workspace") {
        void onSwitch(row.id);
        return;
      }
      // Lazy: keeps workspaceStore out of the side panel's bundle.
      import("@/stores/workspaceStore")
        .then(({ useWorkspaceStore }) => {
          const tab = useWorkspaceStore.getState().tabs.find((t) => t.sessionId === row.id);
          // The tab closed since the list rendered: nothing holds it elsewhere now.
          if (tab) continueInPanel(tab.id);
          else void onSwitch(row.id);
        })
        .catch((err) => {
          console.error("[AI] Moving a conversation to the side panel failed:", err);
          showToast({ type: "error", message: t("aiConversationMove.notAvailable") });
        });
    },
    [continueInPanel, onSwitch, t],
  );

  return (
    <>
      <AiConversationList
        rows={items}
        currentSessionId={currentSessionId}
        onPick={pick}
        surface="panel"
        query={query}
        onQueryChange={setQuery}
        isLoading={isLoading}
        isSearching={isSearching}
        error={error}
      />
      {replaceDialog}
    </>
  );
}
