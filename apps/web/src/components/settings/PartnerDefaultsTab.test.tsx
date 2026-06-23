import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PartnerDefaultsTab from './PartnerDefaultsTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

describe('PartnerDefaultsTab agent update policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockReturnValue(new Promise(() => undefined) as Promise<Response>);
  });

  it('renders legacy automatic as a weekly schedule', () => {
    render(
      <PartnerDefaultsTab
        data={{ agentUpdatePolicy: 'auto', maintenanceWindow: 'Fri 04:00-06:00' }}
        onChange={vi.fn()}
      />,
    );

    expect((screen.getByTestId('partner-agent-update-policy-select') as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByTestId('partner-agent-update-window-day-0') as HTMLSelectElement).value).toBe('fri');
    expect((screen.getByTestId('partner-agent-update-window-start-0') as HTMLSelectElement).value).toBe('04:00');
    expect((screen.getByTestId('partner-agent-update-window-end-0') as HTMLSelectElement).value).toBe('06:00');
  });

  it('adds a second weekly window without writing staged policy', () => {
    const onChange = vi.fn();

    render(
      <PartnerDefaultsTab
        data={{ agentUpdateMode: 'automatic', agentUpdateTiming: 'weekly' }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId('partner-agent-update-window-add'));

    const patch = onChange.mock.calls[0]?.[0];
    expect(patch).toEqual(expect.objectContaining({
      agentUpdateTiming: 'weekly',
      agentUpdateSchedule: {
        windows: [
          { dayOfWeek: 'sun', start: '02:00', end: '04:00' },
          { dayOfWeek: 'sun', start: '02:00', end: '04:00' },
        ],
      },
    }));
    expect(patch?.agentUpdatePolicy).not.toBe('staged');
  });
});
