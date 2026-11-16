/**
 * #9429: opt-in browser notifications for the AI chat (side panel and the
 * AI Assistant workspace). A long turn can run for minutes; when the user is
 * looking elsewhere, tell them the reply is ready, failed, or is waiting on
 * their approval (approvals time out, so that one matters most).
 *
 * Rules (Gate B, 2026-10-22):
 * - Permission is only ever requested from a click on the header bell
 *   (`requestNotifyOptIn`), never on page load or mid-turn.
 * - The opt-in is per browser and per user: localStorage
 *   `breeze-ai-notify:<userId>`. Browser permission is itself per browser, so
 *   a server-side flag could be "on" where it can never be honoured.
 * - Text is generic and translated. No device name, reply content or session
 *   title ever reaches the OS (lock screen): options carry body, tag, silent.
 * - Notify when the page is hidden or unfocused; on a visible, focused page
 *   only when the owning surface is not showing the chat, and then only for
 *   kinds that need the user (approval, input).
 *
 * Framework-free and store-free: the stores call in with an `onOpen` that
 * routes a click to their own surface (#9427's deep link plugs in there).
 * Nothing here throws into a caller: every browser API access is guarded, so
 * a blocked storage or a missing Notification API means "off".
 */
import { i18n } from '@/lib/i18n';
import { useAuthStore } from '@/stores/auth';
import { registerLogoutHook } from '@/stores/logoutHooks';

export type AiNotifyKind = 'response_ready' | 'needs_approval' | 'needs_input' | 'failed';
export type AiNotifySurface = { kind: 'sidebar' } | { kind: 'workspace'; tabId: string };
export type AiNotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export interface AiNotifyContext {
  /** The conversation the turn belongs to; null before the first create answers. */
  sessionId: string | null;
  /** Whether the owning surface currently shows this conversation (panel open / tab active). */
  surfaceVisible: boolean;
  /** Routes a click to the surface: open the side panel, switch to the workspace tab. */
  onOpen: () => void;
}

const STORAGE_PREFIX = 'breeze-ai-notify:';
const TAG_PREFIX = 'breeze-ai:';

/** Static map so every key is a literal (keyUsage.test.ts flags computed keys). */
const BODY_KEYS: Record<AiNotifyKind, string> = {
  response_ready: 'ai:aiNotifications.responseReady',
  needs_approval: 'ai:aiNotifications.needsApproval',
  needs_input: 'ai:aiNotifications.needsInput',
  failed: 'ai:aiNotifications.failed',
};

const NEEDS_USER: ReadonlySet<AiNotifyKind> = new Set<AiNotifyKind>(['needs_approval', 'needs_input']);

type NotificationCtor = typeof Notification;

function notificationApi(): NotificationCtor | null {
  try {
    const api = (globalThis as { Notification?: NotificationCtor }).Notification;
    return typeof api === 'function' ? api : null;
  } catch {
    return null;
  }
}

/** The Notification API exists and has not been seen to refuse construction. */
let constructorRefused = false;

export function isNotificationSupported(): boolean {
  return notificationApi() !== null && !constructorRefused;
}

export function getNotifyPermission(): AiNotifyPermission {
  const api = notificationApi();
  if (!api || constructorRefused) return 'unsupported';
  try {
    const p = api.permission;
    return p === 'granted' || p === 'denied' ? p : 'default';
  } catch {
    return 'unsupported';
  }
}

export function isNotifyOptedIn(userId: string | undefined | null): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(STORAGE_PREFIX + userId) === '1';
  } catch {
    return false;
  }
}

export function setNotifyOptIn(userId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_PREFIX + userId, '1');
    else localStorage.removeItem(STORAGE_PREFIX + userId);
  } catch {
    // Storage blocked (private window, site data off): the feature stays off.
  }
}

/**
 * Called only from the bell's click handler (the browser requires a user
 * gesture). Prompts only while permission is undecided; a denied permission is
 * never re-prompted (the browser would ignore it anyway). Stores the opt-in
 * only on a grant, and returns whether the user is now opted in.
 */
export async function requestNotifyOptIn(userId: string): Promise<boolean> {
  const api = notificationApi();
  if (!api) return false;
  let permission = getNotifyPermission();
  if (permission === 'default') {
    try {
      permission = (await api.requestPermission()) as AiNotifyPermission;
    } catch {
      return false;
    }
  }
  if (permission !== 'granted') return false;
  setNotifyOptIn(userId, true);
  return isNotifyOptedIn(userId);
}

