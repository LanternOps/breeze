import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { Finding } from './types';

const SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'detectors.browser.js'),
  'utf8',
)
  .replace(/^\s*\/\/.*$/gm, '')
  .trim()
  .replace(/;$/, '');

export type LayoutFinding = Omit<Finding, 'viewport' | 'theme'>;

export interface LayoutScan {
  findings: LayoutFinding[];
  signature: string;
  /** Absolute hrefs of every link on the page (dynamic-route harvesting). */
  links: string[];
  /** Per-kind totals before the per-kind cap. */
  totals: Record<string, number>;
}

export async function detectLayoutIssues(page: Page, opts: { mobile: boolean }): Promise<LayoutScan> {
  return page.evaluate(`${SOURCE}(${JSON.stringify(opts)})`) as Promise<LayoutScan>;
}
