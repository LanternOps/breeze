/**
 * Flows completion W01e (#12438) Task E3: the guided form's sections.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FlowFormAction, FlowFormOnFailure, FlowFormTrigger } from '@breeze/shared';
import { CHANNEL, CHANNEL_2, MockDeviceTargetSelector, SCRIPT } from './formTestUtils';

vi.mock('../../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: MockDeviceTargetSelector }));

import { ActionsSection, NOTIFY_MESSAGE_MAX } from './ActionsSection';
import { OnFailureSection } from './OnFailureSection';
import { TargetSection } from './TargetSection';
import { TriggerSection } from './TriggerSection';

const scripts = [{ id: SCRIPT, name: 'Cleanup' }];
const channels = [{ id: CHANNEL, name: 'Ops', type: 'email' }, { id: CHANNEL_2, name: 'Pager', type: 'slack' }];

describe('TargetSection', () => {
  it('an event trigger hides the target picker and binds the triggering device', () => {
    render(
      <TargetSection
        trigger={{ type: 'event', event: 'device.offline', filter: {} }}
        target={{ kind: 'trigger_device' }}
        onChange={vi.fn()}
        partnerWide={false}
        needsChoice={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('flow-form-target-trigger-device')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-target-selector')).toBeNull();
  });

  it('a partner-wide flow offers only all and filter targets', () => {
    render(
      <TargetSection
        trigger={{ type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' }}
        target={{ kind: 'target', target: { type: 'all' } }}
        onChange={vi.fn()}
        partnerWide
        needsChoice={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mock-target-selector')).toHaveAttribute('data-modes', 'all,filter');
  });

  it('an organization flow offers every target mode', () => {
    render(
      <TargetSection
        trigger={{ type: 'manual' }}
        target={{ kind: 'target', target: { type: 'all' } }}
        onChange={vi.fn()}
        partnerWide={false}
        needsChoice={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mock-target-selector')).toHaveAttribute('data-modes', 'all,manual,groups,filter');
  });

  it('asks the person to choose a target when one is needed', () => {
    const onConfirm = vi.fn();
    render(
      <TargetSection
        trigger={{ type: 'manual' }}
        target={{ kind: 'target', target: { type: 'all' } }}
        onChange={vi.fn()}
        partnerWide={false}
        needsChoice
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId('flow-form-target-confirm'));
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe('TriggerSection', () => {
  it('shows the event delivery warning beside the event picker', () => {
    render(
      <TriggerSection
        trigger={{ type: 'event', event: 'device.offline', filter: {} }}
        onChange={vi.fn()}
        partnerWide={false}
        issues={[{ code: 'event_dispatch_not_durable', severity: 'warning', message: 'Not durable', pointer: '/trigger/event' }]}
      />,
    );
    expect(screen.getByTestId('flow-editor-event-unavailable')).toHaveTextContent('Not durable');
  });

  it('a partner-wide webhook asks for the organization resolver', () => {
    const onChange = vi.fn();
    function Harness() {
      const [trigger, setTrigger] = useState<FlowFormTrigger>({ type: 'webhook', auth: 'hmac' });
      return <TriggerSection trigger={trigger} onChange={(next) => { setTrigger(next); onChange(next); }} partnerWide issues={[]} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByTestId('flow-form-webhook-resolver-path'), { target: { value: 'body.customer.id' } });
    fireEvent.change(screen.getByTestId('flow-form-webhook-resolver-system'), { target: { value: 'psa' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.customer.id', system: 'psa' } });
  });

  it('a Breeze organization ID resolver is shown as such and kept on edit', () => {
    const onChange = vi.fn();
    function Harness() {
      const [trigger, setTrigger] = useState<FlowFormTrigger>({ type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.org', kind: 'breeze_org_id' } });
      return <TriggerSection trigger={trigger} onChange={(next) => { setTrigger(next); onChange(next); }} partnerWide issues={[]} />;
    }
    render(<Harness />);
    expect(screen.getByTestId('flow-form-webhook-resolver-kind')).toHaveValue('breeze_org_id');
    expect(screen.queryByTestId('flow-form-webhook-resolver-system')).toBeNull();
    fireEvent.change(screen.getByTestId('flow-form-webhook-resolver-path'), { target: { value: 'body.tenant' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.tenant', kind: 'breeze_org_id' } });
    fireEvent.change(screen.getByTestId('flow-form-webhook-resolver-kind'), { target: { value: 'system' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.tenant', system: '' } });
  });

  it('each Add a condition adds a row', () => {
    function Harness() {
      const [trigger, setTrigger] = useState<FlowFormTrigger>({ type: 'event', event: 'device.offline', filter: {} });
      return <TriggerSection trigger={trigger} onChange={setTrigger} partnerWide={false} issues={[]} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('flow-form-filter-add'));
    fireEvent.click(screen.getByTestId('flow-form-filter-add'));
    expect(screen.getByTestId('flow-form-filter-1-key')).toBeInTheDocument();
  });

  it('an organization webhook has no resolver', () => {
    render(<TriggerSection trigger={{ type: 'webhook', auth: 'hmac' }} onChange={vi.fn()} partnerWide={false} issues={[]} />);
    expect(screen.queryByTestId('flow-form-webhook-resolver-path')).toBeNull();
  });
});

describe('ActionsSection', () => {
  const script: FlowFormAction = { type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' };

  it('runAs offers system and user only', () => {
    render(<ActionsSection actions={[script]} onChange={vi.fn()} scripts={scripts} channels={channels} />);
    const select = screen.getByTestId('flow-form-action-0-runas') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['', 'system', 'user']);
  });

  it('no command action is offered', () => {
    render(<ActionsSection actions={[]} onChange={vi.fn()} scripts={scripts} channels={channels} />);
    const add = screen.getByTestId('flow-form-actions-add');
    expect(within(add).getByTestId('flow-form-add-run_script')).toBeInTheDocument();
    expect(within(add).getByTestId('flow-form-add-notify')).toBeInTheDocument();
    expect(within(add).getByTestId('flow-form-add-create_alert')).toBeInTheDocument();
    expect(within(add).queryByTestId(/command/)).toBeNull();
    expect(screen.getByTestId('flow-form-command-hint').querySelector('a')).toHaveAttribute('href', '/scripts');
  });

  it('a notification after a script leaves room for the device counts', () => {
    const notify: FlowFormAction = { type: 'notify', channelId: CHANNEL, title: 't', message: 'm', severity: 'info' };
    const { rerender } = render(<ActionsSection actions={[notify]} onChange={vi.fn()} scripts={scripts} channels={channels} />);
    expect(screen.getByTestId('flow-form-action-0-message')).toHaveAttribute('maxLength', String(NOTIFY_MESSAGE_MAX));
    rerender(<ActionsSection actions={[script, notify]} onChange={vi.fn()} scripts={scripts} channels={channels} />);
    const max = Number(screen.getByTestId('flow-form-action-1-message').getAttribute('maxLength'));
    expect(max).toBeLessThan(NOTIFY_MESSAGE_MAX - 100);
    expect(screen.getByTestId('flow-form-action-1-counts-help')).toBeInTheDocument();
  });

  it('adds, reorders and removes actions', () => {
    const onChange = vi.fn();
    const notify: FlowFormAction = { type: 'notify', channelId: CHANNEL, title: 't', message: 'm', severity: 'info' };
    render(<ActionsSection actions={[script, notify]} onChange={onChange} scripts={scripts} channels={channels} />);
    fireEvent.click(screen.getByTestId('flow-form-action-1-up'));
    expect(onChange).toHaveBeenLastCalledWith([notify, script]);
    fireEvent.click(screen.getByTestId('flow-form-action-0-remove'));
    expect(onChange).toHaveBeenLastCalledWith([notify]);
    fireEvent.click(screen.getByTestId('flow-form-add-create_alert'));
    expect(onChange.mock.lastCall?.[0]).toHaveLength(3);
    expect(onChange.mock.lastCall?.[0][2].type).toBe('create_alert');
  });
});

describe('OnFailureSection', () => {
  it("the on-failure label says can't be sent", () => {
    render(<OnFailureSection onFailure={{ mode: 'stop' }} onChange={vi.fn()} channels={channels} />);
    expect(screen.getByTestId('flow-form-onfailure-label').textContent).toMatch(/can't be sent/i);
    expect(screen.getByTestId('flow-form-onfailure-label').textContent).not.toMatch(/script fails/i);
  });

  it('choosing notify selects a channel so the list is never empty, and the last channel cannot be cleared', () => {
    const onChange = vi.fn();
    const { rerender } = render(<OnFailureSection onFailure={{ mode: 'stop' }} onChange={onChange} channels={channels} />);
    fireEvent.click(screen.getByTestId('flow-form-onfailure-notify'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'notify', channelIds: [CHANNEL], notice: 'summary' });
    const one: FlowFormOnFailure = { mode: 'notify', channelIds: [CHANNEL], notice: 'summary' };
    rerender(<OnFailureSection onFailure={one} onChange={onChange} channels={channels} />);
    expect(screen.getByTestId(`flow-form-onfailure-channel-${CHANNEL}`)).toBeDisabled();
  });

  it('channel ids are never duplicated', () => {
    const onChange = vi.fn();
    render(<OnFailureSection onFailure={{ mode: 'notify', channelIds: [CHANNEL, CHANNEL], notice: 'summary' }} onChange={onChange} channels={channels} />);
    fireEvent.click(screen.getByTestId(`flow-form-onfailure-channel-${CHANNEL_2}`));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'notify', channelIds: [CHANNEL, CHANNEL_2], notice: 'summary' });
  });

  it('a per-device notice (a flow moved from a Job) stays per-device when its channels change', () => {
    const onChange = vi.fn();
    render(<OnFailureSection onFailure={{ mode: 'notify', channelIds: [CHANNEL], notice: 'perDevice' }} onChange={onChange} channels={channels} />);
    fireEvent.click(screen.getByTestId(`flow-form-onfailure-channel-${CHANNEL_2}`));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'notify', channelIds: [CHANNEL, CHANNEL_2], notice: 'perDevice' });
  });

  it('choosing Stop on a per-device flow, then Notify again, creates a summary (an explicit choice, not a silent rewrite)', () => {
    const onChange = vi.fn();
    const { rerender } = render(<OnFailureSection onFailure={{ mode: 'notify', channelIds: [CHANNEL], notice: 'perDevice' }} onChange={onChange} channels={channels} />);
    fireEvent.click(screen.getByTestId('flow-form-onfailure-stop'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'stop' });
    rerender(<OnFailureSection onFailure={{ mode: 'stop' }} onChange={onChange} channels={channels} />);
    fireEvent.click(screen.getByTestId('flow-form-onfailure-notify'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'notify', channelIds: [CHANNEL], notice: 'summary' });
  });

  it('the notify help describes the notice the flow sends: one summary per script, or one per failed device', () => {
    const { rerender } = render(<OnFailureSection onFailure={{ mode: 'stop' }} onChange={vi.fn()} channels={channels} />);
    const help = () => screen.getByTestId('flow-form-onfailure-notify-help').textContent ?? '';
    expect(help()).toMatch(/one notice/i);
    expect(help()).not.toMatch(/for each device/i);
    rerender(<OnFailureSection onFailure={{ mode: 'notify', channelIds: [CHANNEL], notice: 'summary' }} onChange={vi.fn()} channels={channels} />);
    expect(help()).toMatch(/one notice/i);
    rerender(<OnFailureSection onFailure={{ mode: 'notify', channelIds: [CHANNEL], notice: 'perDevice' }} onChange={vi.fn()} channels={channels} />);
    expect(help()).toMatch(/for each device/i);
  });

  it('notify is unavailable when there are no channels', () => {
    render(<OnFailureSection onFailure={{ mode: 'stop' }} onChange={vi.fn()} channels={[]} />);
    expect(screen.getByTestId('flow-form-onfailure-notify')).toBeDisabled();
  });
});
