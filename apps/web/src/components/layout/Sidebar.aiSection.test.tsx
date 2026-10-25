/**
 * AI surface cohesion W04 (#10135, spec §5): the sidebar's AI section follows
 * "Operators run Breeze. The workers do the work. Wisp runs your day." —
 * Wisp · Breeze AI · Workers{Agents, Runs, AI Tasks, Findings, Impact} ·
 * Breeze AI for Office. The Workers heading is a label, never a page, and it
 * never shows over nothing (Review Focus 3).
 */
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Perm = { resource: string; action: string };

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: [] as Perm[] },
  scope: 'partner' as 'partner' | 'organization',
}));
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (s: { user: typeof state.user }) => unknown) => selector({ user: state.user }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: () => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() }),
}));
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: state.scope }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar, { navSections } from './Sidebar';
import { useFeaturesStore } from '../../stores/featuresStore';
import { i18n } from '../../lib/i18n';
import { invalidatePartnersMe } from '../../lib/api/partnersMe';

const ALL: Perm[] = [{ resource: '*', action: '*' }];
const AI_SESSIONS_ONLY: Perm[] = [{ resource: 'ai_sessions', action: 'use' }];
const BILLING_ONLY: Perm[] = [{ resource: 'invoices', action: 'read' }];

interface Gates {
  aiOperatorTasks?: boolean;
  toolSources?: boolean;
  aiForOfficeEnabled?: boolean;
  wispEnabled?: boolean;
}

function mockServer({ aiOperatorTasks = false, toolSources = false, aiForOfficeEnabled = false, wispEnabled = false }: Gates) {
  useFeaturesStore.setState({
    features: { billing: false, support: false, aiOperatorTasks, aiAgentsSweepAct: false, toolSources, flows: false, preAssignmentEnrollment: false, callerVerification: false },
    loaded: true,
  });
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/config') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ features: { aiOperatorTasks, toolSources } }) } as Response);
    }
    if (url === '/orgs/partners/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ name: 'Acme MSP', aiForOfficeEnabled, wispEnabled, settings: {} }),
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
}

/** Headings and links of the AI section, in DOM order, as the user reads them. */
function aiSectionEntries(container: HTMLElement): string[] {
  const section = container.querySelector('[data-testid="nav-section-ai"]');
  if (!section) return [];
  return [...section.querySelectorAll('a, [data-testid^="nav-heading-"]')].map((el) => el.textContent?.trim() ?? '');
}

