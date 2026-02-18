// e2e-tests/doc-verify/report.ts
import { writeFile } from 'fs/promises';
import type { RunReport } from './types';

export function printSummary(report: RunReport): void {
  const rate = report.total > 0 ? Math.round((report.passed / report.total) * 100) : 0;
  console.log('\n--- Doc Verification Summary ---');
  console.log(`Total: ${report.total}  Pass: ${report.passed}  Fail: ${report.failed}  Error: ${report.errors}  Skip: ${report.skipped}`);
  console.log(`Pass rate: ${rate}%`);
  console.log(`Duration: ${report.startedAt} → ${report.completedAt}`);
}

export async function saveJsonReport(report: RunReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`JSON report saved to ${path}`);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function saveHtmlReport(report: RunReport, path: string): Promise<void> {
  const rate = report.total > 0 ? Math.round((report.passed / report.total) * 100) : 0;

  const rows = report.results
    .map((r) => {
      const badge =
        r.status === 'pass'
          ? '<span style="color:#22c55e;font-weight:bold">PASS</span>'
          : r.status === 'fail'
            ? '<span style="color:#ef4444;font-weight:bold">FAIL</span>'
            : r.status === 'error'
              ? '<span style="color:#f97316;font-weight:bold">ERR</span>'
              : '<span style="color:#6b7280">SKIP</span>';
      return `<tr><td>${escapeHtml(r.id)}</td><td>${r.type}</td><td>${badge}</td><td>${escapeHtml(r.claim)}</td><td>${escapeHtml(r.reason)}</td><td>${r.durationMs}ms</td></tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Doc Verification Report</title>
<style>
body{font-family:system-ui,sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#0f172a;color:#e2e8f0}
h1{color:#f8fafc}
.summary{display:flex;gap:20px;margin:20px 0}
.stat{background:#1e293b;padding:16px 24px;border-radius:8px;text-align:center}
.stat .value{font-size:2em;font-weight:bold}
.stat .label{color:#94a3b8;font-size:0.85em}
table{width:100%;border-collapse:collapse;margin-top:20px}
th{background:#1e293b;padding:10px;text-align:left;font-size:0.85em;color:#94a3b8}
td{padding:8px 10px;border-bottom:1px solid #1e293b;font-size:0.85em}
tr:hover{background:#1e293b}
</style></head><body>
<h1>Doc Verification Report</h1>
<div class="summary">
  <div class="stat"><div class="value">${rate}%</div><div class="label">Pass Rate</div></div>
  <div class="stat"><div class="value" style="color:#22c55e">${report.passed}</div><div class="label">Passed</div></div>
  <div class="stat"><div class="value" style="color:#ef4444">${report.failed}</div><div class="label">Failed</div></div>
  <div class="stat"><div class="value" style="color:#f97316">${report.errors}</div><div class="label">Errors</div></div>
  <div class="stat"><div class="value">${report.total}</div><div class="label">Total</div></div>
</div>
<table><thead><tr><th>ID</th><th>Type</th><th>Status</th><th>Claim</th><th>Reason</th><th>Duration</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;

  await writeFile(path, html);
  console.log(`HTML report saved to ${path}`);
}
