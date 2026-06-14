import type { ExchangeBranding } from '../auth/session';

/** spec §11 white-label hook. branding is absent until the server adds it (D2) — graceful fallback. */
export function BrandingFooter({ branding }: { branding: ExchangeBranding | null }) {
  const name = branding?.displayName?.trim() || 'your IT provider';
  return (
    <div
      className="flex items-center justify-center gap-1.5 border-t border-gray-100 py-1.5 text-[11px] text-gray-400"
      data-testid="branding-footer"
    >
      {branding?.logoUrl ? (
        <img src={branding.logoUrl} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" />
      ) : null}
      <span>Powered by {name}</span>
    </div>
  );
}
