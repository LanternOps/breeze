import type { Finding, RouteResult, Severity } from './types';

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

export interface QueuedFinding extends Omit<Finding, 'crop'> {
  occurrences: number;
  combos: string[];
  /** Close-ups for renders whose screenshot does not show the finding. */
  crops?: string[];
}

export interface TriageItem {
  app: RouteResult['app'];
  pattern: string;
  path: string;
  /** Screenshots (relative to the run dir) a vision model should look at. */
  screenshots: string[];
  findings: QueuedFinding[];
  /**
   * Writes the audit blocked on this route. An error or empty state that
   * depends on one is the audit's doing, not a product bug.
   */
  blocked?: string[];
}

const DEFAULT_COMBO = { viewport: 'desktop', theme: 'light' } as const;

/**
 * Only layout findings can be confirmed or refuted by looking at a
 * screenshot. axe rules, console/network errors and navigation facts
 * (redirects, HTTP status) are already exact — they go to report tables,
 * never to a vision model.
 */
const VISUAL_SOURCES = new Set<Finding['source']>(['layout']);

/**
 * Identity of a finding independent of which render it came from. Positional
 * selector parts and numbers (px, ratios, ids) vary between pages rendering
 * the same component, so they are normalised away.
 */
export function findingKey(f: Finding): string {
  const selector = (f.selector ?? '').replace(/:nth-(child|of-type)\(\d+\)/g, '');
  const message = f.message.replace(/\d+(\.\d+)?/g, 'N');
  return [f.source, f.kind, selector, message].join('\u0000');
}

export interface ShellFinding extends Omit<Finding, 'viewport' | 'theme' | 'crop'> {
  key: string;
  paths: string[];
  /** One representative render showing it. */
  screenshot?: string;
  /** The close-up from that same render, when its screenshot does not show the finding. */
  crop?: string;
}

/**
 * A visual finding that recurs on several routes (same normalised selector
 * and culprit) comes from shared chrome or a shared component: triage it once
 * on one representative screenshot instead of on every page that renders it.
 */
export function findShellFindings(
  results: RouteResult[],
  opts: { minRoutes: number; minSeverity?: Severity },
): ShellFinding[] {
  const floor = SEVERITY_RANK[opts.minSeverity ?? 'low'];
  const byKey = new Map<string, ShellFinding>();
  for (const r of results) {
    if (r.status !== 'ok') continue;
    for (const fnd of r.findings) {
      if (!VISUAL_SOURCES.has(fnd.source) || SEVERITY_RANK[fnd.severity] < floor) continue;
      const key = findingKey(fnd);
      let entry = byKey.get(key);
      if (!entry) {
        const { viewport: _v, theme: _t, crop: _c, ...rest } = fnd;
        entry = { ...rest, key, paths: [] };
        byKey.set(key, entry);
      }
      if (!entry.paths.includes(r.path)) {
        entry.paths.push(r.path);
        if (!entry.screenshot) {
          entry.screenshot = r.shots.find(
            (s) => s.viewport === (fnd.viewport ?? DEFAULT_COMBO.viewport) && s.theme === (fnd.theme ?? DEFAULT_COMBO.theme),
          )?.file;
          if (entry.screenshot && fnd.crop) entry.crop = fnd.crop;
        }
      }
    }
  }
  return [...byKey.values()]
    .filter((e) => e.paths.length >= opts.minRoutes)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.paths.length - a.paths.length);
}

/**
 * The model-triage input: one item per route that has something worth a look,
 * carrying only the screenshots where the problem shows. This is the cost
 * lever — clean renders never reach a model.
 */
