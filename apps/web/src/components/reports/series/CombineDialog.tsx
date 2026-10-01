import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { showToast } from '../../shared/Toast';
import { Dialog } from '../../shared/Dialog';
import { seriesFriendlyError } from './seriesApi';
import type { CombineCandidateGroup, CombineCcConflictBody, CombineRequest, CombineTargetMode } from './types';

type CcChoice = 'include' | 'drop';

/** A machine error token (`series_type_unsupported`), never shown raw. */
const ERROR_TOKEN = /^[a-z][a-z0-9_]*$/;

function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}

export interface CombineDialogProps {
  open: boolean;
  groups: CombineCandidateGroup[];
  timezone: string;
  onClose: () => void;
  /** After a successful combine, or when the server says the group changed:
   *  the parent closes the dialog and refetches. */
  onChanged: () => void;
}

/**
 * Series W04 (spec §3.8): combine one group of near-identical per-org reports
 * into a multi-org report. Defaults send nothing new: target = exactly these
 * orgs, recipient rule off, each org keeps its contacts. The user must decide
 * every CC address that is on some rows only.
 */
export default function CombineDialog({ open, groups, timezone, onClose, onChanged }: CombineDialogProps) {
  const { t } = useTranslation(['reports', 'common']);
  const [groupKey, setGroupKey] = useState(groups[0]?.groupKey ?? '');
  const group = groups.find((g) => g.groupKey === groupKey) ?? groups[0];
  const [name, setName] = useState(group?.suggestedName ?? '');
  const [targetMode, setTargetMode] = useState<CombineTargetMode>('selected');
  const [ccChoices, setCcChoices] = useState<Record<string, CcChoice>>({});
  const [serverUnresolved, setServerUnresolved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);

  useEffect(() => {
    setName(group?.suggestedName ?? '');
    setTargetMode('selected');
    setCcChoices({});
    setServerUnresolved([]);
  }, [group?.groupKey, group?.suggestedName]);

  if (!group) return null;

  const unresolved = group.conflictingCc.filter((c) => !ccChoices[c.email]);
  const rowLabels = new Map(group.orgs.flatMap((o) => o.rows.map((r) => [r.reportId, `${o.orgName} — ${r.name}`] as const)));
  const orgNames = new Map(group.orgs.map((o) => [o.orgId, o.orgName] as const));
  /** Blocked org ids as names; ids outside this group read as "other organizations". */
  const blockedOrgList = (orgIds: string[]): string => {
    const names = orgIds.map((id) => orgNames.get(id) ?? t('reports.seriesCombine.otherOrgs'));
    return [...new Set(names)].join(', ');
  };
  const friendlyError = (code: string, body: unknown): string | undefined => {
    if (code === 'combine_cc_conflict') return t('reports.seriesCombine.ccUnresolved');
    if (code === 'combine_group_changed') return t('reports.seriesCombine.groupChanged');
    if (code === 'series_owner_ineligible') {
      const orgIds = bodyField(body, 'orgIds');
      // Without orgIds it is the partner-level refusal (W02, { reason }):
      // W03's message below says it.
      if (Array.isArray(orgIds) && orgIds.length > 0) {
        return t('reports.seriesCombine.ownerIneligible', { list: blockedOrgList(orgIds.map(String)) });
      }
    }
    if (code === 'combine_cc_too_many') {
      const max = bodyField(body, 'max');
      if (typeof max === 'number') return t('reports.seriesCombine.ccTooMany', { max });
    }
    return seriesFriendlyError(code, body) ?? (ERROR_TOKEN.test(code) ? t('reports.seriesCombine.failed') : undefined);
  };
  const canConfirm = !busy && name.trim().length > 0 && unresolved.length === 0;
  const typeLabel = t(/* i18n-dynamic */ `reports.reportsList.reportTypes.${group.type}`);
  const scheduleLabel = t(/* i18n-dynamic */ `reports.reportsList.schedules.${group.schedule}`);

  const confirm = async () => {
    if (!canConfirm || acting.current) return;
    acting.current = true;
    setBusy(true);
    const body: CombineRequest = {
      groupKey: group.groupKey,
      planFingerprint: group.planFingerprint,
      reportIds: group.orgs.flatMap((o) => o.rows.map((r) => r.reportId)),
      name: name.trim(),
      targetMode,
      ccResolution: {
        include: group.conflictingCc.filter((c) => ccChoices[c.email] === 'include').map((c) => c.email),
        drop: group.conflictingCc.filter((c) => ccChoices[c.email] === 'drop').map((c) => c.email),
      },
    };
    try {
      await runAction({
        request: () => fetchWithAuth('/reports/series/combine', {
          method: 'POST',
          body: JSON.stringify(body),
          skipOrgIdInjection: true,
        }),
        errorFallback: t('reports.seriesCombine.failed'),
        successMessage: t('reports.seriesCombine.success', { name: body.name }),
        friendly: (code, _message, errorBody) => friendlyError(code, errorBody),
      });
      onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.status === 409) {
        const conflict = err.body as Partial<CombineCcConflictBody> | undefined;
        if (conflict?.error === 'combine_cc_conflict') {
          setServerUnresolved((conflict.unresolved ?? []).map((u) => u.email));
        } else {
          onChanged();
        }
        return;
      }
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('reports.seriesCombine.failed') });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title={t('reports.seriesCombine.title')} maxWidth="3xl" className="p-6">
      <div data-testid="combine-dialog" className="space-y-5 text-sm">
        <h2 className="text-lg font-semibold">{t('reports.seriesCombine.title')}</h2>

        {groups.length > 1 && (
          <label className="block space-y-1">
            <span className="font-medium">{t('reports.seriesCombine.groupLabel')}</span>
            <select
              data-testid="combine-group-select"
              value={group.groupKey}
              onChange={(e) => setGroupKey(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-2"
            >
              {groups.map((g) => (
                <option key={g.groupKey} value={g.groupKey}>{g.suggestedName}</option>
              ))}
            </select>
          </label>
        )}
        <p data-testid="combine-group-summary" className="text-muted-foreground">
          {t('reports.seriesCombine.groupSummary', { type: typeLabel, schedule: scheduleLabel, orgs: group.orgs.length })}
        </p>

        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {group.orgs.map((org) => (
            <li key={org.orgId} data-testid={`combine-org-${org.orgId}`} className="rounded-md border px-3 py-2">
              <div className="font-medium">{org.orgName}</div>
              <ul className="mt-1 space-y-1">
                {org.rows.map((row) => (
                  <li key={row.reportId} data-testid={`combine-row-${row.reportId}`} data-action={row.action} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span>{row.name}</span>
                    <span className={row.action === 'adopt' ? 'text-success' : 'text-muted-foreground'}>
                      {t(/* i18n-dynamic */ `reports.seriesCombine.${row.action}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.lastGeneratedAt
                        ? t('reports.seriesCombine.lastRun', { date: formatDateTime(row.lastGeneratedAt, { timeZone: timezone }) })
                        : t('reports.seriesCombine.neverRun')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.contactRecipients.length > 0
                        ? t('reports.seriesCombine.contacts', { list: row.contactRecipients.map((r) => r.name ?? r.email ?? r.contactId).join(', ') })
                        : t('reports.seriesCombine.noContacts')}
                    </span>
                    {row.deliverableLinked && (
                      <span data-testid={`combine-row-${row.reportId}-deliverable`} className="text-xs">
                        {t('reports.seriesCombine.deliverableLinked')}
                      </span>
                    )}
                    {row.stalled && (
                      <span data-testid={`combine-row-${row.reportId}-stalled`} className="text-xs text-warning">
                        {t('reports.seriesCombine.stalled')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        <label className="block space-y-1">
          <span className="font-medium">{t('reports.seriesCombine.nameLabel')}</span>
          <input
            data-testid="combine-name"
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-2"
          />
        </label>

        <fieldset className="space-y-1">
          <legend className="font-medium">{t('reports.seriesCombine.targetLegend')}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="combine-target" data-testid="combine-target-selected" checked={targetMode === 'selected'} onChange={() => setTargetMode('selected')} />
            {t('reports.seriesCombine.targetSelected')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="combine-target" data-testid="combine-target-all" checked={targetMode === 'all'} onChange={() => setTargetMode('all')} />
            {t('reports.seriesCombine.targetAll')}
          </label>
          {targetMode === 'all' && (
            <p data-testid="combine-target-all-warning" role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
              {t('reports.seriesCombine.targetAllWarning')}
            </p>
          )}
        </fieldset>

        <div className="space-y-2">
          <p data-testid="combine-cc-shared">
            {group.sharedCc.length > 0
              ? t('reports.seriesCombine.ccShared', { list: group.sharedCc.join(', ') })
              : t('reports.seriesCombine.ccNone')}
          </p>
          {group.conflictingCc.length > 0 && (
            <div className="space-y-2">
              <p>{t('reports.seriesCombine.ccConflictHeading')}</p>
              {group.conflictingCc.map((cc) => (
                <div
                  key={cc.email}
                  data-testid={`combine-cc-${cc.email}`}
                  data-server-unresolved={serverUnresolved.includes(cc.email) ? 'true' : 'false'}
                  className={serverUnresolved.includes(cc.email) ? 'rounded-md border border-destructive/60 px-3 py-2' : 'rounded-md border px-3 py-2'}
                >
                  <span className="font-mono text-xs">{cc.email}</span>
                  <p data-testid={`combine-cc-${cc.email}-held-by`} className="text-xs text-muted-foreground">
                    {t('reports.seriesCombine.ccHeldBy', {
                      list: cc.reportIds.map((id) => rowLabels.get(id) ?? id).join(', '),
                    })}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-4">
                    <label className="flex items-center gap-2">
                      <input type="radio" name={`combine-cc-${cc.email}`} data-testid={`combine-cc-include-${cc.email}`}
                        checked={ccChoices[cc.email] === 'include'}
                        onChange={() => setCcChoices((prev) => ({ ...prev, [cc.email]: 'include' }))} />
                      {t('reports.seriesCombine.ccInclude')}
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name={`combine-cc-${cc.email}`} data-testid={`combine-cc-drop-${cc.email}`}
                        checked={ccChoices[cc.email] === 'drop'}
                        onChange={() => setCcChoices((prev) => ({ ...prev, [cc.email]: 'drop' }))} />
                      {t('reports.seriesCombine.ccDrop')}
                    </label>
                  </div>
                </div>
              ))}
              {unresolved.length > 0 && (
                <p data-testid="combine-cc-unresolved" className="text-xs text-muted-foreground">{t('reports.seriesCombine.ccUnresolved')}</p>
              )}
            </div>
          )}
        </div>

        <p data-testid="combine-rule-note" className="text-xs text-muted-foreground">{t('reports.seriesCombine.ruleNote')}</p>

        <div className="flex justify-end gap-2">
          <button type="button" data-testid="combine-cancel" disabled={busy} onClick={onClose} className="h-9 rounded-md border px-4">
            {t('common:actions.cancel')}
          </button>
          <button type="button" data-testid="combine-confirm" disabled={!canConfirm} onClick={() => void confirm()}
            className="h-9 rounded-md bg-primary px-4 font-medium text-primary-foreground disabled:opacity-60">
            {t('reports.seriesCombine.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
