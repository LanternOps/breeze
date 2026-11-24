/**
 * #12614: every field the guided form can leave empty or invalid has its own
 * localized sentence. The form's controls are collected from the rendered form, so a
 * field added later fails here until it is classified. A field that can be invalid is
 * checked against what the shared schemas really report for it (code and pointer).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  FLOW_BUILTIN_STEPS,
  compileFlowForm,
  flowDocumentV1Schema,
  type FlowFormValues,
  type FlowIssue,
} from '@breeze/shared';
import { CHANNEL, CHANNEL_2, MockDeviceTargetSelector, SCRIPT } from './formTestUtils';

vi.mock('../../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: MockDeviceTargetSelector }));
const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../../stores/auth', () => ({ fetchWithAuth }));

import { FlowFormView } from './FlowFormView';
import { FlowIssuesPanel } from '../FlowIssuesPanel';

const RAW = 'RAW-VALIDATOR-TEXT';
const GENERIC = /This value is not valid/;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const ptr = (path: ReadonlyArray<PropertyKey>) => path.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** What the shared schemas report for a form's document, as the editor would show it. */
function schemaIssues(values: FlowFormValues): FlowIssue[] {
  const doc = compileFlowForm(values);
  const out: FlowIssue[] = [];
  const parsed = flowDocumentV1Schema.safeParse(doc);
  if (!parsed.success) {
    for (const zi of parsed.error.issues) out.push({ code: 'schema', severity: 'error', message: RAW, pointer: ptr(zi.path) });
  }
  doc.steps.forEach((step, i) => {
    const entry = (FLOW_BUILTIN_STEPS as Record<string, { inputSchema: { safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } } } }>)[step.tool];
    const r = entry?.inputSchema.safeParse(step.input);
    if (r && !r.success) {
      for (const zi of r.error!.issues) out.push({ code: 'input_invalid', severity: 'error', message: RAW, stepId: step.id, pointer: `/steps/${i}/input${ptr(zi.path)}` });
    }
  });
  return out;
}

const base: FlowFormValues = {
  name: 'Flow',
  trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
  target: { kind: 'target', target: { type: 'all' } },
  actions: [{ type: 'notify', channelId: CHANNEL, title: 'T', message: 'M', severity: 'info' }],
  onFailure: { mode: 'stop' },
};
const notifyWith = (patch: Record<string, string>): FlowFormValues => ({
  ...base,
  actions: [{ type: 'notify', channelId: CHANNEL, title: 'T', message: 'M', severity: 'info', ...patch } as FlowFormValues['actions'][number]],
});
const alertWith = (patch: Record<string, string>): FlowFormValues => ({
  ...base,
  actions: [{ type: 'create_alert', severity: 'medium', title: 'T', message: 'M', ...patch } as FlowFormValues['actions'][number]],
});

type Coverage =
  | { invalid: (partnerWide?: true) => FlowIssue[] }
  | { cannotBeInvalid: string };

const inputIssue = (pointer: string): FlowIssue => ({ code: 'input_invalid', severity: 'error', message: RAW, pointer });

