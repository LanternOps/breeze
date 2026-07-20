import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ExtensionSlotHost, { extensionSlotDescriptorsFromRegistry } from './ExtensionSlotHost';
import type { RuntimeWebRegistry, RuntimeWebExtension } from '@/lib/extensions/registry';

const getExtensionRegistry = vi.fn();
vi.mock('@/lib/extensions/registry', () => ({
  getExtensionRegistry: (...a: unknown[]) => getExtensionRegistry(...a),
}));

// ExtensionSlotHost's own job is slot resolution + ordering; mounting/loading/
// the event bridge/error boundary belong to ExtensionElementHost and have
// their own dedicated tests. Stub it here so these tests assert exactly the
// props (in particular `context`) it was handed.
vi.mock('./ExtensionElementHost', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="extension-element-host-stub" data-props={JSON.stringify(props)} />
  ),
}));

function extension(over: Partial<RuntimeWebExtension> = {}): RuntimeWebExtension {
  return {
    name: 'demo',
    version: '1.0.0',
    digest: 'abc123',
    moduleUrl: '/api/v1/extensions/assets/demo/abc123/index.js',
    pages: [],
    navigation: [],
    slots: [],
    ...over,
  };
}

function registry(extensions: RuntimeWebExtension[]): RuntimeWebRegistry {
  return { apiVersion: 'breeze.extensions.web/v1', revision: 'rev-1', extensions };
}

const DEVICE_CONTEXT = {
  contractVersion: 1,
  deviceId: 'd1',
  organizationId: 'o1',
  siteId: 's1',
};

beforeEach(() => {
  getExtensionRegistry.mockReset();
});

