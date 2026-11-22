import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryReport, DiscoveryReportInput } from '../../aiToolDiscoveryReport';
import { runCli, type DiscoveryCliDeps } from './discovery-report';

const ORG = '00000000-0000-4000-8000-000000000001';
const NOW = new Date(Date.UTC(2026, 10, 21, 12));
const DAY = 24 * 3600 * 1000;

let dir: string;
let out: string[];
let err: string[];
let build: ReturnType<typeof vi.fn>;
let load: ReturnType<typeof vi.fn>;

const emptyReport = (): DiscoveryReport => ({
  searchesPerTurn: { p50: 0, p90: 0, max: 0 }, emptySearchRate: 0, turns: 0, searches: 0, topEmptyQueries: [],
  neverDiscovered: [], discoveredNotCalled: [], perTool: [], searchHintCandidates: [],
  e1: { questions: 0, orgs: 0, calls: { p50: 0, p90: 0, max: 0 }, depthProxy: { p50: 0, p90: 0, max: 0 }, distinctDevices: { p50: 0, p90: 0, max: 0 } },
  e2: { fleetShapedQuestions: 0, shapes: [], longTailShare: 0 },
  candidates: [{ query: 'spooler jammed' }],
});

function deps(): DiscoveryCliDeps {
  return {
    reportsDir: dir,
    now: () => NOW,
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    loadInput: load as unknown as DiscoveryCliDeps['loadInput'],
    build: build as unknown as DiscoveryCliDeps['build'],
    registry: { allToolNames: [], searchHints: new Map(), alwaysLoad: new Set() },
    isEscalatedCall: () => false,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ai-reports-'));
  out = [];
  err = [];
  build = vi.fn(() => emptyReport());
  load = vi.fn(async () => ({
    searchEvents: [], executions: [], droppedResults: [], turnRows: [], userTurns: [], sessions: [],
  }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('discovery-report CLI', () => {
  it('--days abc exits 2 with usage', async () => {
    expect(await runCli(['--days', 'abc'], deps())).toBe(2);
    expect(err.join('\n')).toMatch(/--days/);
    expect(load).not.toHaveBeenCalled();
  });

  it('writes the default report file and prints Markdown; no candidates file without --org', async () => {
    expect(await runCli(['--days', '7'], deps())).toBe(0);
    const files = await readdir(dir);
    expect(files).toContain('discovery-2026-11-21.md');
    expect(files).not.toContain('candidates');
    expect(out.join('\n').length).toBeGreaterThan(0);
    expect((build.mock.calls[0][0] as DiscoveryReportInput).mode).toBe('cross-org');
  });

  it('--org writes .ai-reports/candidates/<date>.json and an org-suffixed report', async () => {
    expect(await runCli(['--days', '7', '--org', ORG], deps())).toBe(0);
    expect(await readdir(dir)).toContain(`discovery-2026-11-21-${ORG}.md`);
    const candidates = JSON.parse(await readFile(path.join(dir, 'candidates', '2026-11-21.json'), 'utf8'));
    expect(candidates).toEqual([{ query: 'spooler jammed' }]);
    expect((build.mock.calls[0][0] as DiscoveryReportInput).mode).toBe('org');
    expect(load.mock.calls[0][0]).toMatchObject({ orgId: ORG, days: 7 });
  });

  it('--out outside .ai-reports/ exits 2 and writes nothing', async () => {
    expect(await runCli(['--out', path.join(os.tmpdir(), 'elsewhere.md')], deps())).toBe(2);
    expect(await runCli(['--out', path.join(dir, '..', 'escape.md')], deps())).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it('--out inside .ai-reports/ is honoured', async () => {
    expect(await runCli(['--out', path.join(dir, 'custom.md')], deps())).toBe(0);
    expect(await readdir(dir)).toContain('custom.md');
  });

  it('a report and a candidates file with an mtime 31 days old are deleted on the next run and 29-day ones are kept', async () => {
    await mkdir(path.join(dir, 'candidates'), { recursive: true });
    const age = async (p: string, days: number) => {
      await writeFile(p, 'x');
      const t = new Date(NOW.getTime() - days * DAY);
      await utimes(p, t, t);
    };
    await age(path.join(dir, 'discovery-old.md'), 31);
    await age(path.join(dir, 'candidates', 'old.json'), 31);
    await age(path.join(dir, 'discovery-fresh.md'), 29);
    await age(path.join(dir, 'candidates', 'fresh.json'), 29);
    expect(await runCli(['--days', '7'], deps())).toBe(0);
    const top = await readdir(dir);
    const cand = await readdir(path.join(dir, 'candidates'));
    expect(top).not.toContain('discovery-old.md');
    expect(cand).not.toContain('old.json');
    expect(top).toContain('discovery-fresh.md');
    expect(cand).toContain('fresh.json');
  });

  it('--fingerprint is forwarded to buildDiscoveryReport', async () => {
    expect(await runCli(['--fingerprint', 'fp-b'], deps())).toBe(0);
    expect((build.mock.calls[0][0] as DiscoveryReportInput).fingerprint).toBe('fp-b');
  });

  it('rejects unknown options and a non-uuid --org with exit 2', async () => {
    expect(await runCli(['--nope', '1'], deps())).toBe(2);
    expect(await runCli(['--org', 'not-a-uuid'], deps())).toBe(2);
  });
});
