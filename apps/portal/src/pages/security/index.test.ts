import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const tableSource = readFileSync(
  new URL('../../components/portal/SecurityDeviceTable.tsx', import.meta.url),
  'utf8',
);

describe('security page fetch states', () => {
  it('never prints a raw transport error at the customer', () => {
    expect(pageSource).not.toMatch(/\{overview\.error\}/);
    expect(pageSource).not.toMatch(/\{devices\.error\}/);
  });

  it('surfaces both failures through ErrorNotice with copy that names the recovery', () => {
    expect(pageSource).toMatch(/import \{[^}]*ErrorNotice[^}]*\} from '\.\.\/\.\.\/components\/portal\/ui'/);
    expect(pageSource).toContain('data-testid="portal-security-error"');
    expect(pageSource).toContain(
      "We couldn't load your security summary just now. Your IT team can help.",
    );
    expect(pageSource).toContain('data-testid="portal-security-devices-error"');
    expect(pageSource).toContain(
      "We couldn't load your device list just now. Your IT team can help.",
    );
  });

  it('keeps a page title even when the summary fails to load', () => {
    expect(pageSource).toMatch(/import \{[^}]*PageHeader[^}]*\} from '\.\.\/\.\.\/components\/portal\/ui'/);
    expect(pageSource).toMatch(/<PageHeader\s+title="Security"/);
  });

  it('hands the device ledger the fleet total so it can foot itself honestly', () => {
    expect(pageSource).toMatch(/<SecurityDeviceTable[\s\S]*devices=\{devices\.data\.data\}/);
    expect(pageSource).toMatch(/<SecurityDeviceTable[\s\S]*timezone=\{devices\.data\.timezone\}/);
    expect(pageSource).toMatch(/<SecurityDeviceTable[\s\S]*total=\{devices\.data\.pagination\.total\}/);
    expect(pageSource).not.toContain('devices.data?.data ?? []');
    // The cap line is a ledger foot inside the table, not an unstyled page paragraph.
    expect(pageSource).not.toContain('portal-security-devices-cap');
    expect(tableSource).toContain('data-testid="portal-security-devices-cap"');
    expect(tableSource).toContain('Showing the first');
  });

  it('keeps the successful zero-device state distinct in the device table', () => {
    expect(tableSource).toContain('data-testid="portal-security-devices-empty"');
    expect(tableSource).toContain('No devices yet');
    expect(pageSource).not.toContain('portal-security-devices-empty');
  });
});
