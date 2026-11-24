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
import { isActiveGrant, useAiStore, type AiPanelTab, type WispState } from "@/stores/aiStore";
import { wispPaneHandedOff } from "@/stores/aiPageContext";
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
import AiThinkingIndicator, { approvalWaitFromPending } from "./AiThinkingIndicator";
import AiTurnModelBadge from "./AiTurnModelBadge";
import AiContinuationPrompt from "./AiContinuationPrompt";
import AiNotifyToggle from "./AiNotifyToggle";
import { noSessionOrgId, useAiModelPickerStore } from "@/stores/aiModelPickerStore";
import { useOrgStore } from "@/stores/orgStore";
import AiContextBadge from "./AiContextBadge";
import AiCostIndicator from "./AiCostIndicator";
import AiConversationList from "./AiConversationList";
import { useAiConversationSource, type ConversationRow } from "./useAiConversationSource";
import { useContinueInPanel } from "../workspace/useContinueInPanel";
import { showToast } from "../shared/Toast";
import type { ActionMenuItem } from "../shared/ActionMenu";
import BuyCreditsLink from "./BuyCreditsLink";
import WispThreadHeader from "./WispThreadHeader";
import WispAttachmentsButton from "./WispAttachmentsButton";
import WispChatWelcome from "../wisp/WispChatWelcome";
import { useWispScopeLabel } from "../wisp/useWispScopeLabel";
import { wispSessionOrgId } from "@/lib/wispSession";
import { useTranslation } from "react-i18next";
import AiErrorBanner from "./AiErrorBanner";
import { activeRetryTarget } from "@/lib/aiErrors";
import { RIGHT_DOCK_BACKDROP_CLASS, RIGHT_DOCK_PANEL_CLASS } from "../layout/rightDockPanel";
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

const HEADER_ICON_BUTTON = "rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

type GrantLookup =
  | { kind: "idle" }
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "active"; grant: NonNullable<WispState> };

