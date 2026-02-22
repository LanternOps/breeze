/**
 * Asset Approval Service
 *
 * Pure logic module for determining the approval status and alert behavior
 * when a discovered asset is processed. No side effects — all DB interaction
 * happens in the caller (discoveryWorker).
 */

import type { DiscoveryProfileAlertSettings } from '../db/schema';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a MAC address: lowercase + trim.
 * Returns null for falsy / empty-string input.
 */
export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const trimmed = mac.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toLowerCase();
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ApprovalDecisionInput {
  /** The existing discovered asset row, if any. null = brand-new device. */
  existingAsset: {
    approvalStatus: string;
    macAddress: string | null;
  } | null;

  /** The MAC address reported by the current scan (raw, not yet normalized). */
  incomingMac?: string | null;

  /** Whether the incoming MAC matches a known-guest entry. */
  isKnownGuest: boolean;

  /** The discovery profile's alert settings. */
  alertSettings: DiscoveryProfileAlertSettings;
}

export interface ApprovalDecision {
  /** The approval status to write to the discovered_assets row. */
  approvalStatus: 'pending' | 'approved' | 'dismissed';

  /** Whether an alert / change-event should be created. */
  shouldAlert: boolean;

  /** The event type for the change-event record (only meaningful when shouldAlert=true). */
  eventType?: 'new_device' | 'device_changed' | 'device_disappeared';
}

// ── Decision Logic ──────────────────────────────────────────────────────────

export function buildApprovalDecision(input: ApprovalDecisionInput): ApprovalDecision {
  const { existingAsset, isKnownGuest, alertSettings } = input;
  const incomingMac = normalizeMac(input.incomingMac);

  // 1. Known guest -> auto-approve, never alert
  if (isKnownGuest) {
    return { approvalStatus: 'approved', shouldAlert: false };
  }

  // 2. Brand-new device (no existing asset row)
  if (!existingAsset) {
    const shouldAlert = alertSettings.enabled && alertSettings.alertOnNew;
    return {
      approvalStatus: 'pending',
      shouldAlert,
      ...(shouldAlert ? { eventType: 'new_device' as const } : {})
    };
  }

  // 3. Dismissed device -> keep dismissed, never alert
  if (existingAsset.approvalStatus === 'dismissed') {
    return { approvalStatus: 'dismissed', shouldAlert: false };
  }

  // 4. MAC changed on a known (approved / pending) device
  const existingMac = normalizeMac(existingAsset.macAddress);
  if (incomingMac && existingMac && incomingMac !== existingMac) {
    const shouldAlert = alertSettings.enabled && alertSettings.alertOnChanged;
    return {
      approvalStatus: 'pending',
      shouldAlert,
      ...(shouldAlert ? { eventType: 'device_changed' as const } : {})
    };
  }

  // 5. No change -> preserve existing status, no alert
  return {
    approvalStatus: existingAsset.approvalStatus as 'pending' | 'approved' | 'dismissed',
    shouldAlert: false
  };
}
