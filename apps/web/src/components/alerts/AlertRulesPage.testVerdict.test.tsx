import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AlertRulesPage from './AlertRulesPage';
import { fetchWithAuth } from '../../stores/auth';

// #3752: the test modal read `data.success` and `data.message` — two fields the
// API has never sent. `data.success ?? true` therefore fired on every 200 and
// the modal rendered a green "Test Passed" whatever the evaluation actually
// concluded. The fields carrying the real verdict (`wouldTrigger`,
// `conditionResults`) were read nowhere in the file.
//
// These assert the VISIBLE verdict rather than any particular markup, so a
// redesign can satisfy them without a rewrite — the contract is "the outcome
// the server computed is the outcome shown", not "a particular <div> exists".

vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: vi.fn(),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
  } as unknown as Response;
}

const RULE = {
  id: 'rule-1',
  name: 'High CPU',
  enabled: true,
  targets: { type: 'all' as const, ids: [] },
};

const DEVICE = { id: 'dev-1', hostname: 'ws-01' };

/** Captured bodies of every POST to the rule-test endpoint. */
let testRequestBodies: string[] = [];

function mockApi(testResponse: Response) {
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/alerts/rules/') && path.endsWith('/test')) {
      testRequestBodies.push(String(init?.body ?? ''));
      return testResponse;
    }
    if (path.startsWith('/alerts/rules')) return jsonResponse({ rules: [RULE] });
    if (path.startsWith('/devices')) return jsonResponse({ devices: [DEVICE] });
    throw new Error(`Unexpected request: ${path}`);
  });
}

/** Open the test modal, pick the device, and run the test. */
async function runTest() {
  render(<AlertRulesPage />);

  // ResponsiveTable renders both a table row and a mobile card, so the row
  // actions appear twice in jsdom; either copy opens the same modal.
  const testButtons = await screen.findAllByTitle('Test rule');
  fireEvent.click(testButtons[0]);

  const select = await screen.findByLabelText('Test against device');
  await waitFor(() => expect(screen.getByRole('option', { name: 'ws-01' })).toBeTruthy());
  fireEvent.change(select, { target: { value: DEVICE.id } });
  expect((select as HTMLSelectElement).value).toBe(DEVICE.id);

  fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
}

beforeEach(() => {
  testRequestBodies = [];
});

