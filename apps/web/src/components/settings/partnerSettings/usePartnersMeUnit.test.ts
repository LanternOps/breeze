import { describe, expect, it } from 'vitest';
import {
  buildPartnersMePayload,
  partnersMeValidity,
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
});
