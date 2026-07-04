import { useEffect, useState } from 'react';
import { getLoginContext, type LoginContextBranding } from '../../lib/loginContext';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';

/**
 * The entire left branded panel of the auth shell, as a React island.
 *
 * Initial render is byte-for-byte the stock Breeze marketing panel (copied from
 * AuthShellBranded.astro), so hosted/multi-partner deployments see no visual
 * regression. On mount it fetches the (memoized) login context; when a partner
 * branding payload is present it swaps in the partner logo/accent/headline and
 * DROPS the Breeze marketing copy.
 */
export default function AuthPanelBranding({ tagline }: { tagline: string }) {
  const [branding, setBranding] = useState<LoginContextBranding | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLoginContext().then((ctx) => {
      if (!cancelled && ctx.branding) setBranding(ctx.branding);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const panelStyle = branding?.accentColor ? { backgroundColor: branding.accentColor } : undefined;
  const safeLogo = branding?.logoUrl ? sanitizeImageSrc(branding.logoUrl) : null;

  return (
    <div
      className="hidden u-w-pct-42 flex-col justify-between bg-[hsl(225,62%,48%)] p-10 text-white md:flex lg:p-14"
      style={panelStyle}
    >
      <div>
        <div className="flex items-center gap-3">
          {safeLogo ? (
            <img
              src={safeLogo}
              alt=""
              data-testid="partner-logo"
              className="h-8 max-w-[180px] object-contain"
            />
          ) : (
            <>
              <svg className="h-8 w-8" viewBox="0 0 64 64" fill="none">
                <path d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
                <path d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
                <path d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
              </svg>
              <span className="text-xl font-bold tracking-tight">Breeze</span>
            </>
          )}
        </div>
      </div>

      <div className="space-y-10">
        <div>
          <h2 className="text-2xl font-bold leading-snug tracking-tight lg:text-3xl">
            {branding?.headline ?? (
              <>
                Effortless endpoint
                <br />
                management
              </>
            )}
          </h2>
          {!branding && (
            <p className="mt-3 text-sm leading-relaxed text-white/70">{tagline}</p>
          )}
        </div>

        {!branding && (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                <svg className="h-4 w-4 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-1.007.66-1.86 1.573-2.147" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-white/95">10,000+ endpoints</p>
                <p className="text-xs leading-relaxed text-white/55">Built to handle fleets of any size without breaking a sweat.</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                <svg className="h-4 w-4 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-white/95">Real-time monitoring</p>
                <p className="text-xs leading-relaxed text-white/55">Live telemetry, instant alerts, zero guesswork.</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                <svg className="h-4 w-4 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-white/95">AI-powered insights</p>
                <p className="text-xs leading-relaxed text-white/55">Smart diagnostics and automated remediation at your fingertips.</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-white/40">&copy; {new Date().getFullYear()} {branding ? '' : 'Breeze RMM'}</p>
    </div>
  );
}
