import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuitConfirm, type QuitConfirmDeps } from './QuitConfirm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render() {
  let fire: ((sessions: number) => void) | null = null;
  const unlisten = vi.fn();
  const deps: QuitConfirmDeps = {
    listenQuitRequested: vi.fn(async (cb: (sessions: number) => void) => {
      fire = cb;
      return unlisten;
    }),
    confirmQuit: vi.fn(async () => {}),
    ackShown: vi.fn(async () => {}),
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<QuitConfirm deps={deps} />));
  return {
    deps,
    unlisten,
    request: async (n: number) => { await act(async () => { await Promise.resolve(); fire!(n); }); },
  };
}

const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('QuitConfirm (Cmd+Q with sessions open, #8241)', () => {
  it('stays hidden until the app asks', () => {
    render();
    expect(q('quit-confirm')).toBeNull();
  });

  it('says how many sessions will end and quits only on confirm', async () => {
    const { deps, request } = render();
    await request(2);
    expect(q('quit-confirm')?.textContent).toMatch(/2 remote sessions/);
    // Tells the app the prompt is up, or Cmd+Q falls back to quitting.
    expect(deps.ackShown).toHaveBeenCalledOnce();
    act(() => q('quit-confirm-cancel')!.click());
    expect(q('quit-confirm')).toBeNull();
    expect(deps.confirmQuit).not.toHaveBeenCalled();

    await request(1);
    expect(q('quit-confirm')?.textContent).toMatch(/1 remote session\b/);
    await act(async () => { q('quit-confirm-quit')!.click(); });
    expect(deps.confirmQuit).toHaveBeenCalledOnce();
  });

  it('stops listening on unmount', async () => {
    const { unlisten } = render();
    await act(async () => { await Promise.resolve(); });
    act(() => root?.unmount());
    root = null;
    expect(unlisten).toHaveBeenCalled();
  });
});
