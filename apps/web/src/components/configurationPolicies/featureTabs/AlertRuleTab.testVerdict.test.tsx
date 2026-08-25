import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertRuleTab from './AlertRuleTab';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';

// Ported from AlertRulesPage.testVerdict.test.tsx (#3752/#3923), which asserted
// this behaviour against a component no route could reach: /alerts/rules/* has
// been a 301 to /configuration-policies since d8a6bc833 (2026-02-22), so those
// tests passed while zero users could run an alert-rule test (#3988). The Test action now
// lives on the live editor — the Configuration Policy Alerts tab — and the same
// contract is pinned here, on the call site a user can actually reach.
//
// The contract is "the outcome the server computed is the outcome shown", not
// "a particular <div> exists", so these assert VISIBLE verdict text and a
// redesign can satisfy them without a rewrite.
//
// Two cases from the original do not carry over:
//  - "says a disabled rule will not fire": config-policy alert rules have no
//    per-rule enabled flag (config_policy_alert_rules has no such column). The
//    equivalent non-condition cause of a negative — the policy not governing the
//    device — is covered by the targeting cases below.
//  - the standalone rule-id in the request path: these rules have no id, which
//    is the whole reason a new endpoint exists. The path/body assertion below
//    pins the policy-scoped endpoint and the DRAFT conditions instead.

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: vi.fn(),
    remove: vi.fn(),
    saving: false,
    error: undefined,
    clearError: vi.fn(),
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigateTo);

const POLICY_ID = 'policy-1';
const DEVICE = { id: 'dev-1', hostname: 'ws-01' };
const CPU_CONDITION = { type: 'metric', metric: 'cpu', operator: 'gt', value: 80 };

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => payload } as unknown as Response;
}

/** Captured path + body of every POST to the policy rule-test endpoint. */
let testRequests: Array<{ path: string; body: string }> = [];

function mockApi(testResponse: Response, devicesResponse?: Response) {
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.includes('/alert-rules/test')) {
      testRequests.push({ path, body: String(init?.body ?? '') });
      return testResponse;
    }
    if (path.startsWith('/devices')) return devicesResponse ?? jsonResponse({ devices: [DEVICE] });
    throw new Error(`Unexpected request: ${path}`);
  });
}

function renderTab(conditions: unknown[] = [CPU_CONDITION]) {
  return render(
    <AlertRuleTab
      policyId={POLICY_ID}
      existingLink={{
        id: 'link-1',
        featureType: 'alert_rule',
        featurePolicyId: null,
        inlineSettings: {
          items: [
            {
              name: 'High CPU',
              severity: 'high',
              conditions,
              cooldownMinutes: 15,
              autoResolve: false,
            },
          ],
        },
      }}
      linkedPolicyId={null}
      onLinkChanged={vi.fn()}
    />
  );
}

/** Two rules, so index-shift behaviour on delete can be exercised. */
function renderTwoRules() {
  return render(
    <AlertRuleTab
      policyId={POLICY_ID}
      existingLink={{
        id: 'link-1',
        featureType: 'alert_rule',
        featurePolicyId: null,
        inlineSettings: {
          items: [
            {
              name: 'High CPU',
              severity: 'high',
              conditions: [CPU_CONDITION],
              cooldownMinutes: 15,
              autoResolve: false,
            },
            {
              name: 'Low disk',
              severity: 'medium',
              conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 90 }],
              cooldownMinutes: 15,
              autoResolve: false,
            },
          ],
        },
      }}
      linkedPolicyId={null}
      onLinkChanged={vi.fn()}
    />
  );
}

/** Expand the first rule card and open its Test modal. */
function openTestModal() {
  fireEvent.click(screen.getByTestId('alert-rule-card-header-0'));
  fireEvent.click(screen.getByTestId('alert-rule-test-0'));
}

/** Open the modal, pick the device, and run the test. */
async function runTest() {
  renderTab();
  openTestModal();

  const select = await screen.findByLabelText('Test against device');
  await waitFor(() => expect(screen.getByRole('option', { name: 'ws-01' })).toBeTruthy());
  fireEvent.change(select, { target: { value: DEVICE.id } });
  expect((select as HTMLSelectElement).value).toBe(DEVICE.id);

  fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
}

function verdictBody(overrides: Record<string, unknown> = {}) {
  return {
    policy: { id: POLICY_ID, name: 'Fleet baseline' },
    device: { id: DEVICE.id, hostname: DEVICE.hostname, osType: 'windows' },
    targetMatch: true,
    targetReason: 'This configuration policy provides the alert rules for this device',
    conditionResults: [
      { condition: 'cpu_usage > 80 for 5min', result: false, reason: 'cpu_usage > 80 for 5min' },
    ],
    wouldTrigger: false,
    testedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  testRequests = [];
});

