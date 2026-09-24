import { useTranslation } from 'react-i18next';
import { configuredDocsOrigin } from '@/lib/docsEmbed';
import { resolvedFormattingLocale } from '@/lib/i18n/format';
import type { HardwareSourceReport } from '@breeze/shared';
export const HARDWARE_DOCS_URL = `${configuredDocsOrigin() ?? 'https://docs.breezermm.com'}/features/hardware-monitoring/`;
const timestamp = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat(resolvedFormattingLocale(), {
    dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(value));
};
export default function SourcesFooter({ sources, lastCollectedAt }: {
  sources: HardwareSourceReport[]; lastCollectedAt: string | null;
}) {
  const { t } = useTranslation('devices');
  const order = ['storcli', 'perccli', 'megacli', 'omreport'];
  const winner = sources.find(s => order.includes(s.source)
    && !['unavailable', 'superseded', 'disabled'].includes(s.status)
    && !sources.some(other => order.includes(other.source)
      && order.indexOf(other.source) < order.indexOf(s.source)
      && !['unavailable', 'superseded', 'disabled'].includes(other.status)));
  return <footer data-testid="hardware-sources-footer" className="border-t pt-3">
    <h4 className="mb-2 text-xs font-medium">{t('hardwareHealth.sources')}</h4>
    <ul className="flex flex-wrap gap-2">{sources.map(s => {
      const label = s.status === 'ok' ? `${t('hardwareHealth.ok')} ${timestamp(lastCollectedAt)}`
        : s.status === 'failed' ? t('hardwareHealth.failed', { error: s.error ?? '—' })
        : s.status === 'backing_off' ? t('hardwareHealth.backingOff', { time: timestamp(s.retryAt) })
        : s.status === 'superseded' ? (order.includes(s.source) && winner
          && order.indexOf(winner.source) < order.indexOf(s.source)
          ? t('hardwareHealth.superseded', { winner: winner.source })
          : t('hardwareHealth.sourceSuperseded'))
        : s.status === 'disabled' ? t('hardwareHealth.sourceDisabled') : t('hardwareHealth.unavailable');
      const color = s.status === 'ok' ? 'bg-success/15 text-success border-success/30'
        : ['failed', 'backing_off'].includes(s.status) ? 'bg-warning/15 text-warning border-warning/30'
        : 'bg-muted/40 text-muted-foreground border-muted';
      return <li key={s.source} className="max-w-full text-xs">
        <span className={`inline-flex flex-wrap items-center gap-1 rounded-full border px-2 py-1 ${color}`}>
          <strong>{s.source}</strong>
          {s.status === 'unavailable' ? <a href={HARDWARE_DOCS_URL} className="underline">{label}</a> : label}
          {s.toolVersion && ` (v${s.toolVersion})`}
        </span>
        {s.status === 'ok' && s.complete === false && <p>{t('hardwareHealth.partial')}</p>}
        {s.status === 'backing_off' && s.error && <p className="break-words">{s.error}</p>}
        {s.warnings?.map((warning, index) => <p key={index} className="break-words text-muted-foreground">{warning}</p>)}
      </li>;
    })}</ul>
  </footer>;
}
