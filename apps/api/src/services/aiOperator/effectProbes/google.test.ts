/**
 * The Google half of probe -> write -> probe (Recipe Library spec 6.6).
 *
 * Every probe mirrors a shipped write in `services/aiToolsGoogle.ts` — same
 * client accessor, same impersonation, same argument keys. Google's client is
 * mocked; the real credential path is exercised only in a lab run.
 *
 * `google_signout` is `unknown` by design (no observable end state) and the
 * test pins that so nobody "fixes" it into a lastLoginTime heuristic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const usersGet = vi.fn();
const groupsList = vi.fn();
const mobileList = vi.fn();
const licenseList = vi.fn();
const getVacation = vi.fn();
const getAutoForwarding = vi.fn();
const forwardingGet = vi.fn();
const delegatesList = vi.fn();
const gmailFor = vi.fn();
const dirFor = vi.fn();

vi.mock('../../googleClient', () => ({
  getDirectoryClient: (...a: unknown[]) => {
    dirFor(...a);
    return { users: { get: usersGet }, groups: { list: groupsList }, mobiledevices: { list: mobileList } };
  },
  getGmailClient: (...a: unknown[]) => {
    gmailFor(...a);
    return {
      users: { settings: {
        getVacation, getAutoForwarding,
        forwardingAddresses: { get: forwardingGet },
        delegates: { list: delegatesList },
      } },
    };
  },
  getLicensingClient: () => ({ licenseAssignments: { listForProduct: licenseList } }),
}));
const resolveContextByOrg = vi.fn();
vi.mock('../../aiToolsGoogle', () => ({
  resolveContextByOrg: (...a: unknown[]) => resolveContextByOrg(...a),
  canonicalizeUserEmail: (raw: string) => {
    const e = raw.trim();
    return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e) ? e.toLowerCase() : null;
  },
}));

import {
  probeGoogleAddMailDelegate, probeGoogleRemoveFromGroup, probeGoogleRemoveLicense,
  probeGoogleSetForwarding, probeGoogleSetVacation, probeGoogleSignout,
  probeGoogleSuspendUser, probeGoogleWipeMobileDevice, registerGoogleEffectProbes,
} from './google';
import { __resetEffectProbesForTest, listProbedTools } from './index';
import type { PlannedEffect } from '../recipes/types';

const ctx = {
  orgId: 'o1', taskId: 't1', planRevision: 1,
  effectRequestedAt: new Date('2026-09-17T10:00:00Z'), phase: 'post' as const,
};
const eff = (toolName: string, canonicalArguments: Record<string, unknown>): PlannedEffect => ({
  ordinal: 0, toolName, provider: 'google', targetId: 'c1', accountExternalId: '101', canonicalArguments,
});

beforeEach(() => {
  vi.resetAllMocks();
  resolveContextByOrg.mockResolvedValue({ conn: { adminEmail: 'admin@customer.example' }, keyJson: '{}' });
});

describe('probeGoogleSuspendUser', () => {
  const e = eff('google_suspend_user', { userEmail: 'dana@customer.example', reason: 'offboarding' });
  it('satisfied when suspended', async () => {
    usersGet.mockResolvedValue({ data: { suspended: true } });
    await expect(probeGoogleSuspendUser(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(usersGet).toHaveBeenCalledWith({ userKey: 'dana@customer.example' });
    expect(dirFor).toHaveBeenCalledWith('{}', 'admin@customer.example');
  });
  it('unsatisfied when still active', async () => {
    usersGet.mockResolvedValue({ data: { suspended: false } });
    await expect(probeGoogleSuspendUser(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown on 404 (code)', async () => {
    usersGet.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }));
    await expect(probeGoogleSuspendUser(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
  it('unknown on 404 (response.status)', async () => {
    usersGet.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    await expect(probeGoogleSuspendUser(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
  it('unknown on missing userEmail, without calling Google', async () => {
    await expect(probeGoogleSuspendUser(eff('google_suspend_user', {}), ctx)).resolves.toMatchObject({ state: 'unknown' });
    expect(usersGet).not.toHaveBeenCalled();
  });
  it('rethrows non-404 API errors (registry converts to unknown)', async () => {
    usersGet.mockRejectedValue(Object.assign(new Error('boom'), { code: 500 }));
    await expect(probeGoogleSuspendUser(e, ctx)).rejects.toThrow('boom');
  });
  it('throws when the org has no Google connection', async () => {
    resolveContextByOrg.mockResolvedValue({ error: 'no_google_connection' });
    await expect(probeGoogleSuspendUser(e, ctx)).rejects.toThrow(/no_google_connection/);
  });
});

describe('probeGoogleRemoveFromGroup', () => {
  const e = eff('google_remove_from_group', {
    userEmail: 'dana@customer.example', groupEmail: 'sales@customer.example', reason: 'offboarding',
  });
  it('satisfied when the group is absent', async () => {
    groupsList.mockResolvedValue({ data: { groups: [{ email: 'all@customer.example' }] } });
    await expect(probeGoogleRemoveFromGroup(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(groupsList).toHaveBeenCalledWith({ userKey: 'dana@customer.example', maxResults: 200 });
  });
  it('satisfied on an empty list', async () => {
    groupsList.mockResolvedValue({ data: {} });
    await expect(probeGoogleRemoveFromGroup(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied while still a member, case-insensitively', async () => {
    groupsList.mockResolvedValue({ data: { groups: [{ email: 'Sales@Customer.Example' }] } });
    await expect(probeGoogleRemoveFromGroup(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown when the page is truncated (nextPageToken) and group not seen', async () => {
    groupsList.mockResolvedValue({ data: { groups: [{ email: 'a@customer.example' }], nextPageToken: 'x' } });
    await expect(probeGoogleRemoveFromGroup(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
  it('unknown on missing groupEmail', async () => {
    const r = await probeGoogleRemoveFromGroup(eff('google_remove_from_group', { userEmail: 'a@b.co' }), ctx);
    expect(r.state).toBe('unknown');
    expect(groupsList).not.toHaveBeenCalled();
  });
});

describe('probeGoogleRemoveLicense', () => {
  const e = eff('google_remove_license', {
    userEmail: 'dana@customer.example', productId: 'Google-Apps', skuId: '1010020020', reason: 'offboarding',
  });
  // licenseAssignments carry the PRIMARY email as userId, so the probe resolves it first.
  beforeEach(() => { usersGet.mockResolvedValue({ data: { primaryEmail: 'dana@customer.example' } }); });
  it('alias input with the license still held under the primary email is unsatisfied (not a false satisfied)', async () => {
    const alias = eff('google_remove_license', {
      userEmail: 'dana.alias@customer.example', productId: 'Google-Apps', skuId: '1010020020', reason: 'offboarding',
    });
    licenseList.mockResolvedValue({ data: { items: [{ userId: 'Dana@customer.example', skuId: '1010020020' }] } });
    await expect(probeGoogleRemoveLicense(alias, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
    expect(usersGet).toHaveBeenCalledWith({ userKey: 'dana.alias@customer.example' });
  });
  it('unknown when the user is not found (404), without listing licenses', async () => {
    usersGet.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }));
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
    expect(licenseList).not.toHaveBeenCalled();
  });
  it('unknown when the user resolves to no primaryEmail', async () => {
    usersGet.mockResolvedValue({ data: {} });
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
  it('rethrows non-404 users.get errors', async () => {
    usersGet.mockRejectedValue(Object.assign(new Error('boom'), { code: 500 }));
    await expect(probeGoogleRemoveLicense(e, ctx)).rejects.toThrow('boom');
  });
  it('satisfied when no assignment matches user and sku', async () => {
    licenseList.mockResolvedValue({ data: { items: [{ userId: 'other@customer.example', skuId: '1010020020' }] } });
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(licenseList).toHaveBeenCalledWith({ productId: 'Google-Apps', customerId: 'my_customer', maxResults: 100 });
  });
  it('unsatisfied while the assignment stands', async () => {
    licenseList.mockResolvedValue({ data: { items: [{ userId: 'Dana@customer.example', skuId: '1010020020' }] } });
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('same user, different sku is not a match', async () => {
    licenseList.mockResolvedValue({ data: { items: [{ userId: 'dana@customer.example', skuId: 'other' }] } });
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unknown when the page is full', async () => {
    licenseList.mockResolvedValue({
      data: { items: Array.from({ length: 100 }, (_, i) => ({ userId: `u${i}@customer.example`, skuId: '1010020020' })) },
    });
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
  it('unknown on missing skuId', async () => {
    const r = await probeGoogleRemoveLicense(eff('google_remove_license', { userEmail: 'a@b.co', productId: 'p' }), ctx);
    expect(r.state).toBe('unknown');
  });
});

describe('probeGoogleSetVacation', () => {
  const e = eff('google_set_vacation', {
    userEmail: 'dana@customer.example', enable: true, message: 'Dana has left.', reason: 'offboarding',
  });
  it('satisfied when on and carrying the message', async () => {
    getVacation.mockResolvedValue({ data: { enableAutoReply: true, responseBodyPlainText: 'Dana has left.' } });
    await expect(probeGoogleSetVacation(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(gmailFor).toHaveBeenCalledWith('{}', 'dana@customer.example');
    expect(getVacation).toHaveBeenCalledWith({ userId: 'me' });
  });
  it('satisfied when the message is only in the HTML body', async () => {
    getVacation.mockResolvedValue({ data: { enableAutoReply: true, responseBodyHtml: '<p>Dana has left.</p>' } });
    await expect(probeGoogleSetVacation(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied with different text', async () => {
    getVacation.mockResolvedValue({ data: { enableAutoReply: true, responseBodyPlainText: 'On holiday.' } });
    await expect(probeGoogleSetVacation(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unsatisfied when auto-reply is off', async () => {
    getVacation.mockResolvedValue({ data: { enableAutoReply: false } });
    await expect(probeGoogleSetVacation(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('enable:false is satisfied when auto-reply is off, unsatisfied when on', async () => {
    const off = eff('google_set_vacation', { userEmail: 'dana@customer.example', enable: false, reason: 'r' });
    getVacation.mockResolvedValue({ data: { enableAutoReply: false } });
    await expect(probeGoogleSetVacation(off, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    getVacation.mockResolvedValue({ data: { enableAutoReply: true } });
    await expect(probeGoogleSetVacation(off, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown on missing userEmail', async () => {
    await expect(probeGoogleSetVacation(eff('google_set_vacation', {}), ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
});

describe('probeGoogleSetForwarding', () => {
  const e = eff('google_set_forwarding', {
    userEmail: 'dana@customer.example', forwardTo: 'manager@customer.example', keepCopy: true, reason: 'offboarding',
  });
  it('satisfied only when enabled, addressed correctly and verified', async () => {
    getAutoForwarding.mockResolvedValue({ data: { enabled: true, emailAddress: 'manager@customer.example' } });
    forwardingGet.mockResolvedValue({ data: { verificationStatus: 'accepted' } });
    await expect(probeGoogleSetForwarding(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(forwardingGet).toHaveBeenCalledWith({ userId: 'me', forwardingEmail: 'manager@customer.example' });
  });
  it('unsatisfied when the destination is unverified', async () => {
    getAutoForwarding.mockResolvedValue({ data: { enabled: true, emailAddress: 'manager@customer.example' } });
    forwardingGet.mockResolvedValue({ data: { verificationStatus: 'pending' } });
    await expect(probeGoogleSetForwarding(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unsatisfied when forwarding points elsewhere or is disabled', async () => {
    getAutoForwarding.mockResolvedValue({ data: { enabled: true, emailAddress: 'someone@evil.example' } });
    await expect(probeGoogleSetForwarding(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
    getAutoForwarding.mockResolvedValue({ data: { enabled: false } });
    await expect(probeGoogleSetForwarding(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
    expect(forwardingGet).not.toHaveBeenCalled();
  });
  it('unsatisfied when the forwarding address record is gone (404)', async () => {
    getAutoForwarding.mockResolvedValue({ data: { enabled: true, emailAddress: 'manager@customer.example' } });
    forwardingGet.mockRejectedValue(Object.assign(new Error('nf'), { code: 404 }));
    await expect(probeGoogleSetForwarding(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown on missing forwardTo', async () => {
    await expect(probeGoogleSetForwarding(eff('google_set_forwarding', { userEmail: 'a@b.co' }), ctx))
      .resolves.toMatchObject({ state: 'unknown' });
  });
});

describe('probeGoogleAddMailDelegate', () => {
  const e = eff('google_add_mail_delegate', {
    userEmail: 'dana@customer.example', delegateEmail: 'manager@customer.example', reason: 'offboarding',
  });
  it('satisfied on an accepted delegate', async () => {
    delegatesList.mockResolvedValue({ data: { delegates: [{ delegateEmail: 'Manager@customer.example', verificationStatus: 'accepted' }] } });
    await expect(probeGoogleAddMailDelegate(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(gmailFor).toHaveBeenCalledWith('{}', 'dana@customer.example');
    expect(delegatesList).toHaveBeenCalledWith({ userId: 'me' });
  });
  it('unsatisfied on a pending delegate', async () => {
    delegatesList.mockResolvedValue({ data: { delegates: [{ delegateEmail: 'manager@customer.example', verificationStatus: 'pending' }] } });
    await expect(probeGoogleAddMailDelegate(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unsatisfied when absent', async () => {
    delegatesList.mockResolvedValue({ data: {} });
    await expect(probeGoogleAddMailDelegate(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown on missing delegateEmail', async () => {
    await expect(probeGoogleAddMailDelegate(eff('google_add_mail_delegate', { userEmail: 'a@b.co' }), ctx))
      .resolves.toMatchObject({ state: 'unknown' });
  });
});

describe('probeGoogleSignout', () => {
  it('is ALWAYS unknown and says why', async () => {
    const r = await probeGoogleSignout(eff('google_signout', { userEmail: 'dana@customer.example', reason: 'r' }), ctx);
    expect(r.state).toBe('unknown');
    expect(r.detail).toMatch(/session/i);
    expect(r.detail).toMatch(/no observable end state/i);
    expect(usersGet).not.toHaveBeenCalled();
    expect(resolveContextByOrg).not.toHaveBeenCalled();
  });
});

describe('probeGoogleWipeMobileDevice', () => {
  const e = eff('google_wipe_mobile_device', { userEmail: 'Dana@customer.example', reason: 'offboarding' });
  const primary = () => usersGet.mockResolvedValue({ data: { primaryEmail: 'Dana@customer.example' } });
  it('satisfied when every exact-matched device is WIPING or WIPED', async () => {
    primary();
    mobileList.mockResolvedValue({ data: { mobiledevices: [
      { resourceId: 'r1', email: ['dana@customer.example'], status: 'WIPING' },
      { resourceId: 'r2', email: ['dana@customer.example'], status: 'WIPED' },
    ] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(usersGet).toHaveBeenCalledWith({ userKey: 'dana@customer.example' });
    expect(mobileList).toHaveBeenCalledWith({ customerId: 'my_customer', query: 'email:dana@customer.example' });
  });
  it('ignores devices that do not carry the exact account', async () => {
    primary();
    mobileList.mockResolvedValue({ data: { mobiledevices: [
      { resourceId: 'r1', email: ['dana@customer.example'], status: 'WIPED' },
      { resourceId: 'r2', email: ['dana2@customer.example'], status: 'APPROVED' },
    ] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied while a matched device is APPROVED', async () => {
    primary();
    mobileList.mockResolvedValue({ data: { mobiledevices: [{ resourceId: 'r1', email: ['dana@customer.example'], status: 'APPROVED' }] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown when no device matches', async () => {
    primary();
    mobileList.mockResolvedValue({ data: { mobiledevices: [] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
  it('unknown when only non-matching devices come back', async () => {
    primary();
    mobileList.mockResolvedValue({ data: { mobiledevices: [{ resourceId: 'r2', email: ['dana2@customer.example'], status: 'WIPED' }] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
  it('unknown on a non-canonical email (wildcard) without calling Google', async () => {
    const r = await probeGoogleWipeMobileDevice(eff('google_wipe_mobile_device', { userEmail: 'a*@x.com' }), ctx);
    expect(r.state).toBe('unknown');
    expect(usersGet).not.toHaveBeenCalled();
  });
  it('unknown when the user 404s', async () => {
    usersGet.mockRejectedValue(Object.assign(new Error('nf'), { code: 404 }));
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
    expect(mobileList).not.toHaveBeenCalled();
  });
});

describe('registerGoogleEffectProbes', () => {
  it('registers exactly the eight Google write tools and returns their names', () => {
    __resetEffectProbesForTest();
    const names = registerGoogleEffectProbes();
    const expected = [
      'google_add_mail_delegate', 'google_remove_from_group', 'google_remove_license',
      'google_set_forwarding', 'google_set_vacation', 'google_signout',
      'google_suspend_user', 'google_wipe_mobile_device',
    ];
    expect([...names].sort()).toEqual(expected);
    expect(listProbedTools()).toEqual(expected);
    __resetEffectProbesForTest();
  });
});
