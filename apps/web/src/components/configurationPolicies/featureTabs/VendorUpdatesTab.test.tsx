import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const m = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  changed: vi.fn(),
  fetch: vi.fn(),
  hook: {
    error: undefined as string | undefined,
    errorDetail: undefined as { status: number; code?: string; body?: unknown } | undefined,
  },
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: m.save,
    remove: m.remove,
    saving: false,
    error: m.hook.error,
    errorDetail: m.hook.errorDetail,
    clearError: vi.fn(),
  }),
}));

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => m.fetch(...args) }));

import VendorUpdatesTab from './VendorUpdatesTab';
import type { FeatureLink } from './types';

const CLOSED = { bios: false, firmware: false, driver: false, application: false };
function gates(dell: Partial<typeof CLOSED> = {}) {
  return {
    lanes: [
      { lane: 'dell', shipped: true, categories: { ...CLOSED, ...dell } },
      { lane: 'surface', shipped: false, categories: CLOSED },
      { lane: 'hp', shipped: false, categories: CLOSED },
      { lane: 'lenovo', shipped: false, categories: CLOSED },
    ],
  };
}

const props = {
  policyId: 'policy',
  existingLink: undefined as FeatureLink | undefined,
  linkedPolicyId: null,
  onLinkChanged: m.changed,
  orgId: 'org-1' as string | null,
};

const SCHEDULE = { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 };
const stored = (dellCategories: Record<string, boolean>, over: Record<string, unknown> = {}) => ({
  version: 1, enabled: true, schedule: SCHEDULE, catchUpNights: 7, reboot: 'overnight',
  vendors: { dell: { enabled: true, categories: dellCategories, blockedUpdateIds: [] } },
  ...over,
});
const link = (inlineSettings: Record<string, unknown>): FeatureLink =>
  ({ id: 'link-1', featureType: 'oem_updates', featurePolicyId: null, inlineSettings } as FeatureLink);

function serveGates(snapshot: unknown) {
  m.fetch.mockResolvedValue(new Response(JSON.stringify({ data: snapshot }), { status: 200 }));
}

const box = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const lastSaved = () => m.save.mock.calls.at(-1)![1].inlineSettings;

beforeEach(() => {
  vi.clearAllMocks();
  m.hook.error = undefined;
  m.hook.errorDetail = undefined;
  serveGates(gates());
  m.save.mockImplementation(async (_id: string | null, payload: { inlineSettings: unknown }) => ({
    id: 'link-1', featureType: 'oem_updates', featurePolicyId: null, inlineSettings: payload.inlineSettings,
  }));
});

