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
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestStep {
  id: string;
  action: 'ui' | 'remote';
  description?: string;
  node?: string;
  tool?: string;
  args?: Record<string, unknown>;
  playwright?: unknown[];
  expect?: Record<string, unknown>;
  optional?: boolean;
  timeout?: number;
}

interface Test {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  nodes: string[];
  timeout?: number;
  steps: TestStep[];
}

interface TestFile {
  tests: Test[];
}

interface NodeAuthConfig {
  type?: string;
  token?: string;
}

interface NodeConfig {
  name?: string;
  host?: string;
  port?: number;
  auth?: NodeAuthConfig;
  platform?: string;
}

interface Config {
  environment: {
    baseUrl: string;
    apiUrl: string;
    defaultTimeout: number;
    testTimeout: number;
  };
  nodes: Record<string, NodeConfig>;
  execution: {
    parallel: boolean;
    retries: number;
    failFast: boolean;
    reporter: string;
  };
  playwright?: {
    browser?: string;
    headless?: boolean;
    slowMo?: number;
    viewport?: {
      width?: number;
      height?: number;
    };
  };
}

interface TestResult {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  error?: string;
  steps: {
    id: string;
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
  }[];
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface RunnerContext {
  vars: Record<string, unknown>;
}

interface UiSession {
  browser: any;
  context: any;
  page: any;
}

const ENV_EXPR = /\$\{([A-Z0-9_]+)(:-([^}]*))?\}/g;
const TEMPLATE_EXPR = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

const args = process.argv.slice(2);
const options = {
  test: '',
  tags: [] as string[],
  nodes: [] as string[],
  dryRun: false,
  mode: 'live' as 'live' | 'simulate',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveEnvString(input: string): string {
  return input.replace(ENV_EXPR, (_m, varName: string, _fallbackExpr: string, fallbackValue: string) => {
    const envValue = process.env[varName];
    if (envValue !== undefined && envValue !== '') {
      return envValue;
    }
    return fallbackValue ?? '';
  });
}

function lookupVar(vars: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = vars;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function interpolateTemplate(input: string, vars: Record<string, unknown>): string {
  const envResolved = resolveEnvString(input);
  return envResolved.replace(TEMPLATE_EXPR, (_m, key: string) => {
    const value = lookupVar(vars, key);
    if (value === undefined || value === null) {
      return '';
    }
    return String(value);
  });
}

function resolveTemplates<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    return interpolateTemplate(value, vars) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplates(entry, vars)) as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveTemplates(v, vars);
    }
    return out as T;
  }
  return value;
}

function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // continue
    }
  }

  const objectLike = trimmed.match(/\{[\s\S]*\}/);
  if (objectLike?.[0]) {
    try {
      return JSON.parse(objectLike[0]);
    } catch {
      // continue
    }
  }

  return undefined;
}

function extractStructuredResult(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }

  if (isRecord(result.structuredContent)) {
    return result.structuredContent;
  }

  if (Array.isArray(result.content)) {
    for (const chunk of result.content) {
      if (!isRecord(chunk)) continue;
      if (typeof chunk.text === 'string') {
        const parsed = parseJsonFromText(chunk.text);
        if (parsed !== undefined) return parsed;
      }
    }
  }

  if (typeof result.text === 'string') {
    const parsed = parseJsonFromText(result.text);
    if (parsed !== undefined) return parsed;
  }

  return result;
}

