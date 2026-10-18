import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PatchTab from './PatchTab';
import { fetchWithAuth } from '../../../stores/auth';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const baseProps = {
  policyId: 'policy-1',
  existingLink: null,
  onLinkChanged: vi.fn(),
  linkedPolicyId: undefined,
  parentLink: null,
} as any;

describe('PatchTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    } as unknown as Response);
    saveMock.mockResolvedValue({ id: 'link-1', featureType: 'patch', inlineSettings: {} });
  });

  // Auto-approval rules live on Update Rings, but patch *sources* are the policy's
  // own install-scope gate (evaluator source-filters on settings.sources). #1428
  // wrongly stripped this control, stranding third-party patching as unreachable —
  // it's restored as a single third-party toggle (OS is always included).
  it('renders the Patch Sources third-party toggle, off by default', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByText('Approval Ring');
    expect(screen.getByText('Patch Sources')).toBeInTheDocument();
    const toggle = screen.getByTestId('patch-third-party-sources-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('adds third_party to sources on save when the toggle is switched on', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByTestId('patch-third-party-sources-toggle'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.sources).toEqual(['os', 'third_party']);
  });

  it('hydrates the third-party toggle on, and drops third_party back to [os] when switched off', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os', 'third_party'] },
        }}
      />
    );
    const toggle = await screen.findByTestId('patch-third-party-sources-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.sources).toEqual(['os']);
  });

  it('does not render the Automatic Approval section', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByText('Approval Ring');
    expect(screen.queryByText('Automatic Approval')).toBeNull();
    expect(screen.queryByTestId('auto-approve-toggle')).toBeNull();
    expect(screen.queryByTestId('auto-approve-severity-critical')).toBeNull();
    expect(screen.queryByTestId('auto-approve-deferral')).toBeNull();
  });

  it('keeps the Approval Ring link and Installation Schedule', async () => {
    render(<PatchTab {...baseProps} />);
    expect(await screen.findByText('Approval Ring')).toBeInTheDocument();
    expect(screen.getByText('No ring (manual approvals only)')).toBeInTheDocument();
    expect(screen.getByText('Installation Schedule')).toBeInTheDocument();
    expect(screen.getByText('Reboot Policy')).toBeInTheDocument();
  });

  // #2609: schedule fields rendered <label> with no htmlFor/id association, so
  // screen readers announced an unnamed control and getByLabel(...) failed.
  it('associates the schedule labels with their inputs (a11y, #2609)', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByText('Installation Schedule');

    expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    expect(screen.getByLabelText('Time')).toBeInTheDocument();

    // Weekly is the default frequency, so the Day of week select is present.
    expect(screen.getByLabelText('Day of week')).toBeInTheDocument();
  });

  it('links the policy to the selected ring on save', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'ring-1', name: 'Pilot', ringOrder: 1, deferralDays: 0, gracePeriodHours: 4 }],
      }),
    } as unknown as Response);

    render(<PatchTab {...baseProps} />);
    fireEvent.change(await screen.findByTestId('approval-ring-select'), { target: { value: 'ring-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.featurePolicyId).toBe('ring-1');
  });

  // #8187: approval and application rules live on the Update Ring. The tab
  // must never send them: the API judges any sent `apps` / `autoApprove*` as an
  // attempt to edit ring-owned rules (400 APPROVAL_RULES_MOVED_TO_RING).
  const LEGACY_APPROVAL_KEYS = ['apps', 'autoApprove', 'autoApproveSeverities', 'autoApproveDeferralDays'];
  const STORED_LEGACY_INLINE = {
    sources: ['third_party'],
    autoApprove: true,
    autoApproveSeverities: ['critical'],
    autoApproveDeferralDays: 3,
    apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', displayName: 'Firefox', action: 'block' }],
  };

  it('saves without any approval or application-rule keys, even when the link stores them', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{ id: 'link-1', featureType: 'patch', featurePolicyId: null, inlineSettings: STORED_LEGACY_INLINE }}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    for (const key of LEGACY_APPROVAL_KEYS) expect(payload.inlineSettings).not.toHaveProperty(key);
    expect(payload.inlineSettings.sources).toEqual(['third_party']);
  });

  it('Override does not copy approval or application-rule keys from the parent', async () => {
    render(
      <PatchTab
        {...baseProps}
        parentLink={{ id: 'parent-link', featureType: 'patch', featurePolicyId: null, inlineSettings: STORED_LEGACY_INLINE }}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: /override/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [linkId, payload] = saveMock.mock.calls[0];
    expect(linkId).toBeNull();
    for (const key of LEGACY_APPROVAL_KEYS) expect(payload.inlineSettings).not.toHaveProperty(key);
  });

  it('no longer renders the application-rules editor', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{ id: 'link-1', featureType: 'patch', featurePolicyId: null, inlineSettings: STORED_LEGACY_INLINE }}
      />
    );
    await screen.findByText('Approval Ring');
    expect(screen.queryByText('Application Rules')).toBeNull();
    expect(screen.queryByTestId('app-rules-add')).toBeNull();
  });

  it('says the linked ring owns approval, or that approval is manual without one', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'ring-1', name: 'Pilot', ringOrder: 1, deferralDays: 0, gracePeriodHours: 4 }],
      }),
    } as unknown as Response);
    render(<PatchTab {...baseProps} />);
    const hint = await screen.findByTestId('patch-ring-owns-approval-hint');
    expect(hint).toHaveTextContent('No ring linked — patches install only after manual approval.');

    fireEvent.change(screen.getByTestId('approval-ring-select'), { target: { value: 'ring-1' } });
    expect(screen.getByTestId('patch-ring-owns-approval-hint')).toHaveTextContent(
      'Auto-approval and application rules are set on the linked Update Ring.',
    );
  });

  it('shows a repair prompt for a link whose ring is no longer available, and lets a ring be chosen', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'ring-1', name: 'Pilot', ringOrder: 1, deferralDays: 0, gracePeriodHours: 4 }],
      }),
    } as unknown as Response);
    render(
      <PatchTab
        {...baseProps}
        existingLink={{ id: 'link-1', featureType: 'patch', featurePolicyId: 'gone-ring', inlineSettings: STORED_LEGACY_INLINE }}
      />
    );
    const prompt = await screen.findByTestId('patch-ring-invalid');
    expect(prompt).toHaveTextContent('The linked Update Ring is no longer available');
    // The legacy rules the replacement ring has to carry are named.
    expect(prompt).toHaveTextContent('Firefox');

    fireEvent.change(screen.getByTestId('approval-ring-select'), { target: { value: 'ring-1' } });
    expect(screen.queryByTestId('patch-ring-invalid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][1].featurePolicyId).toBe('ring-1');
  });

  // #1872: sole-patch-source enforcement toggle.
  it('renders the exclusive Windows Update toggle, off by default', async () => {
    render(<PatchTab {...baseProps} />);
    const toggle = await screen.findByTestId('patch-exclusive-windows-update-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Manage Windows Update exclusively through Breeze')).toBeInTheDocument();
  });

  it('persists exclusiveWindowsUpdate=true in the save payload when toggled on', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByTestId('patch-exclusive-windows-update-toggle'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.exclusiveWindowsUpdate).toBe(true);
  });

  it('hydrates the toggle from a stored exclusiveWindowsUpdate value', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], exclusiveWindowsUpdate: true },
        }}
      />
    );
    const toggle = await screen.findByTestId('patch-exclusive-windows-update-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  // #3197: operator-configurable warning window before a patch-triggered reboot.
  it('renders the reboot delay input with the default value when reboot policy is not "never"', async () => {
    render(<PatchTab {...baseProps} />);
    const input = await screen.findByTestId('patch-reboot-delay-minutes');
    expect(input).toHaveValue(15);
  });

  it('hides the reboot delay input when reboot policy is "never"', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], rebootPolicy: 'never' },
        }}
      />
    );
    await screen.findByText('Reboot Policy');
    expect(screen.queryByTestId('patch-reboot-delay-minutes')).toBeNull();
  });

  it('persists rebootDelayMinutes in the save payload when changed', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.change(await screen.findByTestId('patch-reboot-delay-minutes'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.rebootDelayMinutes).toBe(30);
  });

  it('hydrates the reboot delay input from a stored rebootDelayMinutes value', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], rebootDelayMinutes: 45 },
        }}
      />
    );
    const input = await screen.findByTestId('patch-reboot-delay-minutes');
    expect(input).toHaveValue(45);
  });

  // #3207: end-user reboot deferral. Off by default — the budget fields only
  // exist once an admin opts in, so the tab cannot imply a Postpone button that
  // no device will ever show.
  it('offers the deferral toggle, off, and hides the budget fields until it is on', async () => {
    render(<PatchTab {...baseProps} />);
    const toggle = await screen.findByTestId('patch-reboot-allow-deferral-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('patch-reboot-max-deferrals')).toBeNull();
    expect(screen.queryByTestId('patch-reboot-deferral-minutes')).toBeNull();
  });

  it('shows max deferrals and the deferral window once enabled', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], rebootAllowDeferral: true },
        }}
      />
    );
    expect(await screen.findByTestId('patch-reboot-max-deferrals')).toHaveValue(3);
    expect(screen.getByTestId('patch-reboot-deferral-minutes')).toHaveValue(60);
  });

  it('hides the whole deferral block when the reboot policy is never', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], rebootPolicy: 'never', rebootAllowDeferral: true },
        }}
      />
    );
    await screen.findByText('Reboot Policy');
    expect(screen.queryByTestId('patch-reboot-allow-deferral-toggle')).toBeNull();
    expect(screen.queryByTestId('patch-reboot-max-deferrals')).toBeNull();
  });

  it('hydrates the budget fields from stored values', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: {
            sources: ['os'],
            rebootAllowDeferral: true,
            rebootMaxDeferrals: 2,
            rebootDeferralMinutes: 30,
          },
        }}
      />
    );
    expect(await screen.findByTestId('patch-reboot-max-deferrals')).toHaveValue(2);
    expect(screen.getByTestId('patch-reboot-deferral-minutes')).toHaveValue(30);
  });

  it('persists the deferral settings in the save payload', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByTestId('patch-reboot-allow-deferral-toggle'));
    fireEvent.change(await screen.findByTestId('patch-reboot-max-deferrals'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByTestId('patch-reboot-deferral-minutes'), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.rebootAllowDeferral).toBe(true);
    expect(payload.inlineSettings.rebootMaxDeferrals).toBe(5);
    expect(payload.inlineSettings.rebootDeferralMinutes).toBe(45);
  });

  it('sends deferral off by default so an untouched policy keeps today’s behaviour', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByTestId('patch-reboot-delay-minutes');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.rebootAllowDeferral).toBe(false);
  });

  // #5128 W3 — offline behaviour for scheduled installs.
  describe('offline behaviour (#5128 W3)', () => {
    it('renders both options with queue selected by default', async () => {
      render(<PatchTab {...baseProps} />);
      const group = await screen.findByTestId('patch-offline-behavior');
      expect(group).toHaveAttribute('role', 'radiogroup');
      expect(screen.getByText('Queue for offline devices')).toBeInTheDocument();
      expect(screen.getByText('Skip offline devices')).toBeInTheDocument();

      const queue = screen.getByTestId('patch-offline-behavior-queue') as HTMLInputElement;
      const skip = screen.getByTestId('patch-offline-behavior-skip') as HTMLInputElement;
      expect(queue.checked).toBe(true);
      expect(skip.checked).toBe(false);
    });

    it("sends offlineBehavior 'queue' on an untouched policy", async () => {
      render(<PatchTab {...baseProps} />);
      await screen.findByTestId('patch-offline-behavior');
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(saveMock).toHaveBeenCalled());
      const [, payload] = saveMock.mock.calls[0];
      expect(payload.inlineSettings.offlineBehavior).toBe('queue');
    });

    it("persists a switch to 'skip' in the save payload", async () => {
      render(<PatchTab {...baseProps} />);
      fireEvent.click(await screen.findByTestId('patch-offline-behavior-skip'));
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(saveMock).toHaveBeenCalled());
      const [, payload] = saveMock.mock.calls[0];
      expect(payload.inlineSettings.offlineBehavior).toBe('skip');
    });

    it('hydrates from a stored offlineBehavior', async () => {
      render(
        <PatchTab
          {...baseProps}
          existingLink={{
            id: 'link-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: { offlineBehavior: 'skip' },
          }}
        />
      );
      const skip = (await screen.findByTestId(
        'patch-offline-behavior-skip'
      )) as HTMLInputElement;
      expect(skip.checked).toBe(true);
    });
  });

  describe('inline ring editor', () => {
    it('creates a ring inline, refetches, and auto-selects it', async () => {
      fetchMock.mockImplementation((_url: any, opts: any) => {
        if (opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ data: { id: 'ring-9' } }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            data: [{ id: 'ring-9', name: 'Broad', enabled: true, ringOrder: 0, deferralDays: 0, gracePeriodHours: 4 }],
          }),
        } as unknown as Response);
      });

      render(<PatchTab {...baseProps} />);
      fireEvent.click(await screen.findByRole('button', { name: /new ring/i }));
      fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Broad' } });
      fireEvent.click(screen.getByRole('button', { name: /create ring/i }));

      await waitFor(() => expect(screen.getByTestId('approval-ring-select')).toHaveValue('ring-9'));
      const postCall = fetchMock.mock.calls.find(([, o]: any) => o?.method === 'POST');
      expect(postCall?.[0]).toBe('/update-rings');
    });

    it('surfaces an error when inline ring create fails', async () => {
      fetchMock.mockImplementation((_url: any, opts: any) => {
        if (opts?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 500, json: vi.fn().mockResolvedValue({}) } as unknown as Response);
        }
        return Promise.resolve({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response);
      });

      render(<PatchTab {...baseProps} />);
      fireEvent.click(await screen.findByRole('button', { name: /new ring/i }));
      fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Broad' } });
      fireEvent.click(screen.getByRole('button', { name: /create ring/i }));

      expect(await screen.findByText('Failed to create update ring')).toBeInTheDocument();
    });

    it('does not call a just-created ring unavailable when the ring refetch fails', async () => {
      let gets = 0;
      fetchMock.mockImplementation((_url: any, opts: any) => {
        if (opts?.method === 'POST') {
          return Promise.resolve({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: { id: 'ring-9' } }) } as unknown as Response);
        }
        gets += 1;
        if (gets > 1) return Promise.resolve({ ok: false, status: 503, json: vi.fn() } as unknown as Response);
        return Promise.resolve({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response);
      });

      render(<PatchTab {...baseProps} />);
      fireEvent.click(await screen.findByRole('button', { name: /new ring/i }));
      fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Broad' } });
      fireEvent.click(screen.getByRole('button', { name: /create ring/i }));

      expect(await screen.findByText('Failed to load update rings')).toBeInTheDocument();
      expect(screen.queryByTestId('patch-ring-invalid')).toBeNull();
    });

    it("surfaces the server's reason when an inline ring save is rejected", async () => {
      fetchMock.mockImplementation((_url: any, opts: any) => {
        if (opts?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: vi.fn().mockResolvedValue({ error: 'Duplicate application rule: third_party|mozilla.firefox' }),
          } as unknown as Response);
        }
        return Promise.resolve({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response);
      });

      render(<PatchTab {...baseProps} />);
      fireEvent.click(await screen.findByRole('button', { name: /new ring/i }));
      fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Broad' } });
      fireEvent.click(screen.getByRole('button', { name: /create ring/i }));

      expect(await screen.findByText('Duplicate application rule: third_party|mozilla.firefox')).toBeInTheDocument();
    });

    it("carries the edited ring's application rules in the inline ring save", async () => {
      const ring = {
        id: 'ring-1', name: 'Pilot', enabled: true, ringOrder: 1, deferralDays: 0, gracePeriodHours: 4,
        appRules: [{ source: 'third_party', packageId: 'Mozilla.Firefox', displayName: 'Firefox', action: 'block' }],
      };
      fetchMock.mockImplementation((_url: any, opts: any) => {
        if (opts?.method === 'PATCH') {
          return Promise.resolve({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: ring }) } as unknown as Response);
        }
        return Promise.resolve({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [ring] }) } as unknown as Response);
      });

      render(
        <PatchTab
          {...baseProps}
          existingLink={{ id: 'link-1', featureType: 'patch', featurePolicyId: 'ring-1', inlineSettings: { sources: ['os'] } }}
        />
      );
      fireEvent.click(await screen.findByTestId('patch-edit-ring'));
      expect(await screen.findByText('Firefox')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /save ring|save changes/i }));

      await waitFor(() => expect(fetchMock.mock.calls.some(([, o]: any) => o?.method === 'PATCH')).toBe(true));
      const patchCall = fetchMock.mock.calls.find(([, o]: any) => o?.method === 'PATCH');
      expect(JSON.parse((patchCall![1] as any).body).appRules).toEqual([
        expect.objectContaining({ packageId: 'Mozilla.Firefox', action: 'block' }),
      ]);
    });
  });

  // #8030: custom restart-prompt text. Blank keeps the agent's built-in copy.
  describe('restart-prompt text', () => {
    it('renders empty title, body and button fields by default and saves them as null', async () => {
      render(<PatchTab {...baseProps} />);
      expect(await screen.findByTestId('patch-reboot-prompt-title')).toHaveValue('');
      expect(screen.getByTestId('patch-reboot-prompt-body')).toHaveValue('');
      expect(screen.getByTestId('patch-reboot-prompt-button')).toHaveValue('');

      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(saveMock).toHaveBeenCalled());
      const [, payload] = saveMock.mock.calls[0];
      expect(payload.inlineSettings.rebootPromptTitle).toBeNull();
      expect(payload.inlineSettings.rebootPromptBody).toBeNull();
      expect(payload.inlineSettings.rebootPromptButton).toBeNull();
    });

    it('persists custom text in the save payload', async () => {
      render(<PatchTab {...baseProps} />);
      fireEvent.change(await screen.findByTestId('patch-reboot-prompt-title'), { target: { value: 'Neustart' } });
      fireEvent.change(screen.getByTestId('patch-reboot-prompt-body'), {
        target: { value: 'Neustart in {{countdown}}.' },
      });
      fireEvent.change(screen.getByTestId('patch-reboot-prompt-button'), { target: { value: 'Jetzt' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(saveMock).toHaveBeenCalled());
      const [, payload] = saveMock.mock.calls[0];
      expect(payload.inlineSettings.rebootPromptTitle).toBe('Neustart');
      expect(payload.inlineSettings.rebootPromptBody).toBe('Neustart in {{countdown}}.');
      expect(payload.inlineSettings.rebootPromptButton).toBe('Jetzt');
    });

    it('hydrates the fields from stored values', async () => {
      render(
        <PatchTab
          {...baseProps}
          existingLink={{
            id: 'link-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: { sources: ['os'], rebootPromptTitle: 'Titel', rebootPromptBody: null },
          }}
        />
      );
      expect(await screen.findByTestId('patch-reboot-prompt-title')).toHaveValue('Titel');
      expect(screen.getByTestId('patch-reboot-prompt-body')).toHaveValue('');
    });

    it('blocks save on markup or an unknown placeholder, then proceeds once fixed', async () => {
      render(<PatchTab {...baseProps} />);
      const body = await screen.findByTestId('patch-reboot-prompt-body');
      fireEvent.change(body, { target: { value: 'Restart in {{countdwon}}' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      expect(await screen.findByTestId('patch-reboot-prompt-error')).toBeInTheDocument();
      expect(saveMock).not.toHaveBeenCalled();

      fireEvent.change(body, { target: { value: 'Restart in {{countdown}}' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(saveMock).toHaveBeenCalled());
    });

    it('shows the prompt error once, inline, when the fields are visible', async () => {
      render(<PatchTab {...baseProps} />);
      fireEvent.change(await screen.findByTestId('patch-reboot-prompt-title'), { target: { value: '<b>x</b>' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      expect(await screen.findByTestId('patch-reboot-prompt-error')).toBeInTheDocument();
      expect(screen.getAllByText(/must be plain text/i)).toHaveLength(1);
    });

    it('still blocks a save with invalid hidden text under the never policy, via the banner', async () => {
      render(
        <PatchTab
          {...baseProps}
          existingLink={{
            id: 'link-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: { sources: ['os'], rebootPolicy: 'never', rebootPromptTitle: '<b>x</b>' },
          }}
        />
      );
      await screen.findByText('Approval Ring');
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      expect(await screen.findByText(/must be plain text/i)).toBeInTheDocument();
      expect(screen.queryByTestId('patch-reboot-prompt-error')).toBeNull();
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('hides the prompt-text fields when the reboot policy is never', async () => {
      render(
        <PatchTab
          {...baseProps}
          existingLink={{
            id: 'link-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: { sources: ['os'], rebootPolicy: 'never' },
          }}
        />
      );
      await screen.findByText('Approval Ring');
      expect(screen.queryByTestId('patch-reboot-prompt-title')).toBeNull();
    });
  });
});
