// e2e-tests/doc-verify/runner.ts
import type { AssertionManifest, Assertion, AssertionResult, RunReport } from './types';
import { executeApiAssertion } from './executors/api';
import { executeSqlAssertion } from './executors/sql';
import { executeUiAssertion, initBrowser, closeBrowser } from './executors/ui';

export interface RunOptions {
  apiUrl: string;
  webUrl: string;
  dbUrl: string;
  env: Record<string, string>;
  filterPage?: string;
  filterType?: 'api' | 'sql' | 'ui';
}

export async function runAssertions(
  manifest: AssertionManifest,
  options: RunOptions,
): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const results: AssertionResult[] = [];

  // Collect all assertions, optionally filtering
  const allAssertions: Assertion[] = [];
  for (const page of manifest.pages) {
    if (options.filterPage && !page.source.includes(options.filterPage)) continue;
    for (const assertion of page.assertions) {
      if (options.filterType && assertion.type !== options.filterType) continue;
      allAssertions.push(assertion);
    }
  }

  // Init browser if we have UI assertions
  const hasUi = allAssertions.some((a) => a.type === 'ui');
  if (hasUi) {
    console.log('  [browser] Launching Chromium...');
    await initBrowser();
  }

  // Execute sequentially
  for (const assertion of allAssertions) {
    try {
      let result: AssertionResult;

      switch (assertion.type) {
        case 'api':
          result = await executeApiAssertion(assertion, options.apiUrl, options.env);
          break;
        case 'sql':
          result = await executeSqlAssertion(assertion, options.dbUrl, options.env);
          break;
        case 'ui':
          result = await executeUiAssertion(assertion, options.webUrl, options.env);
          break;
      }

      const icon = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : result.status === 'error' ? 'ERR ' : 'SKIP';
      console.log(`  [${icon}] ${assertion.id}: ${assertion.claim.slice(0, 80)}`);
      if (result.status !== 'pass') {
        console.log(`         ${result.reason.slice(0, 120)}`);
      }

      results.push(result);
    } catch (err) {
      const errResult: AssertionResult = {
        id: assertion.id,
        type: assertion.type,
        claim: assertion.claim,
        status: 'error',
        reason: `Runner error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: 0,
      };
      console.log(`  [ERR ] ${assertion.id}: ${errResult.reason.slice(0, 100)}`);
      results.push(errResult);
    }
  }

  if (hasUi) {
    await closeBrowser();
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const errors = results.filter((r) => r.status === 'error').length;

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    skipped,
    errors,
    results,
  };
}
