import type { Config, UiSession, BrowserError, RunnerContext, TestStep } from './types.js';
import { isRecord, resolveEnvString, resolveTemplates, normalizeUrl, asNumber, asBoolean } from './utils.js';

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

// Shared browser instance — launched once, reused across all tests
let sharedBrowser: any = null;

// Shared UI session — persistent across all tests (no window flashing, no re-login)
let sharedUiSession: UiSession | null = null;

// Cached storage state (cookies/localStorage) from a successful login
export let cachedStorageState: any = null;
export function setCachedStorageState(state: any): void { cachedStorageState = state; }

// Cached API token captured from UI login response
export let cachedApiToken: string | null = null;
export function setCachedApiToken(token: string | null): void { cachedApiToken = token; }

export async function closeUiSession(session: UiSession | null): Promise<void> {
  if (!session) return;
  try {
    const state = await session.context.storageState();
    if (state && state.cookies && state.cookies.length > 0) {
      cachedStorageState = state;
    }
  } catch {
    // ignore — may already be closed
  }
  session.browserErrors.length = 0;
}

async function closeSharedBrowser(browser: any): Promise<void> {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    // ignore close errors
  }
}

export async function cleanupBrowser(): Promise<void> {
  if (sharedUiSession) {
    sharedUiSession.markClosed();
    try { await sharedUiSession.context.close(); } catch {}
    sharedUiSession = null;
  }
  await closeSharedBrowser(sharedBrowser);
  sharedBrowser = null;
}

async function launchSharedBrowser(config: Config): Promise<any> {
  if (sharedBrowser) return sharedBrowser;

  const playwright = await loadPlaywrightModule();
  const configuredBrowser = String(process.env.E2E_BROWSER ?? config.playwright?.browser ?? 'chromium').toLowerCase();
  const browserType = playwright[configuredBrowser];
  if (!browserType || typeof browserType.launch !== 'function') {
    throw new Error(`Unsupported Playwright browser "${configuredBrowser}". Use chromium, firefox, or webkit.`);
  }

  const headless = asBoolean(process.env.E2E_HEADLESS) ?? config.playwright?.headless ?? true;
  const slowMo = asNumber(process.env.E2E_SLOWMO) ?? config.playwright?.slowMo ?? 0;
  console.log(`  Browser: ${configuredBrowser}, headless: ${headless}, slowMo: ${slowMo}`);

  sharedBrowser = await browserType.launch({ headless, slowMo });
  return sharedBrowser;
}

export async function ensureUiSession(existing: UiSession | null, context: RunnerContext, config: Config): Promise<UiSession> {
  if (existing) return existing;

  if (sharedUiSession) {
    sharedUiSession.browserErrors.length = 0;
    return sharedUiSession;
  }

  const browser = await launchSharedBrowser(config);

  const contextOptions: Record<string, unknown> = {};
  const baseUrl = String(context.vars.baseUrl ?? resolveEnvString(config.environment.baseUrl));
  contextOptions.baseURL = resolveEnvString(baseUrl);

  const viewportWidth = config.playwright?.viewport?.width;
  const viewportHeight = config.playwright?.viewport?.height;
  if (typeof viewportWidth === 'number' && typeof viewportHeight === 'number') {
    contextOptions.viewport = { width: viewportWidth, height: viewportHeight };
  }

  if (cachedStorageState) {
    contextOptions.storageState = cachedStorageState;
  }

  const browserContext = await browser.newContext(contextOptions);
  const page = await browserContext.newPage();
  page.setDefaultTimeout(config.environment.defaultTimeout ?? 30000);

  const browserErrors: BrowserError[] = [];
  let sessionClosed = false;

  page.on('pageerror', (error: Error) => {
    if (sessionClosed) return;
    browserErrors.push({ type: 'pageerror', message: error.message, url: page.url() });
  });

  page.on('console', (msg: any) => {
    if (sessionClosed) return;
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('Download the React DevTools')) return;
      if (text.includes('favicon.ico')) return;
      browserErrors.push({
        type: 'console.error',
        message: text.length > 500 ? text.substring(0, 500) + '...' : text,
        url: page.url(),
      });
    }
  });

  page.on('response', async (response: any) => {
    if (sessionClosed) return;
    try {
      const url = response.url();
      if (response.status() === 200 && url.includes('/api/v1/auth/login')) {
        const body = await response.json().catch(() => null);
        if (body?.tokens?.accessToken) {
          cachedApiToken = body.tokens.accessToken;
        }
      }
    } catch { /* ignore */ }
  });

  page.on('response', (response: any) => {
    if (sessionClosed) return;
    try {
      const status = response.status();
      const url = response.url();
      if (status >= 400 && url.includes('/api/')) {
        browserErrors.push({
          type: 'http-error',
          message: `HTTP ${status} ${response.request().method()} ${url}`,
          url,
        });
      }
    } catch {
      // Response object may be invalid after context close
    }
  });

  const session: UiSession = {
    browser,
    context: browserContext,
    page,
    browserErrors,
    markClosed: () => { sessionClosed = true; },
  };

  sharedUiSession = session;
  return session;
}