function aiSectionHrefs(container: HTMLElement): string[] {
  const section = container.querySelector('[data-testid="nav-section-ai"]');
  if (!section) return [];
  return [...section.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
}

beforeEach(async () => {
  fetchWithAuthMock.mockReset();
  // A never-answering read would otherwise be shared into the next test.
  invalidatePartnersMe();
  state.user.isPlatformAdmin = false;
  state.user.permissions = [];
  state.scope = 'partner';
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  localStorage.setItem('sidebar-sections', JSON.stringify({ ai: true }));
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
  await i18n.changeLanguage('en');
});

afterEach(() => vi.clearAllMocks());

describe('Sidebar — the AI section (#10135)', () => {
  it('has exactly these entries in this order with every gate on', async () => {
    state.user.permissions = ALL;
    mockServer({ aiOperatorTasks: true, toolSources: true, aiForOfficeEnabled: true, wispEnabled: true });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(aiSectionEntries(container)).toContain('Breeze AI for Office'));
    expect(aiSectionEntries(container)).toEqual([
      'Wisp', 'Breeze AI', 'Workers', 'Agents', 'Runs', 'AI Tasks', 'Findings', 'Impact', 'Breeze AI for Office',
    ]);
    expect(aiSectionHrefs(container)).toEqual([
      '/wisp', '/wisp/chat', '/settings/ai-agents', '/ai-agents/runs', '/operator', '/fleet', '/ai-agents/impact', '/ai-for-office',
    ]);
  });

  it('shows no Workers heading to a user who holds only ai_sessions:use', async () => {
    state.user.permissions = AI_SESSIONS_ONLY;
    mockServer({ aiOperatorTasks: true, wispEnabled: true });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(aiSectionEntries(container)).toContain('Breeze AI'));
    expect(aiSectionEntries(container)).toEqual(['Wisp', 'Breeze AI']);
  });

  it('shows the Workers heading directly before Agents once a worker item is visible', async () => {
    state.user.permissions = [...AI_SESSIONS_ONLY, { resource: 'ai_agents', action: 'read' }];
    mockServer({ aiOperatorTasks: false, wispEnabled: true });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(aiSectionEntries(container)).toContain('Workers'));
    const entries = aiSectionEntries(container);
    expect(entries.indexOf('Agents')).toBe(entries.indexOf('Workers') + 1);
    // The AI Tasks flag is off: its entry hides, the rest of the group stays.
    expect(entries).toEqual(['Wisp', 'Breeze AI', 'Workers', 'Agents', 'Runs', 'Findings', 'Impact']);
  });

  it('keeps Breeze AI for Office outside the Workers group', async () => {
    // Partner scope, Office on, no AI permission at all: Office is the only
    // visible entry, and it is not a worker, so no heading sits over it.
    state.user.permissions = BILLING_ONLY;
    mockServer({ aiForOfficeEnabled: true });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(aiSectionEntries(container)).toContain('Breeze AI for Office'));
    expect(aiSectionEntries(container)).toEqual(['Breeze AI for Office']);
  });

  it('hides the whole AI section from a user with no AI permission and no Office', async () => {
    state.user.permissions = BILLING_ONLY;
    mockServer({});
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners/me'));
    expect(container.querySelector('[data-testid="nav-section-ai"]')).toBeNull();
  });

  it('never lists AI Usage, Script authoring, Tool Sources, Fix memory or Fleet Design in the AI section', async () => {
    const retired = ['/settings/ai-usage', '/settings/ai-script-authoring', '/settings/tool-sources', '/ai-agents/fix-memory', '/ai-agents/fleet-design'];
    const ai = navSections.find((s) => s.id === 'ai')!;
    for (const href of retired) expect(ai.items.map((i) => i.href), href).not.toContain(href);

    state.user.permissions = ALL;
    mockServer({ aiOperatorTasks: true, toolSources: true, aiForOfficeEnabled: true, wispEnabled: true });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(aiSectionEntries(container)).toContain('Breeze AI for Office'));
    for (const href of retired) expect(aiSectionHrefs(container), href).not.toContain(href);
    for (const label of ['AI Usage', 'Script authoring', 'Tool Sources', 'Fix memory', 'Fleet Design', 'Fleet Orchestration', 'AI Agent Runs']) {
      expect(aiSectionEntries(container), label).not.toContain(label);
    }
  });

  it('highlights Breeze AI, not Wisp, on the full-page chat', async () => {
    state.user.permissions = ALL;
    mockServer({ wispEnabled: true });
    const { container } = render(<Sidebar currentPath="/wisp/chat" />);
    await waitFor(() => expect(aiSectionHrefs(container)).toContain('/wisp/chat'));
    const active = [...container.querySelectorAll('a[aria-current="page"]')].map((a) => a.getAttribute('href'));
    expect(active).toEqual(['/wisp/chat']);
  });

  it.each([
    ['/ai-agents/fix-memory', '/settings/ai-agents'],
    ['/ai-agents/fleet-design', '/settings/ai-agents'],
  ])('keeps the AI section open on the folded report %s by highlighting Agents', async (path, expected) => {
    localStorage.removeItem('sidebar-sections');
    state.user.permissions = ALL;
    mockServer({});
    const { container } = render(<Sidebar currentPath={path} />);
    await waitFor(() => {
      const active = [...container.querySelectorAll('a[aria-current="page"]')].map((a) => a.getAttribute('href'));
      expect(active).toEqual([expected]);
    });
  });

  it('declares each heading once, contiguously, with a label that resolves', () => {
    for (const section of navSections) {
      const seen: string[] = [];
      let prev: string | undefined;
      for (const item of section.items) {
        if (item.heading && item.heading !== prev) {
          expect(seen, `${section.id}: heading "${item.heading}" is split`).not.toContain(item.heading);
          seen.push(item.heading);
          const meta = section.headings?.[item.heading];
          expect(meta, `${section.id}: heading "${item.heading}" is not declared`).toBeDefined();
          expect(i18n.t(meta!.labelKey, { lng: 'en' })).toBe(meta!.label);
          expect(i18n.t(meta!.labelKey, { lng: 'pt-BR' })).not.toBe(meta!.labelKey);
        }
        prev = item.heading;
      }
    }
    const ai = navSections.find((s) => s.id === 'ai')!;
    expect(ai.headings?.workers).toEqual({ label: 'Workers', labelKey: 'nav.workersHeading' });
    expect(ai.items.filter((i) => i.heading === 'workers').map((i) => i.href)).toEqual([
      '/settings/ai-agents', '/ai-agents/runs', '/operator', '/fleet', '/ai-agents/impact',
    ]);
  });
});

