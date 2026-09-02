import { describe, expect, it } from 'vitest';
import { buildAiBudgetAlertEmail, describeAiBudgetAlert, periodResetLabel, shouldEmail } from './aiBudgetAlertEmail';

const base = { orgName: 'Acme <Corp>', period: 'monthly' as const, periodKey: '2026-09', thresholdPct: 80, capCents: 10000, usedCents: 8123, billingSource: 'platform' as const, usagePath: '/settings/ai-usage', appBaseUrl: 'https://app.example.com' };

describe('describeAiBudgetAlert', () => {
  it('names the rung, org and period', () => {
    expect(describeAiBudgetAlert(base).title).toBe('AI budget at 80% for Acme <Corp> (monthly)');
    expect(describeAiBudgetAlert(base).message).toContain('$81.23 of $100.00');
  });
  it('uses cap-reached wording at 100', () => {
    const d = describeAiBudgetAlert({ ...base, thresholdPct: 100, usedCents: 10000 });
    expect(d.title).toBe('AI budget reached for Acme <Corp> (monthly)');
    expect(d.message).toContain('paused');
  });
});

describe('buildAiBudgetAlertEmail', () => {
  it('escapes the org name and links to the usage page', () => {
    const e = buildAiBudgetAlertEmail(base);
    expect(e.html).toContain('Acme &lt;Corp&gt;');
    expect(e.html).not.toContain('Acme <Corp>');
    expect(e.html).toContain('https://app.example.com/settings/ai-usage');
    expect(e.text).toContain('$81.23 of $100.00');
  });
  it('states the billing destination', () => {
    expect(buildAiBudgetAlertEmail(base).text).toContain('Breeze AI credits');
    expect(buildAiBudgetAlertEmail({ ...base, billingSource: 'partner_key' }).text).toContain('your Anthropic API key');
  });
});

describe('periodResetLabel', () => {
  it('monthly resets on the first of next month UTC', () => expect(periodResetLabel('monthly', '2026-09')).toBe('1 Oct 2026 00:00 UTC'));
  it('daily resets next UTC midnight', () => expect(periodResetLabel('daily', '2026-09-30')).toBe('1 Oct 2026 00:00 UTC'));
});

describe('shouldEmail', () => {
  it.each([['monthly', 50, true], ['monthly', 100, true], ['daily', 80, false], ['daily', 100, true]] as const)('%s %s → %s', (p, r, want) => {
    expect(shouldEmail(p, r)).toBe(want);
  });
});