describe('AlertRulesPage — alert rule test verdict', () => {
  // The defect itself. Under the old handler this response produced
  // "Test Passed", because `success` is absent and `?? true` supplied one.
  it('states that a rule which would not fire did not fire', async () => {
    mockApi(
      jsonResponse({
        rule: { id: RULE.id, name: RULE.name, severity: 'high', enabled: true },
        device: { id: DEVICE.id, hostname: DEVICE.hostname, osType: 'windows' },
        targetMatch: true,
        targetReason: 'Rule applies to all devices',
        conditionResults: [
          {
            condition: 'cpu_usage > 80 for 5min',
            result: false,
            reason: 'cpu_usage > 80 for 5min',
          },
        ],
        wouldTrigger: false,
        testedAt: '2026-08-23T00:00:00.000Z',
      })
    );

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
      jsonResponse({
        rule: { id: RULE.id, name: RULE.name, severity: 'high', enabled: true },
        device: { id: DEVICE.id, hostname: DEVICE.hostname, osType: 'windows' },
        targetMatch: true,
        targetReason: 'Rule applies to all devices',
        conditionResults: [
          {
            condition: 'cpu_usage > 80 for 5min',
            result: true,
            reason: 'cpu_usage > 80 for 5min',
          },
        ],
        wouldTrigger: true,
        testedAt: '2026-08-23T00:00:00.000Z',
      })
    );

    await runTest();

    expect(await screen.findByText('Rule would fire')).toBeTruthy();
    expect(screen.queryByText('Rule would not fire')).toBeNull();
    expect(screen.getByText('Met: cpu_usage > 80 for 5min')).toBeTruthy();
  });

  it('explains a negative caused by targeting rather than by conditions', async () => {
    mockApi(
      jsonResponse({
        rule: { id: RULE.id, name: RULE.name, severity: 'high', enabled: true },
        device: { id: DEVICE.id, hostname: DEVICE.hostname, osType: 'windows' },
        targetMatch: false,
        targetReason: 'Device is not a member of the targeted device group',
        conditionResults: [
          {
            condition: 'cpu_usage > 80 for 5min',
            result: true,
            reason: 'cpu_usage > 80 for 5min',
          },
        ],
        wouldTrigger: false,
        testedAt: '2026-08-23T00:00:00.000Z',
      })
    );

    await runTest();

    expect(await screen.findByText('Rule would not fire')).toBeTruthy();
    expect(
      screen.getByText('Device is not a member of the targeted device group')
    ).toBeTruthy();
  });

  it('says a disabled rule will not fire', async () => {
    mockApi(
      jsonResponse({
        rule: { id: RULE.id, name: RULE.name, severity: 'high', enabled: false },
        device: { id: DEVICE.id, hostname: DEVICE.hostname, osType: 'windows' },
        targetMatch: true,
        targetReason: 'Rule applies to all devices',
        conditionResults: [],
        wouldTrigger: false,
        testedAt: '2026-08-23T00:00:00.000Z',
      })
    );

    await runTest();

    expect(await screen.findByText('Rule would not fire')).toBeTruthy();
    expect(
      screen.getByText('This rule is disabled, so it will not fire until you enable it.')
    ).toBeTruthy();
  });

  // A body with no verdict in it is a failure to report, not a pass to assume.
  it('reports a failure when the response carries no verdict', async () => {
    mockApi(jsonResponse({ testedAt: '2026-08-23T00:00:00.000Z' }));

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

  // The endpoint validates `{ deviceId }` as a required body. The old handler
  // sent no body at all, so every test 400'd before reaching any evaluation.
  it('sends the selected deviceId with the test request', async () => {
    mockApi(
      jsonResponse({
        rule: { id: RULE.id, name: RULE.name, severity: 'high', enabled: true },
        device: { id: DEVICE.id, hostname: DEVICE.hostname, osType: 'windows' },
        targetMatch: true,
        conditionResults: [],
        wouldTrigger: true,
        testedAt: '2026-08-23T00:00:00.000Z',
      })
    );

    await runTest();

    await waitFor(() => expect(testRequestBodies).toHaveLength(1));
    expect(JSON.parse(testRequestBodies[0])).toEqual({ deviceId: DEVICE.id });
  });

  it('does not render a negative verdict identically to a positive one', async () => {
    const body = (wouldTrigger: boolean) => ({
      rule: { id: RULE.id, name: RULE.name, severity: 'high', enabled: true },
      device: { id: DEVICE.id, hostname: DEVICE.hostname, osType: 'windows' },
      targetMatch: true,
      targetReason: 'Rule applies to all devices',
      conditionResults: [
        { condition: 'cpu_usage > 80 for 5min', result: wouldTrigger, reason: 'cpu_usage > 80 for 5min' },
      ],
      wouldTrigger,
      testedAt: '2026-08-23T00:00:00.000Z',
    });

    mockApi(jsonResponse(body(true)));
    const { container: passing, unmount } = render(<AlertRulesPage />);
    fireEvent.click((await screen.findAllByTitle('Test rule'))[0]);
    fireEvent.change(await screen.findByLabelText('Test against device'), {
      target: { value: DEVICE.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await screen.findByText('Rule would fire');
    const passingText = passing.textContent ?? '';
    unmount();

    mockApi(jsonResponse(body(false)));
    const { container: failing } = render(<AlertRulesPage />);
    fireEvent.click((await screen.findAllByTitle('Test rule'))[0]);
    fireEvent.change(await screen.findByLabelText('Test against device'), {
      target: { value: DEVICE.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await screen.findByText('Rule would not fire');

    expect(failing.textContent).not.toEqual(passingText);
  });
});
