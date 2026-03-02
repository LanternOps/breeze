export interface TestStep {
  id: string;
  action: 'ui' | 'remote' | 'api';
  description?: string;
  node?: string;
  tool?: string;
  args?: Record<string, unknown>;
  playwright?: unknown[];
  request?: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  };
  poll?: {
    maxAttempts: number;
    intervalMs: number;
    until: string;
  };
  expect?: Record<string, unknown>;
  optional?: boolean;
  timeout?: number;
}

export interface Test {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  nodes: string[];
  timeout?: number;
  steps: TestStep[];
}

export interface TestFile {
  tests: Test[];
}

export interface NodeAuthConfig {
  type?: string;
  token?: string;
}

export interface NodeConfig {
  name?: string;
  host?: string;
  port?: number;
  auth?: NodeAuthConfig;
  platform?: string;
}

export interface Config {
  environment: {
    baseUrl: string;
    apiUrl: string;
    defaultTimeout: number;
    testTimeout: number;
  };
  nodes: Record<string, NodeConfig>;
  api?: {
    apiKey?: string;
    email?: string;
    password?: string;
  };
  devices?: Record<string, string>;
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

export interface BrowserError {
  type: 'pageerror' | 'console.error' | 'http-error';
  message: string;
  url?: string;
  stepId?: string;
}

export interface UiSession {
  browser: any;
  context: any;
  page: any;
  browserErrors: BrowserError[];
  markClosed: () => void;
}

export interface TestResult {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  error?: string;
  browserErrors?: BrowserError[];
  steps: {
    id: string;
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    browserErrors?: BrowserError[];
  }[];
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface RunnerContext {
  vars: Record<string, unknown>;
}

export interface CLIOptions {
  test: string;
  tags: string[];
  nodes: string[];
  dryRun: boolean;
  mode: 'live' | 'simulate';
  verbose: boolean;
  help: boolean;
  allowUiSimulationInLive: boolean;
}
