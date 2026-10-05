import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AiUsagePricingFields from './AiUsagePricingFields';
import type { AiModelChoice, AiUsageValue } from './aiUsagePricing';

const CHOICES: AiModelChoice[] = [
  { modelId: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', source: 'offering' },
  { modelId: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', source: 'recent_usage' },
];
let latest: AiUsageValue;
function Harness({ initial, currencyCode = 'USD', choices = CHOICES, choicesUnavailable = false }: {
  initial?: Partial<AiUsageValue>; currencyCode?: string; choices?: AiModelChoice[]; choicesUnavailable?: boolean;
}) {
  const [value, setValue] = useState<AiUsageValue>({ aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [], ...initial });
  latest = value;
  return <AiUsagePricingFields value={value} currencyCode={currencyCode} choices={choices} choicesUnavailable={choicesUnavailable} onChange={setValue} />;
}
const fill = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('AiUsagePricingFields', () => {
  it('shows only the coverage select until the card is billable', () => {
    render(<Harness />);
    expect(screen.getByTestId('billing-ai-coverage')).toHaveValue('non_billable');
    expect(screen.queryByTestId('billing-ai-markup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-ai-pricelist')).not.toBeInTheDocument();
    fill('billing-ai-coverage', 'billable');
    expect(screen.getByTestId('billing-ai-markup')).toBeInTheDocument();
    expect(screen.getByTestId('billing-ai-pricelist')).toBeInTheDocument();
  });

  it('clears markup and price rows when coverage leaves billable', () => {
    render(<Harness initial={{ aiCoverage: 'billable', aiMarkupPercent: '25', aiRates: [{ modelId: 'm', inputPricePerM: '1', outputPricePerM: '2', cacheReadPricePerM: '0.1', cacheWritePricePerM: '1.25' }] }} />);
    fill('billing-ai-coverage', 'included');
    expect(latest).toEqual({ aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] });
    expect(screen.queryByTestId('billing-ai-markup')).not.toBeInTheDocument();
  });

  it('edits markup and reports an inline error for a bad percentage', () => {
    render(<Harness initial={{ aiCoverage: 'billable' }} />);
    fill('billing-ai-markup', '25');
    expect(latest.aiMarkupPercent).toBe('25');
    expect(screen.queryByTestId('billing-ai-markup-error')).not.toBeInTheDocument();
    fill('billing-ai-markup', '1500');
    expect(screen.getByTestId('billing-ai-markup-error')).toBeInTheDocument();
    fill('billing-ai-markup', '');
    expect(latest.aiMarkupPercent).toBeNull();
  });

  it('adds, edits and removes price list rows; accepts a free-text model id', () => {
    render(<Harness initial={{ aiCoverage: 'billable' }} />);
    fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
    expect(screen.getByTestId('billing-ai-rate-error-0')).toBeInTheDocument();
    fill('billing-ai-rate-model-0', 'my-custom-model');
    fill('billing-ai-rate-input-0', '3.00');
    fill('billing-ai-rate-output-0', '15.00');
    fill('billing-ai-rate-cache-read-0', '0.30');
    fill('billing-ai-rate-cache-write-0', '3.75');
    expect(latest.aiRates).toEqual([{ modelId: 'my-custom-model', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75' }]);
    expect(screen.queryByTestId('billing-ai-rate-error-0')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('billing-ai-rate-remove-0'));
    expect(latest.aiRates).toEqual([]);
    expect(screen.queryByTestId('billing-ai-rate-row-0')).not.toBeInTheDocument();
  });

  it('offers fetched model choices through the datalist and flags a duplicate model', () => {
    render(<Harness initial={{ aiCoverage: 'billable' }} />);
    const list = screen.getByTestId('billing-ai-model-options');
    expect(within(list).getByTestId('billing-ai-model-option-claude-sonnet-4-5')).toHaveAttribute('value', 'claude-sonnet-4-5');
    expect(within(list).getByTestId('billing-ai-model-option-claude-haiku-4-5')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
    fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
    fill('billing-ai-rate-model-0', 'claude-sonnet-4-5');
    fill('billing-ai-rate-model-1', 'claude-sonnet-4-5');
    expect(screen.getByTestId('billing-ai-rate-error-1')).toHaveTextContent(/already on the price list/i);
  });

  it('warns when a billable non-USD card has no price list, and clears the warning once priced', () => {
    render(<Harness initial={{ aiCoverage: 'billable', aiMarkupPercent: '20' }} currencyCode="EUR" />);
    expect(screen.getByTestId('billing-ai-currency-warning')).toHaveTextContent('Markup applies only to USD cards; add a price list for EUR or usage will be recorded unpriced.');
    fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
    expect(screen.queryByTestId('billing-ai-currency-warning')).not.toBeInTheDocument();
  });

  it('never warns on a USD card and shows the suggestions-unavailable hint when asked', () => {
    render(<Harness initial={{ aiCoverage: 'billable' }} choicesUnavailable />);
    expect(screen.queryByTestId('billing-ai-currency-warning')).not.toBeInTheDocument();
    expect(screen.getByTestId('billing-ai-choices-unavailable')).toBeInTheDocument();
  });

  it('disables every control when disabled', () => {
    render(<AiUsagePricingFields value={{ aiCoverage: 'billable', aiMarkupPercent: null, aiRates: [] }} currencyCode="USD" choices={[]} onChange={() => {}} disabled />);
    expect(screen.getByTestId('billing-ai-coverage')).toBeDisabled();
    expect(screen.getByTestId('billing-ai-markup')).toBeDisabled();
    expect(screen.getByTestId('billing-ai-rate-add')).toBeDisabled();
  });
});
