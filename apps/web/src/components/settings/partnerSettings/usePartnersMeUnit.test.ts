import { describe, expect, it } from 'vitest';
import {
  allValidationErrorsShownOnFields,
  buildPartnersMePayload,
  partnersMeValidity,
  securityServerErrorsFrom,
  stateFromPartner,
  tabSnapshots,
  type Partner,
} from './usePartnersMeUnit';
import { PARTNERS_ME_FIXTURE } from './partnersMeFixture';

// Captured by running the pre-W2 `PartnerSettingsPage.handleSave` once against
// PARTNERS_ME_FIXTURE with the company name edited to "Acme MSP!". Never
// regenerate this from the new code.
const PRE_W2_PAYLOAD = '{"settings":{"timezone":"Europe/Berlin","dateFormat":"DD/MM/YYYY","timeFormat":"24h","language":"de-DE","contact":{"name":"Ada","email":"ada@example.com","website":"https://acme.example"},"address":{"street1":"1 Main St","city":"Springfield","country":"US"},"security":{"minLength":12,"sessionTimeout":720,"requireMfa":true,"ipAllowlist":[],"complexity":null,"expirationDays":null,"maxSessions":null},"notifications":{"fromAddress":"noc@example.com"},"eventLogs":{"retentionDays":30},"defaults":{"maintenanceWindow":"Sun 02:00-04:00"},"branding":{"primaryColor":"#123456"},"aiBudgets":{"enabled":true,"monthlyBudgetCents":5000,"alertThresholdPercents":[50,80]},"aiApprovals":{"timeoutMinutes":15},"remoteAccessProviders":{"teamviewer":{"enabled":true}},"networkProxy":{"dedicatedTunnelOrigin":false}},"name":"Acme MSP!","emailSignature":"Thanks,\\nAcme"}';

const fixtureState = () => stateFromPartner(PARTNERS_ME_FIXTURE as unknown as Partner);

describe('partners/me unit', () => {
  it('payload unchanged', () => {
    const state = { ...fixtureState(), companyName: 'Acme MSP!' };
    expect(JSON.stringify(buildPartnersMePayload(state))).toBe(PRE_W2_PAYLOAD);
  });

  it('omits networkProxy when the partner never chose and sends a null signature when cleared', () => {
    const state = { ...fixtureState(), networkProxy: {}, emailSignature: '   ' };
    const payload = buildPartnersMePayload(state) as { settings: Record<string, unknown>; emailSignature: unknown };
    expect(payload.settings).not.toHaveProperty('networkProxy');
    expect(payload.emailSignature).toBeNull();
  });

  it('a loaded state is valid and every tab matches its own baseline', () => {
    const state = fixtureState();
    expect(Object.values(partnersMeValidity(state)).every(v => v!.isValid)).toBe(true);
    expect(tabSnapshots(state)).toEqual(tabSnapshots(fixtureState()));
  });

  it('flags an invalid website, maintenance window and threshold text with their field ids', () => {
    const state = {
      ...fixtureState(),
      contact: { ...fixtureState().contact, website: 'ftp://acme.example' },
      defaults: { maintenanceWindow: 'whenever' },
      aiBudgetsThresholdsRaw: '50,abc',
    };
    const v = partnersMeValidity(state);
    expect(v.company).toEqual({ isValid: false, invalidCount: 1, firstInvalidFieldId: 'contact-website' });
    expect(v.defaults).toEqual({ isValid: false, invalidCount: 1, firstInvalidFieldId: 'partner-defaults-maintenance-window' });
    expect(v.aiBudgets).toEqual({ isValid: false, invalidCount: 1, firstInvalidFieldId: 'partner-ai-budget-thresholds' });
  });

  it('unparseable threshold text makes the AI budgets tab dirty without touching the ladder', () => {
    const base = fixtureState();
    const edited = { ...base, aiBudgetsThresholdsRaw: '50,abc' };
    expect(tabSnapshots(edited).aiBudgets).not.toBe(tabSnapshots(base).aiBudgets);
    expect(buildPartnersMePayload(edited)).toEqual(buildPartnersMePayload(base));
  });

  it('a threshold box hidden by disabled budgets never blocks Save', () => {
    const state = { ...fixtureState(), aiBudgets: { enabled: false }, aiBudgetsThresholdsRaw: 'abc' };
    expect(partnersMeValidity(state).aiBudgets?.isValid).toBe(true);
  });

  it('flags security limits outside the shared server bounds, first field in form order (#10081)', () => {
    const base = fixtureState();
    const state = { ...base, security: { ...base.security, maxSessions: 0, minLength: 2 } };
    expect(partnersMeValidity(state).security).toEqual({ isValid: false, invalidCount: 2, firstInvalidFieldId: 'partner-security-min-length' });
    expect(partnersMeValidity({ ...base, security: { ...base.security, minLength: 6 } }).security?.isValid).toBe(true);
  });

  it('maps a server 400 on a security limit to its field until the value changes (#10081)', () => {
    const sent = fixtureState();
    const body = {
      error: 'settings.security.minLength: Too small; settings.contact.email: Invalid email',
      details: { formErrors: [], fieldErrors: { 'settings.security.minLength': ['Too small'], 'settings.contact.email': ['Invalid email'] } },
    };
    const errors = securityServerErrorsFrom(body, sent.security);
    expect(errors).toEqual({ minLength: { message: 'Too small', sent: 12 } });
    expect(partnersMeValidity(sent, errors).security).toEqual({ isValid: false, invalidCount: 1, firstInvalidFieldId: 'partner-security-min-length' });
    const edited = { ...sent, security: { ...sent.security, minLength: 14 } };
    expect(partnersMeValidity(edited, errors).security?.isValid).toBe(true);
    expect(securityServerErrorsFrom({ error: 'boom' }, sent.security)).toEqual({});
    expect(securityServerErrorsFrom(null, sent.security)).toEqual({});
  });

  it('drops the toast details only when every 400 problem is shown on a field (#10081)', () => {
    const sent = { minLength: 4 };
    const body = (fieldErrors: Record<string, string[]>, formErrors: string[] = []) => ({ error: 'x', details: { formErrors, fieldErrors } });
    expect(allValidationErrorsShownOnFields(body({ 'settings.security.minLength': ['Too small'] }), sent, sent)).toBe(true);
    // A problem with no field to show it on keeps the full toast.
    expect(allValidationErrorsShownOnFields(body({ 'settings.security.minLength': ['Too small'], 'settings.contact.email': ['Invalid email'] }), sent, sent)).toBe(false);
    expect(allValidationErrorsShownOnFields(body({ 'settings.security.minLength': ['Too small'] }, ['Unrecognized key']), sent, sent)).toBe(false);
    expect(allValidationErrorsShownOnFields(body({}), sent, sent)).toBe(false);
    expect(allValidationErrorsShownOnFields({ error: 'boom' }, sent, sent)).toBe(false);
    expect(allValidationErrorsShownOnFields({ error: 'x', details: 'nope' }, sent, sent)).toBe(false);
    // Edited while the request was in flight: the field no longer shows the verdict.
    expect(allValidationErrorsShownOnFields(body({ 'settings.security.minLength': ['Too small'] }), sent, { minLength: 9 })).toBe(false);
  });
});
