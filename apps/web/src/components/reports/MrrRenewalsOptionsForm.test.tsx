import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_MRR_RENEWALS_OPTIONS,
  MrrRenewalsOptionsFields,
  MrrRenewalsOptionsForm,
  isMrrRenewalsOptionsValid,
  mrrRenewalsConfigFromOptions,
  mrrRenewalsOptionsFromConfig,
  type MrrRenewalsOptions,
} from './MrrRenewalsOptionsForm';

const GROUPS = ['organization', 'contract'] as const;
const HORIZONS = [30, 60, 90, 180] as const;

describe('MRR & renewals options mapping', () => {
  it('defaults to organization grouping and a 90 day horizon', () => {
    expect(DEFAULT_MRR_RENEWALS_OPTIONS).toEqual({ groupBy: 'organization', renewalHorizonDays: 90 });
  });

  it.each(GROUPS.flatMap((g) => HORIZONS.map((h) => [g, h] as const)))(
    'round-trips groupBy=%s horizon=%s through the config',
    (groupBy, renewalHorizonDays) => {
      const options: MrrRenewalsOptions = { groupBy, renewalHorizonDays };
      expect(mrrRenewalsOptionsFromConfig(mrrRenewalsConfigFromOptions(options))).toEqual(options);
    },
  );

  it('falls back to the defaults for an unknown groupBy or horizon', () => {
    expect(mrrRenewalsOptionsFromConfig({ groupBy: 'currency', renewalHorizonDays: 45 })).toEqual(DEFAULT_MRR_RENEWALS_OPTIONS);
    expect(mrrRenewalsOptionsFromConfig({ renewalHorizonDays: '90' })).toEqual(DEFAULT_MRR_RENEWALS_OPTIONS);
    expect(mrrRenewalsOptionsFromConfig({})).toEqual(DEFAULT_MRR_RENEWALS_OPTIONS);
  });

  it('never sends asOf or period (the report is measured at run time)', () => {
    const config = mrrRenewalsConfigFromOptions(DEFAULT_MRR_RENEWALS_OPTIONS);
    expect(config).toEqual({ groupBy: 'organization', renewalHorizonDays: 90 });
    expect(config).not.toHaveProperty('asOf');
    expect(config).not.toHaveProperty('period');
    // A stored asOf/period is not carried back into the options either.
    expect(mrrRenewalsConfigFromOptions(mrrRenewalsOptionsFromConfig({ asOf: '2026-01-01', period: { kind: 'last_30_days' } })))
      .toEqual(config);
  });

  it('is always valid (both fields are closed choices)', () => {
    expect(isMrrRenewalsOptionsValid(DEFAULT_MRR_RENEWALS_OPTIONS)).toBe(true);
  });
});

describe('MrrRenewalsOptionsFields', () => {
  it('reports the chosen axis and horizon', async () => {
    const onChange = vi.fn();
    render(<MrrRenewalsOptionsFields value={DEFAULT_MRR_RENEWALS_OPTIONS} onChange={onChange} />);
    expect(screen.getByTestId('mrr-renewals-group-by')).toHaveValue('organization');
    expect(screen.getByTestId('mrr-renewals-horizon')).toHaveValue('90');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('mrr-renewals-group-by'), 'contract');
    expect(onChange).toHaveBeenLastCalledWith({ groupBy: 'contract', renewalHorizonDays: 90 });
    await user.selectOptions(screen.getByTestId('mrr-renewals-horizon'), '180');
    expect(onChange).toHaveBeenLastCalledWith({ groupBy: 'organization', renewalHorizonDays: 180 });
  });
});

describe('MrrRenewalsOptionsForm', () => {
  it('calls onSubmit from the create button', async () => {
    const onSubmit = vi.fn();
    render(
      <MrrRenewalsOptionsForm
        value={DEFAULT_MRR_RENEWALS_OPTIONS}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await userEvent.setup().click(screen.getByTestId('mrr-renewals-create-report'));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
