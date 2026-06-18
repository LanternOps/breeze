export interface PhaseResult { name: string; ok: boolean; ms: number; error?: string }
export interface RegionResult { region: string; phases: PhaseResult[]; ok: boolean }

export function printReport(results: RegionResult[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ results, ok: results.every((r) => r.ok) }, null, 2) + '\n');
    return;
  }
  for (const r of results) {
    process.stdout.write(`\n=== ${r.region.toUpperCase()} : ${r.ok ? 'PASS' : 'FAIL'} ===\n`);
    for (const p of r.phases) {
      const mark = p.ok ? '✓' : '✗';
      process.stdout.write(`  ${mark} ${p.name.padEnd(16)} ${p.ms}ms${p.error ? `  — ${p.error}` : ''}\n`);
    }
  }
  process.stdout.write(`\nOVERALL: ${results.every((r) => r.ok) ? 'PASS' : 'FAIL'}\n`);
}
