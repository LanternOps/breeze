import { describe, it, expect } from 'vitest';
import { normalizeMac, buildApprovalDecision } from './assetApproval';

describe('normalizeMac', () => {
  it('lowercases and trims', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
  });
  it('returns null for empty/null input', () => {
    expect(normalizeMac(null)).toBeNull();
    expect(normalizeMac('')).toBeNull();
  });
  it('returns null for undefined', () => {
    expect(normalizeMac(undefined)).toBeNull();
  });
  it('trims whitespace', () => {
    expect(normalizeMac('  aa:bb:cc:dd:ee:ff  ')).toBe('aa:bb:cc:dd:ee:ff');
  });
  it('returns null for whitespace-only string', () => {
    expect(normalizeMac('   ')).toBeNull();
  });
});

describe('buildApprovalDecision', () => {
  it('returns auto-approve for known guest MAC', () => {
    const decision = buildApprovalDecision({
      existingAsset: null,
      isKnownGuest: true,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: false, alertOnChanged: false, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('approved');
    expect(decision.shouldAlert).toBe(false);
  });

  it('returns pending + alert for new device when alertOnNew enabled', () => {
    const decision = buildApprovalDecision({
      existingAsset: null,
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: false, alertOnChanged: false, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('pending');
    expect(decision.shouldAlert).toBe(true);
    expect(decision.eventType).toBe('new_device');
  });

  it('returns no alert for new device when alertOnNew disabled', () => {
    const decision = buildApprovalDecision({
      existingAsset: null,
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: false, alertOnDisappeared: false, alertOnChanged: false, changeRetentionDays: 90 }
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it('returns pending + alert when MAC changes on approved device', () => {
    const decision = buildApprovalDecision({
      existingAsset: { approvalStatus: 'approved', macAddress: 'aa:bb:cc:00:00:01' },
      incomingMac: 'aa:bb:cc:00:00:02',
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: false, alertOnDisappeared: false, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('pending');
    expect(decision.shouldAlert).toBe(true);
    expect(decision.eventType).toBe('device_changed');
  });

  it('does not alert for dismissed device that reappears', () => {
    const decision = buildApprovalDecision({
      existingAsset: { approvalStatus: 'dismissed', macAddress: 'aa:bb:cc:00:00:01' },
      incomingMac: 'aa:bb:cc:00:00:01',
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: true, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it('does not alert when alerting is globally disabled', () => {
    const decision = buildApprovalDecision({
      existingAsset: null,
      isKnownGuest: false,
      alertSettings: { enabled: false, alertOnNew: true, alertOnDisappeared: true, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it('preserves approved status for unchanged approved device', () => {
    const decision = buildApprovalDecision({
      existingAsset: { approvalStatus: 'approved', macAddress: 'aa:bb:cc:00:00:01' },
      incomingMac: 'aa:bb:cc:00:00:01',
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: true, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('approved');
    expect(decision.shouldAlert).toBe(false);
  });

  it('preserves pending status for unchanged pending device', () => {
    const decision = buildApprovalDecision({
      existingAsset: { approvalStatus: 'pending', macAddress: 'aa:bb:cc:00:00:01' },
      incomingMac: 'aa:bb:cc:00:00:01',
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: true, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('pending');
    expect(decision.shouldAlert).toBe(false);
  });

  it('returns pending + alert when MAC changes on pending device', () => {
    const decision = buildApprovalDecision({
      existingAsset: { approvalStatus: 'pending', macAddress: 'aa:bb:cc:00:00:01' },
      incomingMac: 'aa:bb:cc:00:00:99',
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: false, alertOnDisappeared: false, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('pending');
    expect(decision.shouldAlert).toBe(true);
    expect(decision.eventType).toBe('device_changed');
  });

  it('known guest auto-approves even if existing asset is dismissed', () => {
    const decision = buildApprovalDecision({
      existingAsset: { approvalStatus: 'dismissed', macAddress: 'aa:bb:cc:00:00:01' },
      incomingMac: 'aa:bb:cc:00:00:01',
      isKnownGuest: true,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: true, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('approved');
    expect(decision.shouldAlert).toBe(false);
  });
});
