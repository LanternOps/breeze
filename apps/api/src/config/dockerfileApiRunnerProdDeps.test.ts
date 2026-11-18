import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The published API image (`apps/api/Dockerfile`) must ship only the production
 * dependency closure.
 *
 * Its `deps` stage installs devDependencies too, because `builder` needs
 * vitest/tsup/drizzle-kit/etc. The runner used to `COPY --from=deps` the whole
 * `node_modules`, so ~1 GB of build and test tooling shipped to every customer
 * and every advisory in that tooling landed on the image scan. picomatch
 * (CVE-2026-112366, #12114) is the case that surfaced it: `pnpm why picomatch
 * --prod` is empty for @breeze/api, yet both picomatch copies were in the image.
 *
 * Rule: every stage the runner copies from that inherits a `pnpm install` must
 * inherit a `--prod` one as its NEAREST install. Copying from a stage whose
 * nearest install is dev-inclusive (deps, or a stage FROM deps) fails. `dist/`
 * stages that never run an install (builder output, release-dist, yarac) are
 * out of scope by construction.
 *
 * Static text check; never invokes Docker. The real-image evidence (Trivy and
 * a boot test of the pruned image) is in the PR that added this guard.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOCKERFILE = 'apps/api/Dockerfile';

interface Stage {
  name: string;
  from: string;
  installs: string[];
  copiesFrom: { stage: string; text: string }[];
}

function logicalLines(content: string): string[] {
  const out: string[] = [];
  let buffer = '';
  for (const raw of content.split('\n')) {
    if (buffer === '' && /^\s*(#|$)/.test(raw)) continue;
    const continued = /\\\s*$/.test(raw);
    buffer += (buffer ? ' ' : '') + raw.replace(/\\\s*$/, '').trim();
    if (!continued) {
      out.push(buffer);
      buffer = '';
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function parseStages(content: string): Stage[] {
  const stages: Stage[] = [];
  let current: Stage | null = null;
  for (const line of logicalLines(content)) {
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)\s+AS\s+(\S+)$/i.exec(line);
    if (from) {
      current = { name: from[2]!, from: from[1]!, installs: [], copiesFrom: [] };
      stages.push(current);
      continue;
    }
    if (!current) continue;
    if (/^RUN\b/i.test(line) && /\bpnpm\s+(install|i)\b/.test(line)) current.installs.push(line);
    const copy = /^COPY\s+(?:--\S+\s+)*?--from=(\S+)/i.exec(line);
    if (copy) current.copiesFrom.push({ stage: copy[1]!, text: line });
  }
  return stages;
}

/** The last `pnpm install` on the FROM-inheritance chain, or null if none. */
function nearestInstall(stages: Map<string, Stage>, name: string): string | null {
  for (let stage = stages.get(name); stage; stage = stages.get(stage.from)) {
    const last = stage.installs.at(-1);
    if (last) return last;
  }
  return null;
}

const isProdInstall = (command: string) => /--prod\b|--production\b/.test(command);

describe(`${DOCKERFILE} runner ships production dependencies only`, () => {
  const stages = parseStages(readFileSync(path.join(REPO_ROOT, DOCKERFILE), 'utf8'));
  const byName = new Map(stages.map((s) => [s.name, s]));
  const runner = stages.at(-1)!;
  const installCopies = runner.copiesFrom.filter((c) => nearestInstall(byName, c.stage) !== null);

  it('parses the runner and finds the node_modules copies (guards a vacuous pass)', () => {
    expect(runner.name).toBe('runner');
    expect(installCopies.filter((c) => /node_modules\s*$/.test(c.text)).length).toBeGreaterThanOrEqual(2);
  });

  it('copies installed files only from stages whose nearest install is --prod', () => {
    const devInclusive = installCopies
      .filter((c) => !isProdInstall(nearestInstall(byName, c.stage)!))
      .map((c) => c.text);
    expect(
      devInclusive,
      'The runner copies from a stage whose nearest `pnpm install` includes devDependencies. ' +
        'Copy node_modules (and anything inheriting them) from the --prod stage instead.',
    ).toEqual([]);
  });

  it('rebuilds node_modules when the --prod install inherits a dev-inclusive tree', () => {
    // `pnpm install --prod` over an existing dev-inclusive node_modules only
    // unlinks the dev packages; they stay in node_modules/.pnpm and still ship
    // and scan (observed: picomatch and vitest remained in the image). The same
    // RUN must delete the trees before the --prod install re-links them.
    const prodStages = [...new Set(installCopies.map((c) => c.stage))]
      .map((name) => {
        for (let s = byName.get(name); s; s = byName.get(s.from)) if (s.installs.length) return s;
        return undefined;
      })
      .filter((s): s is Stage => s !== undefined);
    expect(prodStages.length).toBeGreaterThan(0);
    for (const stage of prodStages) {
      const inheritsDevTree = nearestInstall(byName, stage.from) !== null;
      if (!inheritsDevTree) continue;
      const install = stage.installs.at(-1)!;
      expect(install, `${stage.name}: delete node_modules before the --prod install`).toMatch(
        /\brm\s+-rf\s+[^&;]*\bnode_modules\b[^&;]*(&&|;)\s*pnpm\s+(install|i)\b[^&;]*--prod\b/,
      );
    }
  });

  it('keeps the dev-inclusive install for the compile stage (the prod stage is a prune, not a replacement)', () => {
    const deps = byName.get('deps');
    expect(deps?.installs.some((i) => !isProdInstall(i))).toBe(true);
  });
});
