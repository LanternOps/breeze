import type { Region } from '../regions';

export async function purgePartner(region: Region, partnerId: string, syntheticToken: string): Promise<void> {
  const res = await fetch(`${region.apiUrl}/internal/synthetic/purge-partner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${syntheticToken}` },
    body: JSON.stringify({ partnerId }),
  });
  if (!res.ok) throw new Error(`purge-partner ${partnerId} -> ${res.status} ${await res.text()}`);
}
