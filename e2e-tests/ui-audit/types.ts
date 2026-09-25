export type AppName = 'web' | 'portal';
export type Theme = 'light' | 'dark';
export type Severity = 'high' | 'medium' | 'low';

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface Finding {
  /** Which detector produced it. */
  source: 'layout' | 'axe' | 'console' | 'network' | 'nav';
  /** Stable machine name, e.g. `content-overflow`, `color-contrast`, `api-error`. */
  kind: string;
  severity: Severity;
  message: string;
  selector?: string;
  /** Absent for findings that are not tied to one render (console, network). */
  viewport?: string;
  theme?: Theme;
}

export interface Shot {
  viewport: string;
  theme: Theme;
  /** Relative to the run directory. */
  file: string;
  diff?: 'new' | 'changed' | 'same';
  diffRatio?: number;
}

export interface RouteResult {
  app: AppName;
  /** Route pattern as declared by the page file, e.g. `/devices/[id]`. */
  pattern: string;
  /** Concrete path that was visited (equals `pattern` for static routes). */
  path: string;
  status: 'ok' | 'error' | 'skipped' | 'unresolved';
  error?: string;
  finalUrl?: string;
  /** Coarse page shape (`table+tabs`, `form`, …) used to group pages for critique. */
  signature?: string;
  shots: Shot[];
  findings: Finding[];
}
