import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against the "new service image ships without the OpenSSL upgrade the
 * other images have" class (issue #4246).
 *
 * Every production image in this repo pins its base by digest. A pinned digest
 * freezes the Alpine package set at whatever shipped that day, so when upstream
 * publishes a fix for a libcrypto3/libssl3 CVE the image keeps the vulnerable
 * version until someone bumps the digest. The established mitigation is to
 * refresh just those two packages in the runtime stage:
 *
 *   RUN apk upgrade --no-cache libcrypto3 libssl3 && \
 *       rm -rf ...
 *
 * `docker/Dockerfile.api`, `docker/Dockerfile.web` and `apps/portal/Dockerfile`
 * carried that line; the three M365 executor images were added later and never
 * got it, so `Trivy Image Scan` went red on `main` for CVE-2026-14456 and stayed
 * red across six unrelated PRs — a permanently-red security job stops being a
 * signal and starts masking real findings.
 *
 * This is a static text check over the Dockerfiles; it never invokes Docker.
 *
 * Two things make the naive check ("does the file contain `apk upgrade`?")
 * wrong, and this guard models both:
 *
 *  1. **Stage placement.** A build stage is discarded — an upgrade there fixes
 *     nothing while looking perfectly correct in a diff. Only the final stage
 *     is shipped.
 *  2. **Stage inheritance.** `FROM base AS runner` *inherits* base's filesystem,
 *     so an upgrade run in `base` genuinely does reach the shipped image (this
 *     is how `docker/Dockerfile.api` is structured). But `COPY --from=builder`
 *     copies only named paths and carries no package state, so an upgrade in a
 *     stage that is merely copied from does NOT count.
 *
 * So the rule is: the upgrade must appear somewhere in the final stage's
 * `FROM`-inheritance chain.
 *
 * Which Dockerfiles are in scope is derived from the files themselves rather
 * than hand-listed: an image is in scope when its final stage's inheritance
 * chain bottoms out at a digest-pinned `node:*-alpine` base. That is exactly the
 * set that both ships to users and freezes its package set. The `.dev` images
 * use a floating tag (they re-pull fixes on every rebuild and are never shipped)
 * and `docker/Dockerfile.binaries` is a non-node `alpine:*` packaging image, so
 * both fall out of scope on the base ref, with no allowlist to rot.
 *
 * Because that classification is derived, a companion test snapshots it — if a
 * new image appears, or a base ref changes shape, the snapshot fails and forces
 * a human to decide which side of the line it belongs on, rather than letting an
 * image drop silently out of coverage.
 *
 * Two assumptions this guard rests on, recorded so they are not rediscovered
 * the hard way:
 *
 *  - **"Last stage in the file" == "the stage that ships."** True for every
 *    Dockerfile here today, but a `docker build --target <stage>` in a workflow
 *    would ship an earlier stage and quietly defeat the whole check. Nothing in
 *    the repo does that at present.
 *  - The supply-chain contract below proves the hardening *rule text* still
 *    admits only the exact two-package CVE repair; it cannot prove the
 *    hardening *script* is still wired into CI. If that script were dropped
 *    from its workflow the control would stop running while this suite stayed
 *    green.
 */

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The packages CVE-2026-14456 is fixed in. */
const REQUIRED_PACKAGES = ['libcrypto3', 'libssl3'] as const;

/**
 * True when `bodies` collectively `apk upgrade` both OpenSSL packages.
 *
 * Deliberately order-independent, and tolerant of the two being split across
 * separate `apk upgrade` commands: `apk` does not care about argument order, so
 * a guard that did would reject a Dockerfile that is genuinely patched and send
 * the next author hunting for a bug that is not there. What it still requires is
 * that each package be named on an actual `apk upgrade` line — a bare mention in
 * a comment or an `apk add` does not count.
 */
function upgradesOpenssl(bodies: string[]): boolean {
  const upgraded = new Set<string>();
  for (const body of bodies) {
    for (const line of body.split('\n')) {
      // Credit a package only when it is a standalone argument of an actual
      // `apk upgrade` command, scoped to that command's own arguments (up to
      // the next shell separator). A `\b`-only match on the whole line credited
      // `apk upgrade libcrypto3 && apk add libssl3-dev` — the `-dev` is a
      // *different*, still-vulnerable package — and a bare `echo "...libssl3"`.
      for (const match of line.matchAll(/\bapk\s+upgrade\b(.*?)(?=&&|[;|]|$)/g)) {
        const args = match[1] ?? '';
        for (const pkg of REQUIRED_PACKAGES) {
          if (new RegExp(`(?:^|\\s)${pkg}(?=\\s|$)`).test(args)) upgraded.add(pkg);
        }
      }
    }
  }
  return REQUIRED_PACKAGES.every((pkg) => upgraded.has(pkg));
}

