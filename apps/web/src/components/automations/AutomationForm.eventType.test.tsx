/**
 * #12700: the Event Type picker offers `device.enrolled`, and a stored event type
 * the picker does not list stays selectable so opening and saving cannot lose it.
 * The set below is the server event types a Job can usefully trigger on; adding one
 * to the server without the picker is what this guards against.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import AutomationForm, { getEventTypeOptions } from './AutomationForm';

const identity = ((k: string) => k) as unknown as Parameters<typeof getEventTypeOptions>[0];

describe('getEventTypeOptions', () => {
  it('offers every event type the server publishes for automations', () => {
    const values = getEventTypeOptions(identity).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['device.enrolled', 'device.online', 'device.offline']));
  });
});

describe('AutomationForm event type picker', () => {
  it('lists Device enrolled', () => {
    render(<AutomationForm onSubmit={vi.fn()} defaultValues={{ name: 'A', triggerType: 'event', eventType: 'device.enrolled' }} />);
    const select = screen.getByLabelText(/event type/i) as HTMLSelectElement;
    expect(select.value).toBe('device.enrolled');
    expect(screen.getByRole('option', { name: 'Device enrolled' })).toBeTruthy();
  });

  it('keeps a stored event type that is not in the list selectable and saves it unchanged', async () => {
    const onSubmit = vi.fn();
    render(<AutomationForm onSubmit={onSubmit} defaultValues={{ name: 'A', triggerType: 'event', eventType: 'legacy.custom_event' }} />);
    const select = screen.getByLabelText(/event type/i) as HTMLSelectElement;
    expect(select.value).toBe('legacy.custom_event');
    expect(screen.getByRole('option', { name: 'legacy.custom_event' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Save automation/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].eventType).toBe('legacy.custom_event');
  });
});
