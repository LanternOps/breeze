import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../../../../..');
const docs = resolve(root, 'apps/docs/src/content/docs');
const read = (path: string) => readFileSync(resolve(docs, path), 'utf8');
describe('alerting consolidation documentation', () => {
  it('has one authoring guide and redirects retired feature guides', () => {
    for (const name of ['alert-templates', 'service-monitoring']) {
      expect(existsSync(resolve(docs, `features/${name}.mdx`))).toBe(false);
      const config = readFileSync(resolve(root, 'apps/docs/astro.config.mjs'), 'utf8');
      expect(config).toContain(`'/features/${name}'`);
      expect(config).not.toContain(`slug: 'features/${name}'`);
    }
    const alerts = read('features/alerts.mdx');
    for (const heading of ['## Inbox', '## Monitors', '## Delivery']) expect(alerts).toContain(heading);
  });
  it('documents explicit defaults, conversion and effective monitoring', () => {
    expect(read('features/notifications.mdx')).toContain('Everything else');
    expect(read('features/notifications.mdx')).not.toContain('falls back to all enabled org channels');
    const monitors = read('features/monitors.mdx');
    // The conversion prompt belonged to the previous release; retirement now
    // lists unconvertible sources and preserves their history for review.
    expect(monitors).toContain('legacy rules could not be converted');
    expect(monitors).toContain('Source rows and alert history are retained');
    expect(monitors).toContain('**Conversion history → Undo** is no longer available');
    expect(monitors).toContain('Replace inherited monitors');
    expect(monitors).toContain('Reset escalation');
    expect(monitors).not.toContain("Responses target every device");
  });
  it('updates every migration guide, including the extra script-porting guide', () => {
    const files = readdirSync(resolve(docs, 'migration')).filter((name) => name.endsWith('.mdx'));
    for (const file of files) {
      const body = read(`migration/${file}`);
      expect(body, file).not.toMatch(/\/features\/(service-monitoring|alert-templates)\//);
      expect(body, file).not.toMatch(/monitors and alert rules|point alert rules|\[alert rules\]/i);
    }
  });
});
