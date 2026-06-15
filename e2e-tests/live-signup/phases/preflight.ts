import type { Region } from '../regions';

export async function preflight(region: Region): Promise<void> {
  const health = await fetch(`${region.baseUrl}/health/ready`);
  if (!health.ok) throw new Error(`health/ready -> ${health.status}`);

  const cfgRes = await fetch(`${region.apiUrl}/config`);
  if (!cfgRes.ok) throw new Error(`config -> ${cfgRes.status}`);
  const cfg = (await cfgRes.json()) as { registration?: { enabled?: boolean } };
  if (cfg.registration?.enabled !== true) {
    throw new Error('registration.enabled is not true on this region');
  }
}
