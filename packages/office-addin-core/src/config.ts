/**
 * Build-time configuration. Values come from the host app's Vite env
 * (apps/excel-addin/.env, gitignored — see .env.example). Defaults target local
 * dev against the API
 * dev server (apps/api listens on 3001; apps/web/astro.config.mjs uses the
 * same default).
 */
export const API_BASE_URL: string =
  ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3001').replace(/\/$/, '');

/** Entra app registration client ID — must equal the API's CLIENT_AI_ENTRA_CLIENT_ID (Plan 1 Task 6). */
export const ENTRA_CLIENT_ID: string =
  (import.meta.env.VITE_CLIENT_AI_ENTRA_CLIENT_ID as string | undefined) ?? '';
