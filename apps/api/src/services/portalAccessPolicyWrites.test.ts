import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalAccessPolicyRowValues } from '@breeze/shared';

type Owner = 'org' | 'partner';
const store = vi.hoisted(() => ({
  org: null as Record<string, unknown> | null,
  partner: null as Record<string, unknown> | null,
  inserts: [] as Array<{ owner: Owner; values: Record<string, unknown>; config: Record<string, unknown> }>,
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => true,
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  db: {
    select: vi.fn(() => { throw new Error('writes must read through readPortalAccessPolicyRows'); }),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: (config: Record<string, unknown>) => ({
          returning: async () => {
            const owner: Owner = values.orgId ? 'org' : 'partner';
            store.inserts.push({ owner, values, config });
            const set = config.set as Record<string, unknown>;
            const prev = store[owner];
            const next = prev ? { ...prev, ...set } : { ...values };
            store[owner] = next;
            return [next];
          },
        }),
      }),
    })),
  },
}));

vi.mock('./portalAccessPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portalAccessPolicy')>();
  return {
    ...actual,
    readPortalAccessPolicyRows: vi.fn(async (args: { orgId: string | null; partnerId: string }) => ({
      org: args.orgId ? (store.org as PortalAccessPolicyRowValues | null) : null,
      partner: store.partner as PortalAccessPolicyRowValues | null,
    })),
  };
});

import { portalAccessPolicies } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { PartnerWideWriteDeniedError as LeafPartnerWideWriteDeniedError } from './partnerWideAccess';
import { __testOnly } from './portalAccessPolicy';
import {
  PartnerWideWriteDeniedError,
  PortalAccessPolicyValidationError,
  getOrgPortalAccessPolicyView,
  getPartnerPortalAccessPolicyView,
  updateOrgPortalAccessPolicy,
  updatePartnerPortalAccessPolicy,
} from './portalAccessPolicyWrites';

const ORG = { id: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', partnerId: '9f8e7d6c-5b4a-4f3e-9d2c-1b0a9f8e7d6c' };
const blank: PortalAccessPolicyRowValues = {
  entraEnabled: null, googleEnabled: null, passwordMode: null,
  selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null,
};
type WriteAuth = Parameters<typeof updatePartnerPortalAccessPolicy>[0];
const fullPartner = { scope: 'partner', partnerOrgAccess: 'all' } as Pick<AuthContext, 'scope' | 'partnerOrgAccess'> as WriteAuth;
const selectedPartner = { scope: 'partner', partnerOrgAccess: 'selected' } as Pick<AuthContext, 'scope' | 'partnerOrgAccess'> as WriteAuth;

async function validationError(p: Promise<unknown>): Promise<PortalAccessPolicyValidationError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PortalAccessPolicyValidationError);
  return err as PortalAccessPolicyValidationError;
}

beforeEach(() => {
  store.org = null;
  store.partner = null;
  store.inserts = [];
  __testOnly.setCapabilities(null);
});
afterEach(() => __testOnly.setCapabilities(null));