export function buildTriageQueue(
  results: RouteResult[],
  opts: { minSeverity: Severity; includeChanged?: boolean; exclude?: Set<string> },
): TriageItem[] {
  const floor = SEVERITY_RANK[opts.minSeverity];
  const queue: TriageItem[] = [];

  for (const r of results) {
    if (r.status !== 'ok') continue;
    const wanted = new Set<string>();
    const merged = new Map<string, QueuedFinding>();
    const blocked: string[] = [];
    // one close-up per finding per render: repeats within a render look alike
    const cropped = new Set<string>();

    for (const fnd of r.findings) {
      if (fnd.kind === 'mutation-on-load' && !blocked.includes(fnd.message)) blocked.push(fnd.message);
      if (!VISUAL_SOURCES.has(fnd.source)) continue;
      if (SEVERITY_RANK[fnd.severity] < floor) continue;
      const key = findingKey(fnd);
      if (opts.exclude?.has(key)) continue;
      const viewport = fnd.viewport ?? DEFAULT_COMBO.viewport;
      const theme = fnd.theme ?? DEFAULT_COMBO.theme;
      const combo = `${viewport}-${theme}`;
      const shot = r.shots.find((s) => s.viewport === viewport && s.theme === theme);
      if (shot) wanted.add(shot.file);

      let entry = merged.get(key);
      if (entry) {
        entry.occurrences += 1;
        if (!entry.combos.includes(combo)) entry.combos.push(combo);
      } else {
        const { viewport: _v, theme: _t, crop: _c, ...rest } = fnd;
        entry = { ...rest, occurrences: 1, combos: [combo] };
        merged.set(key, entry);
      }
      if (fnd.crop && !cropped.has(`${key}\u0000${combo}`)) {
        cropped.add(`${key}\u0000${combo}`);
        (entry.crops ??= []).push(fnd.crop);
      }
    }

    if (opts.includeChanged) {
      for (const s of r.shots) if (s.diff === 'changed' || s.diff === 'new') wanted.add(s.file);
    }

    if (wanted.size === 0) continue;
    queue.push({
      app: r.app,
      pattern: r.pattern,
      path: r.path,
      // keep capture order so a reviewer sees mobile → desktop consistently
      screenshots: r.shots.map((s) => s.file).filter((f) => wanted.has(f)),
      findings: [...merged.values()].sort(
        (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.occurrences - a.occurrences,
      ),
      ...(blocked.length ? { blocked } : {}),
    });
  }
  return queue;
}

export interface NonVisualGroup {
  source: Finding['source'];
  kind: string;
  severity: Severity;
  count: number;
  paths: string[];
  /** Most frequent selectors (axe) or messages (console/network/nav). */
  samples: string[];
}

/** axe / console / network findings, grouped by rule — exact already, no model needed. */
export function groupNonVisual(results: RouteResult[]): NonVisualGroup[] {
  const groups = new Map<string, NonVisualGroup>();
  const sampleCounts = new Map<string, Map<string, number>>();
  for (const r of results) {
    for (const fnd of r.findings) {
      if (VISUAL_SOURCES.has(fnd.source)) continue;
      const key = `${fnd.source}\u0000${fnd.kind}`;
      let g = groups.get(key);
      if (!g) {
        g = { source: fnd.source, kind: fnd.kind, severity: fnd.severity, count: 0, paths: [], samples: [] };
        groups.set(key, g);
      }
      g.count += 1;
      if (SEVERITY_RANK[fnd.severity] > SEVERITY_RANK[g.severity]) g.severity = fnd.severity;
      if (!g.paths.includes(r.path)) g.paths.push(r.path);
      const sample = fnd.source === 'axe' ? (fnd.selector ?? '') : fnd.message;
      if (!sample) continue;
      const counts = sampleCounts.get(key) ?? new Map<string, number>();
      counts.set(sample, (counts.get(sample) ?? 0) + 1);
      sampleCounts.set(key, counts);
    }
  }
  for (const [key, g] of groups) {
    // Map keeps insertion order and sort is stable, so ties stay first-seen
    g.samples = [...(sampleCounts.get(key) ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sample]) => sample);
  }
  return [...groups.values()].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count,
  );
}

/** Group rendered routes by page shape so a critique can cover one per group. */
export function groupByLayout(results: RouteResult[]): { signature: string; paths: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const r of results) {
    if (r.status !== 'ok' || !r.signature) continue;
    const list = groups.get(r.signature) ?? [];
    list.push(r.path);
    groups.set(r.signature, list);
  }
  return [...groups.entries()]
    .map(([signature, paths]) => ({ signature, paths }))
    .sort((a, b) => b.paths.length - a.paths.length || a.signature.localeCompare(b.signature));
}

export function summarize(results: RouteResult[]) {
  const routes = { ok: 0, error: 0, unresolved: 0, skipped: 0 };
  const byKind: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const r of results) {
    routes[r.status] += 1;
    for (const fnd of r.findings) {
      byKind[fnd.kind] = (byKind[fnd.kind] ?? 0) + 1;
      bySeverity[fnd.severity] += 1;
    }
  }
  return { routes, byKind, bySeverity };
}