describe('AlertRuleTab — alert rule test verdict', () => {
  // The defect itself. Under the pre-#3923 handler this response produced
  // "Test Passed", because `success` is absent and `?? true` supplied one.
  it('states that a rule which would not fire did not fire', async () => {
    mockApi(jsonResponse(verdictBody()));

    await runTest();

    expect(await screen.findByText('Rule would not fire')).toBeTruthy();
    expect(screen.queryByText('Rule would fire')).toBeNull();
    // No fabricated pass, in any of its old spellings.
    expect(screen.queryByText('Test Passed')).toBeNull();
    expect(screen.queryByText('Test completed successfully')).toBeNull();
    // The unmet condition is what makes the negative actionable.
    expect(screen.getByText('Not met: cpu_usage > 80 for 5min')).toBeTruthy();
  });

  it('states that a rule which would fire would fire', async () => {
    mockApi(
      jsonResponse(
        verdictBody({
          wouldTrigger: true,
          conditionResults: [
            { condition: 'cpu_usage > 80 for 5min', result: true, reason: 'cpu_usage > 80 for 5min' },
          ],
        })
      )
    );

    await runTest();

    expect(await screen.findByText('Rule would fire')).toBeTruthy();
    expect(screen.queryByText('Rule would not fire')).toBeNull();
    expect(screen.getByText('Met: cpu_usage > 80 for 5min')).toBeTruthy();
    // A positive must not be read as "an alert will appear" — cooldown, an open
    // alert and flapping suppression are not simulated by the endpoint.
    expect(
      screen.getByText(/may still stop an alert being created when the rule runs/)
    ).toBeTruthy();
  });

  it('explains a negative caused by targeting rather than by conditions', async () => {
    mockApi(
      jsonResponse(
        verdictBody({
          targetMatch: false,
          targetReason: 'This configuration policy is not assigned to this device',
          conditionResults: [
            { condition: 'cpu_usage > 80 for 5min', result: true, reason: 'cpu_usage > 80 for 5min' },
          ],
        })
      )
    );

    await runTest();

    expect(await screen.findByText('Rule would not fire')).toBeTruthy();
    // The condition IS met — the remedy is an assignment, not a threshold.
    expect(screen.getByText('Met: cpu_usage > 80 for 5min')).toBeTruthy();
    expect(
      screen.getByText('This configuration policy is not assigned to this device')
    ).toBeTruthy();
  });

  // A body with no verdict in it is a failure to report, not a pass to assume.
  it('reports a failure when the response carries no verdict', async () => {
    mockApi(jsonResponse({ testedAt: '2026-08-25T00:00:00.000Z' }));

    await runTest();

    expect(await screen.findByText('Test Failed')).toBeTruthy();
    expect(screen.queryByText('Rule would fire')).toBeNull();
    expect(screen.queryByText('Test Passed')).toBeNull();
  });

  it('reports a failure when the request fails', async () => {
    mockApi(jsonResponse({ error: 'Device not found' }, false, 404));

    await runTest();

    expect(await screen.findByText('Test Failed')).toBeTruthy();
    expect(screen.getByText('Device not found')).toBeTruthy();
    expect(screen.queryByText('Rule would fire')).toBeNull();
  });

  // The endpoint validates `{ deviceId, conditions }` as a required body, and
  // the conditions it must carry are the ones ON SCREEN — a policy alert rule
  // has no id to address, so the draft IS the request.
  it('posts the policy-scoped endpoint with the selected device and the rule conditions', async () => {
    mockApi(jsonResponse(verdictBody()));

    await runTest();

    await waitFor(() => expect(testRequests).toHaveLength(1));
    expect(testRequests[0].path).toBe(`/configuration-policies/${POLICY_ID}/alert-rules/test`);
    expect(JSON.parse(testRequests[0].body)).toEqual({
      deviceId: DEVICE.id,
      conditions: [CPU_CONDITION],
    });
  });

  // The reason this endpoint takes conditions instead of a row id: an edit that
  // has not been saved is exactly what a tech tuning a threshold wants tested.
  it('tests the unsaved draft, not the persisted rule', async () => {
    mockApi(jsonResponse(verdictBody()));
    renderTab();

    fireEvent.click(screen.getByTestId('alert-rule-card-header-0'));
    const valueInput = screen
      .getAllByText('Value (%)')[0]!
      .parentElement!.querySelector('input') as HTMLInputElement;
    expect(valueInput.value).toBe('80');
    fireEvent.change(valueInput, { target: { value: '55' } });

    fireEvent.click(screen.getByTestId('alert-rule-test-0'));
    const select = await screen.findByLabelText('Test against device');
    await waitFor(() => expect(screen.getByRole('option', { name: 'ws-01' })).toBeTruthy());
    fireEvent.change(select, { target: { value: DEVICE.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));

    await waitFor(() => expect(testRequests).toHaveLength(1));
    expect(JSON.parse(testRequests[0].body).conditions).toEqual([
      { ...CPU_CONDITION, value: 55 },
    ]);
  });

  // Changing the device must not leave the previous device's verdict on screen
  // — a verdict attributed to the wrong device is the same lie in a new costume.
  it('clears a verdict when a different device is selected', async () => {
    mockApi(
      jsonResponse(verdictBody({ wouldTrigger: true, conditionResults: [] })),
      jsonResponse({ devices: [DEVICE, { id: 'dev-2', hostname: 'ws-02' }] })
    );

    renderTab();
    openTestModal();

    const select = await screen.findByLabelText('Test against device');
    await waitFor(() => expect(screen.getByRole('option', { name: 'ws-02' })).toBeTruthy());
    fireEvent.change(select, { target: { value: DEVICE.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));

    expect(await screen.findByText('Rule would fire')).toBeTruthy();
    // The verdict names the device it was computed for.
    expect(screen.getByText('Evaluated against ws-01')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'dev-2' } });

    expect(screen.queryByText('Rule would fire')).toBeNull();
    expect(screen.queryByText('Evaluated against ws-01')).toBeNull();
  });

  it('surfaces a failure to load the device list', async () => {
    mockApi(jsonResponse({}), jsonResponse({ error: 'Devices unavailable' }, false, 500));

    renderTab();
    openTestModal();

    expect(await screen.findByText('Devices unavailable')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run Test' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('says so when there are no devices to test against', async () => {
    mockApi(jsonResponse({}), jsonResponse({ devices: [] }));

    renderTab();
    openTestModal();

    expect(
      await screen.findByText('No devices are available to test this rule against.')
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run Test' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('redirects to login when the device list returns 401', async () => {
    mockApi(jsonResponse({}), jsonResponse({ error: 'Unauthorized' }, false, 401));

    renderTab();
    openTestModal();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true }));
    expect(screen.queryByText('Unauthorized')).toBeNull();
  });

  it('redirects to login when the test request returns 401', async () => {
    mockApi(jsonResponse({ error: 'Unauthorized' }, false, 401));

    await runTest();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true }));
    expect(screen.queryByText('Test Failed')).toBeNull();
    expect(screen.queryByText('Rule would fire')).toBeNull();
  });

  it('does not render a negative verdict identically to a positive one', async () => {
    const body = (wouldTrigger: boolean) =>
      verdictBody({
        wouldTrigger,
        conditionResults: [
          {
            condition: 'cpu_usage > 80 for 5min',
            result: wouldTrigger,
            reason: 'cpu_usage > 80 for 5min',
          },
        ],
      });

    mockApi(jsonResponse(body(true)));
    const { container: passing, unmount } = renderTab();
    openTestModal();
    fireEvent.change(await screen.findByLabelText('Test against device'), {
      target: { value: DEVICE.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await screen.findByText('Rule would fire');
    const passingText = passing.textContent ?? '';
    unmount();

    mockApi(jsonResponse(body(false)));
    const { container: failing } = renderTab();
    openTestModal();
    fireEvent.change(await screen.findByLabelText('Test against device'), {
      target: { value: DEVICE.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await screen.findByText('Rule would not fire');

    expect(failing.textContent).not.toEqual(passingText);
  });

  // Deleting a rule shifts every later rule's index. An open Test modal is
  // addressed BY index, so without the shift handling in deleteItem it would
  // silently re-point at whichever rule slid into the slot — a verdict
  // attributed to the wrong rule, the same class of lie as one attributed to
  // the wrong device.
  it('keeps an open Test modal on the same rule when an earlier rule is deleted', async () => {
    mockApi(jsonResponse(verdictBody()));
    renderTwoRules();

    fireEvent.click(screen.getByTestId('alert-rule-card-header-1'));
    fireEvent.click(screen.getByTestId('alert-rule-test-1'));
    expect(await screen.findByTestId('alert-rule-test-rule-name')).toHaveTextContent('Low disk');

    // Delete the FIRST rule; the tested rule slides from index 1 to index 0.
    fireEvent.click(within(screen.getByTestId('alert-rule-card-header-0')).getByRole('button'));

    expect(screen.getByTestId('alert-rule-test-rule-name')).toHaveTextContent('Low disk');
    expect(screen.getByTestId('alert-rule-test-device')).toBeTruthy();
  });

  it('closes an open Test modal when the rule being tested is deleted', async () => {
    mockApi(jsonResponse(verdictBody()));
    renderTwoRules();

    fireEvent.click(screen.getByTestId('alert-rule-card-header-0'));
    fireEvent.click(screen.getByTestId('alert-rule-test-0'));
    expect(await screen.findByTestId('alert-rule-test-rule-name')).toHaveTextContent('High CPU');

    fireEvent.click(within(screen.getByTestId('alert-rule-card-header-0')).getByRole('button'));

    expect(screen.queryByTestId('alert-rule-test-rule-name')).toBeNull();
    expect(screen.queryByTestId('alert-rule-test-device')).toBeNull();
  });

  // A rule carrying a condition the write schema rejects cannot be tested
  // either — the server would refuse the body for the same reason it refuses
  // the save, so offer the amber banner's remedy instead of a Zod error.
  it('disables Test for a rule holding a retired condition', () => {
    mockApi(jsonResponse(verdictBody()));
    renderTab([{ type: 'patch_compliance', value: 1 }]);

    fireEvent.click(screen.getByTestId('alert-rule-card-header-0'));

    expect(screen.getByTestId('alert-rule-legacy-warning-0')).toBeTruthy();
    expect((screen.getByTestId('alert-rule-test-0') as HTMLButtonElement).disabled).toBe(true);
  });
});
