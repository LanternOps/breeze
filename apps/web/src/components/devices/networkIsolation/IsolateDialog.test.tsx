import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { NETWORK_ISOLATION_TTL } from '@breeze/shared';
import IsolateDialog from './IsolateDialog';
import ReleaseDialog from './ReleaseDialog';
import IsolationActionDialog from './IsolationActionDialog';
import { runAction } from '../../../lib/runAction';
import { fetchWithAuth } from '../../../stores/auth';
import '../../../lib/i18n';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../../lib/runAction', () => ({ runAction: vi.fn(async ({ request }) => { await request(); return {}; }), handleActionError: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('warns on server OS, bounds TTL and submits through runAction', async () => {
  render(<IsolateDialog deviceId="device-1" serverOs onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(screen.getByTestId('isolation-server-warning')).toBeInTheDocument();
  expect(screen.getByTestId('isolation-ttl')).toHaveValue(NETWORK_ISOLATION_TTL.defaultHours);
  expect(screen.getByTestId('isolation-ttl')).toHaveAttribute('max', String(NETWORK_ISOLATION_TTL.maxHours));
  fireEvent.change(screen.getByTestId('isolation-reason'), { target: { value: 'Contain incident' } });
  fireEvent.change(screen.getByTestId('isolation-incident-title'), { target: { value: 'Endpoint investigation' } });
  fireEvent.click(screen.getByTestId('isolation-submit'));
  await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
  expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/network-isolation', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'Contain incident', ttlHours: 72, remoteRelay: false, createIncident: { title: 'Endpoint investigation', severity: 'p2' } }) }));
});
it('releases an offline device through runAction', async () => {
  render(<ReleaseDialog deviceId="device-1" episode={{ id: 'episode-1', deviceId: 'device-1', incidentId: null, state: 'verified', expiresAt: '' }} offline onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.change(screen.getByTestId('isolation-reason'), { target: { value: 'Recovered' } });
  fireEvent.click(screen.getByTestId('isolation-submit'));
  await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
  expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/network-isolation/episode-1/release', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'Recovered' }) }));
});
it('rejects excessive TTL and malformed incident IDs before sending', () => {
  render(<IsolateDialog deviceId="device-1" onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.change(screen.getByTestId('isolation-reason'), { target: { value: 'Contain incident' } });
  fireEvent.change(screen.getByTestId('isolation-incident-title'), { target: { value: 'Investigation' } });
  fireEvent.change(screen.getByTestId('isolation-ttl'), { target: { value: '721' } });
  expect(screen.getByTestId('isolation-submit')).toBeDisabled();
  fireEvent.change(screen.getByTestId('isolation-ttl'), { target: { value: '72' } });
  fireEvent.change(screen.getByTestId('isolation-incident-id'), { target: { value: 'invalid-id' } });
  expect(screen.getByTestId('isolation-submit')).toBeDisabled();
  expect(runAction).not.toHaveBeenCalled();
});
it('links an existing incident without creating another', async () => {
  render(<IsolateDialog deviceId="device-1" onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.change(screen.getByTestId('isolation-reason'), { target: { value: 'Investigating' } });
  fireEvent.change(screen.getByTestId('isolation-incident-id'), { target: { value: '11111111-1111-4111-8111-111111111111' } });
  fireEvent.click(screen.getByTestId('isolation-submit'));
  await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
  const body = JSON.parse(vi.mocked(fetchWithAuth).mock.calls[0][1]!.body as string);
  expect(body.incidentId).toBe('11111111-1111-4111-8111-111111111111');
  expect(body).not.toHaveProperty('createIncident');
});

it('extends through runAction with the shared TTL bounds', async () => {
  render(<IsolationActionDialog mode="extend" deviceId="device-1" isolationId="episode-1" onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(screen.queryByTestId('isolation-reason')).not.toBeInTheDocument();
  fireEvent.change(screen.getByTestId('isolation-ttl'), { target: { value: '720' } });
  fireEvent.click(screen.getByTestId('isolation-submit'));
  await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
  expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/network-isolation/episode-1/extend', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ttlHours: 720 }) }));
});
