export function buildMfaEnrollmentUrl(serverUrl: string, enrollUrl: string): string | null {
  if (!/^https?:\/\//i.test(serverUrl) || !enrollUrl.startsWith('/') || enrollUrl.startsWith('//')) {
    return null;
  }
  return `${serverUrl.replace(/\/$/, '')}${enrollUrl}`;
}
