import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
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
 */

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The exact mitigation the shipped images already use. */
const UPGRADE_RE = /apk\s+upgrade\b[^\n]*?\blibcrypto3\b[^\n]*?\blibssl3\b/;

/**
 * A digest-pinned node Alpine base, e.g.
 * `node:24-alpine@sha256:d32cdf61...`. The digest pin is what freezes the
 * package set and therefore what creates the exposure this guard covers.
 */
const PINNED_NODE_ALPINE_RE = /^node:[^\s@]*-alpine@sha256:[0-9a-f]{64}$/;

/**
 * The two customer-Graph credential-boundary executors, which
 * `scripts/security/check-supply-chain-hardening.sh` forbids from running ANY
 * `apk upgrade`/`apk add` ("executor runtime must not resolve mutable Alpine
 * packages during the image build"). That rule and this guard want opposite
 * things, and the conflict is a real security tradeoff — build reproducibility
 * for the credential boundary versus shipping a known HIGH CVE — so it belongs
 * to the repo owner, not to whoever is fixing CI that day. Until that call is
 * made these two stay unpatched and `Trivy Image Scan` stays red on them.
 *
 * The exception is deliberately self-invalidating: the test below asserts the
 * hardening rule is still there. Relax or delete that rule and this entry stops
 * being justified, the assertion fails, and the upgrade becomes required — so
 * the two controls can never quietly both be off.
 */
const HARDENING_BLOCKED = new Set([
  'apps/m365-graph-read-executor/Dockerfile',
  'apps/m365-communications-executor/Dockerfile',
]);

const HARDENING_SCRIPT = 'scripts/security/check-supply-chain-hardening.sh';

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
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
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

/** In scope and actually allowed to carry the upgrade today. */
const COVERED = IN_SCOPE.filter((f) => !HARDENING_BLOCKED.has(f));

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
    const upgraded = chain.some((stage) => UPGRADE_RE.test(stage.body));

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
    expect(chain.some((stage) => UPGRADE_RE.test(stage.body))).toBe(false);

    // ...while an upgrade inherited through `FROM base` is correctly credited.
    const inherited = parseStages(
      [
        'FROM node:24-alpine@sha256:' + 'a'.repeat(64) + ' AS base',
        'RUN apk upgrade --no-cache libcrypto3 libssl3',
        'FROM base AS runner',
        'CMD ["node", "index.js"]',
      ].join('\n'),
    );
    expect(inheritanceChain(inherited).some((s) => UPGRADE_RE.test(s.body))).toBe(true);
  });

  it.each([...HARDENING_BLOCKED])(
    '%s is exempt only while the hardening rule still forbids the upgrade',
    (dockerfile) => {
      const script = readFileSync(path.join(REPO_ROOT, HARDENING_SCRIPT), 'utf8');
      const stillForbidden =
        script.includes(dockerfile) && /reject_grep\s+'\^RUN.*apk.*upgrade/.test(script);

      expect(
        stillForbidden,
        `${dockerfile} is listed in HARDENING_BLOCKED because ${HARDENING_SCRIPT} rejects ` +
          '`apk upgrade` in it, but that rule is no longer there. The reason for the exemption ' +
          'is gone, so either restore the rule or drop the entry and add ' +
          '`apk upgrade --no-cache libcrypto3 libssl3` to the image (issue #4246).',
      ).toBe(true);
    },
  );

  it('leaves no Dockerfile silently out of scope', () => {
    // Scope is derived from each file's effective base ref, so this snapshot is
    // the anti-rot mechanism: a new image, or a base ref that changes shape,
    // fails here and forces a decision instead of quietly losing coverage.
    const classification = Object.fromEntries(
      DOCKERFILES.map((f) => [
        f,
        HARDENING_BLOCKED.has(f)
          ? 'blocked-by-hardening'
          : IN_SCOPE.includes(f)
            ? 'covered'
            : effectiveBaseRef(STAGES.get(f)!),
      ]),
    );

    expect(classification).toEqual({
      'apps/api/Dockerfile': 'covered',
      // Credential-boundary images: see HARDENING_BLOCKED. Still vulnerable to
      // CVE-2026-14456; awaiting an owner decision on a CVE-scoped exception.
      'apps/m365-communications-executor/Dockerfile': 'blocked-by-hardening',
      'apps/m365-graph-actions-executor/Dockerfile': 'covered',
      'apps/m365-graph-read-executor/Dockerfile': 'blocked-by-hardening',
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
