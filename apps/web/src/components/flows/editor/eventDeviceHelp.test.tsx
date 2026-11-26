/**
 * #12497 part 4: the help line under the event picker is true for the event picked.
 * Engine facts (apps/api/src/services/flows/eventTrigger.ts): an alert event with
 * no device starts no run; the Huntress and SentinelOne events that can arrive
 * without a device start a run that fails with input_invalid.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getEventTypeOptions } from '../../automations/AutomationForm';
import { EVENT_DEVICE_BEHAVIOR, eventDeviceBehavior } from './eventDeviceHelp';
import { TriggerSection } from './TriggerSection';

describe('event device classification', () => {
  const picker = getEventTypeOptions(((k: string) => k) as unknown as Parameters<typeof getEventTypeOptions>[0]).map((o) => o.value);

  it('classifies every event in the picker, so a new event cannot be added without one', () => {
    const missing = picker.filter((event) => !(event in EVENT_DEVICE_BEHAVIOR));
    expect(missing).toEqual([]);
  });

  it('holds no entry for an event the picker no longer offers', () => {
    expect(Object.keys(EVENT_DEVICE_BEHAVIOR).filter((event) => !picker.includes(event))).toEqual([]);
  });

  it('matches what the engine does', () => {
    expect(eventDeviceBehavior('alert.triggered')).toBe('no_run');
    expect(eventDeviceBehavior('alert.resolved')).toBe('no_run');
    for (const event of ['huntress.incident_created', 'huntress.incident_updated', 'huntress.agent_offline', 's1.threat_detected', 's1.threat_action_completed']) {
      expect(eventDeviceBehavior(event)).toBe('fails');
    }
    for (const event of ['device.online', 'device.offline', 'script.completed', 'script.failed', 'policy.violation', 's1.device_isolated', 'device.enrolled']) {
      expect(eventDeviceBehavior(event)).toBe('always');
    }
  });
});

describe('TriggerSection event help', () => {
  const show = (event: string) => {
    render(<TriggerSection trigger={{ type: 'event', event, filter: {} }} onChange={vi.fn()} partnerWide={false} issues={[]} />);
  };

  it('says nothing about a missing device for an event that always carries one', () => {
    show('device.offline');
    expect(screen.getByTestId('flow-form-trigger')).toHaveTextContent(/run on the device that raised the event/i);
    expect(screen.queryByTestId('flow-form-event-no-device')).toBeNull();
  });

  it('says no run starts for an alert without a device', () => {
    show('alert.triggered');
    expect(screen.getByTestId('flow-form-event-no-device')).toHaveTextContent(/no run starts/i);
  });

  it('says the run fails for an event that can arrive without a device and still starts one', () => {
    show('huntress.incident_created');
    const line = screen.getByTestId('flow-form-event-no-device');
    expect(line).toHaveTextContent(/the run fails/i);
    expect(line).not.toHaveTextContent(/no run starts/i);
  });
});
