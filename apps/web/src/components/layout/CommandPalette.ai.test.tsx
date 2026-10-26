/**
 * AI surface cohesion W04 (#10135): the palette reads the partner's Wisp and
 * AI for Office flags (one /orgs/partners/me answer, asked when the palette
 * first opens — never at mount, since the palette mounts on every page) instead
 * of hard-coding both off, and offers the two AI doors as commands.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
const navigateToMock = vi.hoisted(() => vi.fn(async () => 'soft' as const));
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: fetchWithAuthMock,
}));
const claimsMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/authScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/authScope')>()),
  getJwtClaims: claimsMock,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

import CommandPalette from './CommandPalette';
import { useAuthStore } from '../../stores/auth';
import { useUiStore } from '../../stores/uiStore';
import { useAiStore } from '../../stores/aiStore';
import { invalidatePartnersMe } from '../../lib/api/partnersMe';
import { i18n } from '../../lib/i18n';

function setPermissions(permissions: Array<{ resource: string; action: string }>) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false, permissions },
  } as never);
}

function mockPartner(body: Record<string, unknown> | null) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/orgs/partners/me') {
      return Promise.resolve(
        body
          ? { ok: true, status: 200, json: async () => body }
          : { ok: false, status: 500, json: async () => ({}) },
      );
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ results: [] }) });
  });
}

function openPalette() {
  act(() => { useUiStore.getState().openCommandPalette(); });
}

function search(q: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: q } });
}

function titlesIn(sectionId: string): string[] {
  const section = screen.queryByTestId(`palette-section-${sectionId}`);
  return section ? within(section).getAllByTestId('palette-item-title').map((e) => e.textContent ?? '') : [];
}

const partnersMeCalls = () => fetchWithAuthMock.mock.calls.filter(([url]) => url === '/orgs/partners/me').length;

beforeEach(async () => {
  fetchWithAuthMock.mockReset();
  invalidatePartnersMe();
  navigateToMock.mockClear();
  claimsMock.mockReset();
  claimsMock.mockReturnValue({ scope: 'partner' });
  useUiStore.setState({ isCommandPaletteOpen: false, isShortcutsHelpOpen: false });
  useAiStore.setState({ isOpen: false });
  await i18n.changeLanguage('en');
  setPermissions([{ resource: '*', action: '*' }]);
});

describe('CommandPalette — Wisp and AI for Office gates (#10135)', () => {
  it('lists Wisp memory when the server has Wisp on', async () => {
    mockPartner({ wispEnabled: true, aiForOfficeEnabled: false });
    render(<CommandPalette />);
    openPalette();
    search('wisp memory');
    await waitFor(() => expect(titlesIn('settings')).toContain('Wisp memory'));
  });

  it('keeps Wisp memory out when the server has Wisp off', async () => {
    mockPartner({ wispEnabled: false });
    render(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(partnersMeCalls()).toBe(1));
    await act(async () => { await Promise.resolve(); });
    search('wisp memory');
    expect(titlesIn('settings')).not.toContain('Wisp memory');
  });

  it('keeps Wisp memory out when the partner read fails', async () => {
    mockPartner(null);
    render(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(partnersMeCalls()).toBe(1));
    await act(async () => { await Promise.resolve(); });
    search('wisp memory');
    expect(titlesIn('settings')).not.toContain('Wisp memory');
  });

  it('does not read /orgs/partners/me until the palette opens, and reads it once', async () => {
    mockPartner({ wispEnabled: true });
    render(<CommandPalette />);
    await act(async () => { await Promise.resolve(); });
    expect(partnersMeCalls()).toBe(0);
    openPalette();
    await waitFor(() => expect(partnersMeCalls()).toBe(1));
    act(() => { useUiStore.getState().closeCommandPalette(); });
    openPalette();
    await act(async () => { await Promise.resolve(); });
    expect(partnersMeCalls()).toBe(1);
  });

  it.each([
    ['a failed read', () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) })],
    ['an unreadable 200 body', () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })],
  ])('asks again on the next open after %s', async (_label, firstAnswer) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithAuthMock.mockImplementation((url: string) =>
      url === '/orgs/partners/me' ? firstAnswer() : Promise.resolve({ ok: true, status: 200, json: async () => ({ results: [] }) }),
    );
    render(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(partnersMeCalls()).toBe(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(warn).toHaveBeenCalled();
    act(() => { useUiStore.getState().closeCommandPalette(); });
    mockPartner({ wispEnabled: true });
    openPalette();
    await waitFor(() => expect(partnersMeCalls()).toBe(2));
    await waitFor(() => expect(titlesIn('quick-actions')).toContain('Open Wisp'));
    warn.mockRestore();
  });

  it('never asks for an org-scoped token (the route is partner-level)', async () => {
    claimsMock.mockReturnValue({ scope: 'organization' });
    mockPartner({ wispEnabled: true });
    render(<CommandPalette />);
    openPalette();
    search('wisp memory');
    await act(async () => { await Promise.resolve(); });
    expect(partnersMeCalls()).toBe(0);
    expect(titlesIn('settings')).not.toContain('Wisp memory');
  });
});

describe('CommandPalette — the AI doors as commands (#10135)', () => {
  it('"Ask Breeze AI" opens the side panel', async () => {
    mockPartner({ wispEnabled: false });
    render(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(titlesIn('quick-actions')).toContain('Ask Breeze AI'));
    fireEvent.click(screen.getByRole('button', { name: /Ask Breeze AI/ }));
    expect(useAiStore.getState().isOpen).toBe(true);
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('"Ask Breeze AI" keeps an already-open panel open', async () => {
    mockPartner({ wispEnabled: false });
    useAiStore.setState({ isOpen: true });
    render(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(titlesIn('quick-actions')).toContain('Ask Breeze AI'));
    fireEvent.click(screen.getByRole('button', { name: /Ask Breeze AI/ }));
    expect(useAiStore.getState().isOpen).toBe(true);
  });

  it('offers neither AI door without ai_sessions:use', async () => {
    setPermissions([{ resource: 'devices', action: 'read' }]);
    mockPartner({ wispEnabled: true });
    render(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(partnersMeCalls()).toBe(1));
    await act(async () => { await Promise.resolve(); });
    expect(titlesIn('quick-actions')).not.toContain('Ask Breeze AI');
    expect(titlesIn('quick-actions')).not.toContain('Open Wisp');
  });

  it('"Open Wisp" goes to /wisp when the server has Wisp on', async () => {
    mockPartner({ wispEnabled: true });
    render(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(titlesIn('quick-actions')).toContain('Open Wisp'));
    fireEvent.click(screen.getByRole('button', { name: /Open Wisp/ }));
    expect(navigateToMock).toHaveBeenCalledWith('/wisp');
  });

  it('does not offer "Open Wisp" when the server has Wisp off', async () => {
    mockPartner({ wispEnabled: false });
    render(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(titlesIn('quick-actions')).toContain('Ask Breeze AI'));
    await act(async () => { await Promise.resolve(); });
    expect(titlesIn('quick-actions')).not.toContain('Open Wisp');
  });
});
