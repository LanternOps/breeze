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
});
