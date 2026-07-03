import type { ComponentType } from 'react';
import { Shield, ShieldCheck, Network, Globe, Cloud, Lock } from 'lucide-react';
import type { VpnPresence, VpnProvider } from '@breeze/shared';

// Presentation metadata for VPN providers surfaced on the Devices list column
// and the device-detail VPN section (#2139). Mirrors the ROLE_META pattern in
// deviceRoles.ts: a Record keyed by the normalized provider id with graceful
// fallback for unknown ids. lucide icons are used (no vendor logos in v1) —
// each provider gets a distinct glyph + badge color so multiple active VPNs
// read apart at a glance.

type VpnProviderMeta = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Tailwind classes for the compact badge (light/dark aware via /20 alpha). */
  badgeClass: string;
};

const PROVIDER_META: Record<VpnProvider, VpnProviderMeta> = {
  wireguard:         { label: 'WireGuard',      icon: ShieldCheck, badgeClass: 'bg-rose-500/15 text-rose-700 border-rose-500/40 dark:text-rose-300' },
  tailscale:         { label: 'Tailscale',      icon: Network,     badgeClass: 'bg-indigo-500/15 text-indigo-700 border-indigo-500/40 dark:text-indigo-300' },
  netbird:           { label: 'NetBird',        icon: Globe,       badgeClass: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300' },
  zerotier:          { label: 'ZeroTier',       icon: Network,     badgeClass: 'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300' },
  openvpn:           { label: 'OpenVPN',        icon: Shield,      badgeClass: 'bg-orange-500/15 text-orange-700 border-orange-500/40 dark:text-orange-300' },
  'cloudflare-warp': { label: 'Cloudflare WARP', icon: Cloud,      badgeClass: 'bg-yellow-500/15 text-yellow-800 border-yellow-500/40 dark:text-yellow-300' },
  generic:           { label: 'VPN',            icon: Lock,        badgeClass: 'bg-slate-500/15 text-slate-700 border-slate-500/40 dark:text-slate-300' },
};

const FALLBACK_META: VpnProviderMeta = PROVIDER_META.generic;

function metaFor(provider: string): VpnProviderMeta {
  return PROVIDER_META[provider as VpnProvider] ?? FALLBACK_META;
}

export function getVpnProviderLabel(provider: string): string {
  return metaFor(provider).label;
}

export function getVpnProviderIcon(provider: string): ComponentType<{ className?: string }> {
  return metaFor(provider).icon;
}

export function getVpnProviderBadgeClass(provider: string): string {
  return metaFor(provider).badgeClass;
}

/** Active VPNs only, deduped by provider+interface, sorted by provider label. */
export function activeVpnList(vpns: VpnPresence[] | null | undefined): VpnPresence[] {
  if (!vpns || vpns.length === 0) return [];
  const seen = new Set<string>();
  const result: VpnPresence[] = [];
  for (const vpn of vpns) {
    if (!vpn.active) continue;
    const key = `${vpn.provider}:${vpn.interfaceName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(vpn);
  }
  return result.sort((a, b) => getVpnProviderLabel(a.provider).localeCompare(getVpnProviderLabel(b.provider)));
}

/** Distinct provider ids among active VPNs (for the list facet options). */
export function activeVpnProviders(vpns: VpnPresence[] | null | undefined): VpnProvider[] {
  const set = new Set<VpnProvider>();
  for (const vpn of activeVpnList(vpns)) set.add(vpn.provider);
  return Array.from(set);
}

/** One-line tooltip for a single VPN: "WireGuard · wg0 · 10.8.0.2 · host.tailnet.ts.net". */
export function formatVpnTooltip(vpn: VpnPresence): string {
  const parts: string[] = [getVpnProviderLabel(vpn.provider), vpn.interfaceName];
  if (vpn.ipv4) parts.push(vpn.ipv4);
  if (vpn.ipv6) parts.push(vpn.ipv6);
  if (vpn.dnsName) parts.push(vpn.dnsName);
  return parts.join(' · ');
}
