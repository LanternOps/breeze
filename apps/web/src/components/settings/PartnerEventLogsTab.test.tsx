import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { InheritableEventLogSettings } from '@breeze/shared';
import { i18n } from '../../lib/i18n';

import PartnerEventLogsTab from './PartnerEventLogsTab';

const SAVED_PLACEHOLDER = () => i18n.t('settings:partnerEventLogs.savedSecretPlaceholder');

// Controlled like PartnerSettingsPage: the tab reports every change upward.
function Harness({ initial, onChange }: { initial: InheritableEventLogSettings; onChange: (d: InheritableEventLogSettings) => void }) {
  const [data, setData] = useState(initial);
  return (
    <PartnerEventLogsTab
      data={data}
      onChange={(next) => {
        setData(next);
        onChange(next);
      }}
    />
  );
}

const saved: InheritableEventLogSettings = {
  enabled: true,
  elasticsearchUrl: 'https://es.partner.test:9200',
  elasticsearchApiKey: '********',
};

describe('PartnerEventLogsTab: saved credentials', () => {
  it('shows a saved API key as a placeholder instead of the marker', () => {
    render(<Harness initial={saved} onChange={vi.fn()} />);

    const input = screen.getByTestId('partner-event-logs-api-key');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', SAVED_PLACEHOLDER());
  });

  it('typing replaces the saved value, and erasing it keeps the saved value', () => {
    const onChange = vi.fn();
    render(<Harness initial={saved} onChange={onChange} />);
    const input = screen.getByTestId('partner-event-logs-api-key');

    fireEvent.change(input, { target: { value: 'typed-key' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ elasticsearchApiKey: 'typed-key' }));

    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ elasticsearchApiKey: '********' }));
  });

  it('removing a saved value sends an explicit clear', () => {
    const onChange = vi.fn();
    render(<Harness initial={saved} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('partner-event-logs-api-key-remove'));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ elasticsearchApiKey: '' }));
    expect(screen.getByTestId('partner-event-logs-api-key')).toHaveAttribute(
      'placeholder',
      i18n.t('settings:partnerEventLogs.secretRemovedPlaceholder'),
    );
  });

  it('offers no remove control and the ordinary placeholder when nothing is saved', () => {
    render(<Harness initial={{ enabled: true }} onChange={vi.fn()} />);

    expect(screen.getByTestId('partner-event-logs-api-key')).toHaveAttribute('placeholder', i18n.t('settings:partnerEventLogs.notSet'));
    expect(screen.queryByTestId('partner-event-logs-api-key-remove')).toBeNull();
  });
});