function assertExpectations(expected: unknown, actual: unknown, pathLabel = 'result'): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`${pathLabel}: expected array, got ${typeof actual}`);
    }
    if (expected.length !== actual.length) {
      throw new Error(`${pathLabel}: expected array length ${expected.length}, got ${actual.length}`);
    }
    for (let i = 0; i < expected.length; i++) {
      assertExpectations(expected[i], actual[i], `${pathLabel}[${i}]`);
    }
    return;
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      throw new Error(`${pathLabel}: expected object, got ${typeof actual}`);
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (!(key in actual)) {
        throw new Error(`${pathLabel}.${key}: missing key in actual result`);
      }
      assertExpectations(expectedValue, actual[key], `${pathLabel}.${key}`);
    }
    return;
  }

  if (actual !== expected) {
    throw new Error(`${pathLabel}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function buildNodeBaseUrl(host: string, port: number): string {
  const normalizedHost = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;
  const url = new URL(normalizedHost);
  if (!url.port) {
    url.port = String(port);
  }
  return `${url.protocol}//${url.host}`;
}

function resolveNode(nodeId: string): { baseUrl: string; token: string; platform?: string } {
  const rawNode = config.nodes[nodeId];
  if (!rawNode) {
    throw new Error(`Unknown node "${nodeId}" in config.yaml`);
  }

  const host = rawNode.host ? resolveEnvString(rawNode.host) : '';
  if (!host) {
    throw new Error(`Node "${nodeId}" is missing host configuration`);
  }

  const token = rawNode.auth?.token ? resolveEnvString(String(rawNode.auth.token)) : '';
  const port = Number(rawNode.port ?? 3100);

  return {
    baseUrl: buildNodeBaseUrl(host, port),
    token,
    platform: rawNode.platform,
  };
}

async function postJsonWithTimeout(url: string, payload: unknown, headers: Record<string, string>, timeoutMs: number): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    const bodyJson = bodyText ? (JSON.parse(bodyText) as JsonRpcResponse) : {};

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${bodyText}`);
    }

    return bodyJson;
  } finally {
    clearTimeout(timeout);
  }
}

function captureSimulatedExtracts(step: TestStep, vars: Record<string, unknown>): void {
  if (!Array.isArray(step.playwright)) return;
  for (const action of step.playwright) {
    if (!isRecord(action) || !isRecord(action.extract)) continue;
    for (const key of Object.keys(action.extract)) {
      if (!(key in vars)) {
        vars[key] = `simulated-${key}`;
      }
    }
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

function normalizeUrl(target: string, baseUrl: string): string {
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return target;
  }
  return new URL(target, baseUrl).toString();
}

let playwrightModulePromise: Promise<any> | null = null;

async function loadPlaywrightModule(): Promise<any> {
  if (!playwrightModulePromise) {
    playwrightModulePromise = import('playwright').catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Playwright is required for live UI steps. Install it in e2e-tests (npm install) and run "npx playwright install". Original error: ${message}`
      );
    });
  }
  return playwrightModulePromise;
}

async function closeUiSession(session: UiSession | null): Promise<void> {
  if (!session) return;
  try {
    await session.context.close();
  } catch {
    // ignore close errors
  }
  try {
    await session.browser.close();
  } catch {
    // ignore close errors
  }
}

async function ensureUiSession(existing: UiSession | null, context: RunnerContext): Promise<UiSession> {
  if (existing) return existing;

  const playwright = await loadPlaywrightModule();
  const configuredBrowser = String(process.env.E2E_BROWSER ?? config.playwright?.browser ?? 'chromium').toLowerCase();
  const browserType = playwright[configuredBrowser];
  if (!browserType || typeof browserType.launch !== 'function') {
    throw new Error(`Unsupported Playwright browser "${configuredBrowser}". Use chromium, firefox, or webkit.`);
  }

  const headless = asBoolean(process.env.E2E_HEADLESS) ?? config.playwright?.headless ?? false;
  const slowMo = asNumber(process.env.E2E_SLOWMO) ?? config.playwright?.slowMo ?? 0;

  const browser = await browserType.launch({
    headless,
    slowMo,
  });

  const contextOptions: Record<string, unknown> = {};
  const baseUrl = String(context.vars.baseUrl ?? resolveEnvString(config.environment.baseUrl));
  contextOptions.baseURL = resolveEnvString(baseUrl);

  const viewportWidth = config.playwright?.viewport?.width;
  const viewportHeight = config.playwright?.viewport?.height;
  if (typeof viewportWidth === 'number' && typeof viewportHeight === 'number') {
    contextOptions.viewport = { width: viewportWidth, height: viewportHeight };
  }

  const browserContext = await browser.newContext(contextOptions);
  const page = await browserContext.newPage();
  page.setDefaultTimeout(config.environment.defaultTimeout ?? 30000);

  return {
    browser,
    context: browserContext,
    page,
  };
}

