import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../../lib/dateTimeFormat';
import type { FleetTimeResult, FleetTimeRow } from './fleetTypes';
const colors = {
  healthy: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};
export function TimeRows({ rows }: { rows: FleetTimeRow[] }) {
  const { t } = useTranslation('devices');
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {[
              'device',
              'organization',
              'health',
              'findings',
              'role',
              'source',
              'received',
            ].map((key) => (
              <th key={key} className="p-3 text-left font-medium">
                {t(/* i18n-dynamic */ `timeFleet.${key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.deviceId}
              data-testid={`time-row-${r.deviceId}`}
              className="border-t border-border"
            >
              <td className="p-3">
                <a
                  className="text-primary underline"
                  href={`/devices/${r.deviceId}`}
                >
                  {r.hostname}
                </a>
              </td>
              <td className="p-3">
                {r.orgName}
                <div className="text-xs text-muted-foreground">
                  {r.siteName}
                </div>
              </td>
              <td className="p-3">
                <span
                  className={`rounded border px-2 py-0.5 ${colors[r.view.health]}`}
                >
                  {t(/* i18n-dynamic */ `timeFleet.healthLabels.${r.view.health}`)}
                </span>
                {r.view.stale && (
                  <div className="mt-1 text-warning">
                    {t('timeFleet.stale')}
                  </div>
                )}
                {r.view.state === 'not_reported' && (
                  <div className="mt-1 text-muted-foreground">
                    {t('timeFleet.noData')}
                  </div>
                )}
              </td>
              <td className="p-3">
                {r.view.findings.length
                  ? r.view.findings.map((f) => (
                      <div key={f.code}>
                        {t(/* i18n-dynamic */ `timeSync.findings.${f.code}.label`)}
                      </div>
                    ))
                  : t('timeFleet.none')}
              </td>
              <td className="p-3">
                {t(/* i18n-dynamic */ `timeFleet.roles.${r.view.domain?.role ?? 'unknown'}`)}
              </td>
              <td className="p-3">
                {r.view.status?.source ?? t('timeFleet.unknown')}
              </td>
              <td className="p-3 whitespace-nowrap">
                {r.view.receivedAt
                  ? formatDateTime(r.view.receivedAt)
                  : t('timeFleet.never')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export default function DomainGroupView({
  result,
}: {
  result: FleetTimeResult;
}) {
  const { t } = useTranslation('devices');
  const groups = new Map<
    string,
    { orgId: string; dns: string | null; rows: FleetTimeRow[] }
  >();
  for (const row of result.data) {
    const dns = row.view.domain?.domainDns ?? null,
      key = `${row.orgId}:${dns ?? ''}`;
    const group = groups.get(key) ?? { orgId: row.orgId, dns, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([key, group]) => {
        const domain = result.domains.find(
          (d) => d.orgId === group.orgId && d.domainDns === group.dns,
        );
        const rows = domain?.pdc
          ? [
              domain.pdc,
              ...group.rows.filter((r) => r.deviceId !== domain.pdc!.deviceId),
            ]
          : group.rows;
        return (
          <section
            key={key}
            className="rounded-md border border-border"
            data-testid="time-domain-group"
          >
            <div className="border-b border-border p-3">
              <h2 className="font-medium">
                {group.dns ?? t('timeFleet.noDomain')} ·{' '}
                {group.rows[0]!.orgName}
              </h2>
              {domain?.pdc && (
                <p className="text-xs text-muted-foreground">
                  {t('timeFleet.pdcContext')}
                </p>
              )}
              {domain?.pdcExpected && !domain.pdcEnrolled && (
                <p
                  className="text-sm text-warning"
                  data-testid="time-pdc-warning"
                >
                  {t('timeFleet.pdcMissing')}
                </p>
              )}
            </div>
            <TimeRows rows={rows} />
          </section>
        );
      })}
    </div>
  );
}
