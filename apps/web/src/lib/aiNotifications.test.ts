import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => authState },
}));

import {
  closeAiNotification,
  closeAllAiNotifications,
  getNotifyPermission,
  isNotificationSupported,
  isNotifyOptedIn,
  noteAiStreamFailure,
  noteAiTurnEvent,
  notifyAi,
  requestNotifyOptIn,
  resetAiNotificationsForTests,
  resetAiTurnNotify,
  setNotifyOptIn,
  shouldNotify,
  type AiNotifyKind,
} from './aiNotifications';
import { runLogoutHooks } from '@/stores/logoutHooks';

/** A stand-in for the browser Notification API: records every construction. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => FakeNotification.permission);
  static instances: FakeNotification[] = [];
  static throwOnConstruct = false;
  title: string;
  options: NotificationOptions;
  onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  onclose: ((this: Notification, ev: Event) => unknown) | null = null;
  close = vi.fn(() => {
    this.onclose?.call(this as unknown as Notification, new Event('close'));
  });
  constructor(title: string, options: NotificationOptions) {
    if (FakeNotification.throwOnConstruct) throw new TypeError('Illegal constructor');
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
}

const g = globalThis as unknown as { Notification?: unknown };

function setDocumentState(visibility: 'visible' | 'hidden', focused: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

const KINDS: AiNotifyKind[] = ['response_ready', 'needs_approval', 'needs_input', 'failed'];
const sidebar = { kind: 'sidebar' } as const;

beforeEach(() => {
  FakeNotification.permission = 'granted';
  FakeNotification.instances = [];
  FakeNotification.throwOnConstruct = false;
  FakeNotification.requestPermission.mockClear();
  g.Notification = FakeNotification;
  authState.user = { id: 'u1' };
  localStorage.clear();
  setDocumentState('hidden', false);
});

afterEach(() => {
  resetAiNotificationsForTests();
  vi.restoreAllMocks();
  delete g.Notification;
});

describe('support and permission', () => {
  it('reports unsupported when the Notification API is missing', () => {
    delete g.Notification;
    expect(isNotificationSupported()).toBe(false);
    expect(getNotifyPermission()).toBe('unsupported');
  });

  it('reports the browser permission when supported', () => {
    FakeNotification.permission = 'denied';
    expect(isNotificationSupported()).toBe(true);
    expect(getNotifyPermission()).toBe('denied');
  });
});

describe('opt-in storage', () => {
  it('is off without a user id', () => {
    expect(isNotifyOptedIn(undefined)).toBe(false);
  });

  it('stores the opt-in per user under breeze-ai-notify:<userId>', () => {
    setNotifyOptIn('u1', true);
    expect(localStorage.getItem('breeze-ai-notify:u1')).toBe('1');
    expect(isNotifyOptedIn('u1')).toBe(true);
    expect(isNotifyOptedIn('u2')).toBe(false);
    setNotifyOptIn('u1', false);
    expect(localStorage.getItem('breeze-ai-notify:u1')).toBeNull();
    expect(isNotifyOptedIn('u1')).toBe(false);
  });

  it('degrades to off when storage throws, and never throws itself', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(isNotifyOptedIn('u1')).toBe(false);
    expect(() => setNotifyOptIn('u1', true)).not.toThrow();
    expect(() => setNotifyOptIn('u1', false)).not.toThrow();
  });
});

describe('requestNotifyOptIn', () => {
  it('asks the browser when permission is default and stores the opt-in on grant', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });
    await expect(requestNotifyOptIn('u1')).resolves.toBe(true);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('breeze-ai-notify:u1')).toBe('1');
  });

  it('does not store the opt-in when the user refuses the prompt', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockImplementationOnce(async () => 'denied');
    await expect(requestNotifyOptIn('u1')).resolves.toBe(false);
    expect(localStorage.getItem('breeze-ai-notify:u1')).toBeNull();
  });

  it('never prompts when permission is already denied', async () => {
    FakeNotification.permission = 'denied';
    await expect(requestNotifyOptIn('u1')).resolves.toBe(false);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(localStorage.getItem('breeze-ai-notify:u1')).toBeNull();
  });

  it('opts in without prompting when permission is already granted', async () => {
    await expect(requestNotifyOptIn('u1')).resolves.toBe(true);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(isNotifyOptedIn('u1')).toBe(true);
  });

  it('resolves false when the API is missing or the prompt throws', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockImplementationOnce(async () => { throw new Error('no gesture'); });
    await expect(requestNotifyOptIn('u1')).resolves.toBe(false);
    delete g.Notification;
    await expect(requestNotifyOptIn('u1')).resolves.toBe(false);
  });
});

describe('shouldNotify', () => {
  it('always notifies while the document is hidden', () => {
    setDocumentState('hidden', false);
    for (const kind of KINDS) {
      expect(shouldNotify(kind, true)).toBe(true);
      expect(shouldNotify(kind, false)).toBe(true);
    }
  });

  it('always notifies while the window is visible but not focused', () => {
    setDocumentState('visible', false);
    for (const kind of KINDS) {
      expect(shouldNotify(kind, true)).toBe(true);
      expect(shouldNotify(kind, false)).toBe(true);
    }
  });

  it('never notifies for a visible, focused, open surface', () => {
    setDocumentState('visible', true);
    for (const kind of KINDS) expect(shouldNotify(kind, true)).toBe(false);
  });

  it('on a visible, focused page with the surface closed, notifies only for needs-input kinds', () => {
    setDocumentState('visible', true);
    expect(shouldNotify('needs_approval', false)).toBe(true);
    expect(shouldNotify('needs_input', false)).toBe(true);
    expect(shouldNotify('response_ready', false)).toBe(false);
    expect(shouldNotify('failed', false)).toBe(false);
  });
});

describe('notifyAi', () => {
  const onOpen = vi.fn();
  beforeEach(() => {
    onOpen.mockReset();
    setNotifyOptIn('u1', true);
  });

  it('shows generic, silent text tagged per session, with no other fields (lock-screen privacy)', () => {
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    expect(FakeNotification.instances).toHaveLength(1);
    const n = FakeNotification.instances[0]!;
    expect(n.title).toBe('Breeze AI');
    expect(n.options).toEqual({ body: 'Response ready', tag: 'breeze-ai:s1', silent: true });
    expect(Object.keys(n.options).sort()).toEqual(['body', 'silent', 'tag']);
  });

  it('uses a separate tag for approvals so a later "ready" does not silently replace one', () => {
    notifyAi('needs_approval', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    notifyAi('failed', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    expect(FakeNotification.instances.map((n) => [n.options.tag, n.options.body])).toEqual([
      ['breeze-ai:s1:input', 'Needs your approval'],
      ['breeze-ai:s1', 'Response failed'],
    ]);
  });

  it('falls back to the surface key when the session id is not known yet', () => {
    notifyAi('response_ready', { kind: 'workspace', tabId: 't9' }, { sessionId: null, surfaceVisible: false, onOpen });
    expect(FakeNotification.instances[0]!.options.tag).toBe('breeze-ai:workspace:t9');
  });

  it('does nothing when not opted in, for another user, or with permission not granted', () => {
    setNotifyOptIn('u1', false);
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    setNotifyOptIn('u1', true);
    authState.user = { id: 'u2' };
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    authState.user = null;
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    authState.user = { id: 'u1' };
    FakeNotification.permission = 'denied';
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('does nothing for a visible, focused, open surface', () => {
    setDocumentState('visible', true);
    notifyAi('needs_approval', sidebar, { sessionId: 's1', surfaceVisible: true, onOpen });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('notifies for an approval when the page is visible but the side panel is closed', () => {
    setDocumentState('visible', true);
    notifyAi('needs_approval', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('on click focuses the window, opens the surface and closes the notification', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    const n = FakeNotification.instances[0]!;
    n.onclick?.call(n as unknown as Notification, new Event('click'));
    expect(focus).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(n.close).toHaveBeenCalled();
  });

  it('a throwing onOpen still closes the notification and does not escape the click', () => {
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen: () => { throw new Error('boom'); } });
    const n = FakeNotification.instances[0]!;
    expect(() => n.onclick?.call(n as unknown as Notification, new Event('click'))).not.toThrow();
    expect(n.close).toHaveBeenCalled();
  });

  it('closeAiNotification closes both the ready and the approval notification of a session', () => {
    notifyAi('needs_approval', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    notifyAi('response_ready', sidebar, { sessionId: 's2', surfaceVisible: false, onOpen });
    closeAiNotification(sidebar, 's1');
    const [approval, ready, other] = FakeNotification.instances;
    expect(approval!.close).toHaveBeenCalled();
    expect(ready!.close).toHaveBeenCalled();
    expect(other!.close).not.toHaveBeenCalled();
  });

  it('closeAiNotification with no session id closes the surface-keyed notification', () => {
    const surface = { kind: 'workspace', tabId: 't1' } as const;
    notifyAi('response_ready', surface, { sessionId: null, surfaceVisible: false, onOpen });
    closeAiNotification(surface, null);
    expect(FakeNotification.instances[0]!.close).toHaveBeenCalled();
  });

  it('closeAllAiNotifications closes every open notification', () => {
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    notifyAi('response_ready', sidebar, { sessionId: 's2', surfaceVisible: false, onOpen });
    closeAllAiNotifications();
    for (const n of FakeNotification.instances) expect(n.close).toHaveBeenCalled();
  });

  it('swallows a constructor that throws (e.g. Android Chrome without a service worker)', () => {
    FakeNotification.throwOnConstruct = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen })).not.toThrow();
  });

  it('a TypeError from the constructor latches the feature off (the bell hides)', () => {
    FakeNotification.throwOnConstruct = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    expect(isNotificationSupported()).toBe(false);
    expect(getNotifyPermission()).toBe('unsupported');
  });

  it('any other constructor error is not latched: the next notification still shows', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const Throwing = class extends FakeNotification {
      constructor(title: string, options: NotificationOptions) {
        if (Throwing.once) { Throwing.once = false; throw new Error('transient'); }
        super(title, options);
      }
      static once = true;
    };
    g.Notification = Throwing;
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    expect(isNotificationSupported()).toBe(true);
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('a newer notification with the same tag replaces (closes) the older one', () => {
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    notifyAi('failed', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    const [older, newer] = FakeNotification.instances;
    expect(older!.close).toHaveBeenCalled();
    closeAiNotification(sidebar, 's1');
    expect(newer!.close).toHaveBeenCalled();
  });

  it('logout closes every notification and forgets failed turns', () => {
    notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen });
    notifyAi('needs_approval', { kind: 'workspace', tabId: 't1' }, { sessionId: 's2', surfaceVisible: false, onOpen });
    noteAiTurnEvent('error', { kind: 'workspace', tabId: 't2' }, { sessionId: 's3', surfaceVisible: false, onOpen });
    runLogoutHooks();
    for (const n of FakeNotification.instances) expect(n.close).toHaveBeenCalled();
    FakeNotification.instances = [];
    noteAiTurnEvent('done', { kind: 'workspace', tabId: 't2' }, { sessionId: 's3', surfaceVisible: false, onOpen });
    expect(FakeNotification.instances.map((n) => n.options.body)).toEqual(['Response ready']);
  });

  it('never throws when the auth store is unavailable', () => {
    authState.user = undefined as unknown as null;
    expect(() => notifyAi('response_ready', sidebar, { sessionId: 's1', surfaceVisible: false, onOpen })).not.toThrow();
  });
});

describe('noteAiTurnEvent (per-turn mapping)', () => {
  const onOpen = vi.fn();
  const ctx = () => ({ sessionId: 's1', surfaceVisible: false, onOpen });
  const bodies = () => FakeNotification.instances.map((n) => n.options.body);
  beforeEach(() => setNotifyOptIn('u1', true));

  it('done → one "Response ready"', () => {
    noteAiTurnEvent('done', sidebar, ctx());
    expect(bodies()).toEqual(['Response ready']);
  });

  it('error then done → exactly one "Response failed", no "ready"', () => {
    noteAiTurnEvent('error', sidebar, ctx());
    noteAiTurnEvent('done', sidebar, ctx());
    expect(bodies()).toEqual(['Response failed']);
  });

  it('the next turn after a failed one notifies "ready" again', () => {
    noteAiTurnEvent('error', sidebar, ctx());
    noteAiTurnEvent('done', sidebar, ctx());
    noteAiTurnEvent('done', sidebar, ctx());
    expect(bodies()).toEqual(['Response failed', 'Response ready']);
  });

  it('an error with no done (route-level stream failure) is cleared by resetAiTurnNotify at the next turn', () => {
    noteAiTurnEvent('error', sidebar, ctx());
    resetAiTurnNotify(sidebar);
    noteAiTurnEvent('done', sidebar, ctx());
    expect(bodies()).toEqual(['Response failed', 'Response ready']);
  });

  it('tool and plan approvals → "Needs your approval"', () => {
    noteAiTurnEvent('approval_required', sidebar, ctx());
    noteAiTurnEvent('plan_approval_required', sidebar, ctx());
    expect(bodies()).toEqual(['Needs your approval', 'Needs your approval']);
  });

  it('ignores every other event type', () => {
    for (const type of ['message_start', 'content_delta', 'message_end', 'tool_use_start', 'title_updated', 'attach_state']) {
      noteAiTurnEvent(type, sidebar, ctx());
    }
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('noteAiStreamFailure notifies once and suppresses a later "ready" in the same turn', () => {
    noteAiStreamFailure(sidebar, ctx());
    noteAiTurnEvent('done', sidebar, ctx());
    expect(bodies()).toEqual(['Response failed']);
  });

  it('a stream error after an error event does not notify "failed" twice', () => {
    noteAiTurnEvent('error', sidebar, ctx());
    noteAiStreamFailure(sidebar, ctx());
    expect(bodies()).toEqual(['Response failed']);
  });

  it('keeps per-surface failure state independent', () => {
    noteAiTurnEvent('error', { kind: 'workspace', tabId: 't1' }, ctx());
    noteAiTurnEvent('done', { kind: 'workspace', tabId: 't2' }, { ...ctx(), sessionId: 's2' });
    expect(bodies()).toEqual(['Response failed', 'Response ready']);
  });

  it('never throws, even when the notification path fails', () => {
    FakeNotification.throwOnConstruct = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => noteAiTurnEvent('done', sidebar, ctx())).not.toThrow();
    expect(() => noteAiStreamFailure(sidebar, ctx())).not.toThrow();
  });
});
