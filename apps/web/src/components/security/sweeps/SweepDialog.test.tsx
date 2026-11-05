import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const { fetchWithAuth, showToast, navigateTo } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
  navigateTo: vi.fn(),
}));

vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('@/lib/navigation', () => ({ navigateTo }));
// The selector fetches devices/groups itself; the dialog only consumes its value.
vi.mock('../../filters/DeviceTargetSelector', () => ({
  DeviceTargetSelector: ({ onChange, modes }: { onChange: (v: unknown) => void; modes: string[] }) => (
    <button
      type="button"
      data-testid="stub-target-pick"
      onClick={() =>
        onChange(
          modes[0] === 'groups'
            ? { type: 'groups', groupIds: ['grp-1'] }
            : { type: 'devices', deviceIds: ['dev-1', 'dev-2'] },
        )
      }
    >
      pick
    </button>
  ),
}));

import { useOrgStore } from '@/stores/orgStore';
import SweepDialog from './SweepDialog';

const json = (status: number, payload: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const DIGEST_1 = 'a'.repeat(64);
const DIGEST_2 = 'b'.repeat(64);

const preview = (over: Record<string, unknown> = {}) => ({
  targeted: 12,
  byOrg: [
    { orgId: 'org-1', orgName: 'Acme', targeted: 8 },
    { orgId: 'org-2', orgName: 'Globex', targeted: 4 },
  ],
  skipped: { agent_too_old: 3 },
  ruleSets: [{ id: 'set-1', name: 'EICAR set', version: 4 }],
  previewDigest: DIGEST_1,
  ...over,
});

let createResponse: Response;
let previewResponse: Response;

function route() {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/security/sweeps/preview') return previewResponse;
    if (url === '/security/sweeps' && init?.method === 'POST') return createResponse;
    if (String(url).startsWith('/orgs/sites')) return json(200, { data: [{ id: 'site-1', name: 'HQ' }] });
    return json(200, { data: [] });
  });
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const click = async (testId: string) => {
  fireEvent.click(screen.getByTestId(testId));
  await settle();
};

const bodyOf = (url: string) => {
  const call = fetchWithAuth.mock.calls.find(([u, init]) => u === url && (init as RequestInit | undefined)?.method === 'POST');
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
};

async function walkToConfirm() {
  await click('sweep-dialog-next'); // scope (all) -> type
  await click('sweep-dialog-next'); // type -> duration
  await click('sweep-dialog-next'); // duration -> preview (POST)
  await click('sweep-dialog-next'); // preview -> confirm
}

const renderDialog = (over: Partial<React.ComponentProps<typeof SweepDialog>['prefill']> = {}) =>
  render(<SweepDialog prefill={{ ruleSetIds: ['set-1'], ruleSetNames: ['EICAR set'], ...over }} onClose={vi.fn()} />);

