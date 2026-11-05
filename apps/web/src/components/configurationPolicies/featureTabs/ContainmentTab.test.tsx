import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const m = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  changed: vi.fn(),
  hook: { error: undefined as string | undefined },
}));
vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: m.save,
    remove: m.remove,
    saving: false,
    error: m.hook.error,
    errorDetail: undefined,
    clearError: vi.fn(),
  }),
}));

import ContainmentTab from './ContainmentTab';
import type { FeatureLink } from './types';

const props = {
  policyId: 'policy',
  existingLink: undefined as FeatureLink | undefined,
  linkedPolicyId: null,
  onLinkChanged: m.changed,
  orgId: 'org-1' as string | null,
};

const STORED = {
  version: 1,
  extraAllow: [
    { host: 'updates.example.com', proto: 'tcp', ports: [443], label: 'Vendor updates' },
    { cidr: '203.0.113.0/24', proto: 'udp+tcp', ports: [53, 853], label: 'Branch DNS' },
  ],
  defaultTtlHours: 48,
  deadManMinutes: 30,
  remoteRelay: false,
  requireSignedReleaseToken: true,
};

function link(inlineSettings: Record<string, unknown>, id = 'link-1'): FeatureLink {
  return { id, featureType: 'containment', featurePolicyId: null, inlineSettings } as FeatureLink;
}

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const setValue = (id: string, value: string) => {
  fireEvent.change(screen.getByTestId(id), { target: { value } });
  fireEvent.blur(screen.getByTestId(id));
};

beforeEach(() => {
  vi.clearAllMocks();
  m.hook.error = undefined;
  m.save.mockImplementation(async (_id: string | null, payload: { inlineSettings: unknown }) => ({
    id: 'link-1',
    featureType: 'containment',
    featurePolicyId: null,
    inlineSettings: payload.inlineSettings,
  }));
});

