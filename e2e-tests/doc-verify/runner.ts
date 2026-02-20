// e2e-tests/doc-verify/runner.ts
import type { AssertionManifest, Assertion, AssertionResult, RunReport } from './types';
import { executeApiAssertion } from './executors/api';
import { executeSqlAssertion } from './executors/sql';
import { executeUiAssertion, initBrowser, closeBrowser } from './executors/ui';

interface RunOptions {
  apiUrl: string;
  baseUrl: string;
  dbUrl: string;
  env: Record<string, string>;
  page?: string;
  typeFilter?: ('api' | 'sql' | 'ui')[];
}

export async function runAssertions(
  manifest: AssertionManifest,
  options: RunOptions,
): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const results: AssertionResult[] = [];

  let pages = manifest.pages;
  if (options.page) {
    pages = pages.filter((p) => p.source.includes(options.page!));
  }

  const allAssertions: { assertion: Assertion; source: string }[] = [];
  for (const page of pages) {
    for (const assertion of page.assertions) {
      if (options.typeFilter && !options.typeFilter.includes(assertion.type)) {
        continue;
      }
      allAssertions.push({ assertion, source: page.source });
    }
  }

  console.log(`\nRunning ${allAssertions.length} assertions...\n`);

  const hasUiAssertions = allAssertions.some((a) => a.assertion.type === 'ui');
  if (hasUiAssertions) {
    console.log('Initializing browser for UI assertions...');
    await initBrowser();
  }

  const context: Record<string, string> = { ...options.env };

  for (const { assertion } of allAssertions) {
    const prefix = `[${assertion.type}] ${assertion.id}`;
    process.stdout.write(`  ${prefix}: ${assertion.claim.slice(0, 60)}...`);

    let result: AssertionResult;

    switch (assertion.type) {
      case 'api':
        result = await executeApiAssertion(assertion, options.apiUrl, context);
        break;
      case 'sql':
        result = await executeSqlAssertion(assertion, options.dbUrl, context);
        break;
      case 'ui':
        result = await executeUiAssertion(assertion, options.baseUrl, context);
        break;
      default:
        result = {
          id: assertion.id,
          type: assertion.type,
          claim: assertion.claim,
          status: 'skip',
          reason: `Unknown assertion type: ${assertion.type}`,
          durationMs: 0,
        };
    }

    const icon = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : result.status === 'error' ? 'ERR ' : 'SKIP';
    console.log(` ${icon} (${result.durationMs}ms)`);
    if (result.status !== 'pass') {
      console.log(`    ${result.reason}`);
    }

    results.push(result);
  }

  if (hasUiAssertions) {
    await closeBrowser();
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  };
}
