export interface AssertionManifest {
  version: number;
  generatedAt: string;
  pages: PageAssertions[];
}

export interface PageAssertions {
  source: string;
  contentHash: string;
  assertions: Assertion[];
}

export type Assertion = ApiAssertion | SqlAssertion | UiAssertion;

interface BaseAssertion {
  id: string;
  claim: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface ApiAssertion extends BaseAssertion {
  type: 'api';
  test: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    expect: {
      status?: number;
      bodyContains?: string[];
      bodyNotContains?: string[];
      contentType?: string;
    };
  };
}

export interface SqlAssertion extends BaseAssertion {
  type: 'sql';
  test: {
    query: string;
    expect: Record<string, unknown>;
  };
}

export interface UiAssertion extends BaseAssertion {
  type: 'ui';
  test: {
    navigate: string;
    setup?: string[];
    verify: string;
  };
}

export interface AssertionResult {
  id: string;
  type: 'api' | 'sql' | 'ui';
  claim: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  reason: string;
  durationMs: number;
}

export interface RunReport {
  startedAt: string;
  completedAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  results: AssertionResult[];
}