describe('ContainmentTab', () => {
  it('renders the stored extra destinations', () => {
    render(<ContainmentTab {...props} existingLink={link(STORED)} />);
    expect(input('containment-row-0-type').value).toBe('host');
    expect(input('containment-row-0-target').value).toBe('updates.example.com');
    expect(input('containment-row-0-proto').value).toBe('tcp');
    expect(input('containment-row-0-ports').value).toBe('443');
    expect(input('containment-row-0-label').value).toBe('Vendor updates');
    expect(input('containment-row-1-type').value).toBe('cidr');
    expect(input('containment-row-1-target').value).toBe('203.0.113.0/24');
    expect(input('containment-row-1-proto').value).toBe('udp+tcp');
    expect(input('containment-row-1-ports').value).toBe('53, 853');
    expect(screen.queryByTestId('containment-empty')).toBeNull();
  });

  it('describes what the tab controls and says the control plane is always allowed', () => {
    render(<ContainmentTab {...props} />);
    expect(screen.getByText(/control plane is always allowed/i)).toBeInTheDocument();
    expect(screen.getByTestId('containment-empty')).toBeInTheDocument();
  });

  it('renders no controls for the settings later waves own', () => {
    render(<ContainmentTab {...props} existingLink={link(STORED)} />);
    expect(screen.queryByText(/dead.?man/i)).toBeNull();
    expect(screen.queryByText(/release token/i)).toBeNull();
    expect(screen.queryByText(/relay/i)).toBeNull();
  });

  it('saves edits with version 1 and every untouched stored key preserved', async () => {
    render(<ContainmentTab {...props} existingLink={link(STORED)} />);
    setValue('containment-row-0-ports', '443, 8443');
    fireEvent.click(screen.getByTestId('containment-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    expect(m.save).toHaveBeenCalledWith('link-1', {
      featureType: 'containment',
      featurePolicyId: null,
      inlineSettings: {
        version: 1,
        extraAllow: [
          { host: 'updates.example.com', proto: 'tcp', ports: [443, 8443], label: 'Vendor updates' },
          STORED.extraAllow[1],
        ],
        defaultTtlHours: 48,
        deadManMinutes: 30,
        remoteRelay: false,
        requireSignedReleaseToken: true,
      },
    });
    expect(m.changed).toHaveBeenCalledWith(expect.objectContaining({ id: 'link-1' }), 'containment');
  });

  it('writes version 1 even when the stored blob carried another version', async () => {
    render(<ContainmentTab {...props} existingLink={link({ ...STORED, version: 7 })} />);
    fireEvent.click(screen.getByTestId('containment-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    expect(m.save.mock.calls[0][1].inlineSettings.version).toBe(1);
  });

  it('creates a new link with only version and extraAllow when nothing is stored', async () => {
    render(<ContainmentTab {...props} />);
    fireEvent.click(screen.getByTestId('containment-add-row'));
    fireEvent.change(screen.getByTestId('containment-row-0-type'), { target: { value: 'cidr' } });
    setValue('containment-row-0-target', '198.51.100.0/24');
    setValue('containment-row-0-proto', 'udp');
    setValue('containment-row-0-ports', '514');
    setValue('containment-row-0-label', '  Syslog collector  ');
    fireEvent.click(screen.getByTestId('containment-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    expect(m.save).toHaveBeenCalledWith(null, {
      featureType: 'containment',
      featurePolicyId: null,
      inlineSettings: {
        version: 1,
        extraAllow: [{ cidr: '198.51.100.0/24', proto: 'udp', ports: [514], label: 'Syslog collector' }],
      },
    });
  });

  it('removes a row from the saved list', async () => {
    render(<ContainmentTab {...props} existingLink={link(STORED)} />);
    fireEvent.click(screen.getByTestId('containment-row-0-remove'));
    fireEvent.click(screen.getByTestId('containment-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    expect(m.save.mock.calls[0][1].inlineSettings.extraAllow).toEqual([STORED.extraAllow[1]]);
  });

  it.each([
    ['cidr', '0.0.0.0/0', 'a /0 permit is not allowed'],
    ['cidr', '::/0', 'a /0 permit is not allowed'],
    ['cidr', '10.0.0.0/7', 'CIDR must be at least /8 (IPv4) or /32 (IPv6) and exclude loopback and unspecified addresses'],
    ['cidr', '2001:db8::/31', 'CIDR must be at least /8 (IPv4) or /32 (IPv6) and exclude loopback and unspecified addresses'],
    ['cidr', '127.0.0.1/32', 'CIDR must be at least /8 (IPv4) or /32 (IPv6) and exclude loopback and unspecified addresses'],
    ['cidr', '::1/128', 'CIDR must be at least /8 (IPv4) or /32 (IPv6) and exclude loopback and unspecified addresses'],
    ['host', 'localhost', 'loopback hostnames are not allowed'],
    ['host', 'relay.localhost', 'loopback hostnames are not allowed'],
    ['host', '*.example.com', 'host must be a DNS name'],
  ])('rejects %s %s with the schema message and does not save', async (type, target, message) => {
    render(<ContainmentTab {...props} />);
    fireEvent.click(screen.getByTestId('containment-add-row'));
    fireEvent.change(screen.getByTestId('containment-row-0-type'), { target: { value: type } });
    setValue('containment-row-0-target', target);
    setValue('containment-row-0-ports', '443');
    setValue('containment-row-0-label', 'Probe');
    expect(screen.getByTestId('containment-row-0-target-error')).toHaveTextContent(message);
    fireEvent.click(screen.getByTestId('containment-save'));
    await Promise.resolve();
    expect(m.save).not.toHaveBeenCalled();
  });

  it('shows a readable message for a malformed CIDR and for bad ports', () => {
    render(<ContainmentTab {...props} />);
    fireEvent.click(screen.getByTestId('containment-add-row'));
    fireEvent.change(screen.getByTestId('containment-row-0-type'), { target: { value: 'cidr' } });
    setValue('containment-row-0-target', 'not-a-range');
    setValue('containment-row-0-ports', '0x50');
    const cidrError = screen.getByTestId('containment-row-0-target-error').textContent ?? '';
    expect(cidrError).toMatch(/CIDR/);
    expect(cidrError).not.toMatch(/Invalid input/);
    expect(screen.getByTestId('containment-row-0-ports-error')).toHaveTextContent(/65535/);
  });

  it('reveals every row error when an invalid save is attempted', async () => {
    render(<ContainmentTab {...props} />);
    fireEvent.click(screen.getByTestId('containment-add-row'));
    expect(screen.queryByTestId('containment-row-0-target-error')).toBeNull();
    fireEvent.click(screen.getByTestId('containment-save'));
    await Promise.resolve();
    expect(m.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('containment-row-0-target-error')).toBeInTheDocument();
    expect(screen.getByTestId('containment-row-0-label-error')).toBeInTheDocument();
    expect(screen.getByTestId('containment-invalid')).toBeInTheDocument();
  });

  it('stops adding rows at the schema limit', () => {
    const full = Array.from({ length: 32 }, (_, i) => ({
      host: `h${i}.example.com`, proto: 'tcp', ports: [443], label: `Host ${i}`,
    }));
    render(<ContainmentTab {...props} existingLink={link({ version: 1, extraAllow: full })} />);
    expect((screen.getByTestId('containment-add-row') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('containment-limit')).toHaveTextContent('32');
  });

  it('shows a partner-wide parent read-only and inherited', () => {
    render(<ContainmentTab {...props} parentLink={link(STORED, 'parent-link')} />);
    expect(screen.getByText(/configured \(inherited\)/i)).toBeInTheDocument();
    expect(input('containment-row-0-target').value).toBe('updates.example.com');
    expect(input('containment-row-0-target').disabled).toBe(true);
    expect((screen.getByTestId('containment-add-row') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('containment-save')).toBeNull();
  });

  it('overriding a parent creates the org link from the parent settings, untouched keys included', async () => {
    render(<ContainmentTab {...props} parentLink={link(STORED, 'parent-link')} />);
    fireEvent.click(screen.getByRole('button', { name: /override/i }));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    expect(m.save).toHaveBeenCalledWith(null, {
      featureType: 'containment',
      featurePolicyId: null,
      inlineSettings: STORED,
    });
  });

  it('an org override edits its own link, not the parent', async () => {
    render(
      <ContainmentTab
        {...props}
        linkedPolicyId="parent-policy"
        parentLink={link(STORED, 'parent-link')}
        existingLink={link({ version: 1, extraAllow: [] }, 'own-link')}
      />,
    );
    expect(screen.getByTestId('containment-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('containment-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    expect(m.save.mock.calls[0][0]).toBe('own-link');
    expect(screen.getByRole('button', { name: /revert to parent/i })).toBeInTheDocument();
  });

  it('blocks saving a stored list over the limit and says why', async () => {
    const over = Array.from({ length: 33 }, (_, i) => ({
      host: `h${i}.example.com`, proto: 'tcp', ports: [443], label: `Host ${i}`,
    }));
    render(<ContainmentTab {...props} existingLink={link({ version: 1, extraAllow: over })} />);
    fireEvent.click(screen.getByTestId('containment-save'));
    await Promise.resolve();
    expect(m.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('containment-invalid')).toHaveTextContent('32');
  });

  it('explains an invalid parent instead of leaving Override dead', () => {
    const bad = { version: 1, extraAllow: [{ host: '*.example.com', proto: 'tcp', ports: [443], label: 'Bad' }] };
    render(<ContainmentTab {...props} parentLink={link(bad, 'parent-link')} />);
    expect(screen.getByTestId('containment-parent-invalid')).toBeInTheDocument();
    expect((screen.getByRole('button', { name: /override/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server refusal from the hook', () => {
    m.hook.error = 'Full partner org access is required';
    render(<ContainmentTab {...props} />);
    expect(screen.getByText('Full partner org access is required')).toBeInTheDocument();
  });

  it('keeps the edits and reports no change when the save fails', async () => {
    m.save.mockResolvedValue(null);
    render(<ContainmentTab {...props} existingLink={link(STORED)} />);
    setValue('containment-row-0-label', 'Edited');
    fireEvent.click(screen.getByTestId('containment-save'));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(m.changed).not.toHaveBeenCalled();
    expect(input('containment-row-0-label').value).toBe('Edited');
  });

  it('re-seeds rows and clears errors when the link changes', () => {
    const { rerender } = render(<ContainmentTab {...props} existingLink={link(STORED)} />);
    setValue('containment-row-0-target', '*.example.com');
    expect(screen.getByTestId('containment-row-0-target-error')).toBeInTheDocument();
    rerender(
      <ContainmentTab
        {...props}
        existingLink={link({
          version: 1,
          extraAllow: [{ host: 'fresh.example.com', proto: 'udp', ports: [53], label: 'Fresh' }],
        })}
      />,
    );
    expect(input('containment-row-0-target').value).toBe('fresh.example.com');
    expect(screen.queryByTestId('containment-row-0-target-error')).toBeNull();
    expect(screen.queryByTestId('containment-row-1')).toBeNull();
  });

  it('Revert to Parent deletes the override and reports the link gone', async () => {
    m.remove.mockResolvedValue(true);
    render(
      <ContainmentTab
        {...props}
        linkedPolicyId="parent-policy"
        parentLink={link(STORED, 'parent-link')}
        existingLink={link({ version: 1, extraAllow: [] }, 'own-link')}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /revert to parent/i }));
    fireEvent.click(screen.getByTestId('feature-tab-revert-confirm'));
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith('own-link'));
    await waitFor(() => expect(m.changed).toHaveBeenCalledWith(null, 'containment'));
  });

  it('renders translated copy in a non-English locale (no raw keys)', async () => {
    const { i18n, loadLocale } = await import('@/lib/i18n');
    await loadLocale('de-DE');
    await i18n.changeLanguage('de-DE');
    try {
      render(<ContainmentTab {...props} />);
      expect(document.body.textContent ?? '').not.toMatch(/containmentTab\./);
      expect(screen.getByTestId('containment-add-row').textContent).not.toMatch(/Add destination/);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
