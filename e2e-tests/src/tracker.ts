import * as fs from 'fs';
import * as path from 'path';
import type { TestResult } from './types.js';

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  duration: number;
  mode: 'live' | 'simulate';
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  tests: TestResult[];
}

export class TestTracker {
  private resultsDir: string;
  private runDir: string;
  private runId: string;
  private startedAt: Date;
  private mode: 'live' | 'simulate';
  private tests: TestResult[] = [];

  constructor(baseDir: string, mode: 'live' | 'simulate') {
    this.resultsDir = path.join(baseDir, 'results');
    this.startedAt = new Date();
    this.mode = mode;

    const ts = this.startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    this.runId = `${ts}_${mode}`;
    this.runDir = path.join(this.resultsDir, this.runId);

    fs.mkdirSync(this.runDir, { recursive: true });
  }

  recordTest(result: TestResult): void {
    this.tests.push(result);
    // Write incremental results after each test
    this.writeResults();
  }

  private writeResults(): void {
    const resultsPath = path.join(this.runDir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(this.tests, null, 2));
  }

  finish(): RunSummary {
    const finishedAt = new Date();
    const summary: RunSummary = {
      runId: this.runId,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      duration: finishedAt.getTime() - this.startedAt.getTime(),
      mode: this.mode,
      passed: this.tests.filter(t => t.status === 'passed').length,
      failed: this.tests.filter(t => t.status === 'failed').length,
      skipped: this.tests.filter(t => t.status === 'skipped').length,
      total: this.tests.length,
      tests: this.tests,
    };

    // Write final summary
    const summaryPath = path.join(this.runDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    // Write human-readable report
    const reportPath = path.join(this.runDir, 'report.txt');
    fs.writeFileSync(reportPath, this.formatReport(summary));

    // Update latest symlink
    const latestPath = path.join(this.resultsDir, 'latest');
    try { fs.unlinkSync(latestPath); } catch {}
    try { fs.symlinkSync(this.runId, latestPath); } catch {}

    return summary;
  }

  private formatReport(summary: RunSummary): string {
    const lines: string[] = [];
    lines.push(`Breeze E2E Test Report`);
    lines.push(`======================`);
    lines.push(`Run ID:    ${summary.runId}`);
    lines.push(`Mode:      ${summary.mode}`);
    lines.push(`Started:   ${summary.startedAt}`);
    lines.push(`Finished:  ${summary.finishedAt}`);
    lines.push(`Duration:  ${(summary.duration / 1000).toFixed(1)}s`);
    lines.push(``);
    lines.push(`Results: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.total} total)`);
    lines.push(``);

    // Test list with status
    const maxIdLen = Math.max(...summary.tests.map(t => t.id.length), 10);
    lines.push(`${'TEST'.padEnd(maxIdLen)}  STATUS   DURATION  ERROR`);
    lines.push(`${'─'.repeat(maxIdLen)}  ───────  ────────  ─────`);

    for (const test of summary.tests) {
      const status = test.status === 'passed' ? 'PASS' : test.status === 'failed' ? 'FAIL' : 'SKIP';
      const duration = `${(test.duration / 1000).toFixed(1)}s`;
      const error = test.error ? test.error.substring(0, 80) : '';
      lines.push(`${test.id.padEnd(maxIdLen)}  ${status.padEnd(7)}  ${duration.padEnd(8)}  ${error}`);
    }

    if (summary.failed > 0) {
      lines.push(``);
      lines.push(`Failed Tests`);
      lines.push(`────────────`);
      for (const test of summary.tests.filter(t => t.status === 'failed')) {
        lines.push(`  ${test.id}: ${test.error}`);
        const failedSteps = test.steps.filter(s => s.status === 'failed');
        for (const step of failedSteps) {
          lines.push(`    └─ ${step.id}: ${step.error}`);
        }
      }
    }

    lines.push(``);
    return lines.join('\n');
  }

  getRunDir(): string {
    return this.runDir;
  }
}
