// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FlowIssue } from '@breeze/shared';
import { FlowIssuesPanel } from './FlowIssuesPanel';

const issue = (over: Partial<FlowIssue>): FlowIssue => ({
  code: 'schema',
  severity: 'error',
  message: 'Too small: expected string to have >=1 characters',
  ...over,
});

describe('FlowIssuesPanel friendly messages (#12497)', () => {
  it('replaces the validator text for a known pointer and keeps the path visible', () => {
    render(<FlowIssuesPanel issues={[issue({ pointer: '/name' })]} />);
    const row = screen.getByTestId('flow-issue-schema');
    expect(row.textContent).not.toContain('Too small');
    expect(row.textContent).toContain('Give the flow a name');
    expect(row.textContent).toContain('/name');
  });

  it('keys schema issues on the pointer, input_invalid on the field, and other issues on the code', () => {
    render(
      <FlowIssuesPanel
        issues={[
          issue({ pointer: '/trigger/cron', message: 'Invalid cron expression' }),
          issue({ code: 'input_invalid', pointer: '/steps/0/input/scriptId', stepId: 'run', message: 'Invalid uuid' }),
          issue({ code: 'duplicate_step_id', pointer: '/steps/1/id', message: "Duplicate step id 'a'." }),
        ]}
      />,
    );
    const text = screen.getByTestId('flow-issues').textContent ?? '';
    expect(text).toContain('not a valid cron expression');
    expect(text).toContain('Choose a script');
    expect(text).toContain('same id');
    expect(text).not.toContain('Invalid uuid');
    expect(text).not.toContain('Invalid cron expression');
    expect(text).toContain('/steps/0/input/scriptId');
  });

  it('keeps the server message beside the sentence when it names the culprit, and only then', () => {
    render(
      <FlowIssuesPanel
        issues={[
          issue({ code: 'tool_not_found', pointer: '/steps/0/tool', message: "Tool 'ghost_tool' was not found." }),
          issue({ pointer: '/name' }),
        ]}
      />,
    );
    const details = screen.getAllByTestId('issue-detail');
    expect(details).toHaveLength(1);
    expect(details[0].textContent).toContain('ghost_tool');
  });

  it.each<[FlowIssue['code'], string | undefined]>([
    ['schema', '/steps'],
    ['schema', '/trigger/timezone'],
    ['input_invalid', '/steps/0/input/channelId'],
    ['input_invalid', '/steps/0/input/channelIds'],
    ['unknown_step_reference', undefined],
    ['forward_reference', undefined],
    ['event_unknown', '/trigger/event'],
    ['tool_not_found', '/steps/0/tool'],
    ['notify_channel_not_owned', undefined],
    ['reference_not_owned', undefined],
    ['device_not_owned', undefined],
    ['webhook_org_resolver_required', '/trigger/orgResolver'],
    ['webhook_org_resolver_not_allowed', '/trigger/orgResolver'],
    ['document_too_large', undefined],
    ['secret_in_document', undefined],
  ])('maps %s (%s) to a sentence, never the server text or a raw key', (code, pointer) => {
    render(<FlowIssuesPanel issues={[issue({ code, pointer, message: 'SERVER-TEXT' })]} />);
    const row = screen.getByTestId(`flow-issue-${code}`);
    expect(row.textContent).not.toContain('flowEditor.validation');
    // The sentence replaced the server text; only name-carrying codes keep it as a detail line.
    const sentence = row.querySelector('span:nth-of-type(2)')?.textContent ?? '';
    expect(sentence).not.toBe('SERVER-TEXT');
    expect(sentence.length).toBeGreaterThan(10);
  });

  it('does not print the server message twice when a name-carrying code falls back to it', () => {
    render(<FlowIssuesPanel issues={[issue({ code: 'tool_not_found', message: "Tool 'x' was not found." })]} />);
    // No pointer, so a mapped sentence is still used; detail shows once. With an unmapped code the text is the message and no detail row exists.
    render(<FlowIssuesPanel issues={[issue({ code: 'brand_new_code' as FlowIssue['code'], message: 'Only once.' })]} />);
    expect(screen.getAllByText('Only once.')).toHaveLength(1);
  });

  it('falls back to the server message for an unknown code or an unmapped schema pointer', () => {
    render(
      <FlowIssuesPanel
        issues={[
          issue({ code: 'brand_new_code' as FlowIssue['code'], message: 'Something only the server knows.' }),
          issue({ pointer: '/limits/monthlyRuns', message: 'Too big: expected number to be <=1000' }),
        ]}
      />,
    );
    const text = screen.getByTestId('flow-issues').textContent ?? '';
    expect(text).toContain('Something only the server knows.');
    expect(text).toContain('Too big: expected number to be <=1000');
  });
});