function documentAttended(): boolean {
  try {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch {
    return true;
  }
}

/**
 * The visibility rule. A hidden or unfocused page always qualifies (a visible
 * window behind another app still reports 'visible', hence hasFocus). On an
 * attended page only a need-the-user kind qualifies, and only when the owning
 * surface is not showing the chat.
 */
export function shouldNotify(kind: AiNotifyKind, surfaceVisible: boolean): boolean {
  if (!documentAttended()) return true;
  return !surfaceVisible && NEEDS_USER.has(kind);
}

function surfaceKey(surface: AiNotifySurface): string {
  return surface.kind === 'sidebar' ? 'sidebar' : `workspace:${surface.tabId}`;
}

function baseTag(surface: AiNotifySurface, sessionId: string | null): string {
  return TAG_PREFIX + (sessionId ?? surfaceKey(surface));
}

/** Approvals get their own tag so a later "ready" for the turn does not silently replace one. */
function tagFor(kind: AiNotifyKind, surface: AiNotifySurface, sessionId: string | null): string {
  const base = baseTag(surface, sessionId);
  return NEEDS_USER.has(kind) ? `${base}:input` : base;
}

const open = new Map<string, Notification>();

function currentUserId(): string | undefined {
  try {
    return useAuthStore.getState().user?.id;
  } catch {
    return undefined;
  }
}

export function notifyAi(kind: AiNotifyKind, surface: AiNotifySurface, opts: AiNotifyContext): void {
  try {
    const api = notificationApi();
    if (!api || constructorRefused || getNotifyPermission() !== 'granted') return;
    if (!isNotifyOptedIn(currentUserId())) return;
    if (!shouldNotify(kind, opts.surfaceVisible)) return;

    const tag = tagFor(kind, surface, opts.sessionId);
    let n: Notification;
    try {
      n = new api(i18n.t('ai:aiNotifications.title'), { body: i18n.t(BODY_KEYS[kind]), tag, silent: true });
    } catch (err) {
      // Android Chrome (and some embedded browsers) only allow service-worker
      // notifications: stop trying and let the bell hide itself.
      constructorRefused = true;
      console.warn('[aiNotifications] Notification construction refused:', err);
      return;
    }
    open.get(tag)?.close();
    open.set(tag, n);
    const forget = () => { if (open.get(tag) === n) open.delete(tag); };
    n.onclose = forget;
    n.onclick = () => {
      try {
        window.focus();
        opts.onOpen();
      } catch (err) {
        console.warn('[aiNotifications] Opening the chat from a notification failed:', err);
      } finally {
        forget();
        n.close();
      }
    };
  } catch (err) {
    console.warn('[aiNotifications] notify failed:', err);
  }
}

function closeTag(tag: string): void {
  const n = open.get(tag);
  if (!n) return;
  open.delete(tag);
  try { n.close(); } catch { /* already gone */ }
}

/** The user is reading this conversation: drop its ready/failed and its approval notifications. */
export function closeAiNotification(surface: AiNotifySurface, sessionId: string | null): void {
  const base = baseTag(surface, sessionId);
  closeTag(base);
  closeTag(`${base}:input`);
}

export function closeAllAiNotifications(): void {
  for (const tag of [...open.keys()]) closeTag(tag);
}

// --- Per-turn mapping -------------------------------------------------------

/**
 * Surfaces whose current turn already reported a failure. The server sends
 * `error` then `done` for a failed turn, so the `done` must not also say
 * "ready"; the route's own stream failure sends `error` alone, so each new
 * turn starts with `resetAiTurnNotify`.
 */
const failedTurns = new Set<string>();

export function resetAiTurnNotify(surface: AiNotifySurface): void {
  failedTurns.delete(surfaceKey(surface));
}

/** Map one applied stream event (send or attach) to at most one notification. */
export function noteAiTurnEvent(eventType: string, surface: AiNotifySurface, ctx: AiNotifyContext): void {
  try {
    const key = surfaceKey(surface);
    switch (eventType) {
      case 'approval_required':
      case 'plan_approval_required':
        notifyAi('needs_approval', surface, ctx);
        return;
      case 'error':
        if (failedTurns.has(key)) return;
        failedTurns.add(key);
        notifyAi('failed', surface, ctx);
        return;
      case 'done':
        if (failedTurns.delete(key)) return;
        notifyAi('response_ready', surface, ctx);
        return;
      default:
        return;
    }
  } catch (err) {
    console.warn('[aiNotifications] turn event not mapped:', err);
  }
}

/** The request or its stream broke (no `error` event): report it once for the turn. */
export function noteAiStreamFailure(surface: AiNotifySurface, ctx: AiNotifyContext): void {
  noteAiTurnEvent('error', surface, ctx);
}

/** Test seam: forget every notification, failed turn and a refused constructor. */
export function resetAiNotificationsForTests(): void {
  open.clear();
  failedTurns.clear();
  constructorRefused = false;
}

// Logout: nothing from the previous user stays in the OS tray.
registerLogoutHook(() => {
  closeAllAiNotifications();
  failedTurns.clear();
});
