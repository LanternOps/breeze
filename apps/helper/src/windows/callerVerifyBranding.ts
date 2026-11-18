import { invoke } from '@tauri-apps/api/core';
import { helperRequest, type AgentConfig } from '../lib/helperFetch';
import type { Branding } from './CallerVerifyWindow';

function httpsOrNull(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const LOGO_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * `branding.logo.sha256` (#10190 W04): the sha of the logo the agent syncs to
 * Assist as bytes. Only 64 lowercase hex of a PNG/JPEG/WebP logo; anything
 * else (or an older API without the field) is no sha.
 */
function logoShaOrNull(logo: unknown): string | null {
  if (!logo || typeof logo !== 'object') return null;
  const { sha256, mime } = logo as { sha256?: unknown; mime?: unknown };
  return typeof sha256 === 'string' && SHA256.test(sha256) && typeof mime === 'string' && LOGO_MIMES.has(mime)
    ? sha256
    : null;
}

/**
 * Partner branding from the authenticated helper config. Never throws: any
 * failure resolves null so the challenge shows with "Breeze" text instead and
 * is never delayed or hidden by branding.
 */
export async function loadCallerBranding(): Promise<Branding> {
  try {
    const config = await invoke<AgentConfig>('read_agent_config');
    const response = await helperRequest(config, `${config.api_url.replace(/\/$/, '')}/api/v1/helper/config`, {
      method: 'GET',
    });
    if (!response.ok) return null;
    const raw = (
      JSON.parse(response.body) as { branding?: { partnerName?: unknown; logoUrl?: unknown; logo?: unknown } | null }
    ).branding;
    if (!raw || typeof raw.partnerName !== 'string' || !raw.partnerName.trim()) return null;
    const branding: NonNullable<Branding> = { partnerName: raw.partnerName, logoUrl: httpsOrNull(raw.logoUrl) };
    const sha = logoShaOrNull(raw.logo);
    if (sha) branding.logoSha256 = sha;
    return branding;
  } catch {
    return null;
  }
}
