import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@/lib/i18n';
const m = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  changed: vi.fn(),
}));
vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: m.save,
    remove: m.remove,
    saving: false,
    error: undefined,
    clearError: vi.fn(),
  }),
}));
import TimeSyncTab from './TimeSyncTab';
const props = {
  policyId: 'policy',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: m.changed,
};
beforeEach(() => {
  vi.clearAllMocks();
  m.save.mockResolvedValue({
    id: 'link',
    featureType: 'time_sync',
    featurePolicyId: null,
    inlineSettings: {},
  });
});
it('starts off and saves typed settings only after a valid peer is entered', async () => {
  render(<TimeSyncTab {...props} />);
  expect(
    (screen.getByTestId('time-sync-enforce-ntp') as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.click(screen.getByTestId('time-sync-enforce-ntp'));
  expect(
    (screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByTestId('time-sync-servers'), {
    target: { value: 'pool.ntp.org' },
  });
  fireEvent.change(screen.getByTestId('time-sync-interval'), {
    target: { value: '120' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith(null, {
      featureType: 'time_sync',
      featurePolicyId: null,
      inlineSettings: {
        enforceNtp: true,
        ntpServers: ['pool.ntp.org'],
        pollIntervalMinutes: 120,
        timezone: { expected: 'site', pinnedTimezone: null, autoFix: false },
      },
    }),
  );
});
it.each(['a,0x9', 'a b', 'a;b', '-flag', 'a:123', '"a"'])(
  'keeps invalid peer %s visible and disables save',
  (value) => {
    render(<TimeSyncTab {...props} />);
    fireEvent.change(screen.getByTestId('time-sync-servers'), {
      target: { value },
    });
    expect(
      (screen.getByTestId('time-sync-servers') as HTMLTextAreaElement).value,
    ).toBe(value);
    expect(
      (screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  },
);
it('requires a mapped pin and explains that it overrides the site', () => {
  render(<TimeSyncTab {...props} />);
  fireEvent.change(screen.getByTestId('time-sync-expected'), {
    target: { value: 'pinned' },
  });
  expect(
    screen.getByText('The pinned timezone overrides the site timezone.'),
  ).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('inherits without editing the parent, then creates a local override', async () => {
  const parent = {
    id: 'parent-link',
    featureType: 'time_sync' as const,
    featurePolicyId: null,
    inlineSettings: {
      enforceNtp: true,
      ntpServers: ['pool.ntp.org'],
      pollIntervalMinutes: 60,
      timezone: { expected: 'pinned', pinnedTimezone: 'UTC', autoFix: true },
    },
  };
  render(
    <TimeSyncTab {...props} parentLink={parent} linkedPolicyId="parent" />,
  );
  expect(
    screen.getByTestId('time-sync-enforce-ntp').closest('fieldset')!.disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /override/i }));
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ inlineSettings: parent.inlineSettings }),
    ),
  );
});
it('does not report a saved link after failure', async () => {
  m.save.mockResolvedValue(null);
  render(<TimeSyncTab {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(m.save).toHaveBeenCalled());
  expect(m.changed).not.toHaveBeenCalled();
});
it('retains invalid interval text instead of clamping it', () => {
  render(<TimeSyncTab {...props} />);
  fireEvent.change(screen.getByTestId('time-sync-interval'), {
    target: { value: '14' },
  });
  expect(
    (screen.getByTestId('time-sync-interval') as HTMLInputElement).value,
  ).toBe('14');
  expect(
    (screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
