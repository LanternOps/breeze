import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useChatStore } from '../../stores/chatStore';
import type { SessionSummary, PendingApproval, DeviceContext } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import WorkspacePanel from '../workspace/WorkspacePanel';
import { SegmentedControl } from '../ui/SegmentedControl';
import ChatView from './ChatView';

const isMacOS = navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh');

// The shell's single main region shows one of these at a time. Files/Chat/
// History are reachable from the nav; device-info arrives only via the tray
// menu. The shell header persists across every value — none of these unmount it.
export type MainView = 'files' | 'chat' | 'history' | 'device-info';

// At or above this inner width the chat rides as a right-side panel next to the
// main region; below it there's no room, so the chat toggle full-swaps the main
// region instead. Exported for tests.
export const SHELL_WIDE_MIN = 720;

function subscribeWidth(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}
function widthSnapshot() {
  return window.innerWidth;
}
// useSyncExternalStore keeps the breakpoint check in sync with live `resize`
// events without a manual effect + state dance. The server snapshot returns the
// breakpoint itself (treated as wide) — the shell only ever renders client-side.
function useIsWide() {
  const width = useSyncExternalStore(subscribeWidth, widthSnapshot, () => SHELL_WIDE_MIN);
  return width >= SHELL_WIDE_MIN;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function SessionHistory({ onClose }: { onClose: () => void }) {
  const { sessions, sessionsLoading, loadSession, loadSessions } = useChatStore();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleSelect = (session: SessionSummary) => {
    loadSession(session.id);
    onClose();
  };

  return (
    <div className="helper-history">
      <div className="helper-history-header" data-tauri-drag-region>
        {isMacOS && <div className="helper-traffic-light-spacer" />}
        <span className="helper-history-title">History</span>
        <div className="helper-header-drag-spacer" data-tauri-drag-region />
        <button onClick={onClose} className="helper-btn helper-btn-sm">
          Back
        </button>
      </div>
      <div className="helper-history-list">
        {sessionsLoading && (
          <div className="helper-history-loading">
            <span className="helper-spinner" />
            <span>Loading...</span>
          </div>
        )}
        {!sessionsLoading && sessions.length === 0 && (
          <div className="helper-history-empty">No conversations yet</div>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            className="helper-history-item"
            onClick={() => handleSelect(s)}
          >
            <span className="helper-history-item-title">
              {s.title || 'Untitled'}
            </span>
            <span className="helper-history-item-meta">
              {formatDate(s.updatedAt)}
              {s.turnCount > 0 && ` · ${s.turnCount} turns`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Must be <= server-side waitForApproval timeout (300s). Plan approvals use 10-min timeout.
const AUTO_DENY_MS = 5 * 60 * 1000; // 5 minutes
const HIDDEN_INPUT_KEYS = new Set(['deviceId', 'orgId', 'siteId', 'sessionId']);

function filterInput(input: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!HIDDEN_INPUT_KEYS.has(k)) filtered[k] = v;
  }
  return filtered;
}

function formatIdle(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDeviceIdle(lastSeenAt: string | undefined): string | null {
  if (!lastSeenAt) return null;
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < 60_000) return null;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function DeviceBadge({ ctx }: { ctx: DeviceContext }) {
  const name = ctx.displayName || ctx.hostname;
  const isOnline = ctx.status === 'online';
  const deviceIdleText = !isOnline ? formatDeviceIdle(ctx.lastSeenAt) : null;
  const sessions = ctx.activeSessions ?? [];

  return (
    <div className="helper-approval-device">
      <div className="helper-approval-device-row">
        <span className="helper-approval-device-name">{name}</span>
        <span className="helper-approval-device-sep">&middot;</span>
        <span className={isOnline ? 'helper-approval-device-active' : 'helper-approval-device-idle'}>
          {isOnline ? 'online' : (deviceIdleText ? `offline ${deviceIdleText}` : 'offline')}
        </span>
      </div>
      {sessions.map((s, i) => {
        const state = s.activityState ?? 'unknown';
        const idleText = state !== 'active' && s.idleMinutes != null && s.idleMinutes > 0
          ? `idle ${formatIdle(s.idleMinutes)}`
          : state;
        return (
          <div key={i} className="helper-approval-device-session">
            <span className="helper-approval-device-user">{s.username}</span>
            {s.sessionType !== 'console' && (
              <span className="helper-approval-device-type">{s.sessionType}</span>
            )}
            <span className={state === 'active' ? 'helper-approval-device-active' : 'helper-approval-device-idle'}>
              {idleText}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ToolApprovalPopup({
  approval,
  onApprove,
  onDeny,
}: {
  approval: PendingApproval;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [remainingMs, setRemainingMs] = useState(AUTO_DENY_MS);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = AUTO_DENY_MS - elapsed;
      if (remaining <= 0) {
        clearInterval(interval);
        onDeny();
      } else {
        setRemainingMs(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [onDeny]);

  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const countdown = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  const visibleInput = filterInput(approval.input);
  const hasVisibleInput = Object.keys(visibleInput).length > 0;

  return (
    <div className="helper-approval-overlay">
      <div className="helper-approval-card">
        <div className="helper-approval-header">
          <span className="helper-approval-icon">&#9888;</span>
          <span className="helper-approval-title">Approval Required</span>
        </div>
        <div className="helper-approval-body">
          <div className="helper-approval-desc">{approval.description}</div>
          {approval.deviceContext && <DeviceBadge ctx={approval.deviceContext} />}
          {hasVisibleInput && (
            <details className="helper-approval-details">
              <summary>Show parameters</summary>
              <pre className="helper-approval-input">
                {JSON.stringify(visibleInput, null, 2)}
              </pre>
            </details>
          )}
        </div>
        <div className="helper-approval-footer">
          <span className="helper-approval-countdown">Auto-deny {countdown}</span>
          <div className="helper-approval-actions">
            <button onClick={onDeny} className="helper-btn helper-btn-deny">
              Deny
            </button>
            <button onClick={onApprove} className="helper-btn helper-btn-allow">
              Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type DeviceInfo = {
  hostname: string;
  osType: string;
  osVersion: string;
  status: string;
  lastSeenAt?: string;
  agentVersion?: string;
};

function DeviceInfoView({ onClose }: { onClose: () => void }) {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { agentConfig } = useChatStore();
  const helperVersion = agentConfig?.helper_version;

  useEffect(() => {
    if (!agentConfig) return;
    setLoading(true);
    setError(null);

    invoke<{ status: number; body: string }>('helper_fetch', {
        request: {
          url: `${agentConfig.api_url}/api/v1/helper/device-info`,
          method: 'GET',
        },
      })
      .then((res) => {
        if (res.status >= 200 && res.status < 300) {
          const data = JSON.parse(res.body);
          setDevice({
            hostname: data.hostname || data.displayName || 'Unknown',
            osType: data.osType || 'Unknown',
            osVersion: data.osVersion || '',
            status: data.status || 'unknown',
            lastSeenAt: data.lastSeenAt,
            agentVersion: data.agentVersion,
          });
        } else {
          setError('Failed to load device info');
        }
      })
      .catch((e: Error) => setError(e.message || 'Failed to load device info'))
      .finally(() => setLoading(false));
  }, [agentConfig]);

  return (
    <div className="helper-history">
      <div className="helper-history-header" data-tauri-drag-region>
        {isMacOS && <div className="helper-traffic-light-spacer" />}
        <span className="helper-history-title">Device Info</span>
        <div className="helper-header-drag-spacer" data-tauri-drag-region />
        <button onClick={onClose} className="helper-btn helper-btn-sm">Back</button>
      </div>
      <div className="helper-messages" style={{ padding: '16px' }}>
        {loading && (
          <div className="helper-history-loading">
            <span className="helper-spinner" />
            <span>Loading...</span>
          </div>
        )}
        {error && <div className="helper-error-banner"><span>{error}</span></div>}
        {device && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ padding: '12px', border: '1px solid var(--helper-border, #e5e7eb)', borderRadius: '8px' }}>
              <div style={{ fontSize: '13px', color: 'var(--helper-muted, #6b7280)' }}>Hostname</div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>{device.hostname}</div>
            </div>
            <div style={{ padding: '12px', border: '1px solid var(--helper-border, #e5e7eb)', borderRadius: '8px' }}>
              <div style={{ fontSize: '13px', color: 'var(--helper-muted, #6b7280)' }}>Operating System</div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>{device.osType} {device.osVersion}</div>
            </div>
            <div style={{ padding: '12px', border: '1px solid var(--helper-border, #e5e7eb)', borderRadius: '8px' }}>
              <div style={{ fontSize: '13px', color: 'var(--helper-muted, #6b7280)' }}>Status</div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: device.status === 'online' ? '#22c55e' : '#ef4444' }}>
                {device.status}
              </div>
            </div>
            {device.lastSeenAt && (
              <div style={{ padding: '12px', border: '1px solid var(--helper-border, #e5e7eb)', borderRadius: '8px' }}>
                <div style={{ fontSize: '13px', color: 'var(--helper-muted, #6b7280)' }}>Last Check-in</div>
                <div style={{ fontSize: '15px', fontWeight: 600 }}>{formatDate(device.lastSeenAt)}</div>
              </div>
            )}
            {device.agentVersion && (
              <div style={{ padding: '12px', border: '1px solid var(--helper-border, #e5e7eb)', borderRadius: '8px' }}>
                <div style={{ fontSize: '13px', color: 'var(--helper-muted, #6b7280)' }}>Agent Version</div>
                <div style={{ fontSize: '15px', fontWeight: 600 }}>{device.agentVersion}</div>
              </div>
            )}
            {helperVersion && (
              <div style={{ padding: '12px', border: '1px solid var(--helper-border, #e5e7eb)', borderRadius: '8px' }}>
                <div style={{ fontSize: '13px', color: 'var(--helper-muted, #6b7280)' }}>Helper Version</div>
                <div style={{ fontSize: '15px', fontWeight: 600 }}>{helperVersion}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The persistent files-first shell: ONE header (drag region + traffic-light
// spacer + status dot + title + a Files/Chat/History SegmentedControl + the
// chat-scoped Flag/New actions) over a single main region that swaps on
// `mainView`. Connection gates and the username prompt stay full-screen ABOVE
// this in App; by the time the shell mounts we are always connected + named.
export default function AppShell() {
  const {
    sessionId,
    error,
    pendingApproval,
    isFlagged,
    clearMessages,
    approveExecution,
    flagSession,
  } = useChatStore();
  const workspaceAvailable = useWorkspaceStore((s) => s.available);

  // Files when the capability is known-available at first render, else chat.
  // The probe may still be pending (null) here, so an effect below promotes to
  // Files the moment it resolves true — preserving the land-on-Files default.
  const [mainView, setMainView] = useState<MainView>(
    workspaceAvailable === true ? 'files' : 'chat',
  );
  // Where Back returns to after a transient view (History / Device Info): the
  // last primary view the user was on before entering one.
  const returnViewRef = useRef<MainView>('files');
  // Once the user navigates by hand, stop auto-steering the default view.
  const navigatedRef = useRef(false);

  // Chat side panel (wide windows only) and the composer draft. The draft lives
  // here — a single definition shared by whichever ChatView is mounted (panel or
  // full-swap main region) — so text survives a breakpoint conversion.
  const isWide = useIsWide();
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (workspaceAvailable === true && !navigatedRef.current) {
      setMainView('files');
    }
  }, [workspaceAvailable]);

  // Cross the breakpoint downward with the panel open → convert the panel into a
  // full swap (chat becomes the main region). The draft is untouched, so the
  // in-flight composer text rides along.
  useEffect(() => {
    if (!isWide && chatPanelOpen) {
      setChatPanelOpen(false);
      setMainView('chat');
      navigatedRef.current = true;
    }
  }, [isWide, chatPanelOpen]);

  const enter = (view: MainView) => {
    navigatedRef.current = true;
    setMainView((cur) => {
      const transient = view === 'history' || view === 'device-info';
      if (transient && cur !== 'history' && cur !== 'device-info') {
        returnViewRef.current = cur;
      }
      return view;
    });
  };

  const goBack = () => {
    navigatedRef.current = true;
    setMainView(returnViewRef.current);
  };

  // Chat toggle: on wide windows it rides as a side panel next to Files; on
  // narrow windows there's no room, so it full-swaps the main region to chat.
  const toggleChat = () => {
    if (isWide) {
      setChatPanelOpen((open) => !open);
    } else {
      setChatPanelOpen(false);
      enter('chat');
    }
  };

  // Tray menu "Device Info" click. Tray events only exist inside Tauri; the
  // direct listen() call throws in browser dev mode, so skip it when the Tauri
  // IPC bridge is absent.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    listen('show-device-info', () => {
      enter('device-info');
    }).then((fn: () => void) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const navOptions = [
    ...(workspaceAvailable === true ? [{ key: 'files', label: 'Files' }] : []),
    { key: 'chat', label: 'Chat' },
    { key: 'history', label: 'History' },
  ];

  // Flag/New are chat-scoped — they only make sense while the chat is the main
  // view (matches the pre-shell header, which showed them only on the chat home).
  const chatScoped = mainView === 'chat';

  // The chat toggle only makes sense from Files (the one primary view that can
  // sit beside a chat panel). The panel itself renders only when wide + open.
  const canToggleChat = mainView === 'files' && workspaceAvailable === true;
  const panelOpen = canToggleChat && isWide && chatPanelOpen;

  return (
    <div className="helper-shell bg-ws-canvas">
      {/* Header — the shell's single draggable title bar */}
      <div className={`helper-header${isMacOS ? ' helper-header-macos' : ''}`} data-tauri-drag-region>
        <div className="helper-header-left" data-tauri-drag-region>
          {isMacOS && <div className="helper-traffic-light-spacer" />}
          <span className="helper-status-dot helper-status-connected" />
          <span className="helper-title">Breeze Helper</span>
        </div>
        <div className="helper-shell-nav">
          <SegmentedControl
            options={navOptions}
            value={mainView}
            onChange={(key) => enter(key as MainView)}
          />
        </div>
        <div className="helper-header-drag-spacer" data-tauri-drag-region />
        <div className="helper-header-actions">
          {canToggleChat && (
            <button
              onClick={toggleChat}
              className="helper-btn helper-btn-sm helper-chat-toggle"
              data-testid="chat-toggle"
              aria-pressed={panelOpen}
              title={panelOpen ? 'Hide chat' : 'Show chat'}
            >
              Chat
            </button>
          )}
          {chatScoped && sessionId && (
            <button
              onClick={() => flagSession('User flagged from helper')}
              className={`helper-btn helper-btn-sm${isFlagged ? ' helper-btn-flagged' : ''}`}
              title={isFlagged ? 'Conversation flagged' : 'Flag conversation for review'}
              disabled={isFlagged}
            >
              {isFlagged ? 'Flagged' : 'Flag'}
            </button>
          )}
          {chatScoped && (
            <button
              onClick={clearMessages}
              className="helper-btn helper-btn-sm"
              title="New conversation"
            >
              New
            </button>
          )}
          {!isMacOS && (
            <>
              <button
                onClick={() => invoke('minimize_window').catch(() => {})}
                className="helper-btn-window"
                title="Minimize"
              >
                &#8211;
              </button>
              <button
                onClick={() => invoke('hide_window').catch(() => {})}
                className="helper-btn-window helper-btn-window-close"
                title="Close to tray"
              >
                &#10005;
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main region — one view at a time; the header above never unmounts.
          The chat error banner and the tool-approval popup are chat-scoped
          chrome (as in the pre-shell chat home), so they render only with
          ChatView — not over Files/History. */}
      <div className={`helper-shell-main${panelOpen ? ' helper-shell-main-split' : ''}`}>
        {mainView === 'history' ? (
          <SessionHistory onClose={goBack} />
        ) : mainView === 'device-info' ? (
          <DeviceInfoView onClose={goBack} />
        ) : mainView === 'files' && workspaceAvailable === true ? (
          <WorkspacePanel embedded onClose={goBack} />
        ) : (
          <>
            {error && (
              <div className="helper-error-banner">
                <span>{error}</span>
                <button
                  onClick={() => useChatStore.setState({ error: null })}
                  className="helper-btn-close"
                >
                  ×
                </button>
              </div>
            )}

            {pendingApproval && (
              <ToolApprovalPopup
                approval={pendingApproval}
                onApprove={() => approveExecution(pendingApproval.executionId, true)}
                onDeny={() => approveExecution(pendingApproval.executionId, false)}
              />
            )}

            <ChatView draft={draft} setDraft={setDraft} />
          </>
        )}

        {/* Chat side panel (wide windows) — Files stays mounted to the left. The
            same draft state feeds this ChatView and the full-swap one, so text
            survives a breakpoint conversion. */}
        {panelOpen && (
          <aside className="helper-chat-panel" data-testid="chat-panel">
            <ChatView draft={draft} setDraft={setDraft} />
          </aside>
        )}
      </div>
    </div>
  );
}
