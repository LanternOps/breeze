import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { logoObjectUrl, type LogoMime } from '../prompt/identity';
import type { Branding, CallerLogo } from './CallerVerifyWindow';

/*
 * The caller-verify card's logo (#10190 W04, Todd's W03 decision 1).
 *
 * `/api/v1/helper/config` names the partner's logo by sha (`branding.logo`).
 * The agent fetched those same bytes over its authenticated channel and
 * synced them to Assist (`prompt_branding_sync`). When the two agree, the card
 * draws the synced bytes from a local blob: URL, so an uploaded (data:) logo
 * shows too and nothing is fetched from the network. When they do not (a
 * stale sync, another partner, no identity yet, an older API), the card falls
 * back to today's https `logoUrl`, and otherwise draws no logo.
 *
 * The bytes come from `get_caller_verify_logo`: open to this caller-verify
 * window only while its request is live, and it returns the logo for the sha
 * asked for and nothing else of the identity.
 */

export interface CallerLogoApi {
  fetch(verificationId: string, sha256: string): Promise<{ mime: string; data: string } | null>;
}

const tauriLogoApi: CallerLogoApi = {
  fetch: (verificationId, sha256) =>
    invoke<{ mime: string; data: string } | null>('get_caller_verify_logo', { verificationId, sha256 }),
};

interface ObjectUrls {
  create: (blob: Blob) => string;
  revoke: (url: string) => void;
}

const browserUrls: ObjectUrls = {
  create: (b) => URL.createObjectURL(b),
  revoke: (u) => URL.revokeObjectURL(u),
};

function httpsLogo(branding: Branding): CallerLogo {
  const url = branding?.logoUrl;
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? { src: url, kind: 'https' } : null;
  } catch {
    return null;
  }
}

/**
 * The logo for this card: the synced bytes (blob:) when their sha is the one
 * `/helper/config` names, else the https `logoUrl`, else null. Never throws.
 * A returned blob: URL is the caller's to revoke.
 */
export async function resolveCallerLogo(
  branding: Branding,
  verificationId: string,
  api: CallerLogoApi = tauriLogoApi,
  urls: Pick<ObjectUrls, 'create'> = browserUrls,
): Promise<CallerLogo> {
  const sha = branding?.logoSha256;
  if (sha) {
    try {
      const bytes = await api.fetch(verificationId, sha);
      if (bytes) {
        const url = logoObjectUrl({ sha256: sha, mime: bytes.mime as LogoMime, data: bytes.data }, urls.create);
        if (url) return { src: url, kind: 'blob' };
      }
    } catch (err) {
      console.warn('[caller-verify] synced logo unavailable; using the https logo if any', err);
    }
  }
  return httpsLogo(branding);
}

/**
 * The resolved logo for the host window: null until resolved (the challenge
 * never waits for it), and the blob: URL is revoked when the branding
 * changes or the window unmounts.
 */
export function useCallerLogo(
  branding: Branding,
  verificationId: string,
  api: CallerLogoApi = tauriLogoApi,
  urls: ObjectUrls = browserUrls,
): CallerLogo {
  const [logo, setLogo] = useState<CallerLogo>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void resolveCallerLogo(branding, verificationId, api, urls).then((l) => {
      if (l?.kind === 'blob') made = l.src;
      if (live) setLogo(l);
      else if (made) urls.revoke(made);
    });
    return () => {
      live = false;
      if (made) urls.revoke(made);
    };
  }, [branding, verificationId, api, urls]);
  return logo;
}
