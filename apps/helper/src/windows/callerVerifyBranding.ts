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
    const raw = (JSON.parse(response.body) as { branding?: { partnerName?: unknown; logoUrl?: unknown } | null })
      .branding;
    if (!raw || typeof raw.partnerName !== 'string' || !raw.partnerName.trim()) return null;
    return { partnerName: raw.partnerName, logoUrl: httpsOrNull(raw.logoUrl) };
  } catch {
    return null;
  }
}