describe('write validation', () => {
  it('refuses entraEnabled true while caps.entra is false (METHOD_UNAVAILABLE, field entraEnabled)', async () => {
    const err = await validationError(updateOrgPortalAccessPolicy(ORG, { entraEnabled: true }));
    expect(err.code).toBe('PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE');
    expect(err.field).toBe('entraEnabled');
    const g = await validationError(updatePartnerPortalAccessPolicy(fullPartner, ORG.partnerId, { googleEnabled: true }));
    expect(g.code).toBe('PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE');
    expect(g.field).toBe('googleEnabled');
    const s = await validationError(updateOrgPortalAccessPolicy(ORG, { selfRegistrationMode: 'approval' }));
    expect(s.field).toBe('selfRegistrationMode');
    expect(store.inserts).toHaveLength(0);
  });

  it('refuses ssoNewPersonMode while no SSO capability exists', async () => {
    const err = await validationError(updateOrgPortalAccessPolicy(ORG, { ssoNewPersonMode: 'instant' }));
    expect(err.code).toBe('PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE');
    expect(err.field).toBe('ssoNewPersonMode');
    const hours = await validationError(updatePartnerPortalAccessPolicy(fullPartner, ORG.partnerId, { ssoSessionMaxHours: 8 }));
    expect(hours.field).toBe('ssoSessionMaxHours');
    expect(store.inserts).toHaveLength(0);

    // Turning things off, or clearing them, never needs a capability.
    const ok = await updateOrgPortalAccessPolicy(ORG, {
      entraEnabled: false, googleEnabled: false, selfRegistrationMode: 'off', ssoNewPersonMode: null, ssoSessionMaxHours: null,
    });
    expect(ok.changedFields).toEqual(['entraEnabled', 'googleEnabled', 'selfRegistrationMode']);

    // With a capability, the SSO settings are accepted.
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    const withCaps = await updateOrgPortalAccessPolicy(ORG, { ssoNewPersonMode: 'instant', ssoSessionMaxHours: 8 });
    expect(withCaps.changedFields).toEqual(['ssoNewPersonMode', 'ssoSessionMaxHours']);
  });

  it('refuses passwordMode sso_only when the would-be effective policy has no SSO method (SSO_ONLY_NEEDS_SSO)', async () => {
    __testOnly.setCapabilities({ entra: true, google: true, selfRegistration: false });
    const org = await validationError(updateOrgPortalAccessPolicy(ORG, { passwordMode: 'sso_only' }));
    expect(org.code).toBe('PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO');
    expect(org.field).toBe('passwordMode');

    // The org turns entra off in the same patch while the partner has it on.
    store.partner = { ...blank, entraEnabled: true };
    const off = await validationError(updateOrgPortalAccessPolicy(ORG, { passwordMode: 'sso_only', entraEnabled: false }));
    expect(off.code).toBe('PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO');

    // A partner write is judged against the built-in defaults, never against an org row.
    store.partner = null;
    const partner = await validationError(updatePartnerPortalAccessPolicy(fullPartner, ORG.partnerId, { passwordMode: 'sso_only' }));
    expect(partner.code).toBe('PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO');

    // Entra stored on, but the capability is gone: masked, so still refused.
    __testOnly.setCapabilities(null);
    store.org = { ...blank, entraEnabled: true };
    const masked = await validationError(updateOrgPortalAccessPolicy(ORG, { passwordMode: 'sso_only' }));
    expect(masked.code).toBe('PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO');
    expect(store.inserts).toHaveLength(0);
  });

  it('accepts passwordMode sso_only for an org that inherits entra on from the partner (caps on)', async () => {
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    store.partner = { ...blank, entraEnabled: true };
    const r = await updateOrgPortalAccessPolicy(ORG, { passwordMode: 'sso_only' });
    expect(r.changedFields).toEqual(['passwordMode']);
    expect(r.view.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    expect(r.view.passwordModeFallback).toBe(false);

    // A partner patch that turns entra on and sso_only together is judged on the merged row.
    const p = await updatePartnerPortalAccessPolicy(fullPartner, ORG.partnerId, { entraEnabled: true, passwordMode: 'sso_only' });
    expect(p.changedFields).toEqual(['passwordMode']);
    expect(p.view.effective.passwordMode).toEqual({ value: 'sso_only', source: 'partner' });
  });
});

describe('upserts', () => {
  it('null clears an org override; changedFields lists only real changes', async () => {
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    store.org = { ...blank, ssoSessionMaxHours: 8, ssoNewPersonMode: 'instant' };
    store.partner = { ...blank, ssoSessionMaxHours: 24 };
    const r = await updateOrgPortalAccessPolicy(ORG, {
      ssoSessionMaxHours: null, ssoNewPersonMode: 'instant', entraEnabled: null,
    });
    expect(r.changedFields).toEqual(['ssoSessionMaxHours']);
    expect(store.org?.ssoSessionMaxHours).toBeNull();
    expect(r.view.values.ssoSessionMaxHours).toBeNull();
    expect(r.view.effective.ssoSessionMaxHours).toEqual({ value: 24, source: 'partner' });
    expect(r.view.inherited.ssoSessionMaxHours).toEqual({ value: 24, source: 'partner' });

    const [insert] = store.inserts;
    expect(insert!.owner).toBe('org');
    expect(insert!.values).toMatchObject({ orgId: ORG.id, partnerId: null });
    expect(insert!.config.target).toBe(portalAccessPolicies.orgId);
    expect(insert!.config.targetWhere).toBeDefined();
    expect((insert!.config.set as Record<string, unknown>).updatedAt).toBeInstanceOf(Date);
  });

  it('a patch that changes nothing writes nothing', async () => {
    store.org = { ...blank, entraEnabled: false };
    const r = await updateOrgPortalAccessPolicy(ORG, { entraEnabled: false, googleEnabled: null });
    expect(r.changedFields).toEqual([]);
    expect(store.inserts).toHaveLength(0);
    const empty = await updateOrgPortalAccessPolicy(ORG, {});
    expect(empty.changedFields).toEqual([]);
    expect(store.inserts).toHaveLength(0);
    expect(empty.view.values.entraEnabled).toBe(false);
  });

  it('partner write without full partner access throws PartnerWideWriteDeniedError and writes nothing', async () => {
    const err = await updatePartnerPortalAccessPolicy(selectedPartner, ORG.partnerId, { passwordMode: 'allowed' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartnerWideWriteDeniedError);
    // Re-exported, not redefined: one class for every route's instanceof mapping.
    expect(PartnerWideWriteDeniedError).toBe(LeafPartnerWideWriteDeniedError);
    const orgScoped = { scope: 'organization', partnerOrgAccess: undefined } as unknown as WriteAuth;
    await expect(updatePartnerPortalAccessPolicy(orgScoped, ORG.partnerId, { passwordMode: 'allowed' }))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(store.inserts).toHaveLength(0);
  });

  it('a full partner admin upserts the partner row on the partner_id target', async () => {
    const r = await updatePartnerPortalAccessPolicy(fullPartner, ORG.partnerId, { passwordMode: 'allowed', ssoNewPersonMode: null });
    expect(r.changedFields).toEqual(['passwordMode']);
    const [insert] = store.inserts;
    expect(insert!.owner).toBe('partner');
    expect(insert!.values).toMatchObject({ partnerId: ORG.partnerId, orgId: null, passwordMode: 'allowed' });
    expect(insert!.config.target).toBe(portalAccessPolicies.partnerId);
    expect(insert!.config.targetWhere).toBeDefined();
    expect(r.view.owner).toEqual({ kind: 'partner', id: ORG.partnerId });
    expect(r.view.canEdit).toBe(true);
    expect(r.view.effective.passwordMode).toEqual({ value: 'allowed', source: 'partner' });
  });
});

describe('views', () => {
  it('org view: own values, inherited from partner/default, effective, capabilities, canEdit true', async () => {
    store.partner = { ...blank, ssoSessionMaxHours: 24, passwordMode: 'sso_only', entraEnabled: true };
    store.org = { ...blank, ssoNewPersonMode: 'invited_only' };
    const v = await getOrgPortalAccessPolicyView(ORG);
    expect(v.owner).toEqual({ kind: 'org', id: ORG.id });
    expect(v.values).toEqual({ ...blank, ssoNewPersonMode: 'invited_only' });
    expect(v.inherited.ssoSessionMaxHours).toEqual({ value: 24, source: 'partner' });
    expect(v.inherited.ssoNewPersonMode).toEqual({ value: 'approval', source: 'default' });
    // Masked: the deployment cannot run entra, so the inherited "on" resolves to off …
    expect(v.inherited.entraEnabled).toEqual({ value: false, source: 'partner' });
    // … and the inherited sso_only falls back.
    expect(v.inherited.passwordMode).toEqual({ value: 'allowed', source: 'partner' });
    expect(v.effective.ssoNewPersonMode).toEqual({ value: 'invited_only', source: 'org' });
    expect(v.passwordModeFallback).toBe(true);
    expect(v.capabilities).toEqual({ entra: false, google: false, selfRegistration: false });
    expect(v.canEdit).toBe(true);
  });

  it('org view with no rows: values all null, inherited and effective are the defaults', async () => {
    const v = await getOrgPortalAccessPolicyView(ORG);
    expect(v.values).toEqual(blank);
    expect(v.inherited.passwordMode).toEqual({ value: 'allowed', source: 'default' });
    expect(v.effective.passwordMode).toEqual({ value: 'allowed', source: 'default' });
    expect(v.passwordModeFallback).toBe(false);
  });

  it('partner view: canEdit follows canManagePartnerWidePolicies; inherited is always the built-in default', async () => {
    store.partner = { ...blank, ssoSessionMaxHours: 24 };
    const selected = await getPartnerPortalAccessPolicyView(selectedPartner, ORG.partnerId);
    expect(selected.canEdit).toBe(false);
    expect(selected.owner).toEqual({ kind: 'partner', id: ORG.partnerId });
    expect(selected.values.ssoSessionMaxHours).toBe(24);
    expect(selected.inherited.ssoSessionMaxHours).toEqual({ value: 12, source: 'default' });
    expect(selected.effective.ssoSessionMaxHours).toEqual({ value: 24, source: 'partner' });
    const full = await getPartnerPortalAccessPolicyView(fullPartner, ORG.partnerId);
    expect(full.canEdit).toBe(true);
  });
});
