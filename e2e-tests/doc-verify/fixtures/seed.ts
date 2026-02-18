export interface SeedData {
  orgId: string;
  siteId: string;
  enrollmentKey: string;
  adminEmail: string;
  adminPassword: string;
}

export async function seedViaApi(apiUrl: string): Promise<SeedData> {
  const adminEmail = 'admin@breeze.local';
  const adminPassword = 'BreezeAdmin123!';

  // Register admin user (may already exist, that's OK)
  await fetch(`${apiUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
      firstName: 'Test',
      lastName: 'Admin',
    }),
  });

  // Login to get token
  const loginRes = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const loginData = await loginRes.json() as Record<string, unknown>;
  const token = (loginData.token || loginData.accessToken || '') as string;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Get or create org
  const orgsRes = await fetch(`${apiUrl}/api/v1/organizations`, { headers });
  const orgsData = await orgsRes.json() as Record<string, unknown>;
  const orgs = (Array.isArray(orgsData) ? orgsData : (orgsData.organizations || orgsData.data || [])) as { id: string }[];
  const orgId = orgs[0]?.id || '';

  // Get or create site
  let siteId = '';
  if (orgId) {
    const sitesRes = await fetch(`${apiUrl}/api/v1/sites?orgId=${orgId}`, { headers });
    const sitesData = await sitesRes.json() as Record<string, unknown>;
    const sites = (Array.isArray(sitesData) ? sitesData : (sitesData.sites || sitesData.data || [])) as { id: string }[];
    siteId = sites[0]?.id || '';
  }

  // Create enrollment key
  let enrollmentKey = '';
  if (orgId && siteId) {
    const keyRes = await fetch(`${apiUrl}/api/v1/enrollment-keys`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        orgId,
        siteId,
        name: 'doc-verify-key',
        expiresInMinutes: 60,
        maxUses: 100,
      }),
    });
    if (keyRes.ok) {
      const keyData = await keyRes.json() as Record<string, unknown>;
      enrollmentKey = (keyData.key || keyData.enrollmentKey || '') as string;
    }
  }

  return { orgId, siteId, enrollmentKey, adminEmail, adminPassword };
}