describe('SweepDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({
      organizations: [
        { id: 'org-1', partnerId: 'p', name: 'Acme', status: 'active' },
        { id: 'org-2', partnerId: 'p', name: 'Globex', status: 'active' },
      ] as never,
      currentOrgId: null,
    });
    previewResponse = json(200, { data: preview() });
    createResponse = json(201, { data: { groupId: 'grp-new', sweeps: [] } });
    route();
  });

  it('shows the detect-only banner on every step', async () => {
    renderDialog();
    for (const step of ['scope', 'type', 'duration']) {
      expect(screen.getByTestId(`sweep-dialog-step-${step}`)).toBeInTheDocument();
      expect(screen.getByTestId('sweep-dialog-detect-only').textContent).toMatch(/only detect/i);
      await click('sweep-dialog-next');
    }
    expect(screen.getByTestId('sweep-dialog-detect-only')).toBeInTheDocument(); // preview
    await click('sweep-dialog-next');
    expect(screen.getByTestId('sweep-dialog-detect-only')).toBeInTheDocument(); // confirm
  });

  it('previews, then confirms with the previewDigest and lands on the group', async () => {
    renderDialog();
    await walkToConfirm();

    expect(bodyOf('/security/sweeps/preview')).toEqual({
      ruleSetIds: ['set-1'],
      scope: { kind: 'all' },
      scanType: 'quick',
      ttlHours: 24,
    });

    await click('sweep-dialog-confirm');

    expect(bodyOf('/security/sweeps')).toEqual({
      ruleSetIds: ['set-1'],
      scope: { kind: 'all' },
      scanType: 'quick',
      ttlHours: 24,
      previewDigest: DIGEST_1,
    });
    expect(navigateTo).toHaveBeenCalledWith('/security/scans#sweeps&group=grp-new');
  });

  it('renders the preview: devices in orgs, set versions, skipped reasons with explanations', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');

    expect(screen.getByTestId('sweep-dialog-preview-targeted').textContent).toBe('12 devices in 2 organizations');
    expect(screen.getByTestId('sweep-dialog-preview-org-org-1').textContent).toContain('Acme');
    expect(screen.getByTestId('sweep-dialog-preview-set-set-1').textContent).toContain('Version 4');
    expect(screen.getByTestId('sweep-dialog-preview-skipped-agent_too_old').textContent).toMatch(/3.*agent that is too old/);
    expect(screen.queryByTestId('sweep-dialog-preview-skipped-busy_same_sweep')).toBeNull();
    expect(screen.getByTestId('sweep-dialog-preview-org-org-1').textContent).toBe('Acme: 8 devices');
    expect(screen.getByTestId('sweep-dialog-preview-skipped-agent_too_old').textContent).toMatch(
      /^3 devices with an agent that is too old/,
    );
    await click('sweep-dialog-next');
    expect(screen.getByTestId('sweep-dialog-confirm').textContent).toBe('Sweep 12 devices');
    expect(screen.getByTestId('sweep-dialog-confirm-summary').textContent).toMatch(
      /^12 devices in 2 organizations will be scanned .* on the devices\.$/,
    );
  });

  // #10080: "1 devices in 1 organizations", "Sweep 1 devices".
  it('uses singular forms for one device in one organization', async () => {
    previewResponse = json(200, {
      data: preview({
        targeted: 1,
        byOrg: [{ orgId: 'org-1', orgName: 'Acme', targeted: 1 }],
        skipped: { agent_too_old: 1, busy_same_sweep: 1, rule_set_not_eligible: 1 },
      }),
    });
    renderDialog();
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');

    expect(screen.getByTestId('sweep-dialog-preview-targeted').textContent).toBe('1 device in 1 organization');
    expect(screen.getByTestId('sweep-dialog-preview-org-org-1').textContent).toBe('Acme: 1 device');
    expect(screen.getByTestId('sweep-dialog-preview-skipped-agent_too_old').textContent).toMatch(
      /^1 device with an agent that is too old/,
    );
    expect(screen.getByTestId('sweep-dialog-preview-skipped-busy_same_sweep').textContent).toMatch(
      /^1 device already running this sweep/,
    );
    expect(screen.getByTestId('sweep-dialog-preview-skipped-rule_set_not_eligible').textContent).toMatch(
      /^1 device the rule sets do not apply to/,
    );
    await click('sweep-dialog-next');
    expect(screen.getByTestId('sweep-dialog-confirm').textContent).toBe('Sweep 1 device');
    expect(screen.getByTestId('sweep-dialog-confirm-summary').textContent).toMatch(
      /^1 device in 1 organization will be scanned .* on the device\.$/,
    );
  });

  it('shows no skipped block for a restricted caller (empty skipped)', async () => {
    previewResponse = json(200, { data: preview({ skipped: {} }) });
    renderDialog();
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    expect(screen.queryByTestId(/sweep-dialog-preview-skipped-/)).toBeNull();
  });

  it('SWEEP_SCOPE_CHANGED re-previews from detail.preview and confirms again with the new digest', async () => {
    createResponse = json(409, {
      error: 'changed',
      code: 'SWEEP_SCOPE_CHANGED',
      detail: { preview: preview({ targeted: 9, previewDigest: DIGEST_2 }) },
    });
    renderDialog();
    await walkToConfirm();
    await click('sweep-dialog-confirm');

    expect(screen.getByTestId('sweep-dialog-step-preview').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('sweep-dialog-scope-changed')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog-preview-targeted').textContent).toContain('9 devices');
    expect(navigateTo).not.toHaveBeenCalled();

    createResponse = json(201, { data: { groupId: 'grp-2', sweeps: [] } });
    await click('sweep-dialog-next');
    await click('sweep-dialog-confirm');
    const creates = fetchWithAuth.mock.calls.filter(([u, i]) => u === '/security/sweeps' && (i as RequestInit)?.method === 'POST');
    expect(JSON.parse((creates[1][1] as RequestInit).body as string).previewDigest).toBe(DIGEST_2);
    expect(navigateTo).toHaveBeenCalledWith('/security/scans#sweeps&group=grp-2');
  });

  it('SWEEP_ALREADY_RUNNING links to the running group', async () => {
    createResponse = json(409, {
      error: 'running',
      code: 'SWEEP_ALREADY_RUNNING',
      detail: { sweepIds: ['s-9'], groupIds: ['grp-9', 'grp-10'] },
    });
    renderDialog();
    await walkToConfirm();
    await click('sweep-dialog-confirm');

    const link = screen.getByTestId('sweep-dialog-already-running-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/security/scans#sweeps&group=grp-9');
    expect(screen.getByTestId('sweep-dialog-error').textContent).toMatch(/already running/i);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('MFA_REQUIRED shows the inline copy with the device count and threshold', async () => {
    createResponse = json(403, { error: 'mfa', code: 'MFA_REQUIRED', detail: { targeted: 120, threshold: 50 } });
    renderDialog();
    await walkToConfirm();
    await click('sweep-dialog-confirm');

    const message = screen.getByTestId('sweep-dialog-mfa-required').textContent ?? '';
    expect(message).toContain('120');
    expect(message).toContain('50');
    expect(message).toMatch(/multi-factor/i);
    expect(screen.queryByTestId('sweep-dialog-error')).toBeNull();
  });

  it('TOO_MANY_ACTIVE_SWEEPS shows the cap from detail.max', async () => {
    createResponse = json(409, { error: 'cap', code: 'TOO_MANY_ACTIVE_SWEEPS', detail: { orgIds: ['org-1'], max: 5 } });
    renderDialog();
    await walkToConfirm();
    await click('sweep-dialog-confirm');
    expect(screen.getByTestId('sweep-dialog-error').textContent).toMatch(/5 active sweeps/);
  });

  it('NO_ELIGIBLE_DEVICES on preview stays on the duration step with the message inline', async () => {
    previewResponse = json(400, { error: 'none', code: 'NO_ELIGIBLE_DEVICES', detail: { skipped: { agent_too_old: 2 } } });
    renderDialog();
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    expect(screen.getByTestId('sweep-dialog-step-duration').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('sweep-dialog-error').textContent).toMatch(/no device in this scope/i);
  });

  it('a device scope needs a pick, and sends the picked device ids', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('sweep-dialog-scope-devices'));
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(true);
    await click('stub-target-pick');
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(false);
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    expect(bodyOf('/security/sweeps/preview').scope).toEqual({ kind: 'devices', deviceIds: ['dev-1', 'dev-2'] });
  });

  it('an organizations scope sends the ticked org ids', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('sweep-dialog-scope-orgs'));
    fireEvent.click(screen.getByTestId('sweep-dialog-org-org-2'));
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    expect(bodyOf('/security/sweeps/preview').scope).toEqual({ kind: 'orgs', orgIds: ['org-2'] });
  });

  it('a sites scope lists the chosen org\'s sites and sends the ticked site ids', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('sweep-dialog-scope-sites'));
    fireEvent.change(screen.getByTestId('sweep-dialog-sites-org'), { target: { value: 'org-1' } });
    await settle();
    fireEvent.click(screen.getByTestId('sweep-dialog-site-site-1'));
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    expect(bodyOf('/security/sweeps/preview').scope).toEqual({ kind: 'sites', siteIds: ['site-1'] });
  });

  it('a custom scan needs at least one path and sends them trimmed', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    fireEvent.change(screen.getByTestId('sweep-dialog-scan-type'), { target: { value: 'custom' } });
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('sweep-dialog-paths'), { target: { value: ' C:\\Temp \n\n/tmp/x ' } });
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(false);
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    expect(bodyOf('/security/sweeps/preview')).toMatchObject({ scanType: 'custom', paths: ['C:\\Temp', '/tmp/x'] });
  });

  it('refuses a path over the limit and a duration outside 1-72 hours', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    fireEvent.change(screen.getByTestId('sweep-dialog-scan-type'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('sweep-dialog-paths'), { target: { value: 'x'.repeat(1025) } });
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('sweep-dialog-scan-type'), { target: { value: 'quick' } });
    await click('sweep-dialog-next');
    fireEvent.change(screen.getByTestId('sweep-dialog-ttl'), { target: { value: '73' } });
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('sweep-dialog-ttl'), { target: { value: '72' } });
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(false);
  });

  // #10080: an over-limit input used to only grey out Next and redden the help text.
  const expectInvalidField = (field: HTMLElement, errorTestId: string, text: string | RegExp) => {
    const message = screen.getByTestId(errorTestId);
    if (typeof text === 'string') expect(message.textContent).toBe(text);
    else expect(message.textContent).toMatch(text);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(message.id).not.toBe('');
    expect((field.getAttribute('aria-describedby') ?? '').split(' ')).toContain(message.id);
    expectDescribedByResolves(field);
  };

  const expectDescribedByResolves = (field: HTMLElement) => {
    const ids = (field.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(document.getElementById(id), id).not.toBeNull();
  };

  it('does not flag an empty or blank path list, but keeps Next disabled', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    fireEvent.change(screen.getByTestId('sweep-dialog-scan-type'), { target: { value: 'custom' } });
    const field = screen.getByTestId('sweep-dialog-paths');
    for (const value of ['', '  \n \n']) {
      fireEvent.change(field, { target: { value } });
      expect(screen.queryByTestId('sweep-dialog-paths-error')).toBeNull();
      expect(screen.queryByTestId('sweep-dialog-paths-count')).toBeNull();
      expect(field.getAttribute('aria-invalid')).toBe('false');
      expectDescribedByResolves(field);
      expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('accepts a path of exactly 1024 characters, and reports too many paths before a long line', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    fireEvent.change(screen.getByTestId('sweep-dialog-scan-type'), { target: { value: 'custom' } });
    const field = screen.getByTestId('sweep-dialog-paths');
    fireEvent.change(field, { target: { value: 'x'.repeat(1024) } });
    expect(screen.queryByTestId('sweep-dialog-paths-error')).toBeNull();
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(false);

    const many = [...Array.from({ length: 21 }, (_, i) => `C:\\p${i}`), 'x'.repeat(1025)].join('\n');
    fireEvent.change(field, { target: { value: many } });
    expect(screen.getByTestId('sweep-dialog-paths-error').textContent).toBe('22 of 20 paths: remove 2.');
  });

  it('says how many paths to remove when there are more than 20', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    fireEvent.change(screen.getByTestId('sweep-dialog-scan-type'), { target: { value: 'custom' } });
    const field = screen.getByTestId('sweep-dialog-paths');
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `C:\\p${i}`).join('\n');

    fireEvent.change(field, { target: { value: lines(2) } });
    expect(screen.getByTestId('sweep-dialog-paths-count').textContent).toBe('2 of 20 paths');
    expect(screen.queryByTestId('sweep-dialog-paths-error')).toBeNull();
    expect(field.getAttribute('aria-invalid')).toBe('false');

    fireEvent.change(field, { target: { value: lines(21) } });
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(true);
    expectInvalidField(field, 'sweep-dialog-paths-error', '21 of 20 paths: remove 1.');

    fireEvent.change(field, { target: { value: lines(20) } });
    expect(screen.queryByTestId('sweep-dialog-paths-error')).toBeNull();
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('names the line whose path is too long', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    fireEvent.change(screen.getByTestId('sweep-dialog-scan-type'), { target: { value: 'custom' } });
    const field = screen.getByTestId('sweep-dialog-paths');
    fireEvent.change(field, { target: { value: `C:\\ok\n\n${'x'.repeat(1025)}` } });
    expectInvalidField(field, 'sweep-dialog-paths-error', 'Line 3 is longer than 1024 characters.');
  });

  it('says the allowed range when the duration is outside 1-72 hours', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    const field = screen.getByTestId('sweep-dialog-ttl');
    expect(screen.queryByTestId('sweep-dialog-ttl-error')).toBeNull();
    expect(field.getAttribute('aria-invalid')).toBe('false');

    fireEvent.change(field, { target: { value: '73' } });
    expectInvalidField(field, 'sweep-dialog-ttl-error', 'Enter a whole number of hours from 1 to 72.');
    fireEvent.change(field, { target: { value: '0' } });
    expectInvalidField(field, 'sweep-dialog-ttl-error', 'Enter a whole number of hours from 1 to 72.');

    fireEvent.change(field, { target: { value: '72' } });
    expect(screen.queryByTestId('sweep-dialog-ttl-error')).toBeNull();
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expectDescribedByResolves(field);

    for (const value of ['', '1.5', '-1']) {
      fireEvent.change(field, { target: { value } });
      expectInvalidField(field, 'sweep-dialog-ttl-error', 'Enter a whole number of hours from 1 to 72.');
    }
    // Leaving the field clamps it into range, which clears the message.
    fireEvent.change(field, { target: { value: '100' } });
    fireEvent.blur(field);
    expect((field as HTMLInputElement).value).toBe('72');
    expect(screen.queryByTestId('sweep-dialog-ttl-error')).toBeNull();
  });

  it('keeps the prefilled scan type and says the scope must be chosen again', async () => {
    renderDialog({ scanType: 'full', rescope: true });
    expect(screen.getByTestId('sweep-dialog-rescope-note')).toBeInTheDocument();
    // No scope is preselected: Next stays disabled until one is chosen.
    expect((screen.getByTestId('sweep-dialog-next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('sweep-dialog-scope-all'));
    await click('sweep-dialog-next');
    expect((screen.getByTestId('sweep-dialog-scan-type') as HTMLSelectElement).value).toBe('full');
  });

  it('re-previews after Back and a changed scope, and confirms with the new digest', async () => {
    renderDialog();
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next'); // preview 1 (DIGEST_1)
    previewResponse = json(200, { data: preview({ previewDigest: DIGEST_2, targeted: 2, byOrg: [] }) });
    await click('sweep-dialog-back');
    await click('sweep-dialog-back');
    await click('sweep-dialog-back'); // back to scope
    fireEvent.click(screen.getByTestId('sweep-dialog-scope-orgs'));
    fireEvent.click(screen.getByTestId('sweep-dialog-org-org-1'));
    await click('sweep-dialog-next');
    await click('sweep-dialog-next');
    await click('sweep-dialog-next'); // preview 2 (DIGEST_2)
    await click('sweep-dialog-next');
    await click('sweep-dialog-confirm');
    expect(bodyOf('/security/sweeps')).toMatchObject({
      scope: { kind: 'orgs', orgIds: ['org-1'] },
      previewDigest: DIGEST_2,
    });
  });

  it('on /security/scans it writes the group hash instead of navigating', async () => {
    const GROUP = '3f2b8c1e-5a47-4d0e-9c1a-0b7e6d5f4a32';
    createResponse = json(201, { data: { groupId: GROUP, sweeps: [] } });
    window.history.pushState({}, '', '/security/scans');
    try {
      renderDialog();
      await walkToConfirm();
      await click('sweep-dialog-confirm');
      expect(window.location.hash).toBe(`#sweeps&group=${GROUP}`);
      expect(navigateTo).not.toHaveBeenCalled();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('a 2xx create without a groupId is a failure, not a silent success', async () => {
    createResponse = json(201, {});
    renderDialog();
    await walkToConfirm();
    await click('sweep-dialog-confirm');
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByTestId('sweep-dialog-error')).toBeInTheDocument();
  });
});