// Review Focus 1: a self-hosted user with ai_sessions:use sees Wisp, locked
// with the reason, and never a page called Wisp that is plain chat.
describe('Sidebar — the Wisp entry is locked when the server has Wisp off (#10135)', () => {
  const LOCKED_REASON = 'Wisp runs on Breeze Cloud. It is not available on this server.';

  it('locks Wisp when the server has Wisp off', async () => {
    state.user.permissions = AI_SESSIONS_ONLY;
    mockServer({ wispEnabled: false });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(container.querySelector('[data-testid="nav-wisp-locked"]')).not.toBeNull());
    const wisp = container.querySelector('[data-testid="nav-wisp-locked"]')!;
    expect(wisp.tagName).toBe('A');
    expect(wisp.getAttribute('href')).toBe('/wisp');
    expect(wisp.getAttribute('title')).toBe(LOCKED_REASON);
    expect(wisp.querySelector('[data-testid="nav-wisp-lock-icon"]')).not.toBeNull();
    // The reason reaches assistive tech, not only the hover title.
    expect(wisp.textContent).toContain(LOCKED_REASON);
    // Only Wisp locks: the chat door is the built-in AI everyone has.
    const chat = container.querySelector('a[href="/wisp/chat"]')!;
    expect(chat.getAttribute('data-testid')).toBeNull();
    expect(chat.getAttribute('title')).toBeNull();
    expect(aiSectionEntries(container)[0]).toContain('Wisp');
  });

  it('shows Wisp unlocked when the server has Wisp on', async () => {
    state.user.permissions = AI_SESSIONS_ONLY;
    mockServer({ wispEnabled: true });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners/me'));
    // Let the answer land, then the entry is a plain link.
    await waitFor(() => expect(container.querySelector('a[href="/wisp"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="nav-wisp-locked"]')).toBeNull();
    expect(container.querySelector('a[href="/wisp"]')!.getAttribute('title')).toBeNull();
  });

  it('does not lock Wisp before the server has answered', async () => {
    state.user.permissions = AI_SESSIONS_ONLY;
    mockServer({});
    fetchWithAuthMock.mockImplementation((url: string) =>
      url === '/orgs/partners/me'
        ? new Promise(() => { /* never answers */ })
        : Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response),
    );
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(container.querySelector('a[href="/wisp"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="nav-wisp-locked"]')).toBeNull();
  });

  it('does not lock Wisp when the partner read fails', async () => {
    state.user.permissions = AI_SESSIONS_ONLY;
    mockServer({});
    fetchWithAuthMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response),
    );
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners/me'));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('a[href="/wisp"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="nav-wisp-locked"]')).toBeNull();
  });
});

// The Settings group links the Settings → AI hub (/settings/ai). Like the
// Workers heading, the link never leads to nothing: it shows only while the
// hub has at least one card this user may open.
describe('Sidebar — the Settings → AI hub link (#10135)', () => {
  beforeEach(() => {
    localStorage.setItem('sidebar-sections', JSON.stringify({ ai: true, settings: true }));
  });
  const hubLink = (container: HTMLElement) =>
    container.querySelector('[data-testid="nav-section-settings"] a[href="/settings/ai"]');

  it('links the hub when an AI settings card is visible', async () => {
    state.user.permissions = [...AI_SESSIONS_ONLY, { resource: 'ai_agents', action: 'read' }];
    mockServer({});
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(hubLink(container)).not.toBeNull());
  });

  it('does not link an empty hub (org-scoped user holding only ai_sessions:use)', async () => {
    // Every AI card needs partner scope, ai_agents:read, billing:manage,
    // tool_sources:read, Wisp or the knowledge extension — this user has none.
    state.scope = 'organization';
    state.user.permissions = AI_SESSIONS_ONLY;
    mockServer({});
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(container.querySelector('a[href="/wisp/chat"]')).not.toBeNull());
    expect(hubLink(container)).toBeNull();
  });

  it('links the hub for a partner user with only ai_sessions:use (AI Usage is a partner card)', async () => {
    state.user.permissions = AI_SESSIONS_ONLY;
    mockServer({ wispEnabled: false });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(hubLink(container)).not.toBeNull());
  });

  it.each(['/settings/ai-usage', '/settings/ai-script-authoring', '/settings/tool-sources', '/settings/wisp-memory'])(
    'highlights the hub link on the AI settings page %s',
    async (path) => {
      state.user.permissions = ALL;
      mockServer({ wispEnabled: true, toolSources: true });
      const { container } = render(<Sidebar currentPath={path} />);
      await waitFor(() => {
        const active = [...container.querySelectorAll('a[aria-current="page"]')].map((a) => a.getAttribute('href'));
        expect(active).toEqual(['/settings/ai']);
      });
    },
  );
});
