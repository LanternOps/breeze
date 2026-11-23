/**
 * Contract (#8318 wave T2, services/deviceReattach/evidence.ts): every writer
 * of the device_hardware tpm_* key columns locks the DEVICE row first.
 *
 * Reattach evidence reads those columns with no lock of its own: the request
 * and confirm hold both device rows FOR UPDATE, and that keeps the key state
 * still only while every writer takes the device row lock (FOR NO KEY UPDATE
 * or stronger) before it touches device_hardware. A new writer that skipped it
 * could change the key under a confirm that already judged it.
 *
 *  - What it collects: object keys naming a tpm key column
 *    (`tpmEkPubSha256: …`, `tpmAttestedAt: …`, `tpmEkMismatchSha256: …`,
 *    `tpmEkMismatchAt: …`) whose value is not a column reference
 *    (`deviceHardware.…`, a select list), and raw SQL that sets one
 *    (`SET tpm_… =`), in every non-test file of apps/api/src except the schema.
 *  - When it fails: such a site sits in a file not listed below, or a listed
 *    file does not take its device row lock and then the key advisory lock
 *    BEFORE its first write site (by position in the file), or a listed file
 *    has no site left (stale entry). Each listed file has one writing
 *    function, so position in the file is the order the calls run in.
 *
 * Known residual: a write through a spread object built elsewhere is not
 * seen; the inventory writer never sets these columns (db/schema/devices.ts).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each allowed writer and the call that locks the device row before its device_hardware write. */
const WRITERS: Record<string, { lock: RegExp; why: string }> = {
  'services/tpmAttestation/index.ts': {
    lock: /selectOwnDeviceRowForUpdate\(/,
    why: 'the attestation completion: FOR NO KEY UPDATE on its own device row, then device_hardware',
  },
  'services/tpmBaseline/index.ts': {
    lock: /lockReattachDevices\(tx, \[input\.deviceId, input\.deviceId\], 'update'\)/,
    why: 'the key-change review: FOR UPDATE on the device row, then device_hardware',
  },
};

const KEY_WRITE = /\b(tpmEkPubSha256|tpmAttestedAt|tpmEkMismatchSha256|tpmEkMismatchAt)\s*:(?!\s*deviceHardware\.)/;
const RAW_WRITE = /\bSET\b[^;]*\btpm_(ek_pub_sha256|attested_at|ek_mismatch_sha256|ek_mismatch_at)\s*=/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !/\.(test|spec)\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function isWriteLine(line: string): boolean {
  return !/^\s*(\*|\/\/)/.test(line) && (KEY_WRITE.test(line) || RAW_WRITE.test(line));
}

function writeSites(): Map<string, number> {
  const sites = new Map<string, number>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).split(sep).join('/');
    if (rel.startsWith('db/schema/')) continue;
    const count = readFileSync(file, 'utf8').split('\n').filter(isWriteLine).length;
    if (count > 0) sites.set(rel, count);
  }
  return sites;
}

/** The line index of the first write site, and of the first line matching `pattern` (-1: none). */
function firstLines(file: string, pattern: RegExp): { write: number; match: number } {
  const lines = readFileSync(resolve(SRC_ROOT, file), 'utf8').split('\n');
  return {
    write: lines.findIndex(isWriteLine),
    match: lines.findIndex((line) => !/^\s*(\*|\/\/)/.test(line) && pattern.test(line)),
  };
}

describe('device_hardware tpm_* writers lock the device row first (#8318 wave T2)', () => {
  const sites = writeSites();

  it('every write site is in an allowed writer', () => {
    expect([...sites.keys()].filter((file) => !(file in WRITERS)).sort()).toEqual([]);
  });

  it.each(Object.entries(WRITERS))('%s takes its device row lock before its first write', (file, { lock }) => {
    const { write, match } = firstLines(file, lock);
    expect(match).toBeGreaterThanOrEqual(0);
    expect(match).toBeLessThan(write);
  });

  it.each(Object.entries(WRITERS))('%s takes the key advisory lock after the row lock and before its first write', (file, { lock }) => {
    const { write, match: keyLock } = firstLines(file, /await lockTpmKey\(tx, /);
    expect(keyLock).toBeGreaterThan(firstLines(file, lock).match);
    expect(keyLock).toBeLessThan(write);
  });

  it('no allowed writer is stale', () => {
    expect(Object.keys(WRITERS).filter((file) => !sites.has(file))).toEqual([]);
  });
});