function getUiActionTimeout(action: Record<string, unknown>, fallback: number): number {
  return asNumber(action.timeout) ?? fallback;
}

function getUiAction(action: Record<string, unknown>): { name: string; payload: unknown } {
  const actionNames = ['goto', 'fill', 'click', 'waitFor', 'assert', 'assertNotExists', 'extract', 'type', 'press', 'uploadFile'];
  for (const name of actionNames) {
    if (name in action) {
      return { name, payload: action[name] };
    }
  }
  throw new Error(`Unsupported UI action: ${JSON.stringify(action)}`);
}

async function extractLocatorValue(locator: any, timeout: number): Promise<string> {
  try {
    const inputValue = await locator.inputValue({ timeout });
    if (typeof inputValue === 'string' && inputValue.trim() !== '') {
      return inputValue.trim();
    }
  } catch {
    // locator may not support inputValue; continue with text content
  }

  const textContent = await locator.textContent({ timeout });
  return (textContent ?? '').trim();
}

async function runUiPlaywrightAction(
  page: any,
  actionRaw: unknown,
  context: RunnerContext,
  stepOutput: Record<string, unknown>,
  defaultTimeout: number
): Promise<void> {
  if (!isRecord(actionRaw)) {
    throw new Error(`UI action must be an object. Received: ${JSON.stringify(actionRaw)}`);
  }

  const action = resolveTemplates(actionRaw, context.vars);
  if (!isRecord(action)) {
    throw new Error(`UI action template resolution failed for: ${JSON.stringify(actionRaw)}`);
  }

  const { name, payload } = getUiAction(action);
  const timeout = getUiActionTimeout(action, defaultTimeout);

  switch (name) {
    case 'goto': {
      if (typeof payload !== 'string') {
        throw new Error(`goto action expects a URL/path string, got ${typeof payload}`);
      }
      const baseUrl = String(context.vars.baseUrl ?? resolveEnvString(config.environment.baseUrl));
      const target = normalizeUrl(payload, baseUrl);
      await page.goto(target, { waitUntil: 'networkidle', timeout });
      return;
    }

    case 'fill': {
      if (!isRecord(payload)) {
        throw new Error('fill action expects an object mapping selector -> value');
      }
      for (const [selector, value] of Object.entries(payload)) {
        await page.locator(selector).fill(String(value ?? ''), { timeout });
      }
      return;
    }

    case 'click': {
      if (typeof payload !== 'string') {
        throw new Error('click action expects a selector string');
      }
      await page.locator(payload).click({ timeout });
      return;
    }

    case 'waitFor': {
      if (typeof payload === 'string') {
        await page.locator(payload).first().waitFor({ state: 'visible', timeout });
        return;
      }
      if (isRecord(payload)) {
        const waitTimeout = asNumber(payload.timeout) ?? timeout;
        if (typeof payload.url === 'string') {
          await page.waitForURL(payload.url, { timeout: waitTimeout });
          return;
        }
        const selector = typeof payload.selector === 'string' ? payload.selector : undefined;
        const text = typeof payload.text === 'string' ? payload.text : undefined;
        const state = typeof payload.state === 'string' ? payload.state : 'visible';
        if (selector) {
          await page.locator(selector).first().waitFor({ state, timeout: waitTimeout });
          return;
        }
        if (text) {
          await page.locator(`text=${text}`).first().waitFor({ state, timeout: waitTimeout });
          return;
        }
      }
      throw new Error('waitFor action expects a selector string or { selector|text|url, timeout?, state? }');
    }

    case 'assert': {
      if (!isRecord(payload)) {
        throw new Error('assert action expects an object');
      }
      const selector = typeof payload.selector === 'string' ? payload.selector : undefined;
      const text = typeof payload.text === 'string' ? payload.text : undefined;
      const contains = typeof payload.contains === 'string' ? payload.contains : undefined;

      if (!selector) {
        throw new Error('assert action requires "selector"');
      }

      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout });
      const actualText = (await locator.innerText({ timeout })).trim();

      if (text !== undefined && actualText !== text) {
        throw new Error(`assert text mismatch for ${selector}: expected "${text}", got "${actualText}"`);
      }
      if (contains !== undefined && !actualText.includes(contains)) {
        throw new Error(`assert contains mismatch for ${selector}: expected to include "${contains}", got "${actualText}"`);
      }
      return;
    }

    case 'assertNotExists': {
      if (typeof payload !== 'string') {
        throw new Error('assertNotExists action expects a selector string');
      }
      const locator = page.locator(payload);
      const count = await locator.count();
      if (count === 0) {
        return;
      }
      await locator.first().waitFor({ state: 'detached', timeout });
      const remaining = await locator.count();
      if (remaining > 0) {
        throw new Error(`assertNotExists failed: selector "${payload}" still has ${remaining} matching element(s)`);
      }
      return;
    }

    case 'extract': {
      if (!isRecord(payload)) {
        throw new Error('extract action expects an object mapping var -> selector');
      }
      for (const [varName, selectorValue] of Object.entries(payload)) {
        if (typeof selectorValue !== 'string') {
          throw new Error(`extract selector for "${varName}" must be a string`);
        }
        const locator = page.locator(selectorValue).first();
        await locator.waitFor({ state: 'visible', timeout });
        const value = await extractLocatorValue(locator, timeout);
        stepOutput[varName] = value;
        context.vars[varName] = value;
      }
      return;
    }

    case 'type': {
      if (!isRecord(payload)) {
        throw new Error('type action expects { selector, text }');
      }
      const selector = typeof payload.selector === 'string' ? payload.selector : '';
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!selector) {
        throw new Error('type action requires "selector"');
      }
      await page.locator(selector).type(text, { timeout });
      return;
    }

    case 'press': {
      if (typeof payload === 'string') {
        await page.keyboard.press(payload, { timeout });
        return;
      }
      if (isRecord(payload)) {
        const key = typeof payload.key === 'string' ? payload.key : '';
        const selector = typeof payload.selector === 'string' ? payload.selector : '';
        if (!key) {
          throw new Error('press action object requires "key"');
        }
        if (selector) {
          await page.locator(selector).press(key, { timeout });
        } else {
          await page.keyboard.press(key, { timeout });
        }
        return;
      }
      throw new Error('press action expects a key string or { key, selector? }');
    }

    case 'uploadFile': {
      if (!isRecord(payload)) {
        throw new Error('uploadFile action expects { selector, path? | content?, filename?, mimeType? }');
      }
      const selector = typeof payload.selector === 'string' ? payload.selector : '';
      if (!selector) {
        throw new Error('uploadFile action requires "selector"');
      }

      const locator = page.locator(selector);
      if (typeof payload.path === 'string') {
        await locator.setInputFiles(payload.path, { timeout });
        return;
      }

      if (payload.content !== undefined) {
        const filename = typeof payload.filename === 'string' ? payload.filename : 'upload.txt';
        const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : 'text/plain';
        await locator.setInputFiles({
          name: filename,
          mimeType,
          buffer: Buffer.from(String(payload.content)),
        }, { timeout });
        return;
      }

      throw new Error('uploadFile action requires either "path" or "content"');
    }

    default:
      throw new Error(`Unsupported UI action: ${name}`);
  }
}