describe('VendorUpdatesTab', () => {
  it('reads the gates from the API', async () => {
    render(<VendorUpdatesTab {...props} />);
    await waitFor(() => expect(m.fetch).toHaveBeenCalledWith('/configuration-policies/oem-updates/gates'));
  });

  it('a new policy preselects Dell plus open categories only, and starts switched off', async () => {
    serveGates(gates({ driver: true, application: true }));
    render(<VendorUpdatesTab {...props} />);
    await waitFor(() => expect(box('vendor-updates-dell-driver').checked).toBe(true));
    expect(box('vendor-updates-dell-enabled').checked).toBe(true);
    expect(box('vendor-updates-dell-application').checked).toBe(true);
    expect(box('vendor-updates-dell-bios').checked).toBe(false);
    expect(box('vendor-updates-enabled').checked).toBe(false);

    fireEvent.click(screen.getByTestId('vendor-updates-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    expect(m.save.mock.calls[0]![0]).toBeNull();
    expect(lastSaved()).toEqual({
      version: 1, enabled: false, schedule: SCHEDULE, catchUpNights: 7, reboot: 'overnight',
      vendors: { dell: { enabled: true, categories: { driver: true, application: true }, blockedUpdateIds: [] } },
    });
    expect(m.changed).toHaveBeenCalledWith(expect.objectContaining({ id: 'link-1' }), 'oem_updates');
  });

  it('closed categories render disabled with the reason', async () => {
    render(<VendorUpdatesTab {...props} />);
    await waitFor(() => expect(screen.getByTestId('vendor-updates-dell-bios-closed')).toBeTruthy());
    for (const category of ['bios', 'firmware', 'driver', 'application']) {
      expect(box(`vendor-updates-dell-${category}`).disabled).toBe(true);
      expect(box(`vendor-updates-dell-${category}`).checked).toBe(false);
    }
  });

  it('a vendor whose lane has not shipped is shown as coming later and cannot be switched on', async () => {
    render(<VendorUpdatesTab {...props} />);
    await waitFor(() => expect(screen.getByTestId('vendor-updates-hp-not-shipped')).toBeTruthy());
    expect(box('vendor-updates-hp-enabled').disabled).toBe(true);
  });

  it('a gate open but category absent shows "now available" and stays off', async () => {
    serveGates(gates({ driver: true, bios: true }));
    render(<VendorUpdatesTab {...props} existingLink={link(stored({ driver: true }))} />);
    await waitFor(() => expect(screen.getByTestId('vendor-updates-dell-bios-now-available')).toBeTruthy());
    expect(box('vendor-updates-dell-bios').checked).toBe(false);
    expect(box('vendor-updates-dell-bios').disabled).toBe(false);
    // A category the link has decided (driver) carries no note.
    expect(screen.queryByTestId('vendor-updates-dell-driver-now-available')).toBeNull();

    fireEvent.click(screen.getByTestId('vendor-updates-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    expect(m.save.mock.calls[0]![0]).toBe('link-1');
    expect(lastSaved().vendors.dell.categories).toEqual({ driver: true });
  });

  it('edits the schedule and blocked updates and saves them', async () => {
    serveGates(gates({ driver: true }));
    render(<VendorUpdatesTab {...props} existingLink={link(stored({ driver: true }))} />);
    await waitFor(() => expect(box('vendor-updates-enabled').checked).toBe(true));
    fireEvent.change(screen.getByTestId('vendor-updates-week'), { target: { value: 'last' } });
    fireEvent.change(screen.getByTestId('vendor-updates-day'), { target: { value: 'sat' } });
    fireEvent.change(screen.getByTestId('vendor-updates-window-start'), { target: { value: '22:30' } });
    fireEvent.change(screen.getByTestId('vendor-updates-window-hours'), { target: { value: '6' } });
    fireEvent.change(screen.getByTestId('vendor-updates-catch-up'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('vendor-updates-reboot'), { target: { value: 'never' } });
    fireEvent.change(screen.getByTestId('vendor-updates-dell-blocked'), { target: { value: 'ABC12, DEF34\nABC12' } });
    fireEvent.click(screen.getByTestId('vendor-updates-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    expect(lastSaved()).toMatchObject({
      schedule: { weekOfMonth: 'last', dayOfWeek: 'sat', windowStart: '22:30', windowHours: 6 },
      catchUpNights: 3,
      reboot: 'never',
      vendors: { dell: { blockedUpdateIds: ['ABC12', 'DEF34'] } },
    });
  });

  it('out-of-range schedule values block the save with a message', async () => {
    render(<VendorUpdatesTab {...props} existingLink={link(stored({}))} />);
    await waitFor(() => expect(box('vendor-updates-enabled').checked).toBe(true));
    fireEvent.change(screen.getByTestId('vendor-updates-window-hours'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('vendor-updates-save'));
    expect(screen.getByTestId('vendor-updates-invalid')).toBeTruthy();
    expect(m.save).not.toHaveBeenCalled();
  });

  it('arming without execute shows the permission message', async () => {
    m.hook.errorDetail = { status: 403, code: 'oem_updates_execute_required' };
    m.hook.error = 'refused';
    render(<VendorUpdatesTab {...props} existingLink={link(stored({}))} />);
    expect(screen.getByTestId('vendor-updates-execute-required')).toBeTruthy();
  });

  it('narrowing does not: no permission message without that refusal', async () => {
    render(<VendorUpdatesTab {...props} existingLink={link(stored({}))} />);
    await waitFor(() => expect(box('vendor-updates-enabled').checked).toBe(true));
    fireEvent.click(box('vendor-updates-enabled'));
    fireEvent.click(screen.getByTestId('vendor-updates-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    expect(lastSaved().enabled).toBe(false);
    expect(screen.queryByTestId('vendor-updates-execute-required')).toBeNull();
  });

  it('a closed-gate refusal names the reason', () => {
    m.hook.errorDetail = { status: 400, code: 'oem_updates_category_gate_closed', body: { categories: ['dell:bios'] } };
    m.hook.error = 'refused';
    render(<VendorUpdatesTab {...props} existingLink={link(stored({}))} />);
    expect(screen.getByTestId('vendor-updates-gate-closed')).toBeTruthy();
  });

  it('a stored category whose gate has since closed is shown as stored and sent back unchanged', async () => {
    render(<VendorUpdatesTab {...props} existingLink={link(stored({ bios: true }))} />);
    await waitFor(() => expect(screen.getByTestId('vendor-updates-dell-bios-closed')).toBeTruthy());
    expect(box('vendor-updates-dell-bios').checked).toBe(true);
    expect(box('vendor-updates-dell-bios').disabled).toBe(true);
    // Switching the policy off still saves, with the stored choice untouched.
    fireEvent.click(box('vendor-updates-enabled'));
    fireEvent.click(screen.getByTestId('vendor-updates-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    expect(lastSaved()).toMatchObject({ enabled: false, vendors: { dell: { categories: { bios: true } } } });
  });

  it('cannot save before the gates are known, so a stored category is never rewritten blind', async () => {
    m.fetch.mockReturnValue(new Promise(() => {}));
    render(<VendorUpdatesTab {...props} existingLink={link(stored({ driver: true }))} />);
    const save = screen.getByTestId('vendor-updates-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(m.save).not.toHaveBeenCalled();
  });

  it('stored settings that no longer parse are flagged on load', async () => {
    render(<VendorUpdatesTab {...props} existingLink={link({ ...stored({}), catchUpNights: 99 })} />);
    expect(screen.getByTestId('vendor-updates-stored-invalid')).toBeTruthy();
  });

  it('an inherited link that no longer parses is flagged too, not left as a silent disabled button', async () => {
    render(<VendorUpdatesTab {...props} parentLink={link({ ...stored({}), unknownKey: 1 })} />);
    expect(screen.getByTestId('vendor-updates-stored-invalid')).toBeTruthy();
  });

  it('valid stored settings carry no warning', async () => {
    render(<VendorUpdatesTab {...props} existingLink={link(stored({}))} />);
    expect(screen.queryByTestId('vendor-updates-stored-invalid')).toBeNull();
  });

  it('shows the partner-wide badge on a partner-wide policy', () => {
    render(<VendorUpdatesTab {...props} orgId={null} />);
    expect(screen.getByTestId('vendor-updates-partner-wide-badge')).toBeTruthy();
  });

  it('an inherited link is read-only until overridden', async () => {
    render(<VendorUpdatesTab {...props} parentLink={link(stored({}))} />);
    await waitFor(() => expect(box('vendor-updates-enabled').checked).toBe(true));
    // Disabled through the surrounding fieldset.
    expect(box('vendor-updates-enabled').matches(':disabled')).toBe(true);
  });

  it('a gates read failure keeps every category closed and saving off', async () => {
    m.fetch.mockResolvedValue(new Response('{}', { status: 500 }));
    render(<VendorUpdatesTab {...props} existingLink={link(stored({ driver: true }))} />);
    await waitFor(() => expect(screen.getByTestId('vendor-updates-gates-error')).toBeTruthy());
    expect(box('vendor-updates-dell-driver').disabled).toBe(true);
    expect((screen.getByTestId('vendor-updates-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
