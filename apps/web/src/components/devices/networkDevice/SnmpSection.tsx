// The "SNMP data" card: the scalar system-OID grid, with long values (a
// chatty sysDescr) clamped behind a "Show more" toggle so one oversized field
// can't blow out the row's layout.

import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Section } from './primitives';
import { snmpFieldLabel } from './format';

// Values longer than this are clamped behind a "Show more" toggle so one
// oversized SNMP field (a chatty sysDescr) can't push every other field off
// screen or blow out the row's layout.
const SNMP_VALUE_CLAMP_LENGTH = 200;

function SnmpValue({ fieldKey, value }: { fieldKey: string; value: string }) {
  const { t } = useTranslation('devices');
  const [expanded, setExpanded] = useState(false);
  const isLong = value.length > SNMP_VALUE_CLAMP_LENGTH;
  const displayValue = isLong && !expanded ? `${value.slice(0, SNMP_VALUE_CLAMP_LENGTH)}…` : value;
  return (
    <dd className="font-medium break-words">
      {displayValue || '—'}
      {isLong && (
        <button
          type="button"
          data-testid={`snmp-value-toggle-${fieldKey}`}
          onClick={() => setExpanded((e) => !e)}
          className="ml-1.5 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? t('networkDeviceDetailPage.showLess') : t('networkDeviceDetailPage.showMore')}
        </button>
      )}
    </dd>
  );
}

export function SnmpSection({ snmpData }: { snmpData: Record<string, string> }) {
  const { t } = useTranslation('devices');
  return (
    <Section title={t('networkDeviceDetailPage.sections.snmpData')} testId="network-detail-snmp">
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
        {Object.keys(snmpData).length === 0 ? (
          <div className="col-span-2 text-xs text-muted-foreground">
            {t('networkDeviceDetailPage.emptySnmp')}
          </div>
        ) : (
          Object.entries(snmpData).map(([key, value]) => (
            <Fragment key={key}>
              <dt className="text-muted-foreground">{snmpFieldLabel(key, t)}</dt>
              <SnmpValue fieldKey={key} value={String(value ?? '')} />
            </Fragment>
          ))
        )}
      </dl>
    </Section>
  );
}
