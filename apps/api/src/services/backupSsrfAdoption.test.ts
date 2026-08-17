/**
 * Contract test: the backup surface may not construct a raw outbound HTTP/S3
 * client from a tenant-supplied endpoint.
 *
 * The security finding this guards was *incomplete adoption*, not absent
 * defense. `services/urlSafety.ts` has been a strong SSRF guard for a long time
 * — DNS-resolved, IP-pinned, Host header discarded, redirects not followed,
 * metadata/link-local/CGNAT blocked — and the backup surface simply never
 * imported it, while `routes/backup/configs.ts` handed a tenant-controlled S3
 * endpoint straight to the AWS SDK from a *test connection* route.
 *
 * Fixing the three call sites is the perishable half of that fix; a new backup
 * feature can silently regrow the same hole next quarter. This test is the
 * durable half: it scans the source text of the backup surface and fails on any
 * outbound client that is not built through `createGuardedS3Client`
 * (`services/guardedS3Client.ts`) or `safeFetch`.
 *
 * Adding a legitimate exception is deliberately awkward — put it in ALLOWLIST
 * with a written reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_ROUTES_DIR = join(SERVICES_DIR, '..', 'routes', 'backup');

/**
 * Reviewed exceptions, keyed by file then by the specific pattern waived — NOT
 * whole-file waivers. A file that legitimately needs a raw `fetch` still fails
 * if it later grows an unguarded `new S3Client(`.
 *
 * `services/s3Storage.ts` is deliberately NOT scanned at all: it builds its
 * client from the server's own `S3_ENDPOINT` env var, which is
 * operator-controlled rather than tenant-controlled, so it sits outside this
 * threat model.
 */
const ALLOWLIST: Record<string, Record<string, string>> = {
  'guardedS3Client.ts': {
    'new S3Client(':
      'This IS the guard — the single sanctioned S3Client construction, wrapping every client in urlSafety-backed agents.',
    'new http(s).Agent(':
      'The guarded agents themselves; their lookup is urlSafety.createGuardedLookup.',
  },
  'recoveryMediaService.ts': {
    'global fetch(':
      'downloadFile() fetches the backup binary from the server-configured GitHub release URL (getGithubBackupUrl), not from any tenant-supplied value, and the asset is then verified against the signed release manifest. safeFetch cannot be used here: it deliberately does not follow redirects, and GitHub release asset URLs redirect to objects.githubusercontent.com.',
  },
};

/**
 * Raw outbound-client constructions. Each entry is [label, regex].
 * `fetch(` is matched only as a call, not as a property/identifier fragment.
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['new S3Client(', /new\s+S3Client\s*\(/],
  ['global fetch(', /(?<![.\w])fetch\s*\(/],
  ['axios', /\baxios\b/],
  ['http.request(', /\bhttps?\s*\.\s*request\s*\(/],
  ['new http(s).Agent(', /new\s+https?\s*\.\s*Agent\s*\(/],
  ['undici', /\bundici\b/],
];

function isScannableSource(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
}

function collectScannedFiles(): string[] {
  const files: string[] = [];

  // Every non-test route file under routes/backup/ — discovered, so a new file
  // in that directory is covered the day it lands.
  for (const name of readdirSync(BACKUP_ROUTES_DIR)) {
    if (isScannableSource(name)) files.push(join(BACKUP_ROUTES_DIR, name));
  }

  // Every services/backup*.ts, likewise discovered.
  for (const name of readdirSync(SERVICES_DIR)) {
    if (name.startsWith('backup') && isScannableSource(name)) {
      files.push(join(SERVICES_DIR, name));
    }
  }

  // Recovery services are reached FROM the backup routes and take the same
  // tenant-supplied provider config, so they belong to this surface even though
  // their names do not start with "backup". Named explicitly.
  for (const name of [
    'recoveryDownloadService.ts',
    'recoveryMediaService.ts',
    'recoveryBootMediaService.ts',
    'guardedS3Client.ts',
  ]) {
    files.push(join(SERVICES_DIR, name));
  }

  return files;
}

describe('backup surface SSRF guard adoption', () => {
  const files = collectScannedFiles();

  it('scans a non-empty, correctly-targeted file set', () => {
    // Without this a broken glob would make every assertion below vacuously
    // pass — the exact failure mode a source-scanning test is prone to.
    expect(files.length).toBeGreaterThan(10);
    const names = files.map((f) => basename(f));
    expect(names).toContain('configs.ts');
    expect(names).toContain('recoveryMediaService.ts');
    expect(names).toContain('guardedS3Client.ts');
    expect(names).toContain('backupSnapshotStorage.ts');
  });

  it('builds no raw outbound client from a tenant-supplied endpoint', () => {
    const violations: string[] = [];

    for (const file of files) {
      const name = basename(file);
      const waived = ALLOWLIST[name] ?? {};

      const source = readFileSync(file, 'utf8');
      for (const [label, pattern] of FORBIDDEN) {
        if (label in waived) continue;
        if (pattern.test(source)) {
          violations.push(
            `${name}: constructs a raw outbound client (${label}). ` +
              'Backup provider endpoints are tenant-supplied — build S3 clients with ' +
              'createGuardedS3Client() from services/guardedS3Client.ts, or make plain ' +
              'HTTP calls with safeFetch() from services/urlSafety.ts. If this really is ' +
              'a legitimate exception, add it to ALLOWLIST in this file with a reason.'
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('routes the tenant-endpoint S3 call sites through the guard', () => {
    // Positive assertion: the three known sites must actively import the guard.
    // The scan above only proves absence of the bad pattern; this proves the
    // good one is present, so deleting the client entirely cannot pass.
    const mustAdopt = [
      join(BACKUP_ROUTES_DIR, 'configs.ts'),
      join(SERVICES_DIR, 'recoveryDownloadService.ts'),
      join(SERVICES_DIR, 'recoveryMediaService.ts'),
    ];

    for (const file of mustAdopt) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${basename(file)} must import the guarded S3 client`).toMatch(
        /createGuardedS3Client/
      );
    }
  });

  it('validates the tenant endpoint before the probe issues a request', () => {
    // configs.ts is the test-connection route — the most reachable primitive.
    const source = readFileSync(join(BACKUP_ROUTES_DIR, 'configs.ts'), 'utf8');
    expect(source).toMatch(/assertSafeUrl\s*\(/);
  });
});
