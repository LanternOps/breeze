// Renders every enabled extension contribution to a given v1 named slot
// (`device.detail.tabs` or `organization.settings.sections`), or exactly one
// of them when the caller wants to scope to a single active contribution
// (DeviceDetails' tab switcher — see `descriptorKey` below). Resolves
// descriptors from the Task 4 registry client and mounts each via
// `ExtensionElementHost` (Task 4) — this component owns ONLY slot resolution
// + ordering; loading, the event bridge, and the error boundary all stay in
// ExtensionElementHost.
//
// CONTEXT CONTRACT — `context` is passed through to every mounted element
// completely unchanged (same reference for all of them; ExtensionElementHost
// freezes it before assignment). Callers are responsible for constructing
// EXACTLY the documented shape (DeviceDetailTabContextV1 /
// OrganizationSettingsSectionContextV1 from @breeze/extension-web-sdk) — this
// component neither adds fields nor reads the device/org object itself, so
// there is nothing here that could leak beyond what the caller passed in.
import { useEffect, useState } from 'react';
import {
  getExtensionRegistry,
  type RuntimeWebExtension,
  type RuntimeWebRegistry,
  type RuntimeWebSlot,
} from '@/lib/extensions/registry';
import ExtensionElementHost from './ExtensionElementHost';

export interface ExtensionSlotDescriptor {
  /** `${extensionName}:${contributionId}` — unique across ALL extensions
   *  contributing to this slot (a bare `contributionId` is only unique
   *  *within* one extension's own manifest, per the server-side
   *  `slot:element`/`id` uniqueness check). Use this to scope
   *  `ExtensionSlotHost` to one contribution, and as the stable id embedded
   *  in DeviceDetails' `ext:<extensionName>:<contributionId>` tab ids. */
  readonly key: string;
  readonly extensionName: string;
  readonly moduleUrl: string;
  readonly elementName: string;
  readonly contributionId: string;
  readonly label: string | undefined;
}

export interface ExtensionSlotHostProps {
  /** Named slot id, e.g. `"device.detail.tabs"`. */
  slot: string;
  contractVersion: number;
  /** Frozen and handed unchanged to every mounted element's `context`. */
  context: Record<string, unknown>;
  /** Scope rendering to exactly one descriptor (its `.key`). Omitted renders
   *  every enabled descriptor for this slot, in deterministic order. */
  descriptorKey?: string;
}

function descriptorContributionId(slot: RuntimeWebSlot): string {
  return slot.id ?? `${slot.slot}:${slot.element}`;
}

function toDescriptor(extension: RuntimeWebExtension, slotItem: RuntimeWebSlot): ExtensionSlotDescriptor {
  const contributionId = descriptorContributionId(slotItem);
  return {
    key: `${extension.name}:${contributionId}`,
    extensionName: extension.name,
    moduleUrl: extension.moduleUrl,
    elementName: slotItem.element,
    contributionId,
    label: slotItem.label,
  };
}

interface RankedDescriptor {
  readonly descriptor: ExtensionSlotDescriptor;
  readonly order: number;
}

/** order -> extension name -> contribution id, matching the server
 *  projection's own tie-break (webRegistry.ts `slotKey`). */
function compareRanked(a: RankedDescriptor, b: RankedDescriptor): number {
  if (a.order !== b.order) return a.order - b.order;
  const nameCompare = a.descriptor.extensionName.localeCompare(b.descriptor.extensionName);
  if (nameCompare !== 0) return nameCompare;
  return a.descriptor.contributionId.localeCompare(b.descriptor.contributionId);
}

/** Pure projection, exported for direct unit-testing of the resolution/sort
 *  rules without mounting a component or mocking the registry client. */
export function extensionSlotDescriptorsFromRegistry(
  registry: RuntimeWebRegistry,
  slot: string,
  contractVersion: number,
): ExtensionSlotDescriptor[] {
  const ranked: RankedDescriptor[] = [];
  for (const extension of registry.extensions) {
    for (const slotItem of extension.slots) {
      if (slotItem.slot !== slot || slotItem.contractVersion !== contractVersion) continue;
      ranked.push({
        descriptor: toDescriptor(extension, slotItem),
        order: slotItem.order ?? Number.POSITIVE_INFINITY,
      });
    }
  }
  return ranked.sort(compareRanked).map((r) => r.descriptor);
}

/** Enabled descriptors for one slot@contractVersion, deterministically
 *  ordered. Never throws: a registry fetch failure resolves to an empty
 *  list (same posture as `useExtensionNavigation`). */
export function useExtensionSlotDescriptors(
  slot: string,
  contractVersion: number,
): ExtensionSlotDescriptor[] {
  const [descriptors, setDescriptors] = useState<ExtensionSlotDescriptor[]>([]);

  useEffect(() => {
    let cancelled = false;

    getExtensionRegistry()
      .then((registry) => {
        if (cancelled) return;
        setDescriptors(extensionSlotDescriptorsFromRegistry(registry, slot, contractVersion));
      })
      .catch(() => {
        if (!cancelled) setDescriptors([]);
      });

    return () => {
      cancelled = true;
    };
  }, [slot, contractVersion]);

  return descriptors;
}

export default function ExtensionSlotHost({
  slot,
  contractVersion,
  context,
  descriptorKey,
}: ExtensionSlotHostProps) {
  const descriptors = useExtensionSlotDescriptors(slot, contractVersion);
  const scoped =
    descriptorKey === undefined
      ? descriptors
      : descriptors.filter((d) => d.key === descriptorKey);

  if (scoped.length === 0) return null;

  return (
    <>
      {scoped.map((descriptor) => (
        <ExtensionElementHost
          key={descriptor.key}
          extensionName={descriptor.extensionName}
          moduleUrl={descriptor.moduleUrl}
          elementName={descriptor.elementName}
          context={context}
        />
      ))}
    </>
  );
}
