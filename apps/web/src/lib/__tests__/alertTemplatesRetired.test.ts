import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('Alert Templates retirement', () => {
  it.each(['index', '[id]'])('%s redirects without hydrating an editor', (page) => {
    const source = readFileSync(resolve(root, `pages/settings/alert-templates/${page}.astro`), 'utf8');
    expect(source).toContain("return Astro.redirect('/alerts/monitors', 301)");
    expect(source).not.toMatch(/AlertTemplate|DashboardLayout|client:load/);
  });

  it('removes both executable editor components', () => {
    for (const component of ['AlertTemplateList', 'AlertTemplateEditor'])
      expect(existsSync(resolve(root, `components/alerts/${component}.tsx`))).toBe(false);
  });

  it('removes owned keys in every locale without deleting common alert vocabulary', () => {
    for (const locale of readdirSync(resolve(root, 'locales'), { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    )) {
      const read = (file: string) => JSON.parse(readFileSync(resolve(root, 'locales', locale.name, file), 'utf8'));
      expect(read('alerts.json')).not.toHaveProperty('alertTemplateEditor');
      expect(read('alerts.json')).not.toHaveProperty('alertTemplateList');
      expect(read('pages.json').titles).not.toHaveProperty('settingsAlertTemplates');
      expect(read('pages.json').titles).not.toHaveProperty('settingsAlertTemplatesDetail');
    }
  });
});
