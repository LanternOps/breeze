/**
 * Tool Catalog W06 (#5221) Task C1 — the conversion API client and its locale keys.
 *
 * Every mutation goes through `runAction` (outcomes toasted, `{success:false}`
 * bodies are failures). A switch refusal is rendered inline by the dialog, so it
 * is never toasted on top, and its body reaches the caller. The finding and
 * fidelity keys are pinned to the shared arrays: locale parity alone cannot
 * catch a key that EVERY locale lacks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLOW_CONVERSION_FIDELITIES,
  FLOW_CONVERSION_FINDING_CODES,
  FLOW_CONVERSION_STATES,
  FLOW_CONVERSION_SWITCH_BLOCKERS,
  SHADOW_DIVERGENCE_KINDS,
} from '@breeze/shared';
import en from '../../../locales/en/flows.json';

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('../../shared/Toast', () => ({ showToast: mocks.showToast }));
vi.mock('../../../lib/trustProbation', () => ({ dispatchTrustDenied: vi.fn(), isTrustDenial: () => false }));

import { ActionError } from '../../../lib/runAction';
import {
  CONVERSION_ERROR_CODES,
  conversionErrorMessage,
  createConversion,
  createConversionsBulk,
  getConversion,
  listConversions,
  previewConversion,
  revertConversion,
  switchConversion,
} from './conversionApi';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function lookup(path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    en,
  );
}

const SWITCH_BODY = {
  expectedFlowVersion: 2,
  preApprovals: [],
  acceptScopeWidening: false,
  acceptDelegatorLifecycle: true as const,
  acknowledgeDivergence: false,
};

beforeEach(() => {
  mocks.fetchWithAuth.mockReset();
  mocks.showToast.mockReset();
});

describe('conversion reads', () => {
  it('previewConversion GETs /flows/conversions/preview/:automationId', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { automationId: 'a1', fidelity: 'exact', findings: [] }));
    await previewConversion('a1');
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/flows/conversions/preview/a1');
  });

  it('listConversions builds the query string', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { conversions: [], total: 0 }));
    await listConversions({ state: 'shadow', automationId: 'a1', limit: 100 });
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/flows/conversions?state=shadow&automationId=a1&limit=100');
  });

  it('a 404 list (Flows off on this installation) throws an ActionError with status 404 and is not toasted', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(404, { error: 'Not found' }));
    await expect(listConversions()).rejects.toMatchObject({ status: 404 });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('getConversion GETs /flows/conversions/:id', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { id: 'c1' }));
    await getConversion('c1');
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/flows/conversions/c1');
  });
});

describe('conversion mutations use runAction', () => {
  it('createConversion POSTs the source digest and toasts success', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(201, { id: 'c1' }));
    await createConversion('a1', 'd'.repeat(64));
    const [path, init] = mocks.fetchWithAuth.mock.calls[0]!;
    expect(path).toBe('/flows/conversions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ automationId: 'a1', expectedSourceDigest: 'd'.repeat(64) });
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('a 200 {success:false} body is a failure (runAction contract)', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { success: false, error: 'nope' }));
    await expect(createConversion('a1', 'd'.repeat(64))).rejects.toBeInstanceOf(ActionError);
  });

  it('a create refusal is toasted with the localized copy, never the raw token', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(409, { error: 'source_changed' }));
    await expect(createConversion('a1', 'd'.repeat(64))).rejects.toBeInstanceOf(ActionError);
    const toast = mocks.showToast.mock.calls.at(-1)?.[0];
    expect(toast).toMatchObject({ type: 'error' });
    expect(toast.message).not.toContain('source_changed');
  });

  it('createConversionsBulk POSTs the owner to /bulk', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { created: 3, skipped: {} }));
    const r = await createConversionsBulk({ ownerScope: 'organization', orgId: 'o1' });
    expect(r.created).toBe(3);
    const [path, init] = mocks.fetchWithAuth.mock.calls[0]!;
    expect(path).toBe('/flows/conversions/bulk');
    expect(JSON.parse(init.body)).toEqual({ ownerScope: 'organization', orgId: 'o1' });
  });

  it('switchConversion POSTs the acceptances to /:id/switch', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { conversion: { id: 'c1' } }));
    await switchConversion('c1', SWITCH_BODY);
    const [path, init] = mocks.fetchWithAuth.mock.calls[0]!;
    expect(path).toBe('/flows/conversions/c1/switch');
    expect(JSON.parse(init.body)).toEqual(SWITCH_BODY);
  });

  it('a switch 422 is rendered inline: not toasted, body on the thrown ActionError', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(422, { error: 'scope_widening_not_accepted' }));
    const err = await switchConversion('c1', SWITCH_BODY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(422);
    expect((err as ActionError).body).toEqual({ error: 'scope_widening_not_accepted' });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('a switch 409 automation_disabled is rendered inline too', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(409, { error: 'automation_disabled' }));
    await expect(switchConversion('c1', SWITCH_BODY)).rejects.toMatchObject({ status: 409 });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('a switch 5xx is still toasted', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(500, { error: 'boom' }));
    await expect(switchConversion('c1', SWITCH_BODY)).rejects.toBeInstanceOf(ActionError);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('revertConversion POSTs /:id/revert with no body', async () => {
    mocks.fetchWithAuth.mockResolvedValue(json(200, { conversion: { id: 'c1' } }));
    await revertConversion('c1');
    const [path, init] = mocks.fetchWithAuth.mock.calls[0]!;
    expect(path).toBe('/flows/conversions/c1/revert');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
});

describe('locale keys pinned to the shared arrays', () => {
  it.each(FLOW_CONVERSION_FINDING_CODES)('finding %s has a title and a one-line explanation', (code) => {
    expect(typeof lookup(`conversion.finding.${code}.title`)).toBe('string');
    expect(typeof lookup(`conversion.finding.${code}.line`)).toBe('string');
  });

  it.each(FLOW_CONVERSION_FIDELITIES)('fidelity %s has a label', (f) => {
    expect(typeof lookup(`conversion.fidelity.${f}`)).toBe('string');
  });

  it.each(FLOW_CONVERSION_STATES)('state %s has a label', (s) => {
    expect(typeof lookup(`conversion.state.${s}`)).toBe('string');
  });

  it.each(FLOW_CONVERSION_SWITCH_BLOCKERS)('switch blocker %s has copy', (b) => {
    expect(typeof lookup(`conversion.switch.blocked.${b}`)).toBe('string');
  });

  it.each(SHADOW_DIVERGENCE_KINDS)('divergence %s has copy', (k) => {
    expect(typeof lookup(`conversion.shadow.divergence.${k}`)).toBe('string');
  });

  it.each(CONVERSION_ERROR_CODES)('refusal %s has localized copy', (code) => {
    expect(typeof lookup(`conversion.errors.${code}`)).toBe('string');
    expect(conversionErrorMessage(code)).not.toBe(`flows:conversion.errors.${code}`);
  });

  it('an unknown token maps to nothing (the caller falls back)', () => {
    expect(conversionErrorMessage('something_else')).toBeUndefined();
  });

  it.each(['run_script_on_targets', 'resolve_targets', 'create_alert'])('built-in %s has step rendering copy', (tool) => {
    expect(typeof lookup(`step.builtin.${tool}`)).toBe('string');
  });
});
