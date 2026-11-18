import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';
import SecurityTab from './SecurityTab';
import type { FeatureLink, FeatureTabProps } from './types';

// The rule-set picker (#6267) lists sets through fetchWithAuth.
const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SET_A1 = '6f1d2c3b-0000-4000-8000-0000000000a1';
const SET_B1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';

function ruleSet(id: string, over: Record<string, unknown> = {}) {
  return {
    id, orgId: ORG_A, partnerId: null, name: id.slice(0, 8), description: null, source: 'custom',
    isBuiltin: false, enabled: true, autoQuarantine: false, currentVersion: 1, publishedVersion: 1,
    publishedSha256: null, publishedAt: null, publishedEngine: null, stale: false, ruleCount: 1,
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', ...over,
  };
}
const BUILTIN_ROW = ruleSet(YARA_BUILTIN_RULE_SET_ID, { orgId: null, isBuiltin: true, source: 'builtin' });
const DEFAULT_LIST = [BUILTIN_ROW, ruleSet(SET_A1), ruleSet(SET_B1, { orgId: ORG_B })];

const listResponse = (status: number, data: unknown) =>
  ({ ok: status === 200, status, statusText: String(status), json: async () => (status === 200 ? { data } : { error: 'x' }) }) as unknown as Response;

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network.
const saveMock = vi.fn(
  async (
    _existingId: string | null,
    _payload: { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
  ) => ({ id: 'link-1' }),
);
const removeMock = vi.fn(async () => true);
const linkState: { error: string | null; errorDetail: unknown } = { error: null, errorDetail: undefined };

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: linkState.error,
    errorDetail: linkState.errorDetail,
    clearError: vi.fn(),
  }),
}));

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue(listResponse(200, DEFAULT_LIST));
  linkState.error = null;
  linkState.errorDetail = undefined;
});

const onLinkChanged = vi.fn();

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged,
};

function parentLinkWith(overrides: Partial<FeatureLink['inlineSettings']>): FeatureLink {
  return {
    id: 'link-parent',
    featureType: 'security',
    featurePolicyId: null,
    inlineSettings: { autoQuarantine: false, ...overrides },
  };
}

describe('SecurityTab inheritance (#5080)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  it('shows Configured (inherited) and seeds the form from parentLink when only a parent link exists', () => {
    render(<SecurityTab {...baseProps} parentLink={parentLinkWith({ autoQuarantine: false })} />);

    expect(screen.getByText(/Configured \(inherited\)/i)).toBeTruthy();
    // autoQuarantine defaults to true; the parent link's distinctive override
    // (false) must be reflected, read-only, in the form.
    const toggle = screen.getByText('Auto-quarantine').closest('div')?.parentElement
      ?.querySelector('button');
    expect(toggle?.className).not.toContain('bg-emerald-500/80');
  });

  it('Override saves a copy of the inherited settings as the policy\'s own link', () => {
    render(<SecurityTab {...baseProps} parentLink={parentLinkWith({ autoQuarantine: false })} />);

    fireEvent.click(screen.getByRole('button', { name: /override/i }));

    expect(saveMock).toHaveBeenCalled();
    const [existingId, payload] = saveMock.mock.calls[0] as unknown as [
      string | null,
      { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
    ];
    expect(existingId).toBeNull();
    expect(payload.featureType).toBe('security');
    expect(payload.featurePolicyId).toBeNull();
    expect(payload.inlineSettings).toMatchObject({ autoQuarantine: false });
  });

  it('Revert to Parent removes the override', async () => {
    const existingLink: FeatureLink = {
      id: 'link-own',
      featureType: 'security',
      featurePolicyId: null,
      inlineSettings: { autoQuarantine: true },
    };
    render(
      <SecurityTab
        {...baseProps}
        existingLink={existingLink}
        parentLink={parentLinkWith({ autoQuarantine: false })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /revert to parent/i }));
    // #5314: Revert to Parent now asks for confirmation first.
    fireEvent.click(screen.getByTestId('feature-tab-revert-confirm'));

    expect(removeMock).toHaveBeenCalledWith('link-own');
    // The detail page's own featureLinks state must be told the override is
    // gone (#5080) — otherwise it stays stale after a successful revert.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalledWith(null, 'security'));
  });

  it('sends featurePolicyId: null on a plain (non-inherited) save', () => {
    render(<SecurityTab {...baseProps} linkedPolicyId="parent-1" />);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(saveMock).toHaveBeenCalled();
    const [, payload] = saveMock.mock.calls[0] as unknown as [string | null, { featurePolicyId: string | null }];
    expect(payload.featurePolicyId).toBeNull();
  });
});

