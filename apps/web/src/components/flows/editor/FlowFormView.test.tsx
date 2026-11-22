/**
 * Flows completion W01e (#12438) Task E3: the guided form as a whole.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileFlowForm, type FlowFormValues } from '@breeze/shared';
import { CHANNEL, MockDeviceTargetSelector, SCRIPT } from './formTestUtils';

vi.mock('../../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: MockDeviceTargetSelector }));
const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../../stores/auth', () => ({ fetchWithAuth }));

import { FlowFormView } from './FlowFormView';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Holds the values like the editor does, and records every compiled document. */
function Harness({ initial, partnerWide = false, onValues }: { initial: FlowFormValues; partnerWide?: boolean; onValues: (v: FlowFormValues) => void }) {
  const [values, setValues] = useState(initial);
  return (
    <FlowFormView
      values={values}
      onChange={(v) => {
        setValues(v);
        onValues(v);
      }}
      partnerWide={partnerWide}
      issues={[]}
    />
  );
}

const base: FlowFormValues = {
  name: '',
  trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
  target: { kind: 'target', target: { type: 'all' } },
  actions: [{ type: 'run_script', scriptId: '', whenOffline: 'queue' }],
  onFailure: { mode: 'stop' },
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) =>
    url.startsWith('/scripts')
      ? json({ data: [{ id: SCRIPT, name: 'Cleanup' }] })
      : json({ data: [{ id: CHANNEL, name: 'Ops', type: 'email' }] }),
  );
});

describe('FlowFormView', () => {
  it('building the Job-form equivalent of a scheduled script with an on-failure notice compiles to the expected document', async () => {
    let last: FlowFormValues = base;
    render(<Harness initial={base} onValues={(v) => { last = v; }} />);
    fireEvent.change(screen.getByTestId('flow-form-name'), { target: { value: 'Nightly cleanup' } });
    fireEvent.change(screen.getByTestId('flow-form-cron'), { target: { value: '30 3 * * 1' } });
    fireEvent.click(screen.getByTestId('mock-target-groups'));
    await waitFor(() => expect(screen.getByTestId('flow-form-action-0-script')).toHaveTextContent('Cleanup'));
    fireEvent.change(screen.getByTestId('flow-form-action-0-script'), { target: { value: SCRIPT } });
    fireEvent.change(screen.getByTestId('flow-form-action-0-offline'), { target: { value: 'skip' } });
    await waitFor(() => expect(screen.getByTestId('flow-form-onfailure-notify')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('flow-form-onfailure-notify'));

    const expected: FlowFormValues = {
      name: 'Nightly cleanup',
      trigger: { type: 'schedule', cron: '30 3 * * 1', timezone: 'UTC' },
      target: { kind: 'target', target: { type: 'groups', groupIds: ['44444444-4444-4444-8444-444444444444'] } },
      actions: [{ type: 'run_script', scriptId: SCRIPT, whenOffline: 'skip' }],
      onFailure: { mode: 'notify', channelIds: [CHANNEL] },
    };
    expect(last).toEqual(expected);
    const doc = compileFlowForm(last);
    expect(doc.steps.map((s) => s.id)).toEqual(['a0_run_script', 'a0_failed', 'a0_failnotice_0']);
    expect(doc.steps[0].input).toMatchObject({ scriptId: SCRIPT, whenOffline: 'skip', target: expected.target.kind === 'target' ? expected.target.target : null });
  });

  it('switching to an event trigger binds the triggering device, and back resets to all devices', () => {
    let last: FlowFormValues = { ...base, target: { kind: 'target', target: { type: 'groups', groupIds: ['g'] } } };
    render(<Harness initial={last} onValues={(v) => { last = v; }} />);
    fireEvent.click(screen.getByTestId('flow-form-trigger-event'));
    expect(last.trigger.type).toBe('event');
    expect(last.target).toEqual({ kind: 'trigger_device' });
    fireEvent.click(screen.getByTestId('flow-form-trigger-manual'));
    expect(last.target).toEqual({ kind: 'target', target: { type: 'all' } });
  });

  it('adding a device action to a notification-only flow asks the person to choose a target', () => {
    const notifyOnly: FlowFormValues = {
      ...base,
      actions: [{ type: 'notify', channelId: CHANNEL, title: 't', message: 'm', severity: 'info' }],
    };
    render(<Harness initial={notifyOnly} onValues={() => {}} />);
    expect(screen.queryByTestId('mock-target-selector')).toBeNull();
    fireEvent.click(screen.getByTestId('flow-form-add-run_script'));
    expect(screen.getByTestId('flow-form-target-choose')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mock-target-groups'));
    expect(screen.queryByTestId('flow-form-target-choose')).toBeNull();
  });

  it('read-only renders every field disabled', () => {
    render(<FlowFormView values={{ ...base, name: 'x' }} onChange={vi.fn()} partnerWide={false} issues={[]} readOnly />);
    expect(screen.getByTestId('flow-form-name')).toBeDisabled();
    expect(screen.getByTestId('flow-form-fieldset')).toBeDisabled();
  });
});
