import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('hardware monitoring documentation', () => {
  it('documents sources, attachment, semantics and local configuration', () => {
    const doc = read('../../../../../docs/src/content/docs/features/hardware-monitoring.mdx');
    for (const source of ['storcli', 'perccli', 'megacli', 'ssacli', 'arcconf', 'omreport',
      'mdadm', 'zfs', 'storage_spaces', 'windows_physical_disk', 'smartctl']) expect(doc).toContain(source);
    for (const key of ['raid_array_degraded', 'physical_disk_failed', 'cache_battery_problem',
      'hardware_collector_failing', 'tool_dirs', 'fixture-only']) expect(doc).toContain(key);
    expect(doc).toContain('not attached');
    expect(doc).toContain('rebuilding is warning');
    expect(doc).toContain('unknown does not resolve');
    expect(doc).toContain('hardware_monitoring');
    expect(doc).toContain('## Install the tools');
  });
  it('registers the page inside Monitoring & Alerting', () => {
    const config = read('../../../../../docs/astro.config.mjs');
    const group = config.slice(config.indexOf("label: 'Monitoring & Alerting'"), config.indexOf("label: 'AI & Intelligence'"));
    expect(group).toContain("{ slug: 'features/hardware-monitoring' }");
  });
});
