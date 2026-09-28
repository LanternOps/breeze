import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import RelationshipExclusionAction from './RelationshipExclusionAction';
import { EXCLUSION, FDB } from './physicalFixtures';
import { SITE } from './topologyFixtures';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); vi.mocked(showToast).mockReset(); });
afterEach(cleanup);

const hide = () => {
  fireEvent.change(screen.getByTestId('topology-exclusion-reason'), { target: { value: 'Lab bench cable' } });
  fireEvent.click(screen.getByTestId('topology-exclusion-hide'));
};

it('offers nothing to a read-only user', () => {
  render(<RelationshipExclusionAction siteId={SITE} relationshipId={FDB} view="physical" canEdit={false} onChanged={vi.fn()} />);
  expect(screen.queryByTestId('topology-exclusion-hide')).not.toBeInTheDocument();
  expect(screen.queryByTestId('topology-exclusion-restore')).not.toBeInTheDocument();
});

it('hides a relationship from one view through runAction and reports success', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ id: EXCLUSION }), { status: 201 }));
  const onChanged = vi.fn();
  render(<RelationshipExclusionAction siteId={SITE} relationshipId={FDB} view="physical" canEdit onChanged={onChanged} />);
  expect(screen.getByTestId('topology-exclusion-hide')).toBeDisabled();
  hide();
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  const [url, options] = vi.mocked(fetchWithAuth).mock.calls[0]!;
  expect(url).toBe(`/topology/sites/${SITE}/relationships/${FDB}/exclusions`);
  expect(options?.method).toBe('POST');
  expect(JSON.parse(options!.body as string)).toEqual({ view: 'physical', reason: 'Lab bench cable' });
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

it('treats an HTTP-200 failure body as a failure, never a silent success', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Relationship changed' }), { status: 200 }));
  const onChanged = vi.fn();
  render(<RelationshipExclusionAction siteId={SITE} relationshipId={FDB} view="physical" canEdit onChanged={onChanged} />);
  hide();
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(onChanged).not.toHaveBeenCalled();
});

it('leaves a 401 to the auth redirect without an error toast', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
  const onChanged = vi.fn();
  render(<RelationshipExclusionAction siteId={SITE} relationshipId={FDB} view="physical" canEdit onChanged={onChanged} />);
  hide();
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(showToast).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
});

it('restores only the selected exclusion', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ id: EXCLUSION, revoked: true }), { status: 200 }));
  const onChanged = vi.fn();
  render(<RelationshipExclusionAction siteId={SITE} relationshipId={FDB} view="physical" canEdit onChanged={onChanged}
    exclusion={{ id: EXCLUSION, view: 'physical', reason: 'Lab bench', createdAt: '2026-09-26T10:00:00.000Z' }} />);
  expect(screen.queryByTestId('topology-exclusion-hide')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('topology-exclusion-restore'));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  const [url, options] = vi.mocked(fetchWithAuth).mock.calls[0]!;
  expect(url).toBe(`/topology/sites/${SITE}/relationships/${FDB}/exclusions/${EXCLUSION}`);
  expect(options?.method).toBe('DELETE');
});
