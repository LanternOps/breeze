import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const tableSource = readFileSync(
  new URL('../../components/portal/SecurityDeviceTable.tsx', import.meta.url),
  'utf8',
);

describe('security page device fetch states', () => {
  it('renders a dedicated devices error instead of the empty table state on fetch failure', () => {
    expect(pageSource).toContain('data-testid="portal-security-devices-error"');
    expect(pageSource).toContain('{devices.error}');
    expect(pageSource).toMatch(
      /devices\.data\s*\?\s*<SecurityDeviceTable devices=\{devices\.data\.data\} \/>\s*:\s*<p data-testid="portal-security-devices-error">\{devices\.error\}<\/p>/,
    );
    expect(pageSource).not.toContain('devices.data?.data ?? []');
  });

  it('keeps the successful zero-device state distinct in the device table', () => {
    expect(tableSource).toContain('data-testid="portal-security-devices-empty"');
    expect(tableSource).toContain('No devices are enrolled.');
    expect(pageSource).not.toContain('portal-security-devices-empty');
  });
});
