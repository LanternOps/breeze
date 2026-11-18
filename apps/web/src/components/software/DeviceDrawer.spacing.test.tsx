import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import DeviceDrawer from './DeviceDrawer';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const respond = (total: number) =>
  fetchMock.mockResolvedValue(json({ data: [], pagination: { total } }));

describe('DeviceDrawer — spacing and plurals (#9638)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the title and vendor as spaced interpolated strings', async () => {
    respond(1);
    render(<DeviceDrawer softwareName="TeamViewer" vendor="TeamViewer Germany GmbH" onClose={() => {}} />);
    expect(await screen.findByText('Devices with TeamViewer')).toBeInTheDocument();
    expect(screen.getByText('by TeamViewer Germany GmbH')).toBeInTheDocument();
  });

  it('pluralises the footer total', async () => {
    respond(26);
    render(<DeviceDrawer softwareName="X" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('26 devices total')).toBeInTheDocument());
  });
});
