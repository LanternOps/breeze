/**
 * Simple fetch wrapper with Bearer token auth for Breeze API
 */

export async function apiFetch(
  apiUrl: string,
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${apiUrl}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });
}

/**
 * Create a desktop session via the API
 */
export async function createDesktopSession(
  apiUrl: string,
  token: string,
  deviceId: string
): Promise<{ id: string } | null> {
  const resp = await apiFetch(apiUrl, '/api/v1/remote/sessions', token, {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      type: 'desktop',
    }),
  });

  if (!resp.ok) return null;
  return resp.json();
}
