/**
 * Tool Catalog W4 (#5219) Task B1 — flow run API client + locale key lists.
 *
 * Every mutation must go through `runAction` (so outcomes are toasted and
 * `{success:false}` bodies are failures), and `enableFlow` must hand the 422
 * body (validation / missing / stepId / reason) to the caller on the thrown
 * ActionError. The locale key lists are pinned to the shared const arrays,
 * because locale parity alone cannot catch a key that EVERY locale lacks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLOW_ADMISSION_REFUSALS,
  FLOW_LIMIT_KEYS,
  FLOW_PAUSED_REASONS,
  FLOW_WEBHOOK_AUTH_FAILURES,
  FLOW_WEBHOOK_AUTH_MODES,
  FLOW_WEBHOOK_DELIVERY_STATUSES,
  FLOW_RUN_ERROR_CODES,
  FLOW_RUN_STATUSES,
  FLOW_RUN_STEP_STATUSES,
  FLOW_TRIGGER_KINDS,
  FLOW_TRIGGERED_VIA,
} from '@breeze/shared';
import en from '../../locales/en/flows.json';

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('../shared/Toast', () => ({ showToast: mocks.showToast }));
vi.mock('../../lib/trustProbation', () => ({ dispatchTrustDenied: vi.fn(), isTrustDenial: () => false }));

import { ActionError } from '../../lib/runAction';
import {
  cancelFlowRun,
  disableFlow,
  enableFlow,
  getFlowLimits,
  getFlowRun,
  getFlowRunStep,
  listFlowRuns,
  listWebhookDeliveries,
  rotateWebhookSecret,
  saveFlowLimits,
  startFlowRun,
} from './api';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function lookup(path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], en);
}

beforeEach(() => {
  mocks.fetchWithAuth.mockReset();
  mocks.showToast.mockReset();
});

describe('flow run reads', () => {
  it('listFlowRuns builds the query string against /flows/:id/runs', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { runs: [], total: 0 }));
    await listFlowRuns('f1', { status: 'running', orgId: 'o1', limit: 25, offset: 50 });
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/flows/f1/runs?status=running&orgId=o1&limit=25&offset=50');
  });

  it('getFlowRun is a body-less GET on /flows/runs/:runId', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { id: 'r1' }));
    await getFlowRun('r1');
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/flows/runs/r1');
  });

  it('getFlowRunStep fetches one step row', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { id: 's1' }));
    await getFlowRunStep('r1', 's1');
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/flows/runs/r1/steps/s1');
  });

  it('a failed read throws an ActionError carrying the status', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(404, { error: 'not found' }));
    await expect(getFlowRun('missing')).rejects.toMatchObject({ name: 'ActionError', status: 404 });
  });
});

describe('flow mutations go through runAction', () => {
  it.each([
    ['enableFlow', () => enableFlow('f1', { expectedVersion: 2, preApprovedStepIds: ['a'] }), '/flows/f1/enable', 200, { ok: true }, 'toast.enabled'],
    ['disableFlow', () => disableFlow('f1'), '/flows/f1/disable', 200, { ok: true, cancelledRuns: 0 }, 'toast.disabled'],
    ['startFlowRun', () => startFlowRun('f1', { inputs: {} }), '/flows/f1/runs', 202, { runId: 'r1', duplicate: false }, 'toast.runStarted'],
    ['cancelFlowRun', () => cancelFlowRun('r1'), '/flows/runs/r1/cancel', 200, { status: 'cancelled' }, 'toast.runCancelled'],
  ] as const)('%s', async (_name, call, url, status, body, toastKey) => {
    mocks.fetchWithAuth.mockResolvedValue(json(status, body));
    await call();
    const [calledUrl, init] = mocks.fetchWithAuth.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(init.method).toBe('POST');
    // The success toast is the runAction signature.
    expect(mocks.showToast).toHaveBeenCalledWith({ message: lookup(toastKey), type: 'success' });
  });

  it('a 200 {success:false} body is a failure, not a green toast (runAction rule)', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { success: false, error: 'nope' }));
    await expect(disableFlow('f1')).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(mocks.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('sends the JSON body for enable', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { ok: true }));
    await enableFlow('f1', { expectedVersion: 3, preApprovedStepIds: ['s1'] });
    expect(JSON.parse(mocks.fetchWithAuth.mock.calls[0]![1].body)).toEqual({ expectedVersion: 3, preApprovedStepIds: ['s1'] });
  });

  it('enableFlow rethrows a 422 ActionError carrying the structured body', async () => {
    const body = {
      error: 'permission_missing',
      validation: { issues: [] },
      missing: ['devices.execute'],
      stepId: 'restart',
      reason: 'four_eyes',
    };
    mocks.fetchWithAuth.mockResolvedValue(json(422, body));
    const err = await enableFlow('f1', { expectedVersion: 1, preApprovedStepIds: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.status).toBe(422);
    expect(err.body).toMatchObject({ missing: ['devices.execute'], stepId: 'restart', reason: 'four_eyes', validation: { issues: [] } });
  });
});

describe('error toasts: friendly copy and no double-reporting', () => {
  it('409 already_terminal on cancel toasts localized copy, never the raw token', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(409, { error: 'already_terminal' }));
    await expect(cancelFlowRun('r1')).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith({ message: lookup('runDetail.alreadyTerminal'), type: 'error' });
  });

  it.each([
    [403, 'delegation_scope_restricted'],
    [403, 'partner_wide_forbidden'],
    [403, 'interactive_session_required'],
    [404, 'flow_not_found'],
    [409, 'version_conflict'],
    [409, 'already_enabled'],
    [409, 'slug_unavailable'],
    [422, 'permission_missing'],
    [422, 'invalid'],
    [422, 'pre_approval_not_eligible'],
    [422, 'event_dispatch_not_durable'],
    [422, 'foreach_concurrency_not_available'],
  ])('enable %s %s is rendered inline by the dialog, so it is not toasted', async (status, code) => {
    mocks.fetchWithAuth.mockResolvedValue(json(status, { error: code }));
    await expect(enableFlow('f1', { expectedVersion: 1, preApprovedStepIds: [] })).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('enable MFA_REQUIRED (rides code) is not toasted; an unmapped enable error still is', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(403, { error: 'MFA required', code: 'MFA_REQUIRED' }));
    await expect(enableFlow('f1', { expectedVersion: 1, preApprovedStepIds: [] })).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).not.toHaveBeenCalled();
    mocks.fetchWithAuth.mockResolvedValue(json(500, { error: 'boom_unknown' }));
    await expect(enableFlow('f1', { expectedVersion: 1, preApprovedStepIds: [] })).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });

  it.each([
    [422, 'inputs_invalid'],
    [403, 'permission_missing'],
    [429, 'flow_queue_full'],
    [409, 'not_enabled'],
    [422, 'org_required'],
    [403, 'delegation_scope_restricted'],
    [403, 'interactive_user_required'],
    [403, 'org_forbidden'],
  ])('run %s %s is rendered inline by the dialog, so it is not toasted', async (status, code) => {
    mocks.fetchWithAuth.mockResolvedValue(json(status, { error: code }));
    await expect(startFlowRun('f1', { inputs: {} })).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('run MFA_REQUIRED is not toasted; unknown run errors still toast', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(403, { error: 'MFA required', code: 'MFA_REQUIRED' }));
    await expect(startFlowRun('f1', { inputs: {} })).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).not.toHaveBeenCalled();
    mocks.fetchWithAuth.mockResolvedValue(json(500, { error: 'boom_unknown' }));
    await expect(startFlowRun('f1', { inputs: {} })).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });

  it('disable and cancel failures are still toasted (no inline surface)', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(403, { error: 'delegation_scope_restricted' }));
    await expect(disableFlow('f1')).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });
});

describe('locale key lists match the shared const arrays', () => {
  const keys = (o: unknown) => Object.keys(o as object).sort();
  const sorted = (a: readonly string[]) => [...a].sort();

  it('runDetail.error.* covers every FLOW_RUN_ERROR_CODES', () => {
    expect(keys(en.runDetail.error)).toEqual(sorted(FLOW_RUN_ERROR_CODES));
  });
  it('runs.status.* covers every FLOW_RUN_STATUSES', () => {
    expect(keys(en.runs.status)).toEqual(sorted(FLOW_RUN_STATUSES));
  });
  it('runs.via.* covers every FLOW_TRIGGERED_VIA', () => {
    expect(keys(en.runs.via)).toEqual(sorted(FLOW_TRIGGERED_VIA));
  });
  it('runs.trigger.* covers every FLOW_TRIGGER_KINDS', () => {
    expect(keys(en.runs.trigger)).toEqual(sorted(FLOW_TRIGGER_KINDS));
  });
  it('runDetail.step.status.* covers every FLOW_RUN_STEP_STATUSES', () => {
    expect(keys(en.runDetail.step.status)).toEqual(sorted(FLOW_RUN_STEP_STATUSES));
  });
  it('status.pausedReason.* covers every FLOW_PAUSED_REASONS', () => {
    expect(keys(en.status.pausedReason)).toEqual(sorted(FLOW_PAUSED_REASONS));
  });
  it('the intent approval badge does not claim an approval happened (it shows while the step still waits)', () => {
    expect(en.runDetail.step.approval.intent).not.toMatch(/approved/i);
  });

  it('previewNotice is gone', () => {
    expect('previewNotice' in en).toBe(false);
  });
});

describe('W05 (#5220): webhook, deliveries and limits client', () => {
  it('listWebhookDeliveries builds /flows/:id/webhook-deliveries with limit and before', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { deliveries: [], identifiersHidden: true }));
    await expect(listWebhookDeliveries('f1', { limit: 50, before: '2026-10-01T00:00:00.000Z' })).resolves.toEqual({ deliveries: [], identifiersHidden: true });
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/flows/f1/webhook-deliveries?limit=50&before=2026-10-01T00%3A00%3A00.000Z');
  });

  it('getFlowLimits reads the partner level, or one org with ?orgId=', async () => {
    // The level is explicit: the switcher's org is never injected (#5220 live
    // check: a partner admin otherwise never reached the partner default).
    mocks.fetchWithAuth.mockResolvedValue(json(200, { level: 'partner', limits: {} }));
    await getFlowLimits();
    expect(mocks.fetchWithAuth).toHaveBeenLastCalledWith('/flows/limits', { orgIdOverride: null });
    mocks.fetchWithAuth.mockResolvedValue(json(200, { level: 'org', limits: {} }));
    await getFlowLimits('o1');
    expect(mocks.fetchWithAuth).toHaveBeenLastCalledWith('/flows/limits?orgId=o1', { orgIdOverride: null });
  });

  it('rotateWebhookSecret goes through runAction and returns the secret without ever toasting it', async () => {
    const reveal = { secret: 'bwh_SECRET_VALUE', fingerprint: 'fp', rotatedAt: '2026-10-26T00:00:00.000Z', warning: 'w' };
    mocks.fetchWithAuth.mockResolvedValue(json(200, reveal));
    await expect(rotateWebhookSecret('f1')).resolves.toEqual(reveal);
    const [url, init] = mocks.fetchWithAuth.mock.calls[0]!;
    expect(url).toBe('/flows/f1/webhook-secret');
    expect(init.method).toBe('POST');
    expect(JSON.stringify(mocks.showToast.mock.calls)).not.toContain('bwh_SECRET_VALUE');
  });

  it('rotateWebhookSecret failures toast localized copy', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(409, { error: 'draft_unresolvable' }));
    await expect(rotateWebhookSecret('f1')).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).toHaveBeenCalledWith({ message: lookup('webhook.secret.draftUnresolvable'), type: 'error' });
  });

  it('saveFlowLimits PUTs /flows/limits through runAction with a success toast', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { level: 'org' }));
    await saveFlowLimits({ orgId: 'o1', limits: { monthlyRunsPerFlow: 5, aiTokensPerRun: null } });
    const [url, init] = mocks.fetchWithAuth.mock.calls[0]!;
    expect(url).toBe('/flows/limits');
    expect(init.method).toBe('PUT');
    expect(init.orgIdOverride).toBeNull();
    expect(JSON.parse(init.body)).toEqual({ orgId: 'o1', limits: { monthlyRunsPerFlow: 5, aiTokensPerRun: null } });
    expect(mocks.showToast).toHaveBeenCalledWith({ message: lookup('limits.saved'), type: 'success' });
  });

  it('saveFlowLimits: a ceiling refusal is rendered inline (not toasted); partner_wide_forbidden toasts localized copy', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(422, { error: 'limit_above_partner_ceiling', field: 'monthlyRunsPerFlow', ceiling: 5 }));
    const err = await saveFlowLimits({ orgId: 'o1', limits: { monthlyRunsPerFlow: 6 } }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.body).toMatchObject({ field: 'monthlyRunsPerFlow', ceiling: 5 });
    expect(mocks.showToast).not.toHaveBeenCalled();
    mocks.fetchWithAuth.mockResolvedValue(json(403, { error: 'partner_wide_forbidden' }));
    await expect(saveFlowLimits({ limits: { monthlyRunsPerFlow: 6 } })).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).toHaveBeenCalledWith({ message: lookup('limits.partnerWideForbidden'), type: 'error' });
  });

  it.each([[422, 'webhook_secret_missing'], [422, 'ai_budget_unavailable']])(
    'enable %s %s is rendered inline by the dialog', async (status, code) => {
      mocks.fetchWithAuth.mockResolvedValue(json(status, { error: code }));
      await expect(enableFlow('f1', { expectedVersion: 1, preApprovedStepIds: [] })).rejects.toBeInstanceOf(ActionError);
      expect(mocks.showToast).not.toHaveBeenCalled();
    },
  );
});

describe('W05 locale key lists match the shared const arrays', () => {
  const keys = (o: unknown) => Object.keys(o as object).sort();
  const sorted = (a: readonly string[]) => [...a].sort();
  const w = en as unknown as Record<string, any>;

  it('webhook.lastFailure.* covers every FLOW_WEBHOOK_AUTH_FAILURES (+ label, none)', () => {
    expect(keys(w.webhook.lastFailure)).toEqual(sorted([...FLOW_WEBHOOK_AUTH_FAILURES, 'label', 'none']));
  });
  it('webhook.authMode.* covers every FLOW_WEBHOOK_AUTH_MODES (+ label)', () => {
    expect(keys(w.webhook.authMode)).toEqual(sorted([...FLOW_WEBHOOK_AUTH_MODES, 'label']));
  });
  it('deliveries.status.* covers every FLOW_WEBHOOK_DELIVERY_STATUSES', () => {
    expect(keys(w.deliveries.status)).toEqual(sorted(FLOW_WEBHOOK_DELIVERY_STATUSES));
  });
  it('usage.refused.* covers every FLOW_ADMISSION_REFUSALS', () => {
    expect(keys(w.usage.refused)).toEqual(sorted(FLOW_ADMISSION_REFUSALS));
  });
  it('limits.fields.* covers every FLOW_LIMIT_KEYS', () => {
    expect(keys(w.limits.fields)).toEqual(sorted(FLOW_LIMIT_KEYS));
  });
  it('step.builtin.* covers the three W05 built-ins', () => {
    expect(keys(w.step.builtin)).toEqual(['ai', 'http_request', 'notify']);
  });
});