describe('SecurityTab scan settings (#6263 W01)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  it('saves only the SecurityScanSettings keys', async () => {
    render(<SecurityTab {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const inlineSettings = saveMock.mock.calls.at(-1)![1].inlineSettings;
    expect(Object.keys(inlineSettings).sort()).toEqual([
      'autoQuarantine', 'exclusions', 'maxFileSizeMb', 'ruleSetIds', 'scanDayOfMonth', 'scanDayOfWeek',
      'scanHour', 'scanMinute', 'scanTimeoutMinutes', 'scanType', 'scheduledScans',
    ]);
  });

  // #6263 W03: saving any other field must carry the policy's attached rule
  // sets through unchanged (both ids are attachable here, so nothing blocks).
  it('round-trips attached YARA rule sets on save', async () => {
    const ids = ['00000000-0000-4000-8000-00000000b001', '6f1d2c3b-0000-4000-8000-0000000000a1'];
    render(<SecurityTab {...baseProps} existingLink={{
      id: 'link-1', featureType: 'security', featurePolicyId: null,
      inlineSettings: { autoQuarantine: false, ruleSetIds: ids },
    } as never} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls.at(-1)![1].inlineSettings.ruleSetIds).toEqual(ids);
  });

  it('renders no control for the five removed toggles', () => {
    render(<SecurityTab {...baseProps} />);
    // Asserted on the visible labels, not on testids: the ToggleRows being
    // deleted carry no data-testid today, so a testid assertion would pass
    // vacuously both before and after the change.
    for (const label of [
      'Real-time protection', 'Behavioral monitoring', 'Cloud lookup',
      'Block untrusted USB devices', 'Notify user',
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('drops values an older policy saved for the removed toggles', async () => {
    render(<SecurityTab {...baseProps} existingLink={{
      id: 'link-1', featureType: 'security', featurePolicyId: null,
      inlineSettings: { realTimeProtection: true, blockUntrustedUsb: true, autoQuarantine: false },
    } as never} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const inlineSettings = saveMock.mock.calls.at(-1)![1].inlineSettings;
    expect(inlineSettings).not.toHaveProperty('realTimeProtection');
    expect(inlineSettings).not.toHaveProperty('blockUntrustedUsb');
    expect(inlineSettings.autoQuarantine).toBe(false); // a kept value survives
  });

  it('offers scan type, size cap and timeout', () => {
    render(<SecurityTab {...baseProps} />);
    expect(screen.getByTestId('security-scan-type')).toBeTruthy();
    expect(screen.getByTestId('security-max-file-size-mb')).toBeTruthy();
    expect(screen.getByTestId('security-scan-timeout-minutes')).toBeTruthy();
  });
});

// Auto-quarantine dispatches only under a stored approval (devices:execute +
// MFA). A link without one runs scans detect-only until it is saved again.
describe('SecurityTab auto-quarantine approval', () => {
  const ownLink = (approval?: 'approved' | 'legacy_grandfathered' | 'reapproval_required' | 'not_enabled'): FeatureLink => ({
    id: 'link-own',
    featureType: 'security',
    featurePolicyId: null,
    inlineSettings: { autoQuarantine: true },
    ...(approval ? { autoQuarantineApproval: approval } : {}),
  });

  it('warns that scans run detect-only when auto-quarantine needs re-approval', () => {
    render(<SecurityTab {...baseProps} existingLink={ownLink('reapproval_required')} />);
    expect(screen.getByTestId('security-auto-quarantine-reapproval')).toBeTruthy();
  });

  it('shows no warning for an approved link', () => {
    render(<SecurityTab {...baseProps} existingLink={ownLink('approved')} />);
    expect(screen.queryByTestId('security-auto-quarantine-reapproval')).toBeNull();
  });

  it('says the approver lost execute access when that is why quarantine stopped', () => {
    render(
      <SecurityTab
        {...baseProps}
        existingLink={{ ...ownLink('reapproval_required'), autoQuarantineApprovalReason: 'approver_invalid' }}
      />,
    );
    expect(screen.getByTestId('security-auto-quarantine-reapproval').textContent).toMatch(/no longer has/i);
  });

  it('shows no warning for a grandfathered legacy link', () => {
    render(<SecurityTab {...baseProps} existingLink={ownLink('legacy_grandfathered')} />);
    expect(screen.queryByTestId('security-auto-quarantine-reapproval')).toBeNull();
  });
});

// #6267 W04-4: the rule-set picker on the Security tab.
describe('SecurityTab rule-set picker (#6267 W04-4)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  const savedRuleSetIds = () => saveMock.mock.calls.at(-1)![1].inlineSettings.ruleSetIds;
  const saveButton = () => screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
  const ownLink = (ruleSetIds: string[]): FeatureLink => ({
    id: 'link-own', featureType: 'security', featurePolicyId: null,
    inlineSettings: { autoQuarantine: false, ruleSetIds },
  });

  it('preselects the built-in pack when the security link is being created', async () => {
    render(<SecurityTab {...baseProps} orgId={ORG_A} />);
    await settle();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedRuleSetIds()).toEqual([YARA_BUILTIN_RULE_SET_ID]);
  });

  it('does not preselect when the list has no built-in row', async () => {
    fetchWithAuth.mockResolvedValue(listResponse(200, [ruleSet(SET_A1)]));
    render(<SecurityTab {...baseProps} orgId={ORG_A} />);
    await settle();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedRuleSetIds()).toEqual([]);
  });

  it('does not preselect into an existing link that has no rule sets', async () => {
    render(<SecurityTab {...baseProps} orgId={ORG_A} existingLink={ownLink([])} />);
    await settle();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedRuleSetIds()).toEqual([]);
  });

  it('keeps an inherited parent value (no preselect) and Override saves it at once when nothing blocks', async () => {
    render(<SecurityTab {...baseProps} orgId={ORG_A} parentLink={parentLinkWith({ ruleSetIds: [SET_A1] })} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /override/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][0]).toBeNull();
    expect(savedRuleSetIds()).toEqual([SET_A1]);
  });

  it('filters by the POLICY owner: an org-A policy never offers org B sets', async () => {
    render(<SecurityTab {...baseProps} orgId={ORG_A} existingLink={ownLink([])} />);
    await settle();
    expect(screen.getByTestId(`rule-set-option-${SET_A1}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`rule-set-option-${SET_B1}`)).toBeNull();
  });

  it('an unavailable saved id blocks Save with the reason until it is removed', async () => {
    render(<SecurityTab {...baseProps} orgId={ORG_A} existingLink={ownLink([SET_A1, SET_B1])} />);
    await settle();

    expect(screen.getByTestId(`rule-set-unavailable-${SET_B1}`)).toBeInTheDocument();
    expect(screen.getByTestId('rule-set-picker-blocking')).toBeInTheDocument();
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(screen.getByTestId(`rule-set-unavailable-remove-${SET_B1}`));
    await settle();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedRuleSetIds()).toEqual([SET_A1]);
  });

  it('override draft: an inherited unavailable id makes Override open an editable draft instead of saving', async () => {
    render(<SecurityTab {...baseProps} orgId={ORG_A} parentLink={parentLinkWith({ ruleSetIds: [SET_A1, SET_B1] })} />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /override/i }));
    await settle();
    expect(saveMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('security-override-draft-banner')).toBeInTheDocument();
    expect(screen.getByTestId(`rule-set-unavailable-${SET_B1}`)).toBeInTheDocument();
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(screen.getByTestId(`rule-set-unavailable-remove-${SET_B1}`));
    await settle();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][0]).toBeNull();
    expect(savedRuleSetIds()).toEqual([SET_A1]);
  });

  it('after the draft is saved and later reverted, the tab is inherited (read-only) again', async () => {
    const parentLink = parentLinkWith({ ruleSetIds: [SET_A1, SET_B1] });
    const { rerender } = render(<SecurityTab {...baseProps} orgId={ORG_A} parentLink={parentLink} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /override/i }));
    await settle();
    expect(screen.getByTestId('security-override-draft-banner')).toBeInTheDocument();

    // The draft was saved: the policy now has its own link.
    rerender(<SecurityTab {...baseProps} orgId={ORG_A} parentLink={parentLink} existingLink={ownLink([SET_A1])} />);
    await settle();
    // Revert to parent removed it again.
    rerender(<SecurityTab {...baseProps} orgId={ORG_A} parentLink={parentLink} />);
    await settle();

    expect(screen.queryByTestId('security-override-draft-banner')).toBeNull();
    expect(screen.getByRole('button', { name: /override/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
  });

  it('a failed list fetch is not deletion: the ids are kept and the rest of the tab still saves', async () => {
    fetchWithAuth.mockResolvedValue(listResponse(500, null));
    render(<SecurityTab {...baseProps} orgId={ORG_A} existingLink={ownLink([SET_A1, SET_B1])} />);
    await settle();

    expect(screen.getByTestId('rule-set-picker-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId(`rule-set-unavailable-${SET_B1}`)).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedRuleSetIds()).toEqual([SET_A1, SET_B1]);
  });

  it('a gate 400 YARA_RULE_SET_NOT_ATTACHABLE highlights the named rows', async () => {
    linkState.error = 'This policy cannot use some of the selected rule sets.';
    linkState.errorDetail = { status: 400, code: 'YARA_RULE_SET_NOT_ATTACHABLE', body: { ruleSetIds: [SET_A1] } };
    render(<SecurityTab {...baseProps} orgId={ORG_A} existingLink={ownLink([SET_A1])} />);
    await settle();

    expect(screen.getByTestId(`rule-set-option-row-${SET_A1}`).getAttribute('data-highlighted')).toBe('true');
    expect(screen.getByTestId(`rule-set-option-row-${YARA_BUILTIN_RULE_SET_ID}`).getAttribute('data-highlighted')).toBe('false');
  });
});
