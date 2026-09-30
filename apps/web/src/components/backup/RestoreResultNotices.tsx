import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

// Result details a restore or bare-metal recovery may report beyond the
// counters. Every field is optional: a result from a helper that predates them
// renders nothing here.

export const SYSTEM_STATE_REQUIRES_REBUILD = 'system_state_requires_rebuild';

const UNATTESTED_WARNING_MARKER = 'unattested snapshot: files were not checked against a snapshot attestation';
const VAULT_FALLBACK_WARNING_PREFIX = 'vault copy differs from backup; restored from primary storage';

function warningList(result: Record<string, unknown> | null | undefined): string[] {
  const warnings = result?.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((w): w is string => typeof w === 'string');
}

export function isUnattestedWarning(warning: string): boolean {
  return warning.includes(UNATTESTED_WARNING_MARKER);
}

// Advisory warnings describe how a restore ran, not why it failed, so they are
// never picked as a failure reason.
export function isAdvisoryRestoreWarning(warning: string): boolean {
  const trimmed = warning.trim();
  return (
    trimmed.startsWith(`${SYSTEM_STATE_REQUIRES_REBUILD}:`) ||
    isUnattestedWarning(trimmed) ||
    trimmed.startsWith(VAULT_FALLBACK_WARNING_PREFIX)
  );
}

function resultCode(result: Record<string, unknown> | null | undefined): string | null {
  const code = result?.code;
  return typeof code === 'string' && code.trim() !== '' ? code.trim() : null;
}

function quarantinedCount(result: Record<string, unknown> | null | undefined): number | null {
  const count = result?.securityDescriptorQuarantined;
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : null;
}

function quarantinedPaths(result: Record<string, unknown> | null | undefined): string[] {
  const paths = result?.securityDescriptorQuarantinedPaths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string' && p !== '');
}

type Props = {
  result: Record<string, unknown> | null | undefined;
  // Show the unattested-snapshot note. Off where the surrounding view already
  // lists every warning.
  showUnattestedWarning?: boolean;
};

export default function RestoreResultNotices({ result, showUnattestedWarning = true }: Props) {
  const { t } = useTranslation('backup');
  if (!result) return null;

  const code = resultCode(result);
  const warnings = warningList(result);
  const requiresRebuild =
    code === SYSTEM_STATE_REQUIRES_REBUILD ||
    warnings.some((w) => w.trim().startsWith(`${SYSTEM_STATE_REQUIRES_REBUILD}:`));
  const unattested = showUnattestedWarning && warnings.some(isUnattestedWarning);
  const otherCode = code && code !== SYSTEM_STATE_REQUIRES_REBUILD ? code : null;
  const count = quarantinedCount(result);
  const paths = count ? quarantinedPaths(result) : [];
  const unlisted = count ? Math.max(count - paths.length, 0) : 0;

  if (!requiresRebuild && !unattested && !otherCode && !count) return null;

  return (
    <div className="mt-3 space-y-2">
      {requiresRebuild ? (
        <div
          className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground"
          data-testid="restore-result-system-state-note"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="font-medium">{t('restoreResultNotices.systemStateRequiresRebuildTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('restoreResultNotices.systemStateRequiresRebuildBody')}</p>
          </div>
        </div>
      ) : null}

      {unattested ? (
        <div
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning"
          data-testid="restore-result-unattested-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('restoreResultNotices.unattestedSnapshot')}</span>
        </div>
      ) : null}

      {otherCode ? (
        <p className="text-xs text-muted-foreground" data-testid="restore-result-code">
          {t('restoreResultNotices.resultCode', { code: otherCode })}
        </p>
      ) : null}

      {count ? (
        <div
          className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-foreground"
          data-testid="restore-result-restricted-descriptors"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium">{t('restoreResultNotices.restrictedDescriptors', { count })}</p>
              <p className="text-xs text-muted-foreground">{t('restoreResultNotices.restrictedDescriptorsBody')}</p>
            </div>
          </div>
          {paths.length > 0 ? (
            <details className="mt-2 text-xs" data-testid="restore-result-restricted-descriptors-paths">
              <summary className="cursor-pointer font-medium">
                {t('restoreResultNotices.restrictedDescriptorsShowPaths', { count: paths.length })}
              </summary>
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto font-mono">
                {paths.map((path, index) => (
                  <li key={`${index}-${path}`} className="break-all">{path}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {paths.length > 0 && unlisted > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="restore-result-restricted-descriptors-unlisted">
              {t('restoreResultNotices.restrictedDescriptorsUnlisted', { count: unlisted })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