describe('extensionSlotDescriptorsFromRegistry (pure projection)', () => {
  it('resolves only slots matching slot name + contractVersion', () => {
    const descriptors = extensionSlotDescriptorsFromRegistry(
      registry([
        extension({
          name: 'demo',
          slots: [
            { id: 'main', slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-device-tab', label: 'Demo', order: undefined },
            { id: 'other-slot', slot: 'organization.settings.sections', contractVersion: 1, element: 'demo-org-section', label: undefined, order: undefined },
            { id: 'wrong-version', slot: 'device.detail.tabs', contractVersion: 2, element: 'demo-v2-tab', label: undefined, order: undefined },
          ],
        }),
      ]),
      'device.detail.tabs',
      1,
    );
    expect(descriptors).toEqual([
      {
        key: 'demo:main',
        extensionName: 'demo',
        moduleUrl: '/api/v1/extensions/assets/demo/abc123/index.js',
        elementName: 'demo-device-tab',
        contributionId: 'main',
        label: 'Demo',
      },
    ]);
  });

  it('orders by order -> extension name -> contribution id', () => {
    const descriptors = extensionSlotDescriptorsFromRegistry(
      registry([
        extension({
          name: 'zeta',
          slots: [
            { id: 'b', slot: 'device.detail.tabs', contractVersion: 1, element: 'zeta-b', label: undefined, order: 1 },
            { id: 'a', slot: 'device.detail.tabs', contractVersion: 1, element: 'zeta-a', label: undefined, order: 1 },
          ],
        }),
        extension({
          name: 'alpha',
          slots: [
            { id: 'first', slot: 'device.detail.tabs', contractVersion: 1, element: 'alpha-first', label: undefined, order: 0 },
            { id: undefined, slot: 'device.detail.tabs', contractVersion: 1, element: 'alpha-unordered', label: undefined, order: undefined },
          ],
        }),
      ]),
      'device.detail.tabs',
      1,
    );
    expect(descriptors.map((d) => d.elementName)).toEqual([
      'alpha-first',
      'zeta-a',
      'zeta-b',
      'alpha-unordered',
    ]);
  });

  it('a disabled extension contributes nothing (registry omits it entirely)', () => {
    const descriptors = extensionSlotDescriptorsFromRegistry(registry([]), 'device.detail.tabs', 1);
    expect(descriptors).toEqual([]);
  });
});

describe('ExtensionSlotHost', () => {
  it('mounts the declared element with EXACTLY the documented device context — no full device/org leak', async () => {
    getExtensionRegistry.mockResolvedValue(
      registry([
        extension({
          name: 'demo',
          slots: [{ id: 'main', slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-device-tab', label: 'Demo', order: undefined }],
        }),
      ]),
    );

    render(
      <ExtensionSlotHost slot="device.detail.tabs" contractVersion={1} context={DEVICE_CONTEXT} />,
    );

    const stub = await screen.findByTestId('extension-element-host-stub');
    const props = JSON.parse(stub.dataset.props!);
    expect(props.elementName).toBe('demo-device-tab');
    expect(props.extensionName).toBe('demo');
    // Deep-equal to EXACTLY the documented shape — no extra fields (e.g. a
    // full `device` object, `orgName`, `siteName`, etc.) ever reach the
    // mounted element.
    expect(props.context).toEqual({
      contractVersion: 1,
      deviceId: 'd1',
      organizationId: 'o1',
      siteId: 's1',
    });
    expect(Object.keys(props.context).sort()).toEqual(
      ['contractVersion', 'deviceId', 'organizationId', 'siteId'].sort(),
    );
  });

  it('renders nothing when no enabled extension contributes to this slot', async () => {
    getExtensionRegistry.mockResolvedValue(registry([]));
    render(<ExtensionSlotHost slot="device.detail.tabs" contractVersion={1} context={DEVICE_CONTEXT} />);
    await waitFor(() => expect(getExtensionRegistry).toHaveBeenCalled());
    expect(screen.queryByTestId('extension-element-host-stub')).not.toBeInTheDocument();
  });

  it('renders nothing on a registry fetch failure (never throws)', async () => {
    getExtensionRegistry.mockRejectedValue(new Error('boom'));
    render(<ExtensionSlotHost slot="device.detail.tabs" contractVersion={1} context={DEVICE_CONTEXT} />);
    await waitFor(() => expect(getExtensionRegistry).toHaveBeenCalled());
    expect(screen.queryByTestId('extension-element-host-stub')).not.toBeInTheDocument();
  });

  it('renders every enabled descriptor, in deterministic order, when unscoped', async () => {
    getExtensionRegistry.mockResolvedValue(
      registry([
        extension({
          name: 'zeta',
          slots: [{ id: 'z', slot: 'organization.settings.sections', contractVersion: 1, element: 'zeta-org-section', label: undefined, order: undefined }],
        }),
        extension({
          name: 'alpha',
          slots: [{ id: 'a', slot: 'organization.settings.sections', contractVersion: 1, element: 'alpha-org-section', label: undefined, order: undefined }],
        }),
      ]),
    );

    render(
      <ExtensionSlotHost
        slot="organization.settings.sections"
        contractVersion={1}
        context={{ contractVersion: 1, organizationId: 'o1' }}
      />,
    );

    const stubs = await screen.findAllByTestId('extension-element-host-stub');
    expect(stubs).toHaveLength(2);
    const elementNames = stubs.map((s) => JSON.parse(s.dataset.props!).elementName);
    expect(elementNames).toEqual(['alpha-org-section', 'zeta-org-section']);
  });

  it('scopes to exactly one descriptor via descriptorKey — not all of them', async () => {
    getExtensionRegistry.mockResolvedValue(
      registry([
        extension({
          name: 'demo',
          slots: [
            { id: 'main', slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-device-tab', label: undefined, order: undefined },
            { id: 'secondary', slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-secondary-tab', label: undefined, order: undefined },
          ],
        }),
      ]),
    );

    render(
      <ExtensionSlotHost
        slot="device.detail.tabs"
        contractVersion={1}
        context={DEVICE_CONTEXT}
        descriptorKey="demo:main"
      />,
    );

    const stubs = await screen.findAllByTestId('extension-element-host-stub');
    expect(stubs).toHaveLength(1);
    expect(JSON.parse(stubs[0].dataset.props!).elementName).toBe('demo-device-tab');
  });
});