async function runUiStepLive(step: TestStep, context: RunnerContext, currentSession: UiSession | null): Promise<{ output: Record<string, unknown>; session: UiSession }> {
  const session = await ensureUiSession(currentSession, context);
  const output: Record<string, unknown> = {};
  const actionTimeout = step.timeout ?? config.environment.defaultTimeout ?? 30000;
  const actions = Array.isArray(step.playwright) ? step.playwright : [];

  for (const action of actions) {
    await runUiPlaywrightAction(session.page, action, context, output, actionTimeout);
  }

  if (!('live' in output)) {
    output.live = true;
  }

  return { output, session };
}

async function runRemoteStepLive(step: TestStep, context: RunnerContext): Promise<unknown> {
  if (!step.node) {
    throw new Error('Remote step is missing node');
  }

  const node = resolveNode(step.node);
  const requestId = `${step.id}-${Date.now()}`;
  const timeoutMs = step.timeout ?? config.environment.defaultTimeout ?? 30000;

  const renderedArgs = resolveTemplates(step.args ?? {}, context.vars) as Record<string, unknown>;

  const rpcRequest = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: step.tool ?? 'claude_code',
      arguments: renderedArgs,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (node.token) {
    headers.Authorization = `Bearer ${node.token}`;
  }

  const response = await postJsonWithTimeout(`${node.baseUrl}/mcp`, rpcRequest, headers, timeoutMs);

  if (response.error) {
    throw new Error(`Remote MCP error ${response.error.code}: ${response.error.message}`);
  }

  const structured = extractStructuredResult(response.result);

  if (step.expect !== undefined) {
    const expected = resolveTemplates(step.expect, context.vars);
    assertExpectations(expected, structured);
  }

  return structured;
}

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