/**
 * A digest-pinned node Alpine base, e.g.
 * `node:24-alpine@sha256:d32cdf61...`. The digest pin is what freezes the
 * package set and therefore what creates the exposure this guard covers.
 */
const PINNED_NODE_ALPINE_RE = /^node:[^\s@]*-alpine@sha256:[0-9a-f]{64}$/;

/** Customer-Graph credential-boundary images with the narrow CVE exception. */
const CREDENTIAL_BOUNDARY_DOCKERFILES = [
  'apps/m365-graph-read-executor/Dockerfile',
  'apps/m365-graph-actions-executor/Dockerfile',
  'apps/m365-communications-executor/Dockerfile',
] as const;

/** Hardening-script shell variable each credential-boundary Dockerfile is checked through. */
const CREDENTIAL_BOUNDARY_SCRIPT_VARIABLE: Record<(typeof CREDENTIAL_BOUNDARY_DOCKERFILES)[number], string> = {
  'apps/m365-graph-read-executor/Dockerfile': 'EXECUTOR_DOCKERFILE',
  'apps/m365-graph-actions-executor/Dockerfile': 'ACTIONS_EXECUTOR_DOCKERFILE',
  'apps/m365-communications-executor/Dockerfile': 'COMMS_EXECUTOR_DOCKERFILE',
};

const HARDENING_SCRIPT = 'scripts/security/check-supply-chain-hardening.sh';

