/**
 * #9840 W3 (Task 13, Gate B #13, Advisor finding 10): the tab's session chips.
 * Org chip when the user has more than one org or the session's org is not the
 * current one; "Another organization" while the name is unknown; reactive to
 * the org list arriving later. Device chip from the hostname. Customer chip
 * only when the connection's name is loaded.
 */
import { act, render, screen } from '@testing-library/react';
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
  const useAiStore = mk<{ m365Connections: Array<{ id: string; customerDisplayName: string }> }>(() => ({ m365Connections: [] }));
  return { useAiStore };
});

import WorkspaceSessionChips from './WorkspaceSessionChips';
import { useOrgStore } from '@/stores/orgStore';
import { useAiStore } from '@/stores/aiStore';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const setOrgs = (s: Record<string, unknown>) => act(() => { (useOrgStore as unknown as { setState: (p: unknown) => void }).setState(s); });

beforeEach(() => {
  (useOrgStore as unknown as { setState: (p: unknown) => void }).setState({ organizations: [], currentOrgId: ORG_A });
  (useAiStore as unknown as { setState: (p: unknown) => void }).setState({ m365Connections: [] });
});

describe('org chip', () => {
  it('single-org user on the session’s own org → no org chip', () => {
    setOrgs({ organizations: [{ id: ORG_A, name: 'Acme' }], currentOrgId: ORG_A });
    render(<WorkspaceSessionChips orgId={ORG_A} deviceLabel={null} m365ConnectionId={null} />);
    expect(screen.queryByTestId('workspace-chip-org')).toBeNull();
  });

  it('multi-org user → the org’s name', () => {
    setOrgs({ organizations: [{ id: ORG_A, name: 'Acme' }, { id: ORG_B, name: 'Globex' }], currentOrgId: ORG_A });
    render(<WorkspaceSessionChips orgId={ORG_B} deviceLabel={null} m365ConnectionId={null} />);
    expect(screen.getByTestId('workspace-chip-org')).toHaveTextContent('Globex');
  });

  it('another org whose name is not loaded yet → "Another organization", then the name once the list arrives', () => {
    render(<WorkspaceSessionChips orgId={ORG_B} deviceLabel={null} m365ConnectionId={null} />);
    expect(screen.getByTestId('workspace-chip-org')).toHaveTextContent('Another organization');
    setOrgs({ organizations: [{ id: ORG_A, name: 'Acme' }, { id: ORG_B, name: 'Globex' }] });
    expect(screen.getByTestId('workspace-chip-org')).toHaveTextContent('Globex');
  });

  it('follows the org switcher reactively', () => {
    setOrgs({ organizations: [{ id: ORG_A, name: 'Acme' }], currentOrgId: ORG_A });
    render(<WorkspaceSessionChips orgId={ORG_A} deviceLabel={null} m365ConnectionId={null} />);
    expect(screen.queryByTestId('workspace-chip-org')).toBeNull();
    setOrgs({ currentOrgId: ORG_B });
    expect(screen.getByTestId('workspace-chip-org')).toHaveTextContent('Acme');
  });

  it('no orgId (a tab that created its own session) → no org chip', () => {
    setOrgs({ organizations: [{ id: ORG_A, name: 'Acme' }, { id: ORG_B, name: 'Globex' }] });
    render(<WorkspaceSessionChips orgId={null} deviceLabel={null} m365ConnectionId={null} />);
    expect(screen.queryByTestId('workspace-chip-org')).toBeNull();
  });
});

describe('device and customer chips', () => {
  it('device chip shows the hostname', () => {
    render(<WorkspaceSessionChips orgId={null} deviceLabel="host-01" m365ConnectionId={null} />);
    expect(screen.getByTestId('workspace-chip-device')).toHaveTextContent('host-01');
  });

  it('customer chip only once the connection’s name is known', () => {
    render(<WorkspaceSessionChips orgId={null} deviceLabel={null} m365ConnectionId="c1" />);
    expect(screen.queryByTestId('workspace-chip-customer')).toBeNull();
    act(() => {
      (useAiStore as unknown as { setState: (p: unknown) => void }).setState({ m365Connections: [{ id: 'c1', customerDisplayName: 'Contoso' }] });
    });
    expect(screen.getByTestId('workspace-chip-customer')).toHaveTextContent('Contoso');
  });

  it('nothing to show → renders nothing', () => {
    const { container } = render(<WorkspaceSessionChips orgId={null} deviceLabel={null} m365ConnectionId={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
