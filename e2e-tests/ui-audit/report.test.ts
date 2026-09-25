import { describe, expect, it } from 'vitest';
import { buildTriageQueue, findShellFindings, groupByLayout, groupNonVisual, renderMarkdown, summarize } from './report';
import type { Finding, RouteResult } from './types';

const shots = (slug: string) =>
  (['mobile', 'desktop'] as const).flatMap((viewport) =>
    (['light', 'dark'] as const).map((theme) => ({
      viewport,
      theme,
      file: `web/${slug}/${viewport}-${theme}.png`,
    })),
  );

function route(over: Partial<RouteResult> & { path: string }): RouteResult {
  const slug = over.path.replace(/\//g, '_') || 'root';
  return {
    app: 'web',
    pattern: over.path,
    status: 'ok',
    signature: 'plain',
    shots: shots(slug),
    findings: [],
    ...over,
  };
}

const f = (over: Partial<Finding>): Finding => ({
  source: 'layout',
  kind: 'content-overflow',
  severity: 'medium',
  message: 'spills',
  ...over,
});

describe('buildTriageQueue', () => {
  it('queues only the screenshots whose viewport/theme produced a finding', () => {
    const results = [
      route({ path: '/clean' }),
      route({
        path: '/devices',
        findings: [f({ viewport: 'mobile', theme: 'dark', selector: '[data-testid="card"]' })],
      }),
    ];
    const q = buildTriageQueue(results, { minSeverity: 'low' });
    expect(q).toHaveLength(1);
    expect(q[0].path).toBe('/devices');
    expect(q[0].screenshots).toEqual(['web/_devices/mobile-dark.png']);
  });

  it('never queues screenshots for findings a vision model cannot verify (axe, console, network, nav)', () => {
    const results = [
      route({
        path: '/alerts',
        findings: [
          f({ source: 'axe', kind: 'color-contrast', severity: 'high', viewport: 'desktop', theme: 'dark' }),
          f({ source: 'console', kind: 'console-error', message: 'boom' }),
          f({ source: 'network', kind: 'api-error', severity: 'high', message: 'GET /x → 500' }),
          f({ source: 'nav', kind: 'redirected', severity: 'medium', message: 'Requested /x, landed on /y' }),
        ],
      }),
    ];
    expect(buildTriageQueue(results, { minSeverity: 'low' })).toEqual([]);
  });

  it('collapses the same finding seen in several combos into one entry with a count', () => {
    const same = { selector: '#x', message: 'spills' };
    const results = [
      route({
        path: '/a',
        findings: [
          f({ ...same, viewport: 'mobile', theme: 'light' }),
          f({ ...same, viewport: 'mobile', theme: 'dark' }),
        ],
      }),
    ];
    const q = buildTriageQueue(results, { minSeverity: 'low' });
    expect(q[0].findings).toHaveLength(1);
    expect(q[0].findings[0].occurrences).toBe(2);
    expect(q[0].screenshots).toHaveLength(2);
  });

  it('drops findings below the severity floor', () => {
    const results = [route({ path: '/a', findings: [f({ severity: 'low', viewport: 'mobile', theme: 'light' })] })];
    expect(buildTriageQueue(results, { minSeverity: 'medium' })).toEqual([]);
  });

  it('optionally queues visually changed shots even without findings', () => {
    const r = route({ path: '/b' });
    r.shots[1] = { ...r.shots[1], diff: 'changed', diffRatio: 0.2 };
    expect(buildTriageQueue([r], { minSeverity: 'low' })).toEqual([]);
    const q = buildTriageQueue([r], { minSeverity: 'low', includeChanged: true });
    expect(q[0].screenshots).toEqual([r.shots[1].file]);
  });
});

describe('findShellFindings', () => {
  const shellHit = f({
    kind: 'content-overflow',
    selector: 'header > .toolbar',
    message: 'spills',
    viewport: 'desktop',
    theme: 'dark',
  });
  const results = ['/a', '/b', '/c', '/d'].map((p, i) =>
    route({
      path: p,
      findings: [shellHit, ...(i === 0 ? [f({ selector: '#only-a', viewport: 'mobile', theme: 'light' })] : [])],
    }),
  );

  it('returns findings repeated across at least minRoutes routes, once each', () => {
    const shell = findShellFindings(results, { minRoutes: 3 });
    expect(shell).toHaveLength(1);
    expect(shell[0].kind).toBe('content-overflow');
    expect(shell[0].paths).toEqual(['/a', '/b', '/c', '/d']);
    expect(shell[0].screenshot).toBe('web/_a/desktop-dark.png');
  });

  it('treats selectors differing only by :nth-child and messages differing only by numbers as one finding', () => {
    const variants = ['/a', '/b', '/c'].map((p, i) =>
      route({
        path: p,
        findings: [
          f({
            selector: `aside > div:nth-child(${12 + i}) > span`,
            message: `Content spills ${40 + i}px past the right edge`,
            viewport: 'mobile',
            theme: 'light',
          }),
        ],
      }),
    );
    const shell = findShellFindings(variants, { minRoutes: 3 });
    expect(shell).toHaveLength(1);
    expect(shell[0].paths).toEqual(['/a', '/b', '/c']);
  });

  it('only lifts visual findings — repeated axe/runtime findings belong to the rule table', () => {
    const axeEverywhere = ['/a', '/b', '/c'].map((p) =>
      route({ path: p, findings: [f({ source: 'axe', kind: 'color-contrast', selector: '.muted', viewport: 'desktop', theme: 'light' })] }),
    );
    expect(findShellFindings(axeEverywhere, { minRoutes: 3 })).toEqual([]);
  });

  it('respects the severity floor like the per-route queue does', () => {
    const low = ['/a', '/b', '/c'].map((p) =>
      route({ path: p, findings: [f({ kind: 'small-target', severity: 'low', selector: 'a.link', viewport: 'mobile', theme: 'light' })] }),
    );
    expect(findShellFindings(low, { minRoutes: 3 })).toHaveLength(1);
    expect(findShellFindings(low, { minRoutes: 3, minSeverity: 'medium' })).toEqual([]);
  });

  it('ignores findings below the route threshold', () => {
    expect(findShellFindings(results, { minRoutes: 5 })).toEqual([]);
  });

  it('keeps shell findings out of the per-route queue when excluded', () => {
    const shell = findShellFindings(results, { minRoutes: 3 });
    const q = buildTriageQueue(results, { minSeverity: 'low', exclude: new Set(shell.map((s) => s.key)) });
    expect(q.map((i) => i.path)).toEqual(['/a']);
    expect(q[0].findings.map((x) => x.selector)).toEqual(['#only-a']);
  });
});

describe('groupNonVisual', () => {
  it('groups axe and runtime findings by rule with route counts and sample selectors', () => {
    const results = [
      route({
        path: '/a',
        findings: [
          f({ source: 'axe', kind: 'select-name', severity: 'high', selector: 'select', viewport: 'desktop', theme: 'light' }),
          f({ source: 'axe', kind: 'select-name', severity: 'high', selector: 'select', viewport: 'desktop', theme: 'dark' }),
          f({ source: 'network', kind: 'api-error', severity: 'high', message: 'GET /api/v1/x → 500' }),
          f({ source: 'layout', kind: 'content-overflow' }),
        ],
      }),
      route({
        path: '/b',
        findings: [f({ source: 'axe', kind: 'select-name', severity: 'high', selector: '#per-page', viewport: 'desktop', theme: 'light' })],
      }),
    ];
    const g = groupNonVisual(results);
    expect(g.map((x) => [x.source, x.kind, x.count, x.paths])).toEqual([
      ['axe', 'select-name', 3, ['/a', '/b']],
      ['network', 'api-error', 1, ['/a']],
    ]);
    expect(g[0].samples).toEqual(['select', '#per-page']);
  });
});

describe('groupByLayout', () => {
  it('groups ok routes by signature, largest group first', () => {
    const groups = groupByLayout([
      route({ path: '/a', signature: 'table' }),
      route({ path: '/b', signature: 'form' }),
      route({ path: '/c', signature: 'table' }),
      route({ path: '/d', status: 'error', signature: undefined }),
    ]);
    expect(groups).toEqual([
      { signature: 'table', paths: ['/a', '/c'] },
      { signature: 'form', paths: ['/b'] },
    ]);
  });
});

describe('summarize + renderMarkdown', () => {
  const results = [
    route({ path: '/a', findings: [f({ kind: 'clipped-text', severity: 'low' }), f({})] }),
    route({ path: '/b', status: 'error', error: 'timeout', shots: [] }),
    { ...route({ path: '/tickets/[id]' }), status: 'unresolved' as const, shots: [] },
  ];

  it('counts routes by status and findings by kind', () => {
    const s = summarize(results);
    expect(s.routes).toEqual({ ok: 1, error: 1, unresolved: 1, skipped: 0 });
    expect(s.byKind).toEqual({ 'clipped-text': 1, 'content-overflow': 1 });
  });

  it('renders errors and unresolved dynamic routes so gaps are visible', () => {
    const md = renderMarkdown(results, { baseUrl: 'http://localhost:1', startedAt: 't0' });
    expect(md).toContain('/b');
    expect(md).toContain('timeout');
    expect(md).toContain('/tickets/[id]');
    expect(md).toMatch(/content-overflow\s*\|\s*1/);
  });
});