function checkApkPolicy(source: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'breeze-apk-policy-'));
  const dockerfile = path.join(directory, 'Dockerfile');
  writeFileSync(dockerfile, source);
  try {
    return spawnSync(
      'bash',
      [path.join(REPO_ROOT, HARDENING_SCRIPT), '--check-apk', dockerfile],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Stage {
  /** Lowercased `AS` alias, or undefined for an unnamed stage. */
  alias?: string;
  /** The image ref or parent-stage alias this stage derives from. */
  parent: string;
  /** Full text of the stage body, with line continuations joined. */
  body: string;
}

function findDockerfiles(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, 'apps'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `apps/${entry.name}/Dockerfile`;
    if (existsSync(path.join(REPO_ROOT, rel))) found.push(rel);
  }
  for (const entry of readdirSync(path.join(REPO_ROOT, 'docker'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('Dockerfile')) found.push(`docker/${entry.name}`);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/** Split a Dockerfile into stages, joining `\`-continued lines first. */
function parseStages(source: string): Stage[] {
  const joined = source.replace(/\\\r?\n\s*/g, ' ');
  const stages: Stage[] = [];
  for (const rawLine of joined.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    // Leading flags (`FROM --platform=$BUILDPLATFORM node:24-alpine AS x`) must
    // be skipped, or the flag itself is read as the base ref and the image
    // silently drops out of scope — the exact blind spot this guard exists to
    // close. Nothing in the repo builds multi-arch this way today; this is here
    // so the first image that does is still covered.
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from?.[1]) {
      stages.push({ parent: from[1], alias: from[2]?.toLowerCase(), body: '' });
      continue;
    }
    const open = stages[stages.length - 1];
    if (open) open.body += `${line}\n`;
  }
  return stages;
}

/**
 * The final stage plus every stage it transitively inherits from via `FROM`.
 * Stages that are only `COPY --from`'d are deliberately excluded: that copies
 * named paths, not installed package state.
 */
function inheritanceChain(stages: Stage[]): Stage[] {
  const byAlias = new Map(stages.filter((s) => s.alias).map((s) => [s.alias!, s]));
  const chain: Stage[] = [];
  const seen = new Set<Stage>();
  let current: Stage | undefined = stages[stages.length - 1];
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = byAlias.get(current.parent.toLowerCase());
  }
  return chain;
}

/** The concrete image ref the final stage ultimately derives from. */
function effectiveBaseRef(stages: Stage[]): string {
  const chain = inheritanceChain(stages);
  return chain[chain.length - 1]?.parent ?? '';
}

const DOCKERFILES = findDockerfiles();
const SOURCES = new Map(
  DOCKERFILES.map((f) => [f, readFileSync(path.join(REPO_ROOT, f), 'utf8')]),
);
const STAGES = new Map([...SOURCES].map(([f, src]) => [f, parseStages(src)]));

/** Images that ship AND freeze their package set behind a digest pin. */
const IN_SCOPE = DOCKERFILES.filter((f) =>
  PINNED_NODE_ALPINE_RE.test(effectiveBaseRef(STAGES.get(f)!)),
);

/** Every digest-pinned shipping Node/Alpine image must carry the repair. */
const COVERED = IN_SCOPE;

describe('Dockerfile OpenSSL upgrade coverage', () => {
  it('finds the repo Dockerfiles', () => {
    // Sanity: the discovery walk must actually see the tree, or every
    // assertion below would pass vacuously over an empty list.
    expect(DOCKERFILES).toContain('docker/Dockerfile.api');
    expect(DOCKERFILES).toContain('apps/portal/Dockerfile');
    expect(IN_SCOPE.length).toBeGreaterThanOrEqual(6);
  });

  it.each(COVERED)('%s upgrades libcrypto3/libssl3 in its shipped stage', (dockerfile) => {
    const chain = inheritanceChain(STAGES.get(dockerfile)!);
    const upgraded = upgradesOpenssl(chain.map((stage) => stage.body));

    expect(
      upgraded,
      `${dockerfile} pins its base by digest but never runs ` +
        '`apk upgrade --no-cache libcrypto3 libssl3` in the stage it ships from. ' +
        'The pinned digest freezes the vulnerable package version, so Trivy will ' +
        'flag the image (issue #4246, CVE-2026-14456). Add the upgrade to the ' +
        'final stage — matching docker/Dockerfile.api — not to a build stage, ' +
        'which is discarded.',
    ).toBe(true);
  });

  it('does not accept an upgrade hidden in a discarded build stage', () => {
    // Discriminating check: the guard must reject a file whose only upgrade
    // sits in a stage the runtime merely COPY --from's. Without this, the
    // whole suite would pass on the exact bug it is meant to catch.
    const discarded = parseStages(
      [
        'FROM node:24-alpine@sha256:' + 'a'.repeat(64) + ' AS build',
        'RUN apk upgrade --no-cache libcrypto3 libssl3',
        'FROM node:24-alpine@sha256:' + 'a'.repeat(64) + ' AS runner',
        'COPY --from=build /app /app',
      ].join('\n'),
    );
    const chain = inheritanceChain(discarded);
    expect(upgradesOpenssl(chain.map((stage) => stage.body))).toBe(false);

    // ...while an upgrade inherited through `FROM base` is correctly credited.
    const inherited = parseStages(
      [
        'FROM node:24-alpine@sha256:' + 'a'.repeat(64) + ' AS base',
        'RUN apk upgrade --no-cache libcrypto3 libssl3',
        'FROM base AS runner',
        'CMD ["node", "index.js"]',
      ].join('\n'),
    );
    expect(upgradesOpenssl(inheritanceChain(inherited).map((s) => s.body))).toBe(true);
  });

  it.each(CREDENTIAL_BOUNDARY_DOCKERFILES)(
    '%s permits only the exact audited OpenSSL upgrade at the credential boundary',
    (dockerfile) => {
      const script = readFileSync(path.join(REPO_ROOT, HARDENING_SCRIPT), 'utf8');
      const source = SOURCES.get(dockerfile)!;
      const variable = CREDENTIAL_BOUNDARY_SCRIPT_VARIABLE[dockerfile];
      const apkMutationLines = source
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('#') && /\bapk\s+(?:add|upgrade)\b/.test(line));

      expect(apkMutationLines).toEqual([
        'RUN apk upgrade --no-cache libcrypto3 libssl3 && \\',
      ]);
      expect(script).toContain(`require_audited_openssl_upgrade "$${variable}"`);
    },
  );

  it('rejects every apk mutation except the exact two-package repair', () => {
    const accepted = [
      'RUN apk upgrade --no-cache libcrypto3 libssl3 && \\\n    rm -rf /usr/local/lib/node_modules/npm',
      '# historical note: never use apk add here',
    ];
    const rejected = [
      'RUN apk add --no-cache curl',
      'RUN apk upgrade',
      'RUN apk upgrade --no-cache libssl3 libcrypto3',
      'RUN apk upgrade --no-cache libcrypto3 libssl3 curl',
      'RUN apk -U upgrade libcrypto3 libssl3',
      'RUN true && \\\n    apk add --no-cache curl',
      'RUN /sbin/apk add --no-cache curl',
      // An intra-line '#' is ordinary shell text, not a comment start. Stripping
      // from the first '#' once hid the `apk add` that follows on these lines and
      // let them pass the credential boundary — the previous blanket rule caught
      // all three, so this pins the regression closed.
      "RUN sed -i 's#^#  #' /etc/motd && apk add --no-cache curl",
      "RUN echo '#' && apk add --no-cache curl",
      'RUN curl -o /t https://x.io/a#frag && apk add --no-cache netcat-openbsd',
    ];

    for (const source of accepted) {
      const result = checkApkPolicy(source);
      expect(result.status, result.stderr).toBe(0);
    }
    for (const source of rejected) {
      const result = checkApkPolicy(source);
      expect(result.status, `unexpectedly accepted: ${source}`).not.toBe(0);
    }
  });

  it('accepts the two packages in either order, and rejects a non-upgrade mention', () => {
    // `apk` ignores argument order, so the guard must too — otherwise it fails a
    // Dockerfile that is genuinely patched, which is worse than useless.
    expect(upgradesOpenssl(['RUN apk upgrade --no-cache libssl3 libcrypto3'])).toBe(true);
    expect(upgradesOpenssl(['RUN apk upgrade --no-cache libcrypto3 libssl3'])).toBe(true);
    expect(
      upgradesOpenssl(['RUN apk upgrade --no-cache libcrypto3', 'RUN apk upgrade --no-cache libssl3']),
    ).toBe(true);

    // Still strict where it matters: one package alone is not enough, and
    // naming them outside an `apk upgrade` does not count.
    expect(upgradesOpenssl(['RUN apk upgrade --no-cache libcrypto3'])).toBe(false);
    expect(upgradesOpenssl(['RUN apk add --no-cache libcrypto3 libssl3'])).toBe(false);

    // A package must be a standalone argument of the `apk upgrade` command
    // itself. `libssl3-dev` is a different, still-vulnerable package; a package
    // upgraded by a *different* command in the same &&-chain is not credited to
    // the upgrade; and a bare mention in an echo does not count.
    expect(
      upgradesOpenssl(['RUN apk upgrade --no-cache libcrypto3 libssl3-dev']),
    ).toBe(false);
    expect(
      upgradesOpenssl(['RUN apk upgrade --no-cache libcrypto3 && apk add --no-cache libssl3-dev']),
    ).toBe(false);
    expect(
      upgradesOpenssl(['RUN apk upgrade --no-cache libcrypto3 && echo "TODO: also libssl3"']),
    ).toBe(false);
  });

  it('still resolves the base ref when FROM carries build flags', () => {
    // A multi-arch `FROM --platform=...` must not read the flag as the base
    // ref: that would drop the image out of scope silently, which is the one
    // way this guard could fail without anyone noticing.
    const digest = 'a'.repeat(64);
    const stages = parseStages(
      [
        `FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:${digest} AS build`,
        'RUN pnpm build',
        `FROM --platform=$TARGETPLATFORM node:24-alpine@sha256:${digest} AS runner`,
        'RUN apk upgrade --no-cache libcrypto3 libssl3',
      ].join('\n'),
    );

    expect(effectiveBaseRef(stages)).toBe(`node:24-alpine@sha256:${digest}`);
    expect(PINNED_NODE_ALPINE_RE.test(effectiveBaseRef(stages))).toBe(true);
  });

  it('leaves no Dockerfile silently out of scope', () => {
    // Scope is derived from each file's effective base ref, so this snapshot is
    // the anti-rot mechanism: a new image, or a base ref that changes shape,
    // fails here and forces a decision instead of quietly losing coverage.
    const classification = Object.fromEntries(
      DOCKERFILES.map((f) => [
        f,
        IN_SCOPE.includes(f) ? 'covered' : effectiveBaseRef(STAGES.get(f)!),
      ]),
    );

    expect(classification).toEqual({
      'apps/api/Dockerfile': 'covered',
      'apps/m365-communications-executor/Dockerfile': 'covered',
      'apps/m365-graph-actions-executor/Dockerfile': 'covered',
      'apps/m365-graph-read-executor/Dockerfile': 'covered',
      'apps/portal/Dockerfile': 'covered',
      'apps/web/Dockerfile': 'covered',
      'docker/Dockerfile.api': 'covered',
      // Floating tag: re-pulls upstream fixes on every rebuild, never shipped.
      'docker/Dockerfile.api.dev': 'node:24-alpine',
      // Packaging-only image, non-node base, not a runtime for our code.
      'docker/Dockerfile.binaries': 'alpine:3.24',
      'docker/Dockerfile.portal.dev': 'node:24-alpine',
      'docker/Dockerfile.web': 'covered',
      'docker/Dockerfile.web.dev': 'node:24-alpine',
    });
  });
});
