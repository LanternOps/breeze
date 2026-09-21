// notices.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../../lib/i18n';
import { DuplicateConditionNotice } from './DuplicateConditionNotice';
import { LegacyFreezeNotice } from './LegacyFreezeNotice';

describe('DuplicateConditionNotice', () => {
  it('renders nothing without hits', () => {
    const { container } = render(<DuplicateConditionNotice hits={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('lists each duplicated pair', () => {
    render(<DuplicateConditionNotice hits={[
      { monitorId: 'a', monitorName: 'High CPU usage', legacyLabel: 'Alert Rule 1', source: 'alert_rule' },
      { monitorId: 'b', monitorName: 'Spooler stopped', legacyLabel: 'Spooler', source: 'monitoring' },
    ]} />);
    const el = screen.getByTestId('duplicate-condition-notice');
    expect(el).toHaveTextContent('Devices in this policy will alert twice');
    expect(el).toHaveTextContent('Alert Rule 1 ↔ High CPU usage');
    expect(el).toHaveTextContent('Spooler ↔ Spooler stopped');
  });
});

describe('LegacyFreezeNotice', () => {
  it('links to the Monitors tab of the same policy', () => {
    render(<LegacyFreezeNotice policyId="p-1" />);
    const link = screen.getByTestId('legacy-freeze-link');
    expect(link).toHaveAttribute('href', '/configuration-policies/p-1#monitors');
    expect(screen.getByTestId('legacy-freeze-notice')).toHaveTextContent('New rules are created as monitors');
  });
});
