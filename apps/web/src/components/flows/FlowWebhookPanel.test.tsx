/**
 * Tool Catalog W05 (#5220) Task D2 — webhook panel, reveal-once secret dialog
 * and delivery log.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDetailDto } from '@breeze/shared';

const api = vi.hoisted(() => ({ rotateWebhookSecret: vi.fn(), listWebhookDeliveries: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: unknown) => unknown) => {
    const st = { organizations: [{ id: 'org-1', name: 'Acme' }], currentOrgId: null };
    return sel ? sel(st) : st;
  },
}));

import { ActionError } from '@/lib/runAction';
import { FlowWebhookPanel } from './FlowWebhookPanel';

const FLOW_ID = '9f1c0f4e-0000-4000-8000-000000000001';
const RUN_ID = '44444444-4444-4444-8444-444444444444';

function flow(over: Partial<FlowDetailDto> = {}, auth: 'hmac' | 'token' = 'hmac'): FlowDetailDto {
  return {
    id: FLOW_ID,
    slug: 'ticket_intake',
    name: 'Ticket intake',
    ownerScope: 'partner',
    orgId: null,
    partnerId: 'p-1',
    status: 'enabled',
    definition: {
      version: 1,
      name: 'Ticket intake',
      trigger: { type: 'webhook', auth, orgResolver: { path: 'body.customer.id', system: 'psa' } },
      inputs: [],
      steps: [],
    },
    webhook: {
      url: 'https://api.example.com/api/v1/webhooks/flows/' + FLOW_ID,
      authMode: auth,
      secretFingerprint: 'fp_abc123',
      secretRotatedAt: '2026-10-20T02:00:00.000Z',
      lastAuthFailureAt: '2026-10-25T02:00:00.000Z',
      lastAuthFailureReason: 'bad_signature',
    },
    ...over,
  } as unknown as FlowDetailDto;
}

const ACCEPTED = {
  id: 'd1', receivedAt: '2026-10-25T03:00:00.000Z', status: 'accepted', refusalCode: null, orgId: 'org-1', runId: RUN_ID,
  deliveryId: 'evt_1', authMode: 'hmac', bodyBytes: 12, attempts: 1, resolverValue: 'cust-9',
};
const UNRESOLVED = {
  id: 'd2', receivedAt: '2026-10-25T04:00:00.000Z', status: 'org_unresolved', refusalCode: null, orgId: null, runId: null,
  deliveryId: null, authMode: 'hmac', bodyBytes: 12, attempts: 3, resolverValue: 'unknown-cust',
};
const REFUSED = {
  id: 'd3', receivedAt: '2026-10-25T05:00:00.000Z', status: 'refused', refusalCode: 'flow_monthly_cap_reached', orgId: 'org-1', runId: null,
  deliveryId: 'evt_3', authMode: 'hmac', bodyBytes: 12, attempts: 1, resolverValue: 'cust-9',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listWebhookDeliveries.mockResolvedValue({ deliveries: [ACCEPTED, UNRESOLVED, REFUSED], identifiersHidden: false });
});

describe('FlowWebhookPanel', () => {
  it('shows the URL, auth mode, fingerprint, last failure, the resolver and the HMAC signing headers', async () => {
    render(<FlowWebhookPanel flow={flow()} canWrite onSecretChanged={vi.fn()} />);
    expect(screen.getByTestId('flow-webhook-url').textContent).toContain('/api/v1/webhooks/flows/' + FLOW_ID);
    expect(screen.getByTestId('flow-webhook-auth').textContent).toMatch(/HMAC/);
    expect(screen.getByTestId('flow-webhook-fingerprint').textContent).toContain('fp_abc123');
    expect(screen.getByTestId('flow-webhook-last-failure').textContent).toMatch(/signature did not match/i);
    expect(screen.getByTestId('flow-webhook-resolver').textContent).toContain('body.customer.id');
    const snippet = screen.getByTestId('flow-webhook-snippet').textContent ?? '';
    expect(snippet).toContain('X-Breeze-Timestamp');
    expect(snippet).toContain('X-Breeze-Signature: sha256=');
    expect(snippet).not.toContain('X-Breeze-Webhook-Token');
  });

  it('token mode shows the token header, not the signature', () => {
    render(<FlowWebhookPanel flow={flow({}, 'token')} canWrite onSecretChanged={vi.fn()} />);
    const snippet = screen.getByTestId('flow-webhook-snippet').textContent ?? '';
    expect(snippet).toContain('X-Breeze-Webhook-Token');
    expect(snippet).not.toContain('X-Breeze-Signature');
  });

  it('rotate confirms before calling', async () => {
    const user = userEvent.setup();
    api.rotateWebhookSecret.mockResolvedValue({ secret: 'bwh_NEW', fingerprint: 'fp2', rotatedAt: '2026-10-26T00:00:00.000Z', warning: 'w' });
    render(<FlowWebhookPanel flow={flow()} canWrite onSecretChanged={vi.fn()} />);
    await user.click(screen.getByTestId('flow-webhook-rotate'));
    expect(api.rotateWebhookSecret).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId('flow-webhook-rotate-confirm'));
    expect(api.rotateWebhookSecret).toHaveBeenCalledWith(FLOW_ID);
  });

  it('a flow without a secret offers Create, which needs no confirmation', async () => {
    const user = userEvent.setup();
    api.rotateWebhookSecret.mockResolvedValue({ secret: 'bwh_FIRST', fingerprint: 'fp', rotatedAt: '2026-10-26T00:00:00.000Z', warning: 'w' });
    const f = flow();
    f.webhook = { ...f.webhook!, secretFingerprint: null, secretRotatedAt: null };
    render(<FlowWebhookPanel flow={f} canWrite onSecretChanged={vi.fn()} />);
    expect(screen.getByTestId('flow-webhook-no-secret')).toBeTruthy();
    await user.click(screen.getByTestId('flow-webhook-create'));
    expect(api.rotateWebhookSecret).toHaveBeenCalledWith(FLOW_ID);
    expect(await screen.findByTestId('flow-webhook-secret-value')).toBeTruthy();
  });

  it('secret shown once and gone after close; the flow is reloaded', async () => {
    const user = userEvent.setup();
    const onSecretChanged = vi.fn();
    api.rotateWebhookSecret.mockResolvedValue({ secret: 'bwh_ONCE', fingerprint: 'fp2', rotatedAt: '2026-10-26T00:00:00.000Z', warning: 'w' });
    render(<FlowWebhookPanel flow={flow()} canWrite onSecretChanged={onSecretChanged} />);
    await user.click(screen.getByTestId('flow-webhook-rotate'));
    await user.click(await screen.findByTestId('flow-webhook-rotate-confirm'));
    expect((await screen.findByTestId('flow-webhook-secret-value')).textContent).toBe('bwh_ONCE');
    expect(screen.getByTestId('flow-webhook-secret-warning')).toBeTruthy();
    await user.click(screen.getByTestId('flow-webhook-secret-done'));
    await waitFor(() => expect(screen.queryByTestId('flow-webhook-secret-value')).toBeNull());
    expect(document.body.textContent).not.toContain('bwh_ONCE');
    expect(onSecretChanged).toHaveBeenCalled();
  });

  it('a failed rotate (already toasted) opens no dialog', async () => {
    const user = userEvent.setup();
    api.rotateWebhookSecret.mockRejectedValue(new ActionError('nope', 409));
    render(<FlowWebhookPanel flow={flow()} canWrite onSecretChanged={vi.fn()} />);
    await user.click(screen.getByTestId('flow-webhook-rotate'));
    await user.click(await screen.findByTestId('flow-webhook-rotate-confirm'));
    await waitFor(() => expect(api.rotateWebhookSecret).toHaveBeenCalled());
    expect(screen.queryByTestId('flow-webhook-secret-value')).toBeNull();
  });

  it('no write permission hides rotate and create', () => {
    render(<FlowWebhookPanel flow={flow()} canWrite={false} onSecretChanged={vi.fn()} />);
    expect(screen.queryByTestId('flow-webhook-rotate')).toBeNull();
    expect(screen.queryByTestId('flow-webhook-create')).toBeNull();
  });

  it('deliveries render statuses, run links, attempts, the refusal reason and the unresolved value', async () => {
    render(<FlowWebhookPanel flow={flow()} canWrite onSecretChanged={vi.fn()} />);
    const accepted = await screen.findByTestId('flow-delivery-d1');
    expect(accepted.textContent).toMatch(/Accepted/);
    expect(accepted.textContent).toContain('Acme');
    expect(screen.getByTestId('flow-delivery-run-d1').getAttribute('href')).toBe(`/flows/runs/${RUN_ID}`);
    const unresolved = screen.getByTestId('flow-delivery-d2');
    expect(unresolved.textContent).toMatch(/No matching organization/);
    expect(unresolved.textContent).toContain('unknown-cust');
    expect(unresolved.textContent).toContain('3');
    expect(screen.queryByTestId('flow-delivery-run-d2')).toBeNull();
    expect(screen.getByTestId('flow-delivery-d3').textContent).toMatch(/monthly run limit/i);
    expect(api.listWebhookDeliveries).toHaveBeenCalledWith(FLOW_ID, { limit: 50 });
  });

  it('a restricted reader sees that identifiers are hidden, not absent', async () => {
    api.listWebhookDeliveries.mockResolvedValue({
      deliveries: [{ ...UNRESOLVED, resolverValue: null }],
      identifiersHidden: true,
    });
    render(<FlowWebhookPanel flow={flow()} canWrite={false} onSecretChanged={vi.fn()} />);
    expect(await screen.findByTestId('flow-deliveries-hidden')).toBeTruthy();
    expect(screen.getByTestId('flow-delivery-d2').textContent).not.toContain('unknown-cust');
  });

  it('empty and failed delivery loads have their own states', async () => {
    api.listWebhookDeliveries.mockResolvedValueOnce({ deliveries: [], identifiersHidden: false });
    const { unmount } = render(<FlowWebhookPanel flow={flow()} canWrite onSecretChanged={vi.fn()} />);
    expect(await screen.findByTestId('flow-deliveries-empty')).toBeTruthy();
    unmount();
    api.listWebhookDeliveries.mockRejectedValueOnce(new ActionError('boom', 500));
    render(<FlowWebhookPanel flow={flow()} canWrite onSecretChanged={vi.fn()} />);
    expect(await screen.findByTestId('flow-deliveries-error')).toBeTruthy();
  });
});
