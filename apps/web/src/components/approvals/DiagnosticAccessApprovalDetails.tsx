import { useTranslation } from 'react-i18next';

/**
 * Full, structured scope of a read-only diagnostic access request
 * (actionToolName 'request_diagnostic_access'). Every path is listed with its
 * recursion — nothing is truncated — and each sensitive store the request
 * names is called out on its own line, so the approver sees exactly what an
 * approval would allow.
 */
type Scope = { path: string; recursive: boolean };

const SENSITIVE = ['browser_secrets', 'credential_store', 'private_keys', 'session_tokens'] as const;

function asScopes(value: unknown): Scope[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Scope => !!v && typeof v === 'object' && typeof (v as Scope).path === 'string')
    .map((v) => ({ path: v.path, recursive: v.recursive === true }));
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function isDiagnosticAccessApproval(actionToolName: string | null | undefined): boolean {
  return actionToolName === 'request_diagnostic_access';
}

export default function DiagnosticAccessApprovalDetails({
  args,
  approvalId,
}: {
  args: Record<string, unknown> | null | undefined;
  approvalId: string;
}) {
  const { t } = useTranslation('approvals');
  const a = args ?? {};
  const paths = asScopes(a.paths);
  const ops = asStrings(a.operations);
  const classes = asStrings(a.sensitiveClasses).filter((c) => (SENSITIVE as readonly string[]).includes(c));
  const principal = a.principal === 'api_key'
    ? t('diagnosticAccess.principalApiKey')
    : a.principal === 'oauth_grant'
      ? t('diagnosticAccess.principalOauth')
      : t('diagnosticAccess.principalUser');
  const opLabels = ops.map((o) => (o === 'read' ? t('diagnosticAccess.opRead') : t('diagnosticAccess.opList'))).join(', ');

  return (
    <div className="mt-3 max-w-3xl rounded-md border p-3 text-sm" data-testid={`approval-diagnostic-access-${approvalId}`}>
      <p className="font-medium">{t('diagnosticAccess.title')}</p>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t('diagnosticAccess.organization')}</dt>
        <dd>{typeof a.organization === 'string' ? a.organization : '—'}</dd>
        <dt className="text-muted-foreground">{t('diagnosticAccess.device')}</dt>
        <dd>{typeof a.hostname === 'string' ? a.hostname : '—'}</dd>
        <dt className="text-muted-foreground">{t('diagnosticAccess.access')}</dt>
        <dd data-testid={`approval-diagnostic-access-ops-${approvalId}`}>{t('diagnosticAccess.readOnlyOps', { operations: opLabels })}</dd>
        <dt className="text-muted-foreground">{t('diagnosticAccess.duration')}</dt>
        <dd>{t('diagnosticAccess.durationValue', { minutes: typeof a.durationMinutes === 'number' ? a.durationMinutes : '—' })}</dd>
        <dt className="text-muted-foreground">{t('diagnosticAccess.requestedBy')}</dt>
        <dd>
          {typeof a.requestedBy === 'string' ? `${a.requestedBy} · ` : ''}
          {principal}
        </dd>
        <dt className="text-muted-foreground">{t('diagnosticAccess.purpose')}</dt>
        <dd className="whitespace-pre-line break-words">{typeof a.purpose === 'string' ? a.purpose : '—'}</dd>
      </dl>
      <p className="mt-3 font-medium">{t('diagnosticAccess.paths')}</p>
      <ul className="mt-1 space-y-1" data-testid={`approval-diagnostic-access-paths-${approvalId}`}>
        {paths.map((p) => (
          <li key={`${p.path}:${p.recursive}`} className="break-all font-mono text-xs">
            {p.path}
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground">
              {p.recursive ? t('diagnosticAccess.recursive') : t('diagnosticAccess.thisFolderOnly')}
            </span>
          </li>
        ))}
      </ul>
      {classes.length > 0 ? (
        <div
          className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive"
          data-testid={`approval-diagnostic-access-sensitive-${approvalId}`}
        >
          <p className="font-medium">{t('diagnosticAccess.sensitiveHeading')}</p>
          <ul className="mt-1 list-disc pl-5">
            {classes.map((c) => (
              <li key={c}>{t(/* i18n-dynamic */ `diagnosticAccess.classes.${c}`)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-muted-foreground">{t('diagnosticAccess.noSensitive')}</p>
      )}
    </div>
  );
}
