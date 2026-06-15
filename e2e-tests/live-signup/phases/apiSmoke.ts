import type { Region } from '../regions';
import type { Identity } from '../identity';

export interface SignupResult { partnerId: string; accessToken: string }

export async function registerViaApi(
  region: Region,
  id: Identity,
  onCreated?: (r: SignupResult) => void,
): Promise<SignupResult> {
  const res = await fetch(`${region.apiUrl}/auth/register-partner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      companyName: id.companyName,
      name: id.name,
      email: id.email,
      password: id.password,
      acceptTerms: true,
    }),
  });
  if (!res.ok) throw new Error(`register-partner -> ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { partner?: { id?: string }; tokens?: { accessToken?: string } };
  if (!body.partner?.id || !body.tokens?.accessToken) {
    throw new Error('register-partner response missing partner.id or tokens.accessToken');
  }
  const result: SignupResult = { partnerId: body.partner.id, accessToken: body.tokens.accessToken };
  onCreated?.(result);
  return result;
}
