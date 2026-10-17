import { describe, expect, it } from 'vitest';
import {
  accountingHealth,
  backupProviderHealth,
  dnsFilterHealth,
  edrHealth,
  huntressHealth,
  m365ConnectionHealth,
  m365SyncHealth,
  MAILBOX_TRANSIENT_FAILURE_THRESHOLD,
  pax8Health,
  sentinelOneHealth,
  ticketMailboxHealth,
  unifiHealth,
  type HealthVerdict,
} from './integrationStates';

const healthy: HealthVerdict = { state: 'healthy' };
const unknown: HealthVerdict = { state: 'unknown' };
const retired: HealthVerdict = { state: 'retired' };
const transient = (condition: string): HealthVerdict => ({ state: 'broken', severity: 'transient', condition });
const permanent = (condition: string): HealthVerdict => ({ state: 'broken', severity: 'permanent', condition });

describe('connection health verdicts (W2 Sources table)', () => {
  it.each([
    ['huntress error', huntressHealth({ isActive: true, lastSyncStatus: 'error' }), transient('sync_failed')],
    ['huntress success', huntressHealth({ isActive: true, lastSyncStatus: 'success' }), healthy],
    ['huntress running', huntressHealth({ isActive: true, lastSyncStatus: 'running' }), unknown],
    ['huntress never synced', huntressHealth({ isActive: true, lastSyncStatus: null }), unknown],
    ['huntress inactive', huntressHealth({ isActive: false, lastSyncStatus: 'error' }), retired],
    ['s1 error', sentinelOneHealth({ isActive: true, lastSyncStatus: 'error' }), transient('sync_failed')],
    ['s1 partial', sentinelOneHealth({ isActive: true, lastSyncStatus: 'partial' }), healthy],
    ['s1 inactive', sentinelOneHealth({ isActive: false, lastSyncStatus: 'success' }), retired],
    ['pax8 failed', pax8Health({ isActive: true, lastSyncStatus: 'failed' }), transient('sync_failed')],
    ['pax8 error is not its failure value', pax8Health({ isActive: true, lastSyncStatus: 'error' }), unknown],
    ['pax8 success', pax8Health({ isActive: true, lastSyncStatus: 'success' }), healthy],
    ['pax8 running', pax8Health({ isActive: true, lastSyncStatus: 'running' }), unknown],
  ])('%s', (_name, actual, expected) => expect(actual).toEqual(expected));

  it.each([
    ['unifi reauth', unifiHealth({ isActive: true, status: 'reauth_required', lastSyncStatus: 'failed' }), permanent('reauth_required')],
    ['unifi error status', unifiHealth({ isActive: true, status: 'error', lastSyncStatus: 'success' }), transient('sync_failed')],
    ['unifi failed sync', unifiHealth({ isActive: true, status: 'connected', lastSyncStatus: 'failed' }), transient('sync_failed')],
    ['unifi partial', unifiHealth({ isActive: true, status: 'connected', lastSyncStatus: 'partial' }), healthy],
    ['unifi pending', unifiHealth({ isActive: true, status: 'pending', lastSyncStatus: null }), unknown],
    ['unifi never synced', unifiHealth({ isActive: true, status: 'connected', lastSyncStatus: null }), unknown],
    ['unifi inactive', unifiHealth({ isActive: false, status: 'error', lastSyncStatus: 'failed' }), retired],
    ['backup reauth', backupProviderHealth({ isActive: true, status: 'reauth_required', lastSyncStatus: 'error' }), permanent('reauth_required')],
    ['backup error', backupProviderHealth({ isActive: true, status: 'connected', lastSyncStatus: 'error' }), transient('sync_failed')],
    ['backup connection error', backupProviderHealth({ isActive: true, status: 'error', lastSyncStatus: 'success' }), transient('sync_failed')],
    ['backup retry clears the error', backupProviderHealth({ isActive: true, status: 'connected', lastSyncStatus: 'running' }), unknown],
    ['backup success', backupProviderHealth({ isActive: true, status: 'connected', lastSyncStatus: 'success' }), healthy],
    ['backup partial (alerts only)', backupProviderHealth({ isActive: true, status: 'connected', lastSyncStatus: 'partial' }), healthy],
    ['backup inactive', backupProviderHealth({ isActive: false, status: 'reauth_required', lastSyncStatus: 'error' }), retired],
  ])('%s', (_name, actual, expected) => expect(actual).toEqual(expected));

  const edr = (over: Partial<Parameters<typeof edrHealth>[0]>) => edrHealth({
    isActive: true, status: 'connected', lastInventorySyncStatus: 'success', lastDetectionSyncStatus: 'success', ...over,
  });
  it.each([
    ['edr reauth beats a stream error', edr({ status: 'reauth_required', lastDetectionSyncStatus: 'error' }), permanent('reauth_required')],
    ['edr detection error', edr({ lastDetectionSyncStatus: 'error' }), transient('sync_failed')],
    ['edr inventory error while detection runs', edr({ lastInventorySyncStatus: 'error', lastDetectionSyncStatus: 'running' }), transient('sync_failed')],
    ['edr a stream running', edr({ lastInventorySyncStatus: 'running' }), unknown],
    ['edr partial', edr({ lastInventorySyncStatus: 'partial' }), healthy],
    ['edr never synced', edr({ lastInventorySyncStatus: null, lastDetectionSyncStatus: null }), unknown],
    ['edr one stream synced', edr({ lastInventorySyncStatus: null }), healthy],
    ['edr inactive', edr({ isActive: false, status: 'reauth_required' }), retired],
  ])('%s', (_name, actual, expected) => expect(actual).toEqual(expected));

  it.each([
    ['accounting connected', accountingHealth({ status: 'connected' }), healthy],
    ['accounting reauth', accountingHealth({ status: 'reauth_required' }), permanent('reauth_required')],
    ['accounting disconnected', accountingHealth({ status: 'disconnected' }), permanent('disconnected')],
    ['accounting error', accountingHealth({ status: 'error' }), transient('error')],
    ['accounting connect in progress', accountingHealth({ status: 'pending_tenant' }), unknown],
    ['dns error', dnsFilterHealth({ isActive: true, lastSyncStatus: 'error' }), transient('sync_failed')],
    ['dns success', dnsFilterHealth({ isActive: true, lastSyncStatus: 'success' }), healthy],
    ['dns never synced', dnsFilterHealth({ isActive: true, lastSyncStatus: null }), unknown],
    ['dns inactive', dnsFilterHealth({ isActive: false, lastSyncStatus: 'error' }), retired],
  ])('%s', (_name, actual, expected) => expect(actual).toEqual(expected));

  it.each([
    ['m365 active', m365ConnectionHealth({ status: 'active', lastErrorCode: null }), healthy],
    ['m365 active keeps healthy with an infra code', m365ConnectionHealth({ status: 'active', lastErrorCode: 'executor_unavailable' }), healthy],
    ['m365 degraded consent code', m365ConnectionHealth({ status: 'degraded', lastErrorCode: 'grant_missing' }), permanent('grant_missing')],
    ['m365 degraded tenant mismatch', m365ConnectionHealth({ status: 'degraded', lastErrorCode: 'tenant_mismatch' }), permanent('tenant_mismatch')],
    ['m365 degraded transient', m365ConnectionHealth({ status: 'degraded', lastErrorCode: 'grant_reconciliation_unavailable' }), transient('grant_reconciliation_unavailable')],
    ['m365 degraded without code', m365ConnectionHealth({ status: 'degraded', lastErrorCode: null }), transient('degraded')],
    ['m365 suspended', m365ConnectionHealth({ status: 'suspended', lastErrorCode: null }), permanent('suspended')],
    ['m365 revoked is a deliberate disconnect', m365ConnectionHealth({ status: 'revoked', lastErrorCode: null }), retired],
    ['m365 consent in progress', m365ConnectionHealth({ status: 'pending-consent', lastErrorCode: 'consent_cancelled' }), unknown],
    ['m365 verifying', m365ConnectionHealth({ status: 'verifying', lastErrorCode: null }), unknown],
  ])('%s', (_name, actual, expected) => expect(actual).toEqual(expected));

  it.each([
    ['sync needs consent beats error', m365SyncHealth('active', ['success', 'error', 'needs_consent']), permanent('needs_consent')],
    ['sync error', m365SyncHealth('active', ['success', 'error']), transient('sync_failed')],
    ['sync all good', m365SyncHealth('active', ['success', 'partial', 'throttled', null]), healthy],
    ['sync only throttled', m365SyncHealth('active', ['throttled', null]), unknown],
    ['sync with a degraded parent', m365SyncHealth('degraded', ['needs_consent']), unknown],
    ['sync with a missing parent', m365SyncHealth(null, ['error']), unknown],
    ['sync without rows', m365SyncHealth('active', []), retired],
  ])('%s', (_name, actual, expected) => expect(actual).toEqual(expected));

  it.each([
    ['mailbox reauth', ticketMailboxHealth({ status: 'reauth_required', consecutiveTransientFailures: 0 }), permanent('reauth_required')],
    ['mailbox error', ticketMailboxHealth({ status: 'error', consecutiveTransientFailures: 0 }), transient('mailbox_error')],
    ['mailbox polls failing', ticketMailboxHealth({ status: 'connected', consecutiveTransientFailures: 5 }), transient('poll_failing')],
    ['mailbox a few failures', ticketMailboxHealth({ status: 'connected', consecutiveTransientFailures: 4 }), healthy],
    ['mailbox pending consent', ticketMailboxHealth({ status: 'pending_consent', consecutiveTransientFailures: 0 }), unknown],
    ['mailbox disabled', ticketMailboxHealth({ status: 'disabled', consecutiveTransientFailures: 9 }), retired],
  ])('%s', (_name, actual, expected) => expect(actual).toEqual(expected));

  it('pins the mailbox threshold from the spec', () => {
    expect(MAILBOX_TRANSIENT_FAILURE_THRESHOLD).toBe(5);
  });
});
