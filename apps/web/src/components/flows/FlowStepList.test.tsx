/** Tool Catalog W5 (#5220) D4 — built-in step rendering in the flow step list. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlowStepList } from './FlowStepList';

const step = (id: string, tool: string, input: Record<string, unknown>) =>
  ({ id, tool, input, approval: 'default', onFailure: 'stop', timeoutSec: 60 }) as never;
const summary = (id: string, tool: string, tier: 1 | 2 | 3) =>
  ({ id, tool, source: 'builtin', tier, approval: 'default' }) as never;

describe('FlowStepList built-in steps', () => {
  it('notify shows the built-in label and the literal channel id', () => {
    render(
      <FlowStepList
        steps={[step('tell', 'notify', { channelId: '11111111-1111-4111-8111-111111111111', message: 'hi' })]}
        summaries={[summary('tell', 'notify', 3)]}
      />,
    );
    const el = screen.getByTestId('flow-step-builtin-tell');
    expect(el.textContent).toContain('Send a notice');
    expect(el.textContent).toContain('Channel: 11111111-1111-4111-8111-111111111111');
  });

  it('http_request shows method, origin, tier and the anonymous note', () => {
    render(
      <FlowStepList
        steps={[step('call', 'http_request', { method: 'GET', url: 'https://api.example.com/v1/x?y=1' })]}
        summaries={[summary('call', 'http_request', 2)]}
      />,
    );
    const el = screen.getByTestId('flow-step-builtin-call');
    expect(el.textContent).toContain('Call an outside API');
    expect(el.textContent).toContain('GET https://api.example.com');
    expect(el.textContent).not.toContain('/v1/x');
    expect(el.textContent).toContain('Anonymous (no credentials)');
    expect(screen.getByTestId('flow-step-call-tier').textContent).toContain('2');
  });

  it('http_request with a templated url shows it raw', () => {
    render(
      <FlowStepList
        steps={[step('call', 'http_request', { method: 'POST', url: '{{ inputs.url }}' })]}
        summaries={[summary('call', 'http_request', 3)]}
      />,
    );
    expect(screen.getByTestId('flow-step-builtin-call').textContent).toContain('POST {{ inputs.url }}');
  });

  it('ai shows its tools and the output schema top-level fields', () => {
    render(
      <FlowStepList
        steps={[
          step('ask', 'ai', {
            prompt: 'p',
            tools: ['query_devices', 'get_device_details'],
            output: { type: 'object', properties: { verdict: { type: 'string' }, score: { type: 'number' } } },
          }),
        ]}
        summaries={[summary('ask', 'ai', 1)]}
      />,
    );
    const el = screen.getByTestId('flow-step-builtin-ask');
    expect(el.textContent).toContain('Ask the AI');
    expect(el.textContent).toContain('Tools: query_devices, get_device_details');
    expect(el.textContent).toContain('Result fields: verdict, score');
  });

  it('ai with no tools says so', () => {
    render(<FlowStepList steps={[step('ask', 'ai', { prompt: 'p', tools: [] })]} summaries={[summary('ask', 'ai', 1)]} />);
    expect(screen.getByTestId('flow-step-builtin-ask').textContent).toContain('No tools');
  });

  it('run_script_on_targets shows the script, the device set and the offline policy (#5221)', () => {
    render(
      <FlowStepList
        steps={[
          step('a0_run_script', 'run_script_on_targets', { scriptId: 's-1', target: { type: 'groups', groupIds: ['g'] }, whenOffline: 'queue' }),
          step('a1_run_script', 'run_script_on_targets', { scriptId: 's-2', fromStep: { stepId: 'a0_run_script', set: 'succeeded' }, whenOffline: 'skip' }),
        ]}
        summaries={[summary('a0_run_script', 'run_script_on_targets', 3), summary('a1_run_script', 'run_script_on_targets', 3)]}
        compact
      />,
    );
    const first = screen.getByTestId('flow-step-builtin-a0_run_script').textContent;
    expect(first).toContain('Run a script on devices');
    expect(first).toContain('Script s-1');
    expect(first).toContain('Device groups');
    expect(first).toContain('Offline devices: queued');
    const second = screen.getByTestId('flow-step-builtin-a1_run_script').textContent;
    expect(second).toContain('Devices that succeeded in a0_run_script');
    expect(second).toContain('Offline devices: skipped');
  });

  it('resolve_targets names the triggering device; create_alert its severity (#5221)', () => {
    render(
      <FlowStepList
        steps={[
          step('targets', 'resolve_targets', { deviceIds: ['{{trigger.device.id}}'] }),
          step('a0_alert', 'create_alert', { deviceId: '{{item.id}}', severity: 'high', message: 'm' }),
        ]}
        summaries={[summary('targets', 'resolve_targets', 1), summary('a0_alert', 'create_alert', 2)]}
        compact
      />,
    );
    expect(screen.getByTestId('flow-step-builtin-targets').textContent).toContain('The device from the event');
    expect(screen.getByTestId('flow-step-builtin-a0_alert').textContent).toContain('Raise an alert');
    expect(screen.getByTestId('flow-step-builtin-a0_alert').textContent).toContain('Severity high');
  });
});

describe('FlowStepList step badges and defaults (#9937)', () => {
  it('labels a step whose tool did not resolve as an unknown tool, not a core tool', () => {
    render(
      <FlowStepList
        steps={[step('bogus', 'not_a_real_tool', {})]}
        summaries={[{ id: 'bogus', tool: 'not_a_real_tool', source: 'unknown', tier: null, approval: 'default' }]}
      />,
    );
    expect(screen.getByTestId('flow-step-bogus-source').textContent).toBe('Unknown tool');
    expect(screen.queryByText('Core tool')).toBeNull();
  });

  it('still labels a resolved core tool as a core tool', () => {
    render(
      <FlowStepList
        steps={[step('read', 'get_device_details', {})]}
        summaries={[{ id: 'read', tool: 'get_device_details', source: 'core', tier: 1, approval: 'default' }]}
      />,
    );
    expect(screen.getByTestId('flow-step-read-source').textContent).toBe('Core tool');
  });

  it('shows the schema defaults when a stored step omits onFailure and timeoutSec', () => {
    const bare = { id: 'clean', tool: 'run_script', input: {}, approval: 'default' } as never;
    render(<FlowStepList steps={[bare]} summaries={[summary('clean', 'run_script', 3)]} />);
    expect(screen.getByTestId('flow-step-clean-on-failure').textContent).toBe('stop');
    expect(screen.getByTestId('flow-step-clean-timeout').textContent).toBe('300s');
  });

  it('shows the stored onFailure and timeoutSec when present', () => {
    const custom = { id: 'go', tool: 'run_script', input: {}, approval: 'default', onFailure: 'continue', timeoutSec: 900 } as never;
    render(<FlowStepList steps={[custom]} summaries={[summary('go', 'run_script', 3)]} />);
    expect(screen.getByTestId('flow-step-go-on-failure').textContent).toBe('continue');
    expect(screen.getByTestId('flow-step-go-timeout').textContent).toBe('900s');
  });
});
