/** SentinelOne consoles are always served from the vendor's `.sentinelone.net`
 *  domain (incl. regional/partner subdomains, e.g. usea1-partners.sentinelone.net).
 *  Shared by the write-time route guard and the client's egress-time re-check so
 *  the allowlist has a single source of truth. */
export const S1_HOSTNAME_ALLOWLIST = ['.sentinelone.net'] as const;
