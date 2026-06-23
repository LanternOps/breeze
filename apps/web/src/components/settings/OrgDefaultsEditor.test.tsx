import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgDefaultsEditor from './OrgDefaultsEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const versionsResponse = {
  ok: true,
  json: vi.fn().mockResolvedValue({ data: [] }),
} as unknown as Response;

describe('OrgDefaultsEditor agent update policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(versionsResponse);
  });

  it('renders and saves legacy manual as manual', () => {
    const onSave = vi.fn();

    render(
      <OrgDefaultsEditor
        organizationName="Acme"
        defaults={{ agentUpdatePolicy: 'manual' }}
        onSave={onSave}
      />,
    );

    const policy = screen.getByTestId('agent-update-policy-select') as HTMLSelectElement;
    expect(policy.value).toBe('manual');

    fireEvent.click(screen.getByTestId('org-defaults-save'));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      agentUpdateMode: 'manual',
      agentUpdateTiming: undefined,
      agentUpdateSchedule: undefined,
      agentUpdatePolicy: 'manual',
      maintenanceWindow: undefined,
    }));
  });

  it('renders and saves legacy automatic as weekly schedule', () => {
    const onSave = vi.fn();

    render(
      <OrgDefaultsEditor
        organizationName="Acme"
        defaults={{ agentUpdatePolicy: 'auto', maintenanceWindow: 'Mon 01:00-03:00' }}
        onSave={onSave}
      />,
    );

    expect((screen.getByTestId('agent-update-policy-select') as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByTestId('agent-update-window-day-0') as HTMLSelectElement).value).toBe('mon');
    expect((screen.getByTestId('agent-update-window-start-0') as HTMLSelectElement).value).toBe('01:00');
    expect((screen.getByTestId('agent-update-window-end-0') as HTMLSelectElement).value).toBe('03:00');

    fireEvent.click(screen.getByTestId('org-defaults-save'));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      agentUpdateMode: 'automatic',
      agentUpdateTiming: 'weekly',
      agentUpdatePolicy: 'auto',
      maintenanceWindow: 'Mon 01:00-03:00',
      agentUpdateSchedule: {
        windows: [{ dayOfWeek: 'mon', start: '01:00', end: '03:00' }],
      },
    }));
  });

  it('saves multiple weekly update windows', () => {
    const onSave = vi.fn();

    render(
      <OrgDefaultsEditor
        organizationName="Acme"
        defaults={{
          agentUpdateMode: 'automatic',
          agentUpdateTiming: 'weekly',
          agentUpdateSchedule: {
            windows: [{ dayOfWeek: 'sun', start: '02:00', end: '04:00' }],
          },
        }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByTestId('agent-update-window-add'));
    fireEvent.change(screen.getByTestId('agent-update-window-day-1'), { target: { value: 'tue' } });
    fireEvent.change(screen.getByTestId('agent-update-window-start-1'), { target: { value: '03:30' } });
    fireEvent.change(screen.getByTestId('agent-update-window-end-1'), { target: { value: '05:00' } });
    fireEvent.click(screen.getByTestId('org-defaults-save'));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      agentUpdateMode: 'automatic',
      agentUpdateTiming: 'weekly',
      agentUpdatePolicy: 'auto',
      agentUpdateSchedule: {
        windows: [
          { dayOfWeek: 'sun', start: '02:00', end: '04:00' },
          { dayOfWeek: 'tue', start: '03:30', end: '05:00' },
        ],
      },
    }));
  });
});