function printPlan(testsToRun: Test[]): void {
  console.log('Test Plan:');
  console.log('─'.repeat(60));
  for (const test of testsToRun) {
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

const configPath = path.join(__dirname, 'config.yaml');
let config: Config;
try {
  config = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (error) {
  console.error(`Failed to load config from ${configPath}:`, error);
  process.exit(1);
}

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

const results: TestResult[] = [];

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
            console.log('     [UI] Simulated Playwright actions');
            if (options.verbose && step.playwright) {
              console.log(`     Actions: ${JSON.stringify(step.playwright, null, 2)}`);
            }

            captureSimulatedExtracts(step, context.vars);
            stepOutput = { simulated: true };
          } else {
            console.log('     [UI] Executing Playwright actions');
            const liveUiResult = await runUiStepLive(step, context, uiSession);
            uiSession = liveUiResult.session;
            stepOutput = liveUiResult.output;

            if (options.verbose) {
              console.log(`     Result: ${JSON.stringify(stepOutput, null, 2)}`);
            }
          }
        } else if (step.action === 'remote') {
          if (options.mode === 'simulate') {
            console.log(`     [REMOTE:${step.node}] Simulated call to ${step.tool ?? 'claude_code'}`);
            if (options.verbose && step.args) {
              console.log(`     Args: ${JSON.stringify(resolveTemplates(step.args, context.vars), null, 2)}`);
            }
            stepOutput = { simulated: true };
          } else {
            console.log(`     [REMOTE:${step.node}] Executing ${step.tool ?? 'claude_code'} via MCP`);
            stepOutput = await runRemoteStepLive(step, context);

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

      if (result.status === 'failed' && config.execution.failFast) {
        break;
      }
    }
  } finally {
    await closeUiSession(uiSession);
  }

  result.duration = Date.now() - startTime;
  const statusIcon = result.status === 'passed' ? '✓' : '✗';
  console.log(`  └─ ${statusIcon} ${result.status.toUpperCase()} (${result.duration}ms)`);

  return result;
}

(async () => {
  for (const test of testsToRun) {
    const result = await runTest(test);
    results.push(result);
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    Test Summary                           ║
╠═══════════════════════════════════════════════════════════╣
║  Passed:  ${passed.toString().padEnd(47)}║
║  Failed:  ${failed.toString().padEnd(47)}║
║  Skipped: ${skipped.toString().padEnd(47)}║
║  Total:   ${results.length.toString().padEnd(47)}║
╚═══════════════════════════════════════════════════════════╝
`);

  if (failed > 0) {
    console.log('Failed tests:');
    for (const result of results.filter((r) => r.status === 'failed')) {
      console.log(`  - ${result.id}: ${result.error}`);
    }
    process.exit(1);
  }

  if (options.mode === 'simulate') {
    console.log('All simulated tests passed. No live UI/remote execution was performed.');
  } else {
    console.log('All live test steps passed.');
  }
})();
