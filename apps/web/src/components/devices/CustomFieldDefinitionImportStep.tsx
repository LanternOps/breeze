import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { CustomFieldType } from '@breeze/shared';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useDefaultOwnerScope, type OwnerScope } from '../../hooks/useDefaultOwnerScope';
import { runAction } from '../../lib/runAction';
import { parseCsv } from '../../lib/csvParse';
import { showToast } from '../shared/Toast';

/**
 * Step 1 of the "Import from another RMM" wizard (#3257 W09): the DEFINITIONS
 * half, driving `POST /custom-fields/import/preview` and
 * `POST /custom-fields/import` (W07, #4775).
 *
 * Unlike the contact/org/device-value importers, one CSV ROW here is a
 * candidate FIELD DEFINITION, not a data record — an incumbent RMM's export of
 * its own custom-field catalogue (Datto's `udf1..udf30` slots, NinjaOne's
 * global/org fields, …), not a column-mapped spreadsheet of device data. So
 * there is no per-column mapping grid: the CSV's own rows become the grid,
 * pre-filled from `sourceLabel`, and the operator renames/types each in place.
 */

export type ImportSystem = 'datto_rmm' | 'ninjaone' | 'cw_automate' | 'n_central' | 'csv';

/** Which two columns of the incumbent's export carry the slot id and its label. */
type DefMappableField = 'sourceLabel' | 'name';

const DEF_FIELD_GUESSES: Record<ImportSystem, Record<DefMappableField, string[]>> = {
  datto_rmm: {
    sourceLabel: ['udfslot', 'slot', 'udf', 'field', 'fieldname'],
    name: ['label', 'name', 'friendlyname', 'displayname'],
  },
  ninjaone: {
    sourceLabel: ['fieldname', 'name', 'key', 'apiname'],
    name: ['label', 'displayname', 'friendlyname'],
  },
  cw_automate: {
    sourceLabel: ['edfname', 'fieldname', 'name', 'key'],
    name: ['label', 'displayname', 'friendlyname'],
  },
  n_central: {
    sourceLabel: ['propertyname', 'name', 'key'],
    name: ['label', 'displayname', 'friendlyname'],
  },
  csv: {
    sourceLabel: ['key', 'id', 'slot', 'field', 'fieldkey'],
    name: ['name', 'label', 'displayname'],
  },
};

/**
 * Per-source header guess, mirroring `guessMapping` in `BulkContactImport.tsx`:
 * lowercase + strip whitespace/underscore/hyphen, first match wins, each
 * header claimed once.
 */
function guessDefinitionMapping(
  source: ImportSystem,
  headers: string[],
): Partial<Record<DefMappableField, string>> {
  const normalized = headers.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ''));
  const guesses = DEF_FIELD_GUESSES[source];
  const mapping: Partial<Record<DefMappableField, string>> = {};
  const claimed = new Set<string>();
  for (const field of ['sourceLabel', 'name'] as const) {
    for (const guess of guesses[field]) {
      const idx = normalized.findIndex((h, i) => h === guess && !claimed.has(headers[i]!));
      if (idx >= 0) {
        mapping[field] = headers[idx]!;
        claimed.add(headers[idx]!);
        break;
      }
    }
  }
  return mapping;
}

/**
 * Mirrors `CustomFieldsPage.tsx`'s `generateFieldKey` — duplicated locally
 * rather than imported across an unrelated settings-page boundary — with one
 * addition this importer needs and the single-create form doesn't: the
 * result is guaranteed to satisfy the server's `^[a-z][a-z0-9_]*$` key
 * regex, not just produce something that USUALLY does. The single-create
 * form lets an operator see and fix a bad key before submitting; here the
 * key is generated once for up to 30 rows with no per-row key input, so a
 * source label like "2nd Monitor" (leading digit) or "###" (no letters at
 * all) would otherwise 400 the ENTIRE batch with no in-UI way to fix it.
 */
function generateFieldKey(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (base === '') return 'f_untitled';
  if (!/^[a-z]/.test(base)) return `f_${base}`;
  return base;
}

const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'boolean', 'dropdown', 'date'];

interface DraftDefinitionRow {
  /** The incumbent's own name for the slot, e.g. `udf7`. Never edited. */
  sourceLabel: string;
  name: string;
  type: CustomFieldType;
}

export type DefinitionAnnotation =
  | 'create'
  | 'already-exists'
  | 'type-conflict'
  | 'key-shadowed'
  | 'org-not-found'
  | 'partner-wide-denied';

export interface AnnotatedDefinitionRow {
  index: number;
  fieldKey: string;
  name: string;
  type: CustomFieldType;
  ownerScope: 'organization' | 'partner';
  organizationId?: string;
  sourceLabel?: string;
  annotation: DefinitionAnnotation;
  existingId: string | null;
  existingType: CustomFieldType | null;
  conflictReason?: string;
}

