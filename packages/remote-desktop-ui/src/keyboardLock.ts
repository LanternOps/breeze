// Keyboard Lock (K9, #8241): in fullscreen, ask the webview to deliver the
// keys the OS normally keeps (Alt-Tab, Win, Esc) to the page so they reach the
// remote. Chromium-based webviews (WebView2 on the Windows viewer) expose
// navigator.keyboard.lock(); WKWebView (macOS) and WebKitGTK (Linux) do not,
// so there this is a silent no-op and the toolbar Send Keys menu stays the
// way to send those combinations.
//
// The lock is only honoured in fullscreen. While it holds, a short Esc goes to
// the remote; the toolbar button and the fullscreen host key exit fullscreen.

export interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

/** navigator.keyboard is not in lib.dom; read it defensively. */
export function getKeyboardLockApi(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): KeyboardLockApi | null {
  const keyboard = (nav as unknown as { keyboard?: Partial<KeyboardLockApi> } | undefined)?.keyboard;
  if (!keyboard || typeof keyboard.lock !== 'function' || typeof keyboard.unlock !== 'function') return null;
  return {
    lock: (codes) => keyboard.lock!.call(keyboard, codes),
    unlock: () => keyboard.unlock!.call(keyboard),
  };
}

export function shouldLockKeyboard(state: {
  fullscreen: boolean;
  focused: boolean;
  connected: boolean;
  viewOnly: boolean;
}): boolean {
  return state.fullscreen && state.focused && state.connected && !state.viewOnly;
}

export interface KeyboardLockController {
  /** Lock when `want` is true, unlock when it turns false. Idempotent. */
  sync(want: boolean): void;
  /** Unlock unconditionally (session end, unmount). */
  release(): void;
  locked(): boolean;
}

export function createKeyboardLockController(
  api: KeyboardLockApi | null,
  log: (message: string) => void = (m) => console.debug('[keyboardLock]', m),
): KeyboardLockController {
  let wanted = false;
  let isLocked = false;

  const unlock = () => {
    try {
      api?.unlock();
    } catch (err) {
      log(`unlock failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    isLocked = false;
  };

  return {
    sync(want) {
      if (!api || want === wanted) return;
      wanted = want;
      if (!want) {
        if (isLocked) unlock();
        return;
      }
      api.lock().then(
        () => {
          // The condition may have ended while the lock was being granted.
          if (!wanted) {
            unlock();
            return;
          }
          isLocked = true;
        },
        (err) => {
          log(`lock refused: ${err instanceof Error ? err.message : String(err)}`);
          isLocked = false;
        },
      );
    },
    release() {
      wanted = false;
      if (api) unlock();
    },
    locked: () => isLocked,
  };
}
