import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { deviceHardware } from '../db/schema';
import { DEVICE_HARDWARE_READ_COLUMNS } from './deviceHardwareColumns';

/**
 * #8318 T1 (spec 2026-10-12 §12.2): the TPM EK baseline never leaves the API
 * through a generic device_hardware read. A whole-row select would carry it
 * into device detail, the hardware route or an AI tool's output.
 */
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '__tests__' ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('device_hardware reads (#8318 T1)', () => {
  it('DEVICE_HARDWARE_READ_COLUMNS has every column but the EK hashes', () => {
    expect(Object.keys(DEVICE_HARDWARE_READ_COLUMNS)).not.toContain('tpmEkPubSha256');
    expect(Object.keys(DEVICE_HARDWARE_READ_COLUMNS)).not.toContain('tpmEkMismatchSha256');
    const { tpmEkPubSha256: _ek, tpmEkMismatchSha256: _mismatch, ...all } = getTableColumns(deviceHardware);
    expect(Object.keys(DEVICE_HARDWARE_READ_COLUMNS).sort()).toEqual(Object.keys(all).sort());
  });

  it('no API source selects a whole device_hardware row', () => {
    const offenders = sources(SRC).filter((file) => /\.select\(\s*\)\s*\.from\(\s*deviceHardware\s*\)/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
