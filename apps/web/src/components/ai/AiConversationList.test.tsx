/**
 * #9840 W4 (Task 15, spec §3.7): the conversation list both surfaces render.
 * One search box; rows with the org chip (Gate B #13, reused from W3's
 * WorkspaceSessionChips), the generic "Device" chip (Gate B #9), and an
 * "open elsewhere" label when the other surface holds the conversation.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/orgStore', async () => {
  const { create: mk } = await import('zustand');
  const useOrgStore = mk<{ organizations: Array<{ id: string; name: string }>; currentOrgId: string | null }>(() => ({
    organizations: [], currentOrgId: null,
  }));
  return { useOrgStore };
});
vi.mock('@/stores/aiStore', async () => {
  const { create: mk } = await import('zustand');
  const useAiStore = mk<{ m365Connections: Array<{ id: string; customerDisplayName: string }> }>(() => ({
    m365Connections: [{ id: 'conn-1', customerDisplayName: 'Contoso' }],
  }));
  return { useAiStore };
});

import AiConversationList, { type AiConversationListProps } from './AiConversationList';
import type { ConversationRow } from './useAiConversationSource';
import { useOrgStore } from '@/stores/orgStore';

const setOrgs = (s: Record<string, unknown>) =>
  act(() => { (useOrgStore as unknown as { setState: (p: unknown) => void }).setState(s); });

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const row = (id: string, over: Partial<ConversationRow> = {}): ConversationRow => ({
  id, title: `Chat ${id}`, orgId: ORG_A, type: 'general', deviceId: null, status: 'active',
  createdAt: '2026-10-20T09:00:00.000Z', openIn: null, ...over,
});

function renderList(over: Partial<AiConversationListProps> = {}) {
  const props: AiConversationListProps = {
    rows: [], currentSessionId: null, onPick: vi.fn(), surface: 'panel', query: '', onQueryChange: vi.fn(),
    isLoading: false, isSearching: false, error: null, ...over,
  };
  render(<AiConversationList {...props} />);
  return props;
}
const rowEl = (id: string) => screen.getAllByTestId('ai-conversation-row').find((el) => el.dataset.sessionId === id)!;

beforeEach(() => {
  setOrgs({ organizations: [{ id: ORG_A, name: 'Acme' }], currentOrgId: ORG_A });
});

describe('search box', () => {
  it('shows the query and reports typing', () => {
    const props = renderList({ query: 'pa' });
    const input = screen.getByPlaceholderText('Search conversations...');
    expect(input).toHaveValue('pa');
    fireEvent.change(input, { target: { value: 'pat' } });
    expect(props.onQueryChange).toHaveBeenCalledWith('pat');
  });

  it('spins while searching', () => {
    renderList({ query: 'pa', isSearching: true });
    expect(screen.getByTestId('ai-conversation-loading')).toBeInTheDocument();
    expect(screen.queryByText('No results found')).toBeNull();
  });

  it('spins while the list loads', () => {
    renderList({ isLoading: true });
    expect(screen.getByTestId('ai-conversation-loading')).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet')).toBeNull();
  });

  it('says "No results found" for an empty search', () => {
    renderList({ query: 'pa' });
    expect(screen.getByText('No results found')).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet')).toBeNull();
  });

  it('says "No conversations yet" for an empty list', () => {
    renderList({ query: 'p' });
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    expect(screen.queryByText('No results found')).toBeNull();
  });

  it('says something went wrong on a failed load, instead of an empty-state line', () => {
    renderList({ error: 'list_failed' });
    expect(screen.getByTestId('ai-conversation-error')).toHaveTextContent('Something went wrong');
    expect(screen.queryByText('No conversations yet')).toBeNull();
  });
});

describe('rows', () => {
  it('renders title (or the untitled copy), the matched line, the date, and marks the current session', () => {
    renderList({
      rows: [row('a', { matchedContent: 'check deployment errors' }), row('b', { title: null })],
      currentSessionId: 'a',
    });
    const rows = screen.getAllByTestId('ai-conversation-row');
    expect(rows.map((r) => r.dataset.sessionId)).toEqual(['a', 'b']);
    expect(rowEl('a')).toHaveTextContent('Chat a');
    expect(rowEl('a')).toHaveTextContent('check deployment errors');
    expect(rowEl('a')).toHaveTextContent(new Date('2026-10-20T09:00:00.000Z').toLocaleDateString());
    expect(rowEl('a')).toHaveAttribute('aria-current', 'true');
    expect(rowEl('b')).toHaveTextContent('Untitled conversation');
    expect(rowEl('b')).not.toHaveAttribute('aria-current');
  });

  it('a pick hands the row to the host', () => {
    const r = row('a', { openIn: 'workspace' });
    const props = renderList({ rows: [r] });
    fireEvent.click(rowEl('a'));
    expect(props.onPick).toHaveBeenCalledWith(r);
  });
});

describe('chips', () => {
  it('single-org user, session in the current org → no org chip (Gate B #13)', () => {
    renderList({ rows: [row('a')] });
    expect(within(rowEl('a')).queryByTestId('workspace-chip-org')).toBeNull();
  });

  it('a user with two orgs gets the org chip with its name', () => {
    setOrgs({ organizations: [{ id: ORG_A, name: 'Acme' }, { id: ORG_B, name: 'Beta' }], currentOrgId: ORG_A });
    renderList({ rows: [row('a'), row('b', { orgId: ORG_B })] });
    expect(within(rowEl('a')).getByTestId('workspace-chip-org')).toHaveTextContent('Acme');
    expect(within(rowEl('b')).getByTestId('workspace-chip-org')).toHaveTextContent('Beta');
  });

  it('a session in another org shows "Another organization" until the name loads, then the name (reactive)', () => {
    setOrgs({ organizations: [], currentOrgId: ORG_A });
    renderList({ rows: [row('b', { orgId: ORG_B })] });
    expect(within(rowEl('b')).getByTestId('workspace-chip-org')).toHaveTextContent('Another organization');
    setOrgs({ organizations: [{ id: ORG_A, name: 'Acme' }, { id: ORG_B, name: 'Beta' }] });
    expect(within(rowEl('b')).getByTestId('workspace-chip-org')).toHaveTextContent('Beta');
  });

  it('a device-bound row gets the generic "Device" chip, and only it (Gate B #9)', () => {
    renderList({ rows: [row('a', { deviceId: 'dev-1' }), row('b')] });
    expect(within(rowEl('a')).getByTestId('workspace-chip-device')).toHaveTextContent(/^Device$/);
    expect(within(rowEl('b')).queryByTestId('workspace-chip-device')).toBeNull();
  });

  it('never shows a customer chip in a list', () => {
    renderList({ rows: [row('a', { deviceId: 'dev-1' })] });
    expect(within(rowEl('a')).queryByTestId('workspace-chip-customer')).toBeNull();
  });
});

describe('open elsewhere', () => {
  const label = (id: string) => within(rowEl(id)).queryByTestId('ai-conversation-open-elsewhere');

  it('panel list: a workspace-held row says "Open in AI Assistant"; others say nothing', () => {
    renderList({ surface: 'panel', rows: [row('a', { openIn: 'workspace' }), row('b', { openIn: 'panel' }), row('c')] });
    expect(label('a')).toHaveTextContent('Open in AI Assistant');
    expect(label('b')).toBeNull();
    expect(label('c')).toBeNull();
  });

  it('workspace list: a panel-held row says "Open in side panel"; others say nothing', () => {
    renderList({ surface: 'workspace', rows: [row('a', { openIn: 'panel' }), row('b', { openIn: 'workspace' }), row('c')] });
    expect(label('a')).toHaveTextContent('Open in side panel');
    expect(label('b')).toBeNull();
    expect(label('c')).toBeNull();
  });
});
