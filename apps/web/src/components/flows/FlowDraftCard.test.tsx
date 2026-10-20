/**
 * Tool Catalog W3 (#5218) PR B — the chat Flow card.
 *
 * `parseFlowToolResult` decides what becomes a card: only a SAVED draft_flow or
 * a get_flow result carrying a flow. Everything else (validation failure,
 * error, malformed output) must return null so the default tool card keeps the
 * failure visible.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import FlowDraftCard, { parseFlowToolResult } from './FlowDraftCard';

const ID = '9f1c0f4e-0000-4000-8000-000000000001';

function payload(id = ID) {
  return {
    flow: {
      id,
      slug: 'nightly_offline',
      name: 'Nightly offline report',
      description: null,
      ownerScope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      status: 'draft',
      effectiveTier: 2,
      triggerType: 'schedule',
      definitionVersion: 1,
      updatedAt: '2026-10-20T02:00:00.000Z',
      createdAt: '2026-10-20T02:00:00.000Z',
      createdByUserId: null,
      aiSessionId: 's-1',
      definition: {
        version: 1,
        name: 'Nightly offline report',
        trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
        inputs: [],
        steps: [
          { id: 'a', tool: 'query_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 },
          { id: 'b', tool: 'query_alerts', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 },
          { id: 'c', tool: 'send_email', input: {}, approval: 'pre_approved', onFailure: 'stop', timeoutSec: 300 },
        ],
      },
    },
    validation: {
      valid: false,
      effectiveTier: 2,
      steps: [
        { id: 'a', tool: 'query_devices', source: 'core', tier: 1, approval: 'default' },
        { id: 'b', tool: 'query_alerts', source: 'core', tier: 1, approval: 'default' },
        { id: 'c', tool: 'send_email', source: 'core', tier: 2, approval: 'pre_approved' },
      ],
      issues: [
        { code: 'tool_not_found', severity: 'error', message: 'x', stepId: 'c' },
        { code: 'input_not_supported', severity: 'warning', message: 'y' },
      ],
    },
  };
}

describe('parseFlowToolResult', () => {
  it('accepts a saved draft_flow result (object or JSON string)', () => {
    const out = { saved: true, ...payload(), reviewPath: `/flows/${ID}` };
    expect(parseFlowToolResult('draft_flow', out)?.flow.id).toBe(ID);
    expect(parseFlowToolResult('draft_flow', JSON.stringify(out))?.flow.id).toBe(ID);
  });

  it('accepts a get_flow result that contains a flow', () => {
    expect(parseFlowToolResult('get_flow', payload())?.flow.id).toBe(ID);
  });

  it('rejects everything else', () => {
    expect(parseFlowToolResult('draft_flow', { saved: false, error: 'nope' })).toBeNull();
    expect(parseFlowToolResult('draft_flow', { saved: false, validation: payload().validation })).toBeNull();
    expect(parseFlowToolResult('get_flow', { error: 'flow_not_found' })).toBeNull();
    expect(parseFlowToolResult('get_flow', { error: 'flows_disabled' })).toBeNull();
    expect(parseFlowToolResult('draft_flow', '{not json')).toBeNull();
    expect(parseFlowToolResult('draft_flow', undefined)).toBeNull();
    expect(parseFlowToolResult('list_flows', payload())).toBeNull();
    expect(parseFlowToolResult(undefined, payload())).toBeNull();
  });

  it('rejects structurally partial payloads instead of letting the card crash the transcript', () => {
    const p = payload();
    const noTrigger = { ...p, flow: { ...p.flow, definition: { ...p.flow.definition, trigger: undefined } } };
    const nullStep = { ...p, flow: { ...p.flow, definition: { ...p.flow.definition, steps: [null] } } };
    const nullSummary = { ...p, validation: { ...p.validation, steps: [null] } };
    const nullIssue = { ...p, validation: { ...p.validation, issues: [null] } };
    for (const bad of [noTrigger, nullStep, nullSummary, nullIssue]) {
      expect(parseFlowToolResult('get_flow', bad)).toBeNull();
    }
  });
});

describe('FlowDraftCard', () => {
  it('renders the name, three steps with tiers, issue counts and a review link', () => {
    render(<FlowDraftCard flow={payload().flow as never} validation={payload().validation as never} />);
    const card = screen.getByTestId('flow-draft-card');
    expect(card.textContent).toContain('Nightly offline report');
    expect(card.textContent).toContain('0 2 * * *');
    const steps = within(card).getAllByTestId(/^flow-step-[abc]$/);
    expect(steps).toHaveLength(3);
    expect(within(steps[2]).getByTestId('flow-step-c-tier').textContent).toContain('2');
    expect(within(card).getByTestId('flow-draft-issue-counts').textContent).toMatch(/1.*1/);
    expect(screen.getByTestId('flow-draft-review').getAttribute('href')).toBe(`/flows/${ID}`);
  });

  it('builds no review link when the id is not a UUID', () => {
    const p = payload('not-a-uuid/../x');
    render(<FlowDraftCard flow={p.flow as never} validation={p.validation as never} />);
    expect(screen.queryByTestId('flow-draft-review')).toBeNull();
  });
});