/** The two annotations a client may commit. Everything else needs the operator
 *  to fix the file or is an authorization refusal, neither fixable by ticking. */
const COMMITTABLE: ReadonlySet<DefinitionAnnotation> = new Set(['create', 'already-exists']);

export interface DefinitionImportSummary {
  created: Array<{ index: number; definitionId: string; fieldKey: string; ownerScope: string; organizationId: string | null }>;
  skipped: Array<{ index: number; definitionId: string; fieldKey: string; reason: string }>;
  errors: Array<{ index: number; fieldKey: string; error: string; code: string }>;
}

interface Props {
  source: ImportSystem;
  /** The current organization context; required when ownerScope is 'organization'. */
  organizationId: string | null;
  onCommitted?: (summary: DefinitionImportSummary) => void;
  onSkipToValues?: () => void;
  onUnauthorized?: () => void;
}

export default function CustomFieldDefinitionImportStep({
  source,
  organizationId,
  onCommitted,
  onSkipToValues,
  onUnauthorized,
}: Props) {
  const { t } = useTranslation('devices');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftDefinitionRow[]>([]);

  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const showOwnerScope = isPartnerScope && canManagePartnerWide;
  const [ownerScope, setOwnerScope] = useState<OwnerScope>(defaultOwnerScope);

  const [previewRows, setPreviewRows] = useState<AnnotatedDefinitionRow[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [summary, setSummary] = useState<DefinitionImportSummary | null>(null);

  function loadFile(file: File) {
    void file.text().then((text) => {
      const parsed = parseCsv(text);
      const mapping = guessDefinitionMapping(source, parsed.headers);
      const slotCol = mapping.sourceLabel ? parsed.headers.indexOf(mapping.sourceLabel) : 0;
      const nameCol = mapping.name ? parsed.headers.indexOf(mapping.name) : -1;
      const draftRows: DraftDefinitionRow[] = parsed.rows
        .map((raw) => {
          const sourceLabel = (raw[slotCol] ?? '').trim();
          if (!sourceLabel) return null;
          const label = nameCol >= 0 ? (raw[nameCol] ?? '').trim() : '';
          return { sourceLabel, name: label || sourceLabel, type: 'text' as CustomFieldType };
        })
        .filter((r): r is DraftDefinitionRow => r !== null);
      setFileName(file.name);
      setRows(draftRows);
      setPreviewRows(null);
      setSelected(new Set());
      setSummary(null);
    });
  }

  function updateRow(sourceLabel: string, patch: Partial<DraftDefinitionRow>) {
    setRows((prev) => prev.map((r) => (r.sourceLabel === sourceLabel ? { ...r, ...patch } : r)));
  }

  const canPreview = rows.length > 0 && (ownerScope === 'partner' || !!organizationId);

  async function preview() {
    setPreviewing(true);
    setSummary(null);
    try {
      const body = {
        externalSystem: source,
        rows: rows.map((r) => ({
          ownerScope,
          ...(ownerScope === 'organization' ? { organizationId } : {}),
          fieldKey: generateFieldKey(r.sourceLabel),
          name: r.name,
          type: r.type,
          sourceLabel: r.sourceLabel,
        })),
      };
      const res = await runAction<{ rows: AnnotatedDefinitionRow[] }>({
        request: () => fetchWithAuth('/custom-fields/import/preview', { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: t('customFieldDefinitionImport.errors.previewFailed'),
        onUnauthorized,
      });
      setPreviewRows(res.rows);
      setSelected(new Set(res.rows.filter((r) => COMMITTABLE.has(r.annotation)).map((r) => r.index)));
    } catch {
      // runAction already toasted (or routed the 401).
    } finally {
      setPreviewing(false);
    }
  }

  const allAlreadyExist =
    previewRows !== null && previewRows.length > 0 && previewRows.every((r) => r.annotation === 'already-exists');

  async function commit() {
    if (!previewRows) return;
    const chosen = previewRows.filter((r) => selected.has(r.index));
    if (chosen.length === 0) return;
    setCommitting(true);
    try {
      const body = {
        externalSystem: source,
        rows: chosen.map((r) => ({
          ownerScope: r.ownerScope,
          ...(r.ownerScope === 'organization' ? { organizationId: r.organizationId } : {}),
          fieldKey: r.fieldKey,
          name: r.name,
          type: r.type,
          sourceLabel: r.sourceLabel,
          expectedAnnotation: r.annotation,
          ...(r.annotation === 'already-exists' && r.existingId ? { expectedDefinitionId: r.existingId } : {}),
        })),
      };
      const result = await runAction<DefinitionImportSummary>({
        request: () => fetchWithAuth('/custom-fields/import', { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: t('customFieldDefinitionImport.errors.importFailed'),
        onUnauthorized,
      });
      setSummary(result);
      const wrote = result.created.length > 0;
      if (result.errors.length > 0 && !wrote) {
        // runAction only toasts a request-level failure (non-200 / thrown); a
        // 200 carrying only errors[] (every row refused) is a real failure the
        // operator must see, not a routine status line.
        showToast({ type: 'error', message: t('customFieldDefinitionImport.errors.allRefused') });
      }
      onCommitted?.(result);
    } catch {
      // runAction already toasted the request-level failure.
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div data-testid="cf-def-import-step" className="space-y-4">
      <div
        data-testid="cf-def-dropzone"
        onClick={() => fileInputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          data-testid="cf-def-file-input"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadFile(file);
            e.target.value = '';
          }}
        />
        {fileName ? <span className="font-medium text-foreground">{fileName}</span> : t('customFieldDefinitionImport.dropzone')}
      </div>

      {showOwnerScope && (
        <fieldset className="space-y-2 rounded-md border p-3" data-testid="cf-def-owner">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('customFieldDefinitionImport.ownerScope.legend')}
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="cf-def-owner-scope"
              value="partner"
              data-testid="cf-def-owner-partner"
              checked={ownerScope === 'partner'}
              onChange={() => setOwnerScope('partner')}
            />
            {t('customFieldDefinitionImport.ownerScope.allOrganizations')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="cf-def-owner-scope"
              value="organization"
              data-testid="cf-def-owner-org"
              checked={ownerScope === 'organization'}
              onChange={() => setOwnerScope('organization')}
            />
            {t('customFieldDefinitionImport.ownerScope.thisOrganizationOnly')}
          </label>
        </fieldset>
      )}

      {rows.length > 0 && !previewRows && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('customFieldDefinitionImport.grid.heading', { count: rows.length })}
          </h3>
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1.5">{t('customFieldDefinitionImport.grid.sourceLabel')}</th>
                  <th className="px-2 py-1.5">{t('customFieldDefinitionImport.grid.name')}</th>
                  <th className="px-2 py-1.5">{t('customFieldDefinitionImport.grid.type')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sourceLabel} className="border-b border-border/50 last:border-0">
                    <td className="px-2 py-1.5">
                      <code data-testid={`cf-def-source-label-${r.sourceLabel}`} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {r.sourceLabel}
                      </code>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        data-testid={`cf-def-name-${r.sourceLabel}`}
                        value={r.name}
                        onChange={(e) => updateRow(r.sourceLabel, { name: e.target.value })}
                        className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        data-testid={`cf-def-type-${r.sourceLabel}`}
                        value={r.type}
                        onChange={(e) => updateRow(r.sourceLabel, { type: e.target.value as CustomFieldType })}
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                      >
                        {FIELD_TYPES.map((ft) => (
                          <option key={ft} value={ft}>
                            {ft}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            data-testid="cf-def-preview"
            onClick={preview}
            disabled={previewing || !canPreview}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {previewing ? t('customFieldDefinitionImport.actions.previewing') : t('customFieldDefinitionImport.actions.preview')}
          </button>
        </div>
      )}

      {previewRows && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('customFieldDefinitionImport.preview.heading')}
          </h3>
          <ul className="space-y-1">
            {previewRows.map((r) => {
              const committable = COMMITTABLE.has(r.annotation);
              return (
                <li
                  key={r.index}
                  data-testid={`cf-def-row-${r.index}`}
                  aria-disabled={!committable}
                  className={`flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${!committable ? 'opacity-70' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r.index)}
                    disabled={!committable}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.index)) next.delete(r.index);
                        else if (committable) next.add(r.index);
                        return next;
                      })
                    }
                  />
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.fieldKey}</code>
                  <span>{r.name}</span>
                  <span
                    data-testid={`cf-def-annotation-${r.annotation}`}
                    className="rounded-full border px-2 py-0.5 text-xs"
                  >
                    {t(/* i18n-dynamic */ `customFieldDefinitionImport.annotations.${r.annotation}`)}
                  </span>
                  {r.conflictReason && <span className="text-xs text-destructive">{r.conflictReason}</span>}
                </li>
              );
            })}
          </ul>

          {allAlreadyExist ? (
            <button
              type="button"
              data-testid="cf-def-skip-to-values"
              onClick={onSkipToValues}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t('customFieldDefinitionImport.actions.skipToValues')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="cf-def-commit"
              onClick={commit}
              disabled={committing || selected.size === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {committing ? t('customFieldDefinitionImport.actions.importing') : t('customFieldDefinitionImport.actions.import')}
            </button>
          )}
        </div>
      )}

      {summary && (
        <div className="space-y-2">
          <p
            data-testid="cf-def-summary"
            className={`text-sm ${summary.errors.length > 0 ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {t('customFieldDefinitionImport.summary', {
              created: summary.created.length,
              skipped: summary.skipped.length,
              failed: summary.errors.length,
            })}
          </p>
          {summary.errors.length > 0 && (
            <ul data-testid="cf-def-errors" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {summary.errors.map((e) => (
                <li key={e.index} data-testid={`cf-def-error-${e.index}`}>
                  {e.fieldKey}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
