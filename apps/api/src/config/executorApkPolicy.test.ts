import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The credential-boundary executors (`m365-graph-read`, `m365-communications`)
 * used to reject EVERY `apk` invocation: "executor runtime must not resolve
 * mutable Alpine packages during the image build". That made the images fully
 * reproducible from their pinned base digest, but it also made CVE-2026-14456
 * unfixable in them, because the only available mitigation is an `apk upgrade`
 * (the upstream `node:24-alpine` tag still ships the vulnerable 3.5.7-r0, so
 * refreshing the digest fixes nothing — issue #4246).
 *
 * The owner-approved resolution narrows the rule instead of dropping it: exactly
 * one literal `apk upgrade --no-cache libcrypto3 libssl3` is permitted, and
 * every other apk invocation stays rejected. The accepted tradeoff is that these
 * two builds become time-dependent rather than fully reproducible, bounded to
 * those two named packages.
 *
 * The danger in a change like this is not the CVE — it is writing an allowance
 * so broad that the policy is silently gone while the check still "passes". So
 * this suite proves the narrowed rule REJECTS, not just that it accepts. It
 * drives the real shipped bash rule (`--check-apk`) against its own fixtures,
 * deliberately NOT reusing the case list inside the script's `--self-test`, so
 * that deleting cases from that list cannot quietly reduce coverage here.
 */

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/security/check-supply-chain-hardening.sh');

const workdir = mkdtempSync(path.join(tmpdir(), 'apk-policy-'));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

/** Runs the real policy over a one-off Dockerfile; true when it is allowed. */
function policyAccepts(dockerfileBody: string): boolean {
  const file = path.join(workdir, `Dockerfile.${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, `FROM node:24-alpine AS runner\n${dockerfileBody}\n`);
  try {
    execFileSync('bash', [SCRIPT, '--check-apk', file], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('credential-boundary executor apk policy', () => {
  it('accepts the audited OpenSSL upgrade, in the shapes it really appears in', () => {
    expect(policyAccepts('RUN apk upgrade --no-cache libcrypto3 libssl3 && \\\n    rm -rf /tmp/x')).toBe(true);
    expect(policyAccepts('RUN apk upgrade --no-cache libcrypto3 libssl3')).toBe(true);
  });

  it('still rejects installing any new package', () => {
    // `apk add` is what the original rule existed to stop; narrowing the rule
    // must not have relaxed this.
    expect(policyAccepts('RUN apk add --no-cache wget')).toBe(false);
    expect(policyAccepts('RUN apk add --no-cache curl && rm -rf /var/cache/apk')).toBe(false);
  });

  it('still rejects a general or differently-scoped upgrade', () => {
    // The over-broad allowance this rule must never become.
    expect(policyAccepts('RUN apk upgrade')).toBe(false);
    expect(policyAccepts('RUN apk upgrade --no-cache')).toBe(false);
    expect(policyAccepts('RUN apk upgrade --no-cache openssl')).toBe(false);
    expect(policyAccepts('RUN apk -U upgrade libcrypto3 libssl3')).toBe(false);
  });

  it('requires the canonical literal form, not merely the right packages', () => {
    // Stricter than dockerfileOpensslUpgrade.test.ts, which tolerates either
    // order for images that are not credential boundaries. Intentional: on this
    // boundary the permitted string is pinned so the allowance cannot drift.
    expect(policyAccepts('RUN apk upgrade --no-cache libssl3 libcrypto3')).toBe(false);
    expect(policyAccepts('RUN apk upgrade --no-cache libcrypto3 libssl3 curl')).toBe(false);
    expect(policyAccepts('RUN apk del busybox')).toBe(false);
  });

  it('sees apk invocations the previous rule was blind to', () => {
    // The old rule only matched lines starting with RUN, so an apk on a
    // `\`-continuation line — or behind an absolute path — walked straight
    // through it. Narrowing the policy was the moment to close that too.
    expect(policyAccepts('RUN true && \\\n    apk add --no-cache curl')).toBe(false);
    expect(policyAccepts('RUN /sbin/apk add --no-cache curl')).toBe(false);
  });

  it('does not trip over prose that merely mentions apk', () => {
    expect(policyAccepts('# we deliberately never apk add anything in this image')).toBe(true);
  });

  it('ships a self-test that passes', () => {
    const out = execFileSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });

  it('applies the policy to both credential-boundary executors', () => {
    // Guards the wiring rather than the regex: if a future edit drops one of
    // these call sites, the rule silently stops running for that image.
    const script = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
    expect(script).toMatch(/reject_unaudited_apk "\$EXECUTOR_DOCKERFILE"/);
    expect(script).toMatch(/reject_unaudited_apk "\$COMMS_EXECUTOR_DOCKERFILE"/);
    // And the images themselves must actually pass it.
    for (const image of [
      'apps/m365-graph-read-executor/Dockerfile',
      'apps/m365-communications-executor/Dockerfile',
    ]) {
      expect(() =>
        execFileSync('bash', [SCRIPT, '--check-apk', path.join(REPO_ROOT, image)], { stdio: 'pipe' }),
      ).not.toThrow();
    }
  });
});
