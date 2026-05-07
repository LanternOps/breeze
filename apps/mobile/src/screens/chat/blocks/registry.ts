import type { ReactNode } from 'react';
import { createElement } from 'react';

import { DeviceCard, type DeviceLike } from './DeviceCard';
import { FleetStatusRow } from './FleetStatusRow';

const CARD_THRESHOLD = 3;

// Type-narrowing helpers for unknown JSON outputs from tool_result events.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function looksLikeDevice(v: unknown): v is DeviceLike {
  if (!isObject(v)) return false;
  // A device is identified by hostname OR (id AND status). This skips
  // generic { id, name } objects (e.g. orgs, sites) that share `id`.
  const hasHostname = typeof v.hostname === 'string';
  const hasIdPlusStatus =
    typeof v.id === 'string' && typeof v.status === 'string';
  return hasHostname || hasIdPlusStatus;
}

interface DeviceListShape {
  devices: DeviceLike[];
  total: number;
  showing?: number;
}

function looksLikeDeviceList(v: unknown): v is DeviceListShape {
  if (!isObject(v)) return false;
  if (!Array.isArray(v.devices)) return false;
  if (typeof v.total !== 'number') return false;
  // Tolerate empty arrays — they still represent a query result.
  return v.devices.every((d) => isObject(d));
}

interface SingleDeviceShape {
  device: DeviceLike;
}

function looksLikeSingleDevice(v: unknown): v is SingleDeviceShape {
  if (!isObject(v)) return false;
  return looksLikeDevice(v.device);
}

// Returns a rendered block for the given tool result, or null if no v1
// block matches. The caller falls back to the generic ToolIndicator.
export function renderBlockForOutput(output: unknown): ReactNode | null {
  if (looksLikeDeviceList(output)) {
    if (output.devices.length === 0) {
      // Empty list — nothing to render here; the AI's natural-language
      // reply will say "no devices match." Skip the block.
      return null;
    }
    if (output.devices.length <= CARD_THRESHOLD) {
      return output.devices.map((d, i) =>
        createElement(DeviceCard, { key: d.id ?? `d-${i}`, device: d }),
      );
    }
    return createElement(FleetStatusRow, {
      devices: output.devices,
      total: output.total,
    });
  }

  if (looksLikeSingleDevice(output)) {
    return createElement(DeviceCard, { device: output.device });
  }

  // Bare DeviceLike (unwrapped) — some tools may return the device directly.
  if (looksLikeDevice(output)) {
    return createElement(DeviceCard, { device: output });
  }

  return null;
}
