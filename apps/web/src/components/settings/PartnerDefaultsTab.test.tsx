import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { InheritableDefaultSettings } from '@breeze/shared';
import { ENROLLMENT_TTL_OPTIONS } from '@breeze/shared';

import PartnerDefaultsTab from './PartnerDefaultsTab';

/**
 * The tab is fully controlled by PartnerSettingsPage, so a bare `vi.fn()`
 * onChange leaves every input frozen at its initial value — multi-keystroke
 * typing would then report only the last character. This harness holds the
 * state the real parent holds and forwards each value to the spy.
 */
function ControlledTab({ onChange, initial = {} }: {
  onChange: (data: InheritableDefaultSettings) => void;
  initial?: InheritableDefaultSettings;
}) {
  const [data, setData] = useState<InheritableDefaultSettings>(initial);
  return (
    <PartnerDefaultsTab
      data={data}
      onChange={next => {
        setData(next);
        onChange(next);
      }}
    />
  );
}

describe('PartnerDefaultsTab — enrollment defaults (#2776)', () => {
  it('renders the shared TTL option set (plus the not-set option) for both TTL fields', () => {
    render(<PartnerDefaultsTab data={{}} onChange={vi.fn()} />);

    for (const testId of ['partner-enrollment-ttl', 'partner-max-enrollment-ttl']) {
      const select = screen.getByTestId(testId) as HTMLSelectElement;
      expect([...select.options].map(o => o.value)).toEqual([
        '',
        ...ENROLLMENT_TTL_OPTIONS.map(String),
      ]);
    }
  });

  it('filters the DEFAULT TTL to the partner\'s own cap while the cap picker keeps the full range', () => {
    render(
      <PartnerDefaultsTab
        data={{ maxEnrollmentLinkTtlMinutes: 10080 }}
        onChange={vi.fn()}
      />,
    );

    // The default is clamped to the cap by resolveEnrollmentDefaults, so
    // offering a longer one here would advertise a lifetime no link gets.
    expect(
      [...(screen.getByTestId('partner-enrollment-ttl') as HTMLSelectElement).options].map(
        o => o.value,
      ),
    ).toEqual(['', '60', '1440', '10080']);

    // The cap picker defines the cap — it must stay unfiltered.
    expect(
      [...(screen.getByTestId('partner-max-enrollment-ttl') as HTMLSelectElement).options].map(
        o => o.value,
      ),
    ).toEqual(['', ...ENROLLMENT_TTL_OPTIONS.map(String)]);
  });

  it('shows a stored over-cap default as its own option rather than a clamped one', () => {
    render(
      <PartnerDefaultsTab
        data={{ defaultEnrollmentTtlMinutes: 525600, maxEnrollmentLinkTtlMinutes: 1440 }}
        onChange={vi.fn()}
      />,
    );

    // This component is controlled and never rewrites `data`, so displaying a
    // clamped value would mean showing "1 hour" while the parent persists
    // 525600.
    const select = screen.getByTestId('partner-enrollment-ttl') as HTMLSelectElement;
    expect(select.value).toBe('525600');
    expect([...select.options].map(o => o.value)).toEqual(['', '60', '1440', '525600']);
  });

  it('emits the three enrollment fields as numbers', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledTab onChange={onChange} />);

    await user.selectOptions(screen.getByTestId('partner-enrollment-ttl'), '10080');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultEnrollmentTtlMinutes: 10080 }),
    );

    await user.selectOptions(screen.getByTestId('partner-max-enrollment-ttl'), '60');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxEnrollmentLinkTtlMinutes: 60 }),
    );

    await user.type(screen.getByTestId('partner-enrollment-device-count'), '25');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultEnrollmentDeviceCount: 25 }),
    );
  });

  it('hydrates stored values and clears a field back to not-set', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ControlledTab
        onChange={onChange}
        initial={{ defaultEnrollmentTtlMinutes: 1440, defaultEnrollmentDeviceCount: 5, maxEnrollmentLinkTtlMinutes: 43200 }}
      />,
    );

    expect((screen.getByTestId('partner-enrollment-ttl') as HTMLSelectElement).value).toBe('1440');
    expect((screen.getByTestId('partner-enrollment-device-count') as HTMLInputElement).value).toBe('5');
    expect((screen.getByTestId('partner-max-enrollment-ttl') as HTMLSelectElement).value).toBe('43200');

    await user.selectOptions(screen.getByTestId('partner-max-enrollment-ttl'), '');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxEnrollmentLinkTtlMinutes: undefined }),
    );
  });
});
