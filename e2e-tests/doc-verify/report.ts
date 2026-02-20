// e2e-tests/doc-verify/report.ts
import { writeFile } from 'fs/promises';
import type { RunReport } from './types';

export function printSummary(report: RunReport): void {
  console.log('\n' + '='.repeat(60));
  console.log('Documentation Verification Report');
  console.log('='.repeat(60));
  console.log(`Total:   ${report.total}`);
  console.log(`Passed:  ${report.passed}`);
  console.log(`Failed:  ${report.failed}`);
  console.log(`Errors:  ${report.errors}`);
  console.log(`Skipped: ${report.skipped}`);
  console.log(`Time:    ${new Date(report.completedAt).getTime() - new Date(report.startedAt).getTime()}ms`);
  console.log('='.repeat(60));

  if (report.failed > 0 || report.errors > 0) {
    console.log('\nFailed/Error assertions:');
    for (const r of report.results) {
      if (r.status === 'fail' || r.status === 'error') {
        console.log(`  [${r.status.toUpperCase()}] ${r.id}: ${r.claim}`);
        console.log(`    Reason: ${r.reason}`);
      }
    }
  }
}

export async function saveJsonReport(report: RunReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`\nJSON report saved to ${path}`);
}

export async function saveHtmlReport(report: RunReport, path: string): Promise<void> {
  const passRate = report.total > 0 ? Math.round((report.passed / report.total) * 100) : 0;
  const statusColor = passRate === 100 ? '#22c55e' : passRate >= 80 ? '#eab308' : '#ef4444';

  const rows = report.results
    .map(
      (r) => `<tr>
        <td><code>${escapeHtml(r.id)}</code></td>
        <td>${escapeHtml(r.type)}</td>
        <td>${escapeHtml(r.claim)}</td>
        <td><span class="badge badge-${r.status}">${r.status.toUpperCase()}</span></td>
        <td>${r.durationMs}ms</td>
        <td>${r.status !== 'pass' ? escapeHtml(r.reason) : ''}</td>
      </tr>`,
    )
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Doc Verification Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    .summary { display: flex; gap: 1rem; margin: 1rem 0; }
    .stat { padding: 1rem; border-radius: 8px; background: #f3f4f6; flex: 1; text-align: center; }
    .stat .num { font-size: 2rem; font-weight: bold; }
    .pass { color: #22c55e; } .fail { color: #ef4444; } .error { color: #f59e0b; } .skip { color: #9ca3af; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background: #f9fafb; font-weight: 600; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-pass { background: #dcfce7; color: #166534; }
    .badge-fail { background: #fee2e2; color: #991b1b; }
    .badge-error { background: #fef3c7; color: #92400e; }
    .badge-skip { background: #f3f4f6; color: #6b7280; }
  </style>
</head>
<body>
  <h1>Documentation Verification Report</h1>
  <p>Generated: ${escapeHtml(new Date(report.completedAt).toLocaleString())}</p>
  <div class="summary">
    <div class="stat"><div class="num">${report.total}</div>Total</div>
    <div class="stat"><div class="num pass">${report.passed}</div>Passed</div>
    <div class="stat"><div class="num fail">${report.failed}</div>Failed</div>
    <div class="stat"><div class="num error">${report.errors}</div>Errors</div>
  </div>
  <div style="text-align:center;font-size:1.5rem;color:${statusColor};font-weight:bold;margin:1rem 0;">
    ${passRate}% Pass Rate
  </div>
  <table>
    <thead><tr><th>ID</th><th>Type</th><th>Claim</th><th>Status</th><th>Time</th><th>Details</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;

  await writeFile(path, html);
  console.log(`HTML report saved to ${path}`);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
