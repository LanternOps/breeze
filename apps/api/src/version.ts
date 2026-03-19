export const API_VERSION = process.env.APP_VERSION || '0.2.0';

if (!process.env.APP_VERSION) {
  console.warn('[version] APP_VERSION not set, using fallback:', API_VERSION);
}