// --- Playwright action execution ---

function getUiActionTimeout(action: Record<string, unknown>, fallback: number): number {
  return asNumber(action.timeout) ?? fallback;
}

function getUiAction(action: Record<string, unknown>): { name: string; payload: unknown } {
  const actionNames = ['goto', 'fill', 'click', 'waitFor', 'assert', 'assertNotExists', 'extract', 'type', 'press', 'press_key', 'uploadFile', 'selectOption', 'hover', 'check', 'uncheck', 'scrollTo'];
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

export async function runUiPlaywrightAction(
  page: any,
  actionRaw: unknown,
  context: RunnerContext,
  stepOutput: Record<string, unknown>,
  defaultTimeout: number,
  config: Config
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
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
      try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
      if (payload === '/login' || payload.endsWith('/login')) {
        try { await page.waitForSelector('button[type="submit"]', { state: 'attached', timeout: 5000 }); } catch {}
        await page.waitForTimeout(300);
      }
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
      await page.locator(payload).first().click({ timeout });
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
          await page.waitForURL(payload.url, { timeout: waitTimeout, waitUntil: 'domcontentloaded' });
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
      if (contains !== undefined && !actualText.toLowerCase().includes(String(contains).toLowerCase())) {
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
      if (count === 0) return;
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
      if (typeof payload === 'string') {
        await page.keyboard.type(payload);
        return;
      }
      if (!isRecord(payload)) {
        throw new Error('type action expects a string or { selector, text }');
      }
      const selector = typeof payload.selector === 'string' ? payload.selector : '';
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!selector) {
        throw new Error('type action requires "selector"');
      }
      await page.locator(selector).type(text, { timeout });
      return;
    }

    case 'press_key':
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

    case 'selectOption': {
      if (!isRecord(payload)) {
        throw new Error('selectOption action expects { selector: value } or { selector: [values] }');
      }
      for (const [selector, value] of Object.entries(payload)) {
        if (Array.isArray(value)) {
          await page.locator(selector).selectOption(value.map(String), { timeout });
        } else {
          await page.locator(selector).selectOption(String(value ?? ''), { timeout });
        }
      }
      return;
    }

    case 'hover': {
      if (typeof payload !== 'string') {
        throw new Error('hover action expects a selector string');
      }
      await page.locator(payload).hover({ timeout });
      return;
    }

    case 'check': {
      if (typeof payload !== 'string') {
        throw new Error('check action expects a selector string');
      }
      await page.locator(payload).check({ timeout });
      return;
    }

    case 'uncheck': {
      if (typeof payload !== 'string') {
        throw new Error('uncheck action expects a selector string');
      }
      await page.locator(payload).uncheck({ timeout });
      return;
    }

    case 'scrollTo': {
      if (typeof payload === 'string') {
        await page.locator(payload).scrollIntoViewIfNeeded({ timeout });
      } else if (isRecord(payload) && typeof payload.selector === 'string') {
        await page.locator(payload.selector).scrollIntoViewIfNeeded({ timeout });
      } else {
        throw new Error('scrollTo action expects a selector string or { selector }');
      }
      return;
    }

    default:
      throw new Error(`Unsupported UI action: ${name}`);
  }
}

export function isLoginStep(step: TestStep): boolean {
  const actions = Array.isArray(step.playwright) ? step.playwright : [];
  if (actions.length === 0) return false;
  const first = actions[0];
  if (isRecord(first) && typeof first.goto === 'string') {
    const target = first.goto.replace(/^\/+/, '/');
    return target === '/login' || target.endsWith('/login');
  }
  return false;
}

export function captureSimulatedExtracts(step: TestStep, vars: Record<string, unknown>): void {
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
