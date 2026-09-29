import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DeviceInfoTab from '../DeviceInfoTab';
import { fetchWithAuth } from '../../../stores/auth';
import { view } from './fixtures';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
it('places Time between Operating System and Hardware Summary', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (input) => {
    const path = String(input);
    const body = path.endsWith('/time-status')
      ? view()
      : path === '/custom-fields'
        ? { data: [] }
        : {
            hostname: 'device-fixture',
            displayName: null,
            osType: 'windows',
            osVersion: '11',
            tags: [],
            status: 'online',
          };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  render(<DeviceInfoTab deviceId="11111111-1111-4111-8111-111111111111" />);
  const section = await screen.findByTestId('time-section');
  const os = screen.getByText('Operating System');
  const hardware = screen.getByText('Hardware Summary');
  expect(
    os.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    section.compareDocumentPosition(hardware) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