export function renderMarkdown(
  results: RouteResult[],
  meta: { baseUrl: string; startedAt: string; finishedAt?: string; baseline?: string },
  shell: ShellFinding[] = [],
): string {
  const s = summarize(results);
  const lines: string[] = [];
  lines.push('# UI audit report', '');
  lines.push(`- Target: ${meta.baseUrl}`);
  lines.push(`- Started: ${meta.startedAt}${meta.finishedAt ? ` · finished ${meta.finishedAt}` : ''}`);
  if (meta.baseline) lines.push(`- Baseline: ${meta.baseline}`);
  lines.push(
    `- Routes: ${s.routes.ok} captured · ${s.routes.error} errored · ${s.routes.unresolved} unresolved · ${s.routes.skipped} skipped`,
  );
  lines.push(`- Findings: ${s.bySeverity.high} high · ${s.bySeverity.medium} medium · ${s.bySeverity.low} low`, '');

  lines.push('## Findings by kind', '', '| Kind | Count |', '|---|---|');
  for (const [kind, n] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${kind} | ${n} |`);
  }
  lines.push('');

  if (shell.length) {
    lines.push(
      '## Repeated visual findings',
      '',
      'The same layout finding on several routes: shared chrome or a shared component. Triage once on the representative screenshot; excluded from the per-route queue.',
      '',
      '| Severity | Kind | Routes | Selector | Message |',
      '|---|---|---|---|---|',
    );
    for (const f of shell) {
      const cell = (v: string) => v.replace(/\|/g, '\\|').slice(0, 120);
      lines.push(`| ${f.severity} | ${f.kind} | ${f.paths.length} | \`${cell(f.selector ?? '')}\` | ${cell(f.message)} |`);
    }
    lines.push('');
  }

  const nonVisual = groupNonVisual(results);
  if (nonVisual.length) {
    lines.push(
      '## Accessibility and runtime findings',
      '',
      'Exact already (axe rules, console and API errors), so no model triage needed. Fix by rule.',
      '',
      '| Severity | Source | Rule / kind | Count | Routes | Samples |',
      '|---|---|---|---|---|---|',
    );
    const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 90);
    for (const g of nonVisual) {
      lines.push(
        `| ${g.severity} | ${g.source} | ${g.kind} | ${g.count} | ${g.paths.length} | ${g.samples.slice(0, 3).map((x) => `\`${cell(x)}\``).join('<br>')} |`,
      );
    }
    lines.push('');
  }

  const errored = results.filter((r) => r.status === 'error');
  if (errored.length) {
    lines.push('## Routes that failed to render', '');
    for (const r of errored) lines.push(`- \`${r.path}\` — ${r.error ?? 'unknown error'}`);
    lines.push('');
  }

  const unresolved = results.filter((r) => r.status === 'unresolved');
  if (unresolved.length) {
    lines.push(
      '## Dynamic routes not captured',
      '',
      'No link to a concrete record was found on any static page. Supply one with `--params <file.json>` (`{"/pattern/[id]": "/pattern/<uuid>"}`).',
      '',
    );
    for (const r of unresolved) lines.push(`- \`${r.pattern}\``);
    lines.push('');
  }

  const skipped = results.filter((r) => r.status === 'skipped');
  if (skipped.length) {
    lines.push('## Skipped routes', '');
    for (const r of skipped) lines.push(`- \`${r.pattern}\` — ${r.error ?? 'skipped'}`);
    lines.push('');
  }

  const worst = results
    .filter((r) => r.findings.length)
    .map((r) => ({
      r,
      score: r.findings.reduce((n, fnd) => n + 1 + SEVERITY_RANK[fnd.severity] * 2, 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
  if (worst.length) {
    lines.push('## Routes with the most findings', '', '| Route | High | Medium | Low | Kinds |', '|---|---|---|---|---|');
    for (const { r } of worst) {
      const c = { high: 0, medium: 0, low: 0 };
      for (const fnd of r.findings) c[fnd.severity] += 1;
      const kinds = [...new Set(r.findings.map((fnd) => fnd.kind))].join(', ');
      lines.push(`| \`${r.path}\` | ${c.high} | ${c.medium} | ${c.low} | ${kinds} |`);
    }
    lines.push('');
  }

  const groups = groupByLayout(results);
  if (groups.length) {
    lines.push('## Layout groups (critique one representative per group)', '');
    for (const g of groups) lines.push(`- **${g.signature}** (${g.paths.length}): ${g.paths.slice(0, 8).map((p) => `\`${p}\``).join(', ')}${g.paths.length > 8 ? ', …' : ''}`);
    lines.push('');
  }

  return lines.join('\n');
}
