import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { sanitizePromptPartnerName } from '@prompt-catalog/sanitize';
import { chromeString } from './chrome';

/*
 * The MSP identity shown in the prompt header (#10190, W03, spec section 3.6).
 * It comes only from the agent's `prompt_branding_sync` (Rust keeps it in
 * memory: `prompt.rs` `PromptIdentityView`); a prompt payload can never set it.
 *
 * Defence in depth: Rust already length-checks the name, and the server and
 * agent sanitize it, but Assist sanitizes it again with the same shared
 * function. The logo is only ever the base64 bytes the agent sent, drawn from
 * a local Blob object URL; Assist never fetches a remote URL for it.
 */

/** What Rust hands the webview (`get_prompt_identity` / `prompt-identity-updated`). */
export interface PromptIdentityWire {
  /** Rust's change counter: a window keeps the highest one it has seen. */
  version: number;
  /** `none`: never synced on this session, or the agent sent `cleared`. */
  state: 'set' | 'none';
  partnerName: string | null;
  primaryColor: string | null;
  logo: { sha256: string; mime: string; bytes: number; data: string } | null;
  /** The negotiated locale of the last branding sync (tray and list chrome). */
  locale: string | null;
}

export type LogoMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface PromptLogo {
  sha256: string;
  mime: LogoMime;
  data: string;
}

/** A set identity, after Assist's own checks. */
export interface PromptIdentity {
  /** Sanitized; null shows the localized generic name. */
  partnerName: string | null;
  /** Strict `#RRGGBB`, not yet contrast-checked (IdentityHeader does that). */
  primaryColor: string | null;
  logo: PromptLogo | null;
}

const LOGO_MIMES: ReadonlySet<string> = new Set<LogoMime>(['image/png', 'image/jpeg', 'image/webp']);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The server's logo cap (spec Global Constraints: 256 KB). */
export const MAX_LOGO_BYTES = 262_144;

export function identityFromWire(wire: PromptIdentityWire | null | undefined): PromptIdentity | null {
  if (!wire || wire.state !== 'set') return null;
  const logo =
    wire.logo && LOGO_MIMES.has(wire.logo.mime) && typeof wire.logo.data === 'string'
      ? { sha256: wire.logo.sha256, mime: wire.logo.mime as LogoMime, data: wire.logo.data }
      : null;
  return {
    partnerName: sanitizePromptPartnerName(wire.partnerName ?? ''),
    primaryColor: wire.primaryColor && HEX_COLOR.test(wire.primaryColor) ? wire.primaryColor : null,
    logo,
  };
}

/** Who is asking: the sanitized MSP name, else the localized generic name. */
export function identityDisplayName(identity: PromptIdentity | null, locale: string | null | undefined): string {
  return identity?.partnerName ?? chromeString('identity.generic', locale);
}

/**
 * A Blob object URL for the logo bytes, or null when they are not strict
 * base64 or exceed the cap. The caller owns the URL and must revoke it.
 */
export function logoObjectUrl(
  logo: PromptLogo,
  create: (blob: Blob) => string = (b) => URL.createObjectURL(b),
): string | null {
  if (!LOGO_MIMES.has(logo.mime) || !BASE64.test(logo.data) || logo.data.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(logo.data);
  } catch {
    return null;
  }
  if (binary.length === 0 || binary.length > MAX_LOGO_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return create(new Blob([bytes], { type: logo.mime }));
}

/** The commands and event behind the identity (main window and prompt cards). */
export interface PromptIdentityApi {
  get(): Promise<PromptIdentityWire>;
  subscribe(onIdentity: (wire: PromptIdentityWire) => void): Promise<() => void>;
}

const tauriIdentityApi: PromptIdentityApi = {
  get: () => invoke<PromptIdentityWire>('get_prompt_identity'),
  subscribe: (onIdentity) => listen<PromptIdentityWire>('prompt-identity-updated', (e) => onIdentity(e.payload)),
};

export interface ObjectUrls {
  create: (blob: Blob) => string;
  revoke: (url: string) => void;
}

const browserUrls: ObjectUrls = {
  create: (b) => URL.createObjectURL(b),
  revoke: (u) => URL.revokeObjectURL(u),
};

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * The identity, kept current from Rust: subscribes FIRST, then pulls, and
 * keeps whichever has the higher `version`. The logo's object URL is created
 * once per logo and revoked when the logo changes, is cleared, or the window
 * unmounts. Outside Tauri it stays empty and calls nothing.
 */
export function usePromptIdentity(
  api: PromptIdentityApi = tauriIdentityApi,
  enabled: boolean = inTauri(),
  urls: ObjectUrls = browserUrls,
) {
  const [wire, setWire] = useState<PromptIdentityWire | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    const apply = (next: PromptIdentityWire) => {
      if (live) setWire((cur) => (cur && cur.version > next.version ? cur : next));
    };
    const pull = () =>
      api
        .get()
        .then(apply)
        .catch((err) => console.warn('[prompt] could not load the MSP identity', err));
    api
      .subscribe(apply)
      .then((fn) => {
        if (!live) {
          fn();
          return;
        }
        unlisten = fn;
        void pull();
      })
      .catch((err) => {
        if (!live) return;
        console.warn('[prompt] could not subscribe to MSP identity updates', err);
        void pull();
      });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [api, enabled]);

  const identity = useMemo(() => identityFromWire(wire), [wire]);
  const logo = identity?.logo ?? null;
  const logoKey = logo ? `${logo.sha256}:${logo.mime}:${logo.data.length}` : null;

  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = logo ? logoObjectUrl(logo, urls.create) : null;
    setLogoUrl(url);
    return () => {
      if (url) urls.revoke(url);
    };
    // Re-created only when the logo itself changes, not on every sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logoKey, urls]);

  return { identity, logoUrl: identity ? logoUrl : null, locale: wire?.locale ?? null };
}
