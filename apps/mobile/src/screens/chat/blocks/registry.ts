import type { ReactNode } from 'react';
import { createElement } from 'react';

import { DeviceCard, type DeviceLike } from './DeviceCard';
import { FleetStatusRow } from './FleetStatusRow';
import { AlertCard, type AlertLike } from './AlertCard';
import { AlertSummaryRow } from './AlertSummaryRow';
import { AuditLogRow, type AuditEntryLike } from './AuditLogRow';
import { ScriptResultBlock, type ScriptResultLike } from './ScriptResultBlock';

const DEVICE_CARD_THRESHOLD = 3;
const ALERT_CARD_THRESHOLD = 2;

// Type-narrowing helpers for unknown JSON outputs from tool_result events.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---- Device shape sniffers -------------------------------------------

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

// ---- Alert shape sniffers --------------------------------------------

function looksLikeAlert(v: unknown): v is AlertLike {
  if (!isObject(v)) return false;
  // An alert shape has severity AND (title OR message). Without severity
  // we can't pick a dot color, so we don't claim it as an alert.
  if (typeof v.severity !== 'string') return false;
  return typeof v.title === 'string' || typeof v.message === 'string';
}

interface AlertListShape {
  alerts: AlertLike[];
  total: number;
}

function looksLikeAlertList(v: unknown): v is AlertListShape {
  if (!isObject(v)) return false;
  if (!Array.isArray(v.alerts)) return false;
  if (typeof v.total !== 'number') return false;
  return v.alerts.every((a) => isObject(a));
}

interface SingleAlertShape {
  alert: AlertLike;
}

function looksLikeSingleAlert(v: unknown): v is SingleAlertShape {
  if (!isObject(v)) return false;
  return looksLikeAlert(v.alert);
}

// ---- Audit log shape sniffers ----------------------------------------

function looksLikeAuditEntry(v: unknown): v is AuditEntryLike {
  if (!isObject(v)) return false;
  // An audit entry has actorType + action; that pair is distinctive
  // enough to avoid colliding with alerts or devices.
  return typeof v.actorType === 'string' && typeof v.action === 'string';
}

interface AuditListShape {
  entries: AuditEntryLike[];
}

function looksLikeAuditList(v: unknown): v is AuditListShape {
  if (!isObject(v)) return false;
  if (!Array.isArray(v.entries)) return false;
  return v.entries.every(looksLikeAuditEntry);
}

// ---- Script result shape sniffer -------------------------------------

function looksLikeScriptResult(v: unknown): v is ScriptResultLike {
  if (!isObject(v)) return false;
  // scriptName + numeric exitCode is the distinguishing signature.
  return typeof v.scriptName === 'string' && typeof v.exitCode === 'number';
}

// Returns a rendered block for the given tool result, or null if no v1
// block matches. The caller falls back to the generic ToolIndicator.
//
// Match order, most specific first:
//   1. Alert list / single alert   (severity + title/message)
//   2. Device list / single device (hostname OR id+status)
//   3. Audit log entries           (actorType + action)
//   4. Script result               (scriptName + exitCode)
//   5. null                        (caller falls back to ToolIndicator)
export function renderBlockForOutput(output: unknown): ReactNode | null {
  // Alert list
  if (looksLikeAlertList(output)) {
    if (output.alerts.length === 0) {
      // Empty list — text speaks for itself.
      return null;
    }
    if (output.alerts.length <= ALERT_CARD_THRESHOLD) {
      return output.alerts.map((a, i) =>
        createElement(AlertCard, { key: a.id ?? `a-${i}`, alert: a }),
      );
    }
    return createElement(AlertSummaryRow, {
      alerts: output.alerts,
      total: output.total,
    });
  }

  if (looksLikeSingleAlert(output)) {
    return createElement(AlertCard, { alert: output.alert });
  }

  // Device list
  if (looksLikeDeviceList(output)) {
    if (output.devices.length === 0) {
      // Empty list — nothing to render here; the AI's natural-language
      // reply will say "no devices match." Skip the block.
      return null;
    }
    if (output.devices.length <= DEVICE_CARD_THRESHOLD) {
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

  // Audit entries
  if (looksLikeAuditList(output)) {
    if (output.entries.length === 0) return null;
    return createElement(AuditLogRow, { entries: output.entries });
  }

  // Script result
  if (looksLikeScriptResult(output)) {
    return createElement(ScriptResultBlock, { result: output });
  }

  return null;
}
