import { CheckCircle2, AlertTriangle, ExternalLink, Loader2, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getProviderBranding, type IntegrationProvider } from './providerBranding';
import type { EdrReadiness } from './useEdrReadiness';

export interface BuiltinPackageDetailProps {
  name: string;
  provider: IntegrationProvider;
  readiness: EdrReadiness;
  onDeploy: () => void;
}

export default function BuiltinPackageDetail({ name, provider, readiness, onDeploy }: BuiltinPackageDetailProps) {
  const branding = getProviderBranding(provider);
  const Icon = branding.icon;
  const ready = readiness.status === 'ready';
  const gap = readiness.firstGap;
  const disabled = readiness.status === 'incomplete';
  const deployTitle = disabled && gap ? `Resolve: ${gap.label}` : 'Deploys to mapped organizations only';

  return (
    <div className="mt-4 space-y-5">
      <div className="flex items-start gap-3">
        <div className={cn('flex h-12 w-12 items-center justify-center rounded-md border', branding.accent)}>
          <Icon className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">{name}</h3>
            <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', branding.accent)}>
              Managed built-in
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{branding.blurb}</p>
          {branding.websiteUrl && (
            <a
              href={branding.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {branding.label} website <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/30 p-4">
        {readiness.status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking setup…
          </div>
        )}
        {readiness.status === 'unknown' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <HelpCircle className="h-4 w-4" /> Couldn&apos;t verify setup — deploy will confirm on the server.
          </div>
        )}
        {(ready || readiness.status === 'incomplete') && (
          <ul className="space-y-2">
            {readiness.checks.map((c) => (
              <li key={c.key} className="flex items-center gap-2 text-sm">
                {c.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                )}
                <span className={cn(!c.ok && 'font-medium')}>{c.label}</span>
                {/* The first gap's detail is shown in the Next-step box below; don't repeat it here. */}
                {c.detail && c.key !== gap?.key && (
                  <span className="text-xs text-muted-foreground">· {c.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {ready && (
          <p className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            Ready to deploy
            {typeof readiness.mappedOrgCount === 'number'
              ? ` to ${readiness.mappedOrgCount} mapped org${readiness.mappedOrgCount === 1 ? '' : 's'}`
              : ''}
            .
          </p>
        )}
        {disabled && gap && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">Next step: {gap.label}</p>
            {gap.detail && <p className="mt-0.5 text-muted-foreground">{gap.detail}</p>}
            {gap.fixHref && (
              <a href={gap.fixHref} className="mt-1 inline-flex items-center gap-1 text-xs font-medium underline">
                Open Integrations <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          disabled={disabled}
          title={deployTitle}
          onClick={onDeploy}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Deploy
        </button>
      </div>
    </div>
  );
}
