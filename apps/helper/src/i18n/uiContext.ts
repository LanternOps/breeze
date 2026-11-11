import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { applyBrandingColors, sanitizeBranding, type HelperBranding } from './branding';
import { resolveLocale, translate, type MessageKey } from './index';

/*
 * The Helper's UI context: the locale and the runtime branding of this
 * session, read once from Rust (`get_ui_context`, which validates the Agent's
 * helper_config.yaml). Until it arrives, or if it fails, the webview language
 * and no branding apply, i.e. a Breeze-branded English/OS-language UI.
 */

export interface UiContext {
  locale: string;
  branding: HelperBranding;
}

let state: UiContext = { locale: resolveLocale(navigator.language), branding: {} };
const listeners = new Set<() => void>();

function set(next: UiContext): void {
  state = next;
  applyBrandingColors(next.branding);
  listeners.forEach((l) => l());
}

/** Test seam and the single writer. Input is re-validated. */
export function setUiContext(raw: { locale?: unknown; branding?: unknown } | null | undefined): void {
  set({
    locale: resolveLocale(typeof raw?.locale === 'string' && raw.locale ? raw.locale : navigator.language),
    branding: sanitizeBranding(raw?.branding),
  });
}

export function getUiContext(): UiContext {
  return state;
}

/** Never throws: a failed read leaves the defaults in place. */
export async function loadUiContext(): Promise<void> {
  try {
    setUiContext(await invoke<{ locale?: unknown; branding?: unknown }>('get_ui_context'));
  } catch {
    /* defaults stay */
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useUiContext(): UiContext {
  return useSyncExternalStore(subscribe, getUiContext, getUiContext);
}

export type TFunction = (key: MessageKey, params?: Record<string, string | number>) => string;

/** `t(key, params)` in the session locale. */
export function useT(): TFunction {
  const { locale } = useUiContext();
  return (key, params) => translate(key, locale, params);
}

/** The product name for an identity slot: branded displayName, else the Breeze name. */
export function productName(ctx: UiContext): string {
  return ctx.branding.displayName ?? translate('app.name', ctx.locale);
}
