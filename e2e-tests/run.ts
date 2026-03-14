#!/usr/bin/env npx tsx
/**
 * Breeze E2E Test Runner
 *
 * Executes YAML-defined test plans in either:
 * - live mode: real Playwright UI actions + remote MCP calls
 * - simulate mode: non-blocking preview of UI/remote steps
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import yaml from 'yaml';
import dotenv from 'dotenv';

import type { Config, Test, TestFile, TestResult, CLIOptions, RunnerContext, UiSession } from './src/types.js';
import { isRecord, resolveEnvString } from './src/utils.js';
import { closeUiSession, cleanupBrowser } from './src/browser.js';
import { runUiStepLive, runRemoteStepLive, runApiStepLive, runUiStepSimulated, runRemoteStepSimulated, runApiStepSimulated } from './src/steps.js';
import { TestTracker } from './src/tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from parent breeze directory (where E2E_ vars live)
dotenv.config({ path: path.join(__dirname, '..', '.env') });
// Also try local .env if it exists
dotenv.config({ path: path.join(__dirname, '.env') });

// Alias E2E env vars → TEST_USER vars used in YAML templates
if (!process.env.TEST_USER_EMAIL && process.env.E2E_ADMIN_EMAIL) {
  process.env.TEST_USER_EMAIL = process.env.E2E_ADMIN_EMAIL;
}
if (!process.env.TEST_USER_PASSWORD && process.env.E2E_ADMIN_PASSWORD) {
  process.env.TEST_USER_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
}

// --- CLI argument parsing ---

const args = process.argv.slice(2);
const options: CLIOptions = {
  test: '',
  tags: [],
  nodes: [],
  dryRun: false,
  mode: 'live',
  verbose: false,
  help: false,
  allowUiSimulationInLive: false,
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--test':
    case '-t':
      options.test = args[++i] ?? '';
      break;
    case '--tags':
      options.tags = (args[++i] ?? '').split(',').filter(Boolean);
      break;
    case '--nodes':
    case '-n':
      options.nodes = (args[++i] ?? '').split(',').filter(Boolean);
      break;
    case '--dry-run':
    case '-d':
      options.dryRun = true;
      break;
    case '--mode': {
      const mode = args[++i] ?? '';
      if (mode !== 'live' && mode !== 'simulate') {
        console.error(`Invalid mode "${mode}". Expected "live" or "simulate".`);
        process.exit(1);
      }
      options.mode = mode;
      break;
    }
    case '--simulate':
      options.mode = 'simulate';
      break;
    case '--allow-ui-simulate':
      options.allowUiSimulationInLive = true;
      break;
    case '--verbose':
    case '-v':
      options.verbose = true;
      break;
    case '--help':
    case '-h':
      options.help = true;
      break;
  }
}

if (options.help) {
  console.log(`
Breeze E2E Test Runner

Usage: npx tsx run.ts [options]

Options:
  --test, -t <id>        Run specific test by ID
  --tags <tags>          Run tests matching tags (comma-separated)
  --nodes, -n <nodes>    Run only on specific nodes (comma-separated)
  --dry-run, -d          Show what would run without executing
  --mode <mode>          Execution mode: live | simulate (default: live)
  --simulate             Shortcut for --mode simulate
  --allow-ui-simulate    In live mode, simulate UI steps instead of running Playwright
  --verbose, -v          Verbose output
  --help, -h             Show this help

Examples:
  npx tsx run.ts
  npx tsx run.ts --mode simulate
  npx tsx run.ts --test agent_install_linux
  npx tsx run.ts --mode live --allow-ui-simulate --nodes linux
  npx tsx run.ts --tags critical
  npx tsx run.ts --dry-run
`);
  process.exit(0);
}

// --- Config loading ---

const configPath = path.join(__dirname, 'config.yaml');
let config: Config;
try {
  config = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (error) {
  console.error(`Failed to load config from ${configPath}:`, error);
  process.exit(1);
}

// --- Test discovery and filtering ---

const testsDir = path.join(__dirname, 'tests');
const testFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.yaml'));

const allTests: Test[] = [];
for (const file of testFiles) {
  const content = yaml.parse(fs.readFileSync(path.join(testsDir, file), 'utf-8')) as TestFile;
  if (content.tests) {
    allTests.push(...content.tests);
  }
}

let testsToRun = allTests;
if (options.test) {
  testsToRun = testsToRun.filter((t) => t.id === options.test || t.id.includes(options.test));
}
if (options.tags.length > 0) {
  testsToRun = testsToRun.filter((t) => t.tags?.some((tag) => options.tags.includes(tag)));
}
if (options.nodes.length > 0) {
  testsToRun = testsToRun.filter((t) => t.nodes.some((node) => options.nodes.includes(node)));
}

// In live mode, auto-skip tests that contain 'remote' steps unless nodes are configured
if (options.mode === 'live') {
  const hasRemoteNodes = config.nodes && Object.values(config.nodes).some(
    (n: any) => n.host && !n.host.includes('${')
  );
  if (!hasRemoteNodes) {
    const beforeCount = testsToRun.length;
    testsToRun = testsToRun.filter((t) =>
      !t.steps.some((s) => s.action === 'remote')
    );
    const skipped = beforeCount - testsToRun.length;
    if (skipped > 0) {
      console.log(`⏭ Skipping ${skipped} test(s) with 'remote' steps (no MCP nodes configured)`);
    }
  }
}

// --- Display ---

function printBanner(testCount: number): void {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           Breeze E2E Test Runner                          ║
╠═══════════════════════════════════════════════════════════╣
║  Tests found: ${testCount.toString().padEnd(42)}║
║  Dry run: ${options.dryRun.toString().padEnd(46)}║
║  Mode: ${options.mode.padEnd(49)}║
║  Verbose: ${options.verbose.toString().padEnd(46)}║
╚═══════════════════════════════════════════════════════════╝
`);
}

function printPlan(tests: Test[]): void {
  console.log('Test Plan:');
  console.log('─'.repeat(60));
  for (const test of tests) {
    console.log(`  ${test.id}`);
    console.log(`    Name: ${test.name}`);
    console.log(`    Nodes: ${test.nodes.join(', ')}`);
    console.log(`    Steps: ${test.steps.length}`);
    if (test.tags) {
      console.log(`    Tags: ${test.tags.join(', ')}`);
    }
    console.log();
  }
  console.log('─'.repeat(60));
}

printBanner(testsToRun.length);

if (testsToRun.length === 0) {
  console.log('No tests match the specified criteria.');
  process.exit(0);
}

printPlan(testsToRun);

if (options.dryRun) {
  console.log('\nDry run complete. No tests were executed.');
  process.exit(0);
}

if (options.mode === 'simulate') {
  console.log('\nExecuting tests in SIMULATION mode (no live UI/remote actions will run)...\n');
} else {
  console.log('\nExecuting tests in LIVE mode...\n');
}

// --- Test execution ---

function clearRateLimits(): void {
  try {
    execSync(
      `docker exec breeze-redis redis-cli EVAL "local total = 0; for _,pat in ipairs({'login:*','global:*'}) do local keys = redis.call('KEYS',pat); for _,k in ipairs(keys) do redis.call('DEL',k) end; total = total + #keys end; return total" 0`,
      { stdio: 'ignore', timeout: 5000 }
    );
  } catch { /* Redis not available — skip */ }
}

