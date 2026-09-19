import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { useManualOrder } from './useManualOrder';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const A: Organization = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Alpha Ltd', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const B: Organization = { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'Beta Ltd', status: 'active', createdAt: '2026-01-02T00:00:00Z' };
const C: Organization = { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Gamma Ltd', status: 'active', createdAt: '2026-01-03T00:00:00Z' };

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function Harness({ initial, refetch }: { initial: Organization[]; refetch: () => Promise<void> }) {
  const [organizations, setOrganizations] = useState(initial);
  const order = useManualOrder({ organizations, setOrganizations, refetch });
  return (
    <div>
      <div data-testid="announcement">{order.announcement}</div>
      <div data-testid="pending">{String(order.reorderPending)}</div>
      <ul>
        {organizations.map((org) => (
          <li
            key={org.id}
            data-testid={`row-${org.id}`}
            draggable
            onDragStart={(e) => order.onDragStart(e, org)}
            onDragOver={(e) => order.onDragOver(e, org)}
            onDragLeave={order.onDragLeave}
            onDrop={(e) => order.onDrop(e, org)}
            onDragEnd={order.onDragEnd}
          >
            {org.name}
            <button type="button" data-testid={`down-${org.id}`} onClick={() => order.move(org, 1)}>down</button>
            <button type="button" data-testid={`up-${org.id}`} onClick={() => order.move(org, -1)}>up</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const renderedIds = () => Array.from(document.querySelectorAll('[data-testid^="row-"]')).map((el) => el.getAttribute('data-testid')!.replace('row-', ''));
const patches = () => fetchMock.mock.calls.filter(([url, init]) => String(url) === '/orgs/organizations/order' && init?.method === 'PATCH');
const lastPatchBody = () => JSON.parse(String(patches().at(-1)![1]!.body)) as { orderedIds: string[] };

function drag(sourceId: string, targetId: string) {
  const dataTransfer = { effectAllowed: '', setData: vi.fn(), dropEffect: '' };
  fireEvent.dragStart(screen.getByTestId(`row-${sourceId}`), { dataTransfer });
  fireEvent.dragOver(screen.getByTestId(`row-${targetId}`), { dataTransfer });
  fireEvent.drop(screen.getByTestId(`row-${targetId}`), { dataTransfer });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('useManualOrder', () => {
  it('a keyboard move splices the list, PATCHes the new order and announces the move', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={[A, B, C]} refetch={refetch} />);

    fireEvent.click(screen.getByTestId(`down-${A.id}`));
    expect(renderedIds()).toEqual([B.id, A.id, C.id]);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(lastPatchBody()).toEqual({ orderedIds: [B.id, A.id, C.id] });
    expect(screen.getByTestId('announcement')).toHaveTextContent('Alpha Ltd moved to position 2 of 3');
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('false'));
    expect(refetch).not.toHaveBeenCalled();
  });

  it('a move off either end is a no-op', () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    render(<Harness initial={[A, B]} refetch={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`up-${A.id}`));
    fireEvent.click(screen.getByTestId(`down-${B.id}`));
    expect(renderedIds()).toEqual([A.id, B.id]);
    expect(patches()).toHaveLength(0);
  });

  it('a drag-and-drop PATCHes the new order without an announcement', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    render(<Harness initial={[A, B, C]} refetch={vi.fn()} />);
    drag(C.id, A.id);
    expect(renderedIds()).toEqual([C.id, A.id, B.id]);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(lastPatchBody()).toEqual({ orderedIds: [C.id, A.id, B.id] });
    expect(screen.getByTestId('announcement')).toHaveTextContent('');
  });

  it('a rejected PATCH (403) toasts through runAction and re-reads the authoritative order', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, false, 403));
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={[A, B, C]} refetch={refetch} />);
    fireEvent.click(screen.getByTestId(`down-${A.id}`));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('false'));
  });

  it('a transport failure (fetch throws) also re-reads rather than restoring a local snapshot', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={[A, B, C]} refetch={refetch} />);
    fireEvent.click(screen.getByTestId(`down-${A.id}`));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('ignores a second move while the first PATCH is in flight', async () => {
    let release: ((r: Response) => void) | undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    render(<Harness initial={[A, B, C]} refetch={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`down-${A.id}`));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('true'));
    const mid = renderedIds();
    fireEvent.click(screen.getByTestId(`down-${C.id}`));
    drag(C.id, B.id);
    expect(renderedIds()).toEqual(mid);
    expect(patches()).toHaveLength(1);
    release!(jsonResponse({ ok: true }));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('false'));
  });
});