/**
 * The caller's active Wisp grant the panel can speak under: the partner-wide
 * grant first, then one scoped to the organization selected in the header
 * (the order WispTalkButton uses). `isNoActiveGrant` (200 `{ data: null }`,
 * #10200) is the ordinary "no grant here"; any other failure is reported as `failed` and the panel
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
    retryTarget,
    retryLastTurn,
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
    transcriptPurgedAt,
    flagSession,
    unflagSession,
    m365Connections,
    selectedM365ConnectionId,
    boundM365ConnectionId,
    loadM365Connections,
    setSelectedM365Connection,
    composerDraft,
    composerFocusRequest,
    setComposerDraft,
    wispPageThreadId,
    focusWispPageComposer,
    wisp,
    selectPanelTab,
    topologySiteId,
    joinedMidResponse,
    recheckPendingApproval,
  } = useAiStore();
  // #9431: an approval card may have been decided in another window meanwhile.
  useOnWindowReturn(() => recheckPendingApproval?.());
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
  // (capital), so compare case-insensitively (#9613). On a page whose own
  // composer holds the chat's Wisp thread, the store's toggle focuses that
  // composer instead of opening the pane.
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

  // An active grant gives the panel a second tab, Wisp, beside the direct
  // session. It no longer decides the voice (W05, #10136, did that): Wisp
  // hands device work to specialist runs, and a technician working on a
  // device wants to do it here, step by step. Asked only where a grant can
  // exist: the server has Wisp on, the token is partner-scoped (grants are
  // partner-staff only) and the plan carries `wisp`. Org tokens never ask the
  // partner route at all.
  const jwtClaims = useJwtClaims();
  const partnerToken = jwtClaims.status === "resolved" && jwtClaims.claims.scope === "partner";
  const wispServerOn = useWispEnabled({ enabled: partnerToken });
  const wispEntitlement = useEntitlement("wisp");
  const wispEligible = canUseAi && partnerToken && wispServerOn && wispEntitlement.state === "enabled";
  const [grantLookup, setGrantLookup] = useState<GrantLookup>({ kind: "idle" });
  // The selected org ("" = none) the panel last asked about; null = ask on the next open.
  const grantLookupKeyRef = useRef<string | null>(null);

  // #10195: the panel follows the grant live, not only as it stood when the
  // panel opened. When the grant it speaks under goes away from the shared
  // store — revoked on /wisp (the home's exitWispMode), a create the server
  // refused as unusable, a plain chat picked from History — the answer from
  // before is stale: forget it and ask again, so Meet Wisp (or the Wisp tab
  // of another live grant) is what the panel shows. Leaving by the direct
  // session tab takes the same path: the read confirms the grant is still
  // there. That grant itself is not re-entered on the strength of that one
  // read (whatever dropped it knew better); the guard is spent by it, so a
  // later open or org change decides afresh.
  const wispGrantId = wisp?.grantId ?? null;
  const shownGrantIdRef = useRef<string | null>(wispGrantId);
  const endedGrantIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownGrantIdRef.current;
    shownGrantIdRef.current = wispGrantId;
    if (previous === wispGrantId) return;
    // Entering a grant (fresh, or switching to another thread) is not an end.
    if (wispGrantId !== null) {
      endedGrantIdRef.current = null;
      return;
    }
    endedGrantIdRef.current = previous;
    grantLookupKeyRef.current = null;
    setGrantLookup({ kind: "idle" });
  }, [wispGrantId]);

  // Once per page and selected org, the first time the panel is open with
  // every gate passed (a failed read is asked again on the next open). An
  // active grant offers the Wisp tab. Only a panel the user last left on that
  // tab goes into Wisp by itself, and only when it has no conversation: one
  // already open (a restored chat, a device task being created) is never
  // abandoned for it.
  useEffect(() => {
    if (!isOpen || !wispEligible) return;
    const key = selectedOrgId ?? "";
    if (grantLookupKeyRef.current === key) return;
    grantLookupKeyRef.current = key;
    if (useAiStore.getState().wisp) return;
    const justEnded = endedGrantIdRef.current;
    endedGrantIdRef.current = null;
    void lookUpActiveGrant(selectedOrgId).then((result) => {
      // The org changed while this was in flight: the newer lookup owns the answer.
      if (grantLookupKeyRef.current !== key) return;
      if (result.kind === "failed") grantLookupKeyRef.current = null;
      setGrantLookup(result);
      if (result.kind !== "active") return;
      if (result.grant.grantId === justEnded) return;
      const now = useAiStore.getState();
      if (now.panelTab !== "wisp" || now.wisp || now.sessionId || now.isLoading) return;
      void now.enterWispMode(result.grant);
    });
  }, [isOpen, wispEligible, selectedOrgId, wispGrantId]);

  // The grant behind the Wisp tab, kept across a tab switch: leaving Wisp
  // drops the store's grant and the read above starts over, and the tabs must
  // not blink out meanwhile. A read that finds no grant (or fails) removes it.
  const [tabGrant, setTabGrant] = useState<NonNullable<WispState> | null>(null);
  useEffect(() => {
    if (wisp) {
      if (wisp.status === "active") setTabGrant(wisp);
      return;
    }
    if (grantLookup.kind === "active") setTabGrant(grantLookup.grant);
    else if (grantLookup.kind !== "idle") setTabGrant(null);
  }, [wisp, grantLookup]);
  const activeTab: AiPanelTab = wisp ? "wisp" : "session";
  const [tabSwitching, setTabSwitching] = useState(false);

  const handleSelectTab = useCallback(async (tab: AiPanelTab) => {
    if (tabSwitching || tab === activeTab) return;
    setTabSwitching(true);
    try {
      if (tab === "session") {
        await selectPanelTab("session");
        return;
      }
      // The grant as it is NOW, never the read from when the panel opened: one
      // revoked, paused or expired since then must not start a session the
      // server refuses. Its thread also names the conversation to continue.
      const result = await lookUpActiveGrant(selectedOrgId);
      if (result.kind !== "active") {
        setGrantLookup(result);
        return;
      }
      await selectPanelTab("wisp", result.grant);
    } finally {
      setTabSwitching(false);
    }
  }, [activeTab, selectPanelTab, selectedOrgId, tabSwitching]);

  // Wisp is on here but there is no active grant (none, paused, ended, or the
  // plan lacks Wisp): point at the home, which explains and starts or resumes one.
  const showMeetWisp =
    !wisp &&
    canUseAi &&
    partnerToken &&
    wispServerOn &&
    (wispEntitlement.state === "locked" || (wispEntitlement.state === "enabled" && grantLookup.kind === "none"));

  // #10195: under a Wisp header the whole panel is Wisp — replies, empty state, composer.
  const wispScopeLabel = useWispScopeLabel(wisp ? wispSessionOrgId(wisp) : null);

  const boundConnection = boundM365ConnectionId
    ? m365Connections.find((conn) => conn.id === boundM365ConnectionId)
    : null;

  // A new conversation stays on its tab: direct on the direct session, on the
  // grant under Wisp (createSession sends the grant only while Wisp is on).
  const handleNewConversation = useCallback(async () => {
    await closeSession();
    await createSession();
  }, [closeSession, createSession]);

  if (!canUseAi) return null;

  // The page (the Wisp home, a thread page) shows this same conversation with
  // its own composer: the pane hands off to it instead of repeating the header
  // and transcript. Any other conversation keeps working here.
  // The store closes a pane on the page's claim; this render is the fallback.
  const handedOff = wispPaneHandedOff({ wisp, wispPageThreadId, showHistory });

  // Shared by the plain header and the compact Wisp header's Row A.
  const historyButton = !showHistory && (
    <button
      onClick={toggleHistory}
      className={HEADER_ICON_BUTTON}
      title={t("aiChatSidebar.conversationHistory")}
      data-testid="ai-chat-history-toggle"
    >
      <History className="h-4 w-4" />
    </button>
  );
  const newConversationControl = !showHistory && sessionId && (
    <button
      onClick={handleNewConversation}
      className={HEADER_ICON_BUTTON}
      title={t("aiChatSidebar.newConversation")}
      data-testid="ai-chat-new-conversation"
    >
      <Plus className="h-4 w-4" />
    </button>
  );
  const showTabs = !showHistory && !handedOff && (!!wisp || tabGrant !== null);
  const tabs: Array<{ id: AiPanelTab; label: string; hint: string }> = [
    { id: "session", label: t("aiChatSidebar.tabs.session"), hint: t("aiChatSidebar.tabs.sessionHint") },
    { id: "wisp", label: t("wisp.title"), hint: t("aiChatSidebar.tabs.wispHint") },
  ];
  // #9429: the notification bell sits beside Close in every header shape
  // (plain, Wisp, handed off), so collapsing the Wisp header never drops it.
  const closeButton = (
    <>
      <AiNotifyToggle />
      <button
        onClick={close}
        className={HEADER_ICON_BUTTON}
        title={t("aiChatSidebar.closeShortcut")}
        data-testid="ai-chat-close"
      >
        <X className="h-4 w-4" />
      </button>
    </>
  );
  // Under a Wisp header, Flag is an item in Wisp's overflow menu.
  const wispPaneMenuItems: ActionMenuItem[] = sessionId
    ? [{
        id: "flag",
        label: isFlagged ? t("aiChatSidebar.unflagConversation") : t("aiChatSidebar.flagConversation"),
        onSelect: () => void (isFlagged ? unflagSession() : flagSession()),
        testId: "ai-chat-flag",
      }]
    : [];

  return (
    <>
      {/* Sidebar panel */}
      <div
        data-testid="ai-chat-sidebar"
        // Collapsed, the panel slides off-screen via transform but stays
        // mounted (transition:persist). `inert` + pointer-events-none make the
        // off-canvas shell truly non-interactive so it can't intercept clicks
        // meant for page content on wide layouts, and its (off-viewport) Close
        // control drops out of the focus/hit-test order (#1419). It docks below
        // the app header so the bell, theme and account menu stay usable while
        // it is open (#10107).
        inert={!isOpen}
        className={`${RIGHT_DOCK_PANEL_CLASS} ${
          isOpen ? "translate-x-0 shadow-2xl" : "translate-x-full pointer-events-none"
        }`}
      >
        {/* Header — one flat surface with the panel (no stacked card-on-card
            backgrounds); the bottom border alone separates it. Under a Wisp
            grant the compact Wisp header is the whole header (#critique): its
            Row A carries the pane's History, New and Close beside Wisp's own
            overflow menu, which holds Flag too. Handed off to the page's
            composer, it is a plain title row with History and Close. */}
        {handedOff ? (
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
              <span className="text-sm font-semibold text-foreground">{t("wisp.title")}</span>
            </div>
            <div className="flex items-center gap-1">
              {historyButton}
              {closeButton}
            </div>
          </div>
        ) : wisp && !showHistory ? (
          <WispThreadHeader
            wisp={wisp}
            orgName={wispScopeOrgName}
            wideningAvailable={wisp.wideningAvailable}
            paneActions={<>{historyButton}{newConversationControl}</>}
            paneMenuItems={wispPaneMenuItems}
            closeAction={closeButton}
            usageEnabled={isOpen}
          />
        ) : (
          <div className="flex items-center justify-between border-b px-4 py-2">
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
                {showHistory ? t("aiChatSidebar.history") : t("aiChatSidebar.title")}
              </span>
            </div>

            <div className="flex items-center gap-1">
              {historyButton}
              {/* #9427 W3: hidden for topology investigations (D4) and Wisp threads (the workspace has no Wisp controls). */}
              {!showHistory && sessionId && topologySiteId === null && !wisp && (
                <button
                  onClick={() => void moveToAssistant(sessionId, { draft: composerDraft })}
                  className={HEADER_ICON_BUTTON}
                  title={t("aiConversationMove.openInAssistant")}
                  aria-label={t("aiConversationMove.openInAssistant")}
                  data-testid="ai-open-in-assistant"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
              )}
              {newConversationControl}
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
              {closeButton}
            </div>
          </div>
        )}

        {/* Direct session or Wisp: two conversations, one panel. Switching
            closes neither; each tab comes back to its own. */}
        {showTabs && (
          <div
            role="tablist"
            aria-label={t("aiChatSidebar.tabs.label")}
            data-testid="ai-panel-tabs"
            className="flex gap-1 border-b px-3"
          >
            {tabs.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={tab.hint}
                  disabled={tabSwitching}
                  onClick={() => void handleSelectTab(tab.id)}
                  data-testid={`ai-panel-tab-${tab.id}`}
                  className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default ${
                    selected
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab.id === "wisp"
                    ? <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    : <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />}
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}

        {showHistory ? (
          /* History panel — mounted only while open, so its query resets on close. */
          <AiChatHistory currentSessionId={sessionId} onSwitch={switchSession} />
        ) : handedOff ? (
          <div
            data-testid="ai-chat-handed-off"
            className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <p className="text-sm text-muted-foreground">{t("wisp.sidebar.handedOff")}</p>
            <button
              type="button"
              onClick={focusWispPageComposer}
              data-testid="ai-chat-handed-off-focus"
              className="rounded-md border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              {t("wisp.sidebar.handedOffAction")}
            </button>
          </div>
        ) : (
          /* Chat panel */
          <>
            {/* Cost indicator — under a Wisp header its numbers live in the spend chip's popover. */}
            {!wisp && <AiCostIndicator enabled={isOpen} isStreaming={isStreaming} />}

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

            {/* Context badge */}
            {pageContext && (
              <div className="border-b px-4 py-2">
                <AiContextBadge context={pageContext} />
              </div>
            )}

            {/* Error banner */}
            {error && (
              <AiErrorBanner
                error={error}
                retryTarget={topologySiteId !== null ? null : activeRetryTarget({ error, retryTarget })}
                busy={isStreaming || isLoading}
                onRetry={() => void retryLastTurn()}
                onDismiss={clearError}
                dismissLabel={t("aiChatSidebar.dismiss")}
                className="flex items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-4 py-2 dark:border-red-800/50 dark:bg-red-900/20"
                textClassName="text-xs text-red-700 dark:text-red-400"
                buttonClassName="shrink-0 text-xs text-red-700 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300"
              >
                {errorCode === "credits_exhausted" && (
                  <BuyCreditsLink className="ml-2 shrink-0 text-xs font-medium text-red-800 underline underline-offset-2 hover:text-red-900 dark:text-red-300 dark:hover:text-red-200" />
                )}
                {errorCode === "session_closed" && !wisp && (
                  <button
                    type="button"
                    data-testid="ai-session-closed-new-session"
                    onClick={() => void createSession()}
                    className="ml-2 shrink-0 text-xs font-medium text-red-800 underline underline-offset-2 hover:text-red-900 dark:text-red-300 dark:hover:text-red-200"
                  >
                    {t("sessionClosed.startNew")}
                  </button>
                )}
              </AiErrorBanner>
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
              transcriptPurgedAt={transcriptPurgedAt}
              assistantLabel={wisp ? t("wisp.title") : undefined}
              emptyState={
                wisp ? (
                  <WispChatWelcome
                    key={wisp.grantId}
                    grantId={wisp.grantId}
                    orgId={wispSessionOrgId(wisp)}
                    initialState={wisp.firstLookState}
                    scopeLabel={wispScopeLabel}
                    onSuggest={sendMessage}
                    showTitle={false}
                  />
                ) : undefined
              }
            />

            {/* Continuation prompt, what ran, thinking */}
            <AiContinuationPrompt />
            <AiTurnModelBadge turnModel={turnModel} />
            <AiThinkingIndicator thinking={isStreaming && !!thinking} approvalWait={isStreaming ? approvalWaitFromPending(pendingApproval) : null} />

            {/* Input: attachments (Wisp) left of the text, the model chip row under it (#critique) */}
            <AiChatInput
              onSend={sendMessage}
              value={composerDraft}
              focusRequest={composerFocusRequest}
              onValueChange={setComposerDraft}
              onInterrupt={interruptResponse}
              disabled={isLoading}
              isStreaming={isStreaming}
              isInterrupting={isInterrupting}
              placeholder={wisp ? t("wisp.composer.placeholder") : undefined}
              leftSlot={wisp ? <WispAttachmentsButton key={wisp.threadId} wisp={wisp} /> : undefined}
              bottomSlot={<AiModelPicker variant="inline" disabled={isStreaming} />}
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
          data-testid="ai-chat-sidebar-backdrop"
          className={RIGHT_DOCK_BACKDROP_CLASS}
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
