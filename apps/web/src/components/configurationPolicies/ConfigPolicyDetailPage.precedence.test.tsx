import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// "Outranked on N devices" on the policy page (#12472, plan W05a O3): the page
// reads GET /:id/precedence once, shows the open feature's line and the rail
// status, and re-reads after a feature link changes.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { permissions: [{ resource: 'devices', action: 'write' }] } }),
}));
vi.mock('../../lib/authScope', () => {
  const getJwtClaims = vi.fn(() => ({ scope: 'organization' as const, orgId: 'org-1', partnerId: null }));
  return { getJwtClaims, useJwtClaims: () => ({ status: 'resolved' as const, claims: getJwtClaims() }) };
});
// The Patches stand-in can drop its link, as a real tab's Remove does.
vi.mock('./featureTabs/PatchTab', () => ({
  default: (props: { onLinkChanged: (link: null, featureType: 'patch') => void }) => (
    <div data-testid="patch-tab-editor">
      <button type="button" data-testid="patch-remove" onClick={() => props.onLinkChanged(null, 'patch')}>
        Remove
      </button>
    </div>
  ),
}));
// The panel stand-in can report a committed Apply, as the real panel does.
vi.mock('./appliesTo/AppliesToPanel', () => ({
  default: (props: { onApplied: () => void }) => (
    <button type="button" data-testid="applies-to-applied" onClick={() => props.onApplied()}>
      Applied
    </button>
  ),
}));

import ConfigPolicyDetailPage from './ConfigPolicyDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { i18n } from '../../lib/i18n';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PATCH_LINK = { id: 'link-patch', featureType: 'patch', featurePolicyId: null, inlineSettings: {} };

function mockPage(precedence: () => Response) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/configuration-policies/pol-1') {
      return json({
        id: 'pol-1',
        name: 'Test Policy',
        status: 'active',
        orgId: 'org-1',
        partnerId: null,
        featureLinks: [PATCH_LINK],
        parentPolicyId: null,
        parentPolicy: null,
        childPolicies: [],
      });
    }
    if (url === '/configuration-policies/pol-1/features') return json({ data: [PATCH_LINK] });
    if (url === '/configuration-policies/pol-1/precedence') return precedence();
    return json({ error: 'not found' }, 404);
  });
}

const precedenceCalls = () =>
  fetchMock.mock.calls.filter(([input]) => String(input) === '/configuration-policies/pol-1/precedence').length;

describe('ConfigPolicyDetailPage — outranked on N devices (#12472)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await i18n.changeLanguage('en');
    window.location.hash = '#patch';
  });
  afterEach(() => {
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('the open feature and its rail item show Outranked on N devices', async () => {
    mockPage(() => json({ capped: false, features: { patch: { reached: 40, outranked: 3 } } }));
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    expect(await screen.findByTestId('config-policy-outranked')).toHaveTextContent('Outranked on 3 devices');
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAccessibleName(
      'Patches, Set here · Outranked on 3 devices',
    );
    expect(precedenceCalls()).toBe(1);
  });

  it('capped says to open a device and shows no number', async () => {
    mockPage(() => json({ capped: true }));
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    const line = await screen.findByTestId('config-policy-outranked');
    expect(line).toHaveTextContent('Too many devices to count');
    expect(line.textContent).not.toMatch(/\d/);
  });

  it('a failed precedence read shows nothing, never 0 outranked', async () => {
    mockPage(() => json({ error: 'boom' }, 500));
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByTestId('patch-tab-editor');
    await waitFor(() => expect(precedenceCalls()).toBe(1));
    expect(screen.queryByTestId('config-policy-outranked')).not.toBeInTheDocument();
    expect(screen.queryByText(/Outranked on/)).not.toBeInTheDocument();
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAccessibleName('Patches, Set here');
  });

  it('a feature link change re-reads the count', async () => {
    let second: (r: Response) => void = () => {};
    let calls = 0;
    mockPage(() => {
      calls += 1;
      if (calls === 1) return json({ capped: false, features: { patch: { reached: 40, outranked: 3 } } });
      return new Promise<Response>((resolve) => {
        second = resolve;
      }) as unknown as Response;
    });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByTestId('config-policy-outranked');

    // The removal itself hides the line (the feature is no longer set here);
    // what this pins is the re-read. Dropping the count at once is pinned by
    // the Apply case below and by usePolicyPrecedence.test.ts.
    fireEvent.click(screen.getByTestId('patch-remove'));
    await waitFor(() => expect(precedenceCalls()).toBe(2));
    expect(screen.queryByTestId('config-policy-outranked')).not.toBeInTheDocument();
    await act(async () => second(json({ capped: false, features: {} })));
    expect(screen.queryByTestId('config-policy-outranked')).not.toBeInTheDocument();
  });

  it('an Apply drops the old count at once and re-reads it', async () => {
    window.location.hash = '#assignments';
    let second: (r: Response) => void = () => {};
    let calls = 0;
    mockPage(() => {
      calls += 1;
      if (calls === 1) return json({ capped: false, features: { patch: { reached: 40, outranked: 3 } } });
      return new Promise<Response>((resolve) => {
        second = resolve;
      }) as unknown as Response;
    });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    expect(await screen.findByTestId('config-policy-outranked')).toHaveTextContent('Outranked on 3 devices');

    fireEvent.click(screen.getByTestId('applies-to-applied'));
    // The pre-Apply count describes the old targets: gone before the new read answers.
    expect(screen.queryByTestId('config-policy-outranked')).not.toBeInTheDocument();
    await waitFor(() => expect(precedenceCalls()).toBe(2));

    await act(async () => second(json({ capped: false, features: { patch: { reached: 41, outranked: 5 } } })));
    expect(await screen.findByTestId('config-policy-outranked')).toHaveTextContent('Outranked on 5 devices');
  });
});
