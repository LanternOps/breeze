import type { Region } from '../regions';
import { fetchVerifyToken } from '../resendClient';

export async function verifyEmail(region: Region, recipient: string, resendApiKey: string): Promise<void> {
  const token = await fetchVerifyToken({ apiKey: resendApiKey, recipient });
  const res = await fetch(`${region.apiUrl}/auth/verify-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`verify-email -> ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { verified?: boolean };
  if (body.verified !== true) throw new Error('verify-email did not return verified:true');
}
