/**
 * Tool Catalog W05 (#5220) Task D3 — Flow limits settings. The one home of the
 * flow caps: partner default, org override that may only lower it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowLimitsViewDto } from '@breeze/shared';

const api = vi.hoisted(() => ({ getFlowLimits: vi.fn(), saveFlowLimits: vi.fn() }));
vi.mock('../flows/api', () => api);
const gate = vi.hoisted(() => ({ value: { enabled: true, loaded: true } }));
vi.mock('../../stores/featuresStore', () => ({ useFlowsGate: () => gate.value }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: unknown) => unknown) => {
    const st = { organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Globex' }], currentOrgId: null };
    return sel ? sel(st) : st;
  },
}));

import { ActionError } from '@/lib/runAction';
import FlowLimitsSettings from './FlowLimitsSettings';

const DEFAULTS = { monthlyRunsPerOwner: 100_000, monthlyRunsPerFlow: 10_000, aiTokensPerRun: 100_000 };
const CEILINGS = { monthlyRunsPerOwner: 1_000_000, monthlyRunsPerFlow: 100_000, aiTokensPerRun: 1_000_000 };

function partnerView(over: Partial<FlowLimitsViewDto> = {}): FlowLimitsViewDto {
  return {
    level: 'partner', partnerId: 'p-1', orgId: null,
    stored: { monthlyRunsPerOwner: null, monthlyRunsPerFlow: 500, aiTokensPerRun: null },
    limits: {
      effective: { monthlyRunsPerOwner: 100_000, monthlyRunsPerFlow: 500, aiTokensPerRun: 100_000 },
      source: { monthlyRunsPerOwner: 'default', monthlyRunsPerFlow: 'partner', aiTokensPerRun: 'default' },
      partnerCeiling: null,
    },
    defaults: DEFAULTS, ceilings: CEILINGS, canManage: true, ...over,
  };
}
function orgView(over: Partial<FlowLimitsViewDto> = {}): FlowLimitsViewDto {
  return {
    level: 'org', partnerId: 'p-1', orgId: 'org-1',
    stored: { monthlyRunsPerOwner: null, monthlyRunsPerFlow: 100, aiTokensPerRun: 9_000 },
    limits: {
      effective: { monthlyRunsPerOwner: 100_000, monthlyRunsPerFlow: 100, aiTokensPerRun: 2_000 },
      source: { monthlyRunsPerOwner: 'default', monthlyRunsPerFlow: 'org', aiTokensPerRun: 'partner' },
      partnerCeiling: { monthlyRunsPerOwner: 100_000, monthlyRunsPerFlow: 500, aiTokensPerRun: 2_000 },
    },
    defaults: DEFAULTS, ceilings: CEILINGS, canManage: true, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.value = { enabled: true, loaded: true };
  api.getFlowLimits.mockImplementation(async (orgId?: string) => (orgId ? orgView() : partnerView()));
  api.saveFlowLimits.mockImplementation(async () => partnerView());
});

describe('FlowLimitsSettings', () => {
  it('partner level: stored values fill the fields; a blank field shows the inherited value and its source', async () => {
    render(<FlowLimitsSettings />);
    expect(((await screen.findByTestId('flow-limit-input-monthlyRunsPerFlow')) as HTMLInputElement).value).toBe('500');
    expect((screen.getByTestId('flow-limit-input-monthlyRunsPerOwner') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('flow-limit-inherited-monthlyRunsPerOwner').textContent).toMatch(/100,000.*platform default/);
  });

  it('org level: the partner value is the ceiling and says so; a raise is refused client-side', async () => {
    const user = userEvent.setup();
    render(<FlowLimitsSettings />);
    await screen.findByTestId('flow-limit-input-monthlyRunsPerFlow');
    await user.selectOptions(screen.getByTestId('flow-limits-level'), 'org-1');
    expect(api.getFlowLimits).toHaveBeenLastCalledWith('org-1');
    expect((await screen.findByTestId('flow-limit-ceiling-monthlyRunsPerFlow')).textContent).toMatch(/only lower.*500/i);
    // A stored value above the ceiling is visible but marked as not applying.
    expect(screen.getByTestId('flow-limit-above-aiTokensPerRun').textContent).toMatch(/9,000/);
    const input = screen.getByTestId('flow-limit-input-monthlyRunsPerFlow');
    await user.clear(input);
    await user.type(input, '501');
    expect(screen.getByTestId('flow-limit-error-monthlyRunsPerFlow').textContent).toMatch(/500 or lower/);
    expect((screen.getByTestId('flow-limits-save') as HTMLButtonElement).disabled).toBe(true);
    expect(api.saveFlowLimits).not.toHaveBeenCalled();
  });

  it('saves only the changed fields; clearing a field sends null (inherit)', async () => {
    const user = userEvent.setup();
    render(<FlowLimitsSettings />);
    const perFlow = await screen.findByTestId('flow-limit-input-monthlyRunsPerFlow');
    await user.clear(perFlow);
    await user.type(screen.getByTestId('flow-limit-input-aiTokensPerRun'), '5000');
    await user.click(screen.getByTestId('flow-limits-save'));
    await waitFor(() => expect(api.saveFlowLimits).toHaveBeenCalledWith({ limits: { monthlyRunsPerFlow: null, aiTokensPerRun: 5000 } }));
  });

  it('an org save names the org', async () => {
    const user = userEvent.setup();
    api.saveFlowLimits.mockResolvedValue(orgView());
    render(<FlowLimitsSettings />);
    await screen.findByTestId('flow-limit-input-monthlyRunsPerFlow');
    await user.selectOptions(screen.getByTestId('flow-limits-level'), 'org-1');
    const input = await screen.findByTestId('flow-limit-input-monthlyRunsPerOwner');
    await user.type(input, '10');
    await user.click(screen.getByTestId('flow-limits-save'));
    await waitFor(() => expect(api.saveFlowLimits).toHaveBeenCalledWith({ orgId: 'org-1', limits: { monthlyRunsPerOwner: 10 } }));
  });

  it("a server ceiling refusal is shown on the field (it is not toasted)", async () => {
    const user = userEvent.setup();
    api.saveFlowLimits.mockRejectedValue(new ActionError('x', 422, undefined, { error: 'limit_above_partner_ceiling', field: 'monthlyRunsPerOwner', ceiling: 7 }));
    render(<FlowLimitsSettings />);
    await screen.findByTestId('flow-limit-input-monthlyRunsPerFlow');
    await user.selectOptions(screen.getByTestId('flow-limits-level'), 'org-1');
    await user.type(await screen.findByTestId('flow-limit-input-monthlyRunsPerOwner'), '10');
    await user.click(screen.getByTestId('flow-limits-save'));
    expect((await screen.findByTestId('flow-limit-error-monthlyRunsPerOwner')).textContent).toMatch(/7 or lower/);
  });

  it('read-only when the caller cannot manage the level; an org-scope caller gets no level picker', async () => {
    api.getFlowLimits.mockResolvedValue(orgView({ canManage: false }));
    render(<FlowLimitsSettings />);
    expect(await screen.findByTestId('flow-limits-readonly')).toBeTruthy();
    expect((screen.getByTestId('flow-limit-input-monthlyRunsPerFlow') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('flow-limits-save')).toBeNull();
    expect(screen.queryByTestId('flow-limits-level')).toBeNull();
  });

  it('a load failure says so; flows off renders nothing and requests nothing', async () => {
    api.getFlowLimits.mockRejectedValueOnce(new ActionError('boom', 500));
    const { unmount } = render(<FlowLimitsSettings />);
    expect(await screen.findByTestId('flow-limits-error')).toBeTruthy();
    unmount();
    vi.clearAllMocks();
    gate.value = { enabled: false, loaded: true };
    render(<FlowLimitsSettings />);
    expect(screen.queryByTestId('flow-limits')).toBeNull();
    expect(api.getFlowLimits).not.toHaveBeenCalled();
  });
});
