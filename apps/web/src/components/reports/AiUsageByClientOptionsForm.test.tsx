import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS,
  AiUsageByClientOptionsFields,
  AiUsageByClientOptionsForm,
  aiUsageByClientConfigFromOptions,
  aiUsageByClientOptionsFromConfig,
} from './AiUsageByClientOptionsForm';

describe('AiUsageByClientOptionsFields (#7608 W10)', () => {
  it('defaults to Automatic grouping and states the UTC-month billing rule beside the period', () => {
    render(<AiUsageByClientOptionsFields value={DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId('ai-usage-by-client-group-by')).toHaveValue('');
    expect(screen.getByTestId('ai-usage-by-client-period-note')).toHaveTextContent(/UTC calendar month/i);
  });

  it('says unpriced usage is counted, never free', () => {
    render(<AiUsageByClientOptionsFields value={DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId('ai-usage-by-client-unpriced-note')).toHaveTextContent(/never treated as free/i);
  });

  it('reports the chosen axis, and Automatic as null', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<AiUsageByClientOptionsFields value={DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS} onChange={onChange} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('ai-usage-by-client-group-by'), 'model');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'model' }));

    rerender(<AiUsageByClientOptionsFields value={{ ...DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS, groupBy: 'model' }} onChange={onChange} />);
    await user.selectOptions(screen.getByTestId('ai-usage-by-client-group-by'), '');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: null }));
  });
});

describe('AiUsageByClientOptionsForm', () => {
  it('disables submit while the custom period is incomplete', () => {
    render(
      <AiUsageByClientOptionsForm
        value={{ ...DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS, period: { kind: 'custom', start: '2026-08-01' } }}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('ai-usage-by-client-create-report')).toBeDisabled();
    expect(screen.getByTestId('report-period-error')).toBeInTheDocument();
  });

  it('enables submit for the default period and calls onSubmit', async () => {
    const onSubmit = vi.fn();
    render(
      <AiUsageByClientOptionsForm
        value={DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const submit = screen.getByTestId('ai-usage-by-client-create-report');
    expect(submit).toBeEnabled();
    await userEvent.setup().click(submit);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe('aiUsageByClientConfigFromOptions', () => {
  it('OMITS groupBy for Automatic and emits exactly the keys the server schema accepts', () => {
    expect(aiUsageByClientConfigFromOptions(DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS)).toEqual({
      period: { kind: 'last_full_month' },
    });
  });

  it('sends an explicit axis when chosen', () => {
    expect(aiUsageByClientConfigFromOptions({ ...DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS, groupBy: 'model' })).toEqual({
      period: { kind: 'last_full_month' },
      groupBy: 'model',
    });
  });
});

describe('aiUsageByClientOptionsFromConfig', () => {
  it('falls back to the defaults for an empty config', () => {
    expect(aiUsageByClientOptionsFromConfig({})).toEqual(DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS);
  });

  it('reads a stored period and axis, and ignores an axis the server would reject', () => {
    expect(aiUsageByClientOptionsFromConfig({ period: { kind: 'last_quarter' }, groupBy: 'organization' }))
      .toEqual({ period: { kind: 'last_quarter' }, groupBy: 'organization' });
    expect(aiUsageByClientOptionsFromConfig({ groupBy: 'site' }).groupBy).toBeNull();
  });
});