async function runTest(test: Test): Promise<TestResult> {
  const startTime = Date.now();
  let uiSession: UiSession | null = null;
  const result: TestResult = {
    id: test.id,
    name: test.name,
    status: 'passed',
    duration: 0,
    steps: [],
  };

  const context: RunnerContext = {
    vars: {
      baseUrl: resolveEnvString(config.environment.baseUrl),
      apiUrl: resolveEnvString(config.environment.apiUrl),
      testId: test.id,
      testStartTime: new Date().toISOString(),
      twoHoursAgo: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      oneHourAgo: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      devices: config.devices
        ? Object.fromEntries(
            Object.entries(config.devices).map(([k, v]) => [k, resolveEnvString(String(v))])
          )
        : {},
    },
  };

  console.log(`\n▶ Running: ${test.name}`);

  try {
    for (const step of test.steps) {
      const stepStart = Date.now();
      const stepResult: TestResult['steps'][number] = {
        id: step.id,
        status: 'passed',
        duration: 0,
        error: undefined,
      };

      try {
        console.log(`  ├─ ${step.id}: ${step.description || step.action}`);

        let stepOutput: unknown = undefined;

        if (step.action === 'ui') {
          const shouldSimulateUi =
            options.mode === 'simulate'
            || options.allowUiSimulationInLive
            || process.env.E2E_ALLOW_UI_SIMULATION_IN_LIVE === 'true';

          if (shouldSimulateUi) {
            stepOutput = runUiStepSimulated(step, context, options);
          } else {
            console.log('     [UI] Executing Playwright actions');
            const liveUiResult = await runUiStepLive(step, context, uiSession, config, options, test.id);
            uiSession = liveUiResult.session;
            stepOutput = liveUiResult.output;

            if (options.verbose) {
              console.log(`     Result: ${JSON.stringify(stepOutput, null, 2)}`);
            }
          }
        } else if (step.action === 'remote') {
          if (options.mode === 'simulate') {
            stepOutput = runRemoteStepSimulated(step, context, options);
          } else {
            console.log(`     [REMOTE:${step.node}] (deprecated) Executing ${step.tool ?? 'claude_code'} via MCP`);
            stepOutput = await runRemoteStepLive(step, context, config);

            if (options.verbose) {
              console.log(`     Result: ${JSON.stringify(stepOutput, null, 2)}`);
            }
          }
        } else if (step.action === 'api') {
          if (options.mode === 'simulate') {
            stepOutput = runApiStepSimulated(step, context, options);
          } else {
            const apiMethod = step.request?.method ?? 'GET';
            const apiPath = step.request?.path ?? '';
            console.log(`     [API] ${apiMethod} ${apiPath}`);
            stepOutput = await runApiStepLive(step, context, config, options);

            if (options.verbose) {
              console.log(`     Result: ${JSON.stringify(stepOutput, null, 2)}`);
            }
          }
        }

        context.vars[step.id] = stepOutput;
        if (isRecord(stepOutput)) {
          for (const [k, v] of Object.entries(stepOutput)) {
            if (!(k in context.vars)) {
              context.vars[k] = v;
            }
          }
        }

        // Check for browser errors collected during this step (live UI only)
        if (step.action === 'ui' && uiSession?.browserErrors) {
          const errorsThisStep = uiSession.browserErrors.filter((e) => !e.stepId);
          if (errorsThisStep.length > 0) {
            for (const err of errorsThisStep) {
              err.stepId = step.id;
            }
            stepResult.browserErrors = errorsThisStep;

            const uncaughtErrors = errorsThisStep.filter((e) => e.type === 'pageerror');
            if (uncaughtErrors.length > 0) {
              const messages = uncaughtErrors.map((e) => e.message).join('; ');
              throw new Error(`Uncaught browser exception: ${messages}`);
            }

            for (const err of errorsThisStep) {
              if (err.type === 'console.error') {
                console.log(`     ⚠ Browser console.error: ${err.message}`);
              } else if (err.type === 'http-error') {
                console.log(`     ⚠ ${err.message}`);
              }
            }
          }
        }

        if (options.mode === 'simulate') {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        console.log('     ✓ Passed');
      } catch (error) {
        stepResult.status = 'failed';
        stepResult.error = error instanceof Error ? error.message : String(error);
        console.log(`     ✗ Failed: ${stepResult.error}`);

        if (!step.optional) {
          result.status = 'failed';
          result.error = `Step ${step.id} failed: ${stepResult.error}`;
        }
      }

      stepResult.duration = Date.now() - stepStart;
      result.steps.push(stepResult);

      if (result.status === 'failed') {
        if (config.execution.failFast) break;
        const remaining = test.steps.slice(test.steps.indexOf(step) + 1);
        for (const skipped of remaining) {
          result.steps.push({ id: skipped.id, status: 'skipped' as any, duration: 0, error: undefined });
        }
        break;
      }
    }
  } finally {
    if (uiSession?.browserErrors && uiSession.browserErrors.length > 0) {
      result.browserErrors = [...uiSession.browserErrors];
    }
    await closeUiSession(uiSession);
  }

  result.duration = Date.now() - startTime;
  const statusIcon = result.status === 'passed' ? '✓' : '✗';
  console.log(`  └─ ${statusIcon} ${result.status.toUpperCase()} (${result.duration}ms)`);

  if (result.browserErrors && result.browserErrors.length > 0) {
    const pageErrors = result.browserErrors.filter((e) => e.type === 'pageerror').length;
    const consoleErrors = result.browserErrors.filter((e) => e.type === 'console.error').length;
    const httpErrors = result.browserErrors.filter((e) => e.type === 'http-error').length;
    const parts: string[] = [];
    if (pageErrors > 0) parts.push(`${pageErrors} uncaught exception${pageErrors > 1 ? 's' : ''}`);
    if (consoleErrors > 0) parts.push(`${consoleErrors} console.error${consoleErrors > 1 ? 's' : ''}`);
    if (httpErrors > 0) parts.push(`${httpErrors} HTTP error${httpErrors > 1 ? 's' : ''}`);
    console.log(`  ⚠ Browser errors: ${parts.join(', ')}`);
  }

  return result;
}

// --- Main ---

(async () => {
  const tracker = new TestTracker(__dirname, options.mode);
  console.log(`  Results: ${tracker.getRunDir()}`);

  try {
    clearRateLimits();

    for (let i = 0; i < testsToRun.length; i++) {
      clearRateLimits();
      const test = testsToRun[i];
      const result = await runTest(test);
      tracker.recordTest(result);
    }

    const summary = tracker.finish();

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    Test Summary                           ║
╠═══════════════════════════════════════════════════════════╣
║  Passed:  ${summary.passed.toString().padEnd(47)}║
║  Failed:  ${summary.failed.toString().padEnd(47)}║
║  Skipped: ${summary.skipped.toString().padEnd(47)}║
║  Total:   ${summary.total.toString().padEnd(47)}║
║  Duration: ${((summary.duration / 1000).toFixed(1) + 's').padEnd(47)}║
╚═══════════════════════════════════════════════════════════╝
`);

    if (summary.failed > 0) {
      console.log('Failed tests:');
      for (const result of summary.tests.filter((r) => r.status === 'failed')) {
        console.log(`  - ${result.id}: ${result.error}`);
      }
    }

    // Browser errors summary
    const allBrowserErrors = summary.tests.flatMap((r) => r.browserErrors ?? []);
    if (allBrowserErrors.length > 0) {
      const pageErrors = allBrowserErrors.filter((e) => e.type === 'pageerror');
      const consoleErrors = allBrowserErrors.filter((e) => e.type === 'console.error');
      const httpErrors = allBrowserErrors.filter((e) => e.type === 'http-error');

      console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
      console.log(`║                 Browser Errors Summary                    ║`);
      console.log(`╠═══════════════════════════════════════════════════════════╣`);
      console.log(`║  Uncaught exceptions: ${pageErrors.length.toString().padEnd(36)}║`);
      console.log(`║  Console errors:     ${consoleErrors.length.toString().padEnd(37)}║`);
      console.log(`║  HTTP errors (4xx/5xx): ${httpErrors.length.toString().padEnd(34)}║`);
      console.log(`║  Total:              ${allBrowserErrors.length.toString().padEnd(37)}║`);
      console.log(`╚═══════════════════════════════════════════════════════════╝`);

      if (pageErrors.length > 0) {
        console.log('\nUncaught exceptions (caused test failures):');
        for (const err of pageErrors) {
          console.log(`  [${err.stepId ?? '?'}] ${err.message}`);
          if (err.url) console.log(`    at ${err.url}`);
        }
      }

      if (httpErrors.length > 0) {
        console.log('\nHTTP errors during UI steps:');
        for (const err of httpErrors) {
          console.log(`  [${err.stepId ?? '?'}] ${err.message}`);
        }
      }

      if (consoleErrors.length > 0 && options.verbose) {
        console.log('\nConsole errors (verbose):');
        for (const err of consoleErrors) {
          console.log(`  [${err.stepId ?? '?'}] ${err.message}`);
        }
      }
    }

    console.log(`\nResults saved to: ${tracker.getRunDir()}`);

    if (summary.failed > 0) {
      process.exit(1);
    }

    if (options.mode === 'simulate') {
      console.log('All simulated tests passed. No live UI/remote execution was performed.');
    } else {
      console.log('All live test steps passed.');
    }
  } finally {
    await cleanupBrowser();
  }
})();
