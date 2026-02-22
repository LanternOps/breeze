import { useState, useEffect } from 'react';
import { ShieldAlert, Check, X, Clock, Monitor } from 'lucide-react';

// Must be <= server-side waitForApproval timeout (300s). Plan approvals use 10-min timeout.
const AUTO_DENY_MS = 5 * 60 * 1000;

/** Keys that are internal identifiers — not useful to show the user */
const HIDDEN_INPUT_KEYS = new Set(['deviceId', 'orgId', 'siteId', 'sessionId']);

interface ActiveSessionInfo {
  username: string;
  activityState?: string;
  idleMinutes?: number;
  sessionType: string;
}

interface DeviceContext {
  hostname: string;
  displayName?: string;
  status: string;
  lastSeenAt?: string;
  activeSessions?: ActiveSessionInfo[];
}

interface AiApprovalDialogProps {
  toolName: string;
  description: string;
  input: Record<string, unknown>;
  deviceContext?: DeviceContext;
  onApprove: () => void;
  onReject: () => void;
}

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

function UserSessionBadge({ session }: { session: ActiveSessionInfo }) {
  const state = session.activityState ?? 'unknown';
  const isActive = state === 'active';
  const idleText = !isActive && session.idleMinutes != null && session.idleMinutes > 0
    ? `idle ${formatIdle(session.idleMinutes)}`
    : null;

  const stateColors: Record<string, string> = {
    active: 'text-green-400',
    idle: 'text-yellow-400',
    locked: 'text-amber-400',
    away: 'text-gray-400',
    disconnected: 'text-gray-500',
  };

  const stateLabel = idleText ?? state;

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-gray-300">{session.username}</span>
      {session.sessionType !== 'console' && (
        <span className="text-gray-600 uppercase text-[10px]">{session.sessionType}</span>
      )}
      <span className={stateColors[state] ?? 'text-gray-500'}>{stateLabel}</span>
    </span>
  );
}

function DeviceBadge({ ctx }: { ctx: DeviceContext }) {
  const name = ctx.displayName || ctx.hostname;
  const isOnline = ctx.status === 'online';
  const sessions = ctx.activeSessions ?? [];
  const deviceIdleText = !isOnline ? formatDeviceIdle(ctx.lastSeenAt) : null;

  return (
    <div className="mt-2 rounded-md bg-gray-800/60 px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <Monitor className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <span className="font-medium text-gray-200 truncate">{name}</span>
        <span className="text-gray-600">&middot;</span>
        <span className={isOnline ? 'text-green-400' : 'text-gray-500'}>
          {isOnline ? 'online' : (deviceIdleText ? `offline ${deviceIdleText}` : 'offline')}
        </span>
      </div>
      {sessions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5.5">
          {sessions.map((s, i) => (
            <UserSessionBadge key={i} session={s} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AiApprovalDialog({ toolName, description, input, deviceContext, onApprove, onReject }: AiApprovalDialogProps) {
  const [remainingMs, setRemainingMs] = useState(AUTO_DENY_MS);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const remaining = AUTO_DENY_MS - (Date.now() - start);
      if (remaining <= 0) {
        clearInterval(interval);
        onReject();
      } else {
        setRemainingMs(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [onReject]);

  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const countdown = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const progressPct = (remainingMs / AUTO_DENY_MS) * 100;

  const visibleInput = filterInput(input);
  const hasVisibleInput = Object.keys(visibleInput).length > 0;

  return (
    <div className="my-2 rounded-lg border border-amber-600/50 bg-amber-950/30 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          <span className="text-sm font-medium text-amber-300">Approval Required</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Clock className="h-3 w-3" />
          <span>{countdown}</span>
        </div>
      </div>

      {/* Countdown progress bar */}
      <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-gray-800">
        <div
          className="h-full rounded-full bg-amber-500/60 transition-all duration-1000 ease-linear"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <p className="mt-2 text-sm text-gray-300">{description}</p>

      {deviceContext && <DeviceBadge ctx={deviceContext} />}

      {hasVisibleInput && (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-400 select-none">
            Show parameters
          </summary>
          <pre className="mt-1 max-h-24 overflow-auto rounded bg-gray-900 px-3 py-2 text-xs text-gray-400">
            {JSON.stringify(visibleInput, null, 2)}
          </pre>
        </details>
      )}

      <div className="mt-3 flex gap-2">
        <button
          onClick={onApprove}
          className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
        >
          <Check className="h-3.5 w-3.5" />
          Approve
        </button>
        <button
          onClick={onReject}
          className="flex items-center gap-1.5 rounded-md bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-600"
        >
          <X className="h-3.5 w-3.5" />
          Reject
        </button>
      </div>
    </div>
  );
}
