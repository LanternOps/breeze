const ALLOWED_HTTPS_HOSTS = new Set([
  'breezermm.com',
  '2breeze.app',
]);

const ALLOWED_HTTPS_SUFFIXES = [
  '.breezermm.com',
  '.2breeze.app',
];

const ALLOWED_HTTP_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  'tauri.localhost',
]);

export function isDocsEmbeddableOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);

    if (protocol === 'https:') {
      return ALLOWED_HTTPS_HOSTS.has(hostname) || ALLOWED_HTTPS_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    }

    if (protocol === 'http:') {
      return ALLOWED_HTTP_HOSTS.has(hostname);
    }

    return false;
  } catch {
    return false;
  }
}