/** Keyed by the control's data-testid (digits and ids folded) or aria-label. */
const COVERAGE: Record<string, Coverage> = {
  'flow-form-name': { invalid: () => schemaIssues({ ...base, name: '' }) },
  'flow-form-description': { cannotBeInvalid: 'maxLength matches the 2000-character schema bound' },
  'flow-form-cron': { invalid: () => schemaIssues({ ...base, trigger: { type: 'schedule', cron: '', timezone: 'UTC' } }) },
  'flow-form-timezone': { invalid: () => schemaIssues({ ...base, trigger: { type: 'schedule', cron: '0 2 * * *', timezone: '' } }) },
  'flow-form-event': { invalid: () => schemaIssues({ ...base, trigger: { type: 'event', event: '', filter: {} } }) },
  'flow-form-filter-N-key': { invalid: () => schemaIssues({ ...base, trigger: { type: 'event', event: 'device.online', filter: { '1 bad key': 'x' } } }) },
  'flow-form-filter-N-value': { cannotBeInvalid: 'any text is a valid filter value' },
  'flow-form-webhook-auth': { cannotBeInvalid: 'a fixed list' },
  'flow-form-webhook-resolver-path': { invalid: () => schemaIssues({ ...base, trigger: { type: 'webhook', auth: 'hmac', orgResolver: { path: 'nope', system: 'psa' } } }) },
  'flow-form-webhook-resolver-kind': { cannotBeInvalid: 'a fixed list' },
  'flow-form-webhook-resolver-system': { invalid: () => schemaIssues({ ...base, trigger: { type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.a', system: '' } } }) },
  'flow-form-action-N-script': { invalid: () => [inputIssue('/steps/0/input/scriptId')] },
  'flow-form-action-N-runas': { cannotBeInvalid: 'a fixed list' },
  'flow-form-action-N-offline': { cannotBeInvalid: 'a fixed list' },
  'Parameter name': { invalid: () => [inputIssue('/steps/0/input/parameters')] },
  'Parameter value': { cannotBeInvalid: 'any text is a valid parameter value' },
  'flow-form-action-N-channel': { invalid: () => schemaIssues(notifyWith({ channelId: '' })) },
  'flow-form-action-N-severity': { cannotBeInvalid: 'a fixed list' },
  'flow-form-action-N-title': { invalid: () => [...schemaIssues(notifyWith({ title: '' })), ...schemaIssues(alertWith({ title: '' }))] },
  'flow-form-action-N-message': { invalid: () => [...schemaIssues(notifyWith({ message: '' })), ...schemaIssues(alertWith({ message: '' }))] },
  'flow-form-onfailure-stop': { cannotBeInvalid: 'a fixed choice' },
  'flow-form-onfailure-continue': { cannotBeInvalid: 'a fixed choice' },
  'flow-form-onfailure-notify': { cannotBeInvalid: 'a fixed choice' },
  'flow-form-onfailure-channel-ID': { cannotBeInvalid: 'the list is never empty (the form refuses to untick the last channel); a channel the owner cannot use is notify_channel_not_owned' },
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function controlKey(el: Element): string {
  const id = el.getAttribute('data-testid');
  if (id) return id.replace(UUID, 'ID').replace(/-\d+-/g, '-N-');
  return el.getAttribute('aria-label') ?? '(unlabelled control)';
}

const everything: FlowFormValues[] = [
  {
    name: 'a',
    trigger: { type: 'event', event: 'device.online', filter: { a: 'b' } },
    target: { kind: 'trigger_device' },
    actions: [
      { type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue', parameters: { P: 'v' } },
      { type: 'notify', channelId: CHANNEL, title: 'T', message: 'M', severity: 'info' },
      { type: 'create_alert', severity: 'medium', title: 'T', message: 'M' },
    ],
    onFailure: { mode: 'notify', channelIds: [CHANNEL, CHANNEL_2], notice: 'summary' },
  },
  { ...base, trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' } },
  { ...base, trigger: { type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.a', system: 'psa' } } },
];

describe('flow form fields and their validation sentences (#12614)', () => {
  it('classifies every control the form renders, so a new field cannot be added without a sentence', async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      url.startsWith('/scripts')
        ? json({ data: [{ id: SCRIPT, name: 'Cleanup' }] })
        : json({ data: [{ id: CHANNEL, name: 'Ops', type: 'email' }, { id: CHANNEL_2, name: 'Ops 2', type: 'email' }] }),
    );
    const seen = new Set<string>();
    for (const [i, values] of everything.entries()) {
      const { container, unmount } = render(<FlowFormView values={values} onChange={vi.fn()} partnerWide={i === 2} issues={[]} />);
      await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
      container.querySelectorAll('input, select, textarea').forEach((el) => seen.add(controlKey(el)));
      unmount();
    }
    expect([...seen].sort()).toEqual(Object.keys(COVERAGE).sort());
  });

  it.each(Object.entries(COVERAGE).filter(([, c]) => 'invalid' in c))('%s: what the schema reports shows a sentence, not the validator text', (_key, c) => {
    const issues = (c as { invalid: () => FlowIssue[] }).invalid();
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      const { unmount } = render(<FlowIssuesPanel issues={[issue]} />);
      const row = screen.getByTestId(`flow-issue-${issue.code}`);
      expect(row.textContent, `${issue.code} ${issue.pointer}`).not.toContain(RAW);
      expect(row.textContent, `${issue.code} ${issue.pointer}`).not.toMatch(GENERIC);
      expect(row.textContent).toContain(issue.pointer);
      unmount();
    }
  });
});

describe('input_invalid without a specific sentence (#12614)', () => {
  it('shows one generic sentence, keeps the pointer, never the raw validator text', () => {
    render(<FlowIssuesPanel issues={[inputIssue('/steps/2/input/somethingNew')]} />);
    const row = screen.getByTestId('flow-issue-input_invalid');
    expect(row.textContent).not.toContain(RAW);
    expect(row.textContent).toMatch(GENERIC);
    expect(row.textContent).toContain('/steps/2/input/somethingNew');
  });

  it('still shows the server message for an unknown code', () => {
    render(<FlowIssuesPanel issues={[{ code: 'brand_new_code' as FlowIssue['code'], severity: 'error', message: 'Only the server knows.', pointer: '/x' }]} />);
    expect(screen.getByTestId('flow-issues').textContent).toContain('Only the server knows.');
  });
});

describe('an empty value is not also "not owned" (#12614)', () => {
  const notOwned = (pointer?: string): FlowIssue => ({ code: 'reference_not_owned', severity: 'error', message: RAW, ...(pointer ? { pointer } : {}) });

  it('drops reference_not_owned on a pointer that has an input_invalid', () => {
    render(<FlowIssuesPanel issues={[inputIssue('/steps/0/input/scriptId'), notOwned('/steps/0/input/scriptId')]} />);
    expect(screen.getByTestId('flow-issue-input_invalid')).toBeTruthy();
    expect(screen.queryByTestId('flow-issue-reference_not_owned')).toBeNull();
  });

  it('keeps a reference_not_owned that stands alone, on another pointer or with none', () => {
    render(<FlowIssuesPanel issues={[inputIssue('/steps/0/input/scriptId'), notOwned('/steps/1/input/scriptId'), notOwned()]} />);
    expect(screen.getAllByTestId('flow-issue-reference_not_owned')).toHaveLength(2);
  });

  it('keeps a lone reference_not_owned', () => {
    render(<FlowIssuesPanel issues={[notOwned('/steps/0/input/scriptId')]} />);
    expect(screen.getByTestId('flow-issue-reference_not_owned')).toBeTruthy();
  });
});
