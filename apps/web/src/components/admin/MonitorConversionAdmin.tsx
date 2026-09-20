import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { readPartnerPreview, readPartnerConvertResult, type PartnerConversionPreview } from '../monitoring/conversion/conversionApi';
type Row = { partnerId: string; partnerName: string; pendingRows: number; pendingPolicies: number };
export default function MonitorConversionAdmin() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PartnerConversionPreview | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const load = async () => {
    try {
      const response = await fetchWithAuth('/admin/monitor-conversion/partners');
      if (!response.ok) throw new Error(response.status === 403 ? 'Platform administrator required' : 'Failed to load backlog');
      setRows((await response.json()).data); setError(undefined);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load backlog'); }
  };
  useEffect(() => { void load(); }, []);
  const act = async (partnerId: string, confirm: boolean) => {
    if (confirm && preview?.partnerId !== partnerId) return;
    setBusy(true);
    try {
      if (!confirm) {
        setPreview(null);
        setPreview(await runAction({
          request: () => fetchWithAuth(`/admin/monitor-conversion/partners/${partnerId}/preview`, { method: 'POST' }),
          errorFallback: 'Preview failed', parseSuccess: readPartnerPreview,
        }));
      } else {
        const result = await runAction({
          request: () => fetchWithAuth(`/admin/monitor-conversion/partners/${partnerId}/convert`, {
            method: 'POST', body: JSON.stringify({ previewHash: preview!.previewHash }),
          }), errorFallback: 'Conversion failed', parseSuccess: readPartnerConvertResult,
          successMessage: 'Conversion complete',
        });
        setResults((old) => ({ ...old, [partnerId]: `Converted ${result.converted} · ${result.unconvertible} unconvertible` }));
        setPreview(null); await load();
      }
    } catch (err) {
      setPreview(null); // stale hash requires a fresh preview and deliberate confirmation
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: 'Conversion request failed' });
    } finally { setBusy(false); }
  };
  return <section><h1>Legacy alert conversion</h1>
    <p>Preview each partner and record conversion results in the release checklist.</p>
    {error && <p role="alert">{error}<button onClick={() => void load()}>Retry</button></p>}
    <table><thead><tr><th>Partner</th><th>Pending rows</th><th>Pending policies</th><th>Last result</th><th>Action</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.partnerId}><td>{row.partnerName}</td><td>{row.pendingRows}</td><td>{row.pendingPolicies}</td>
        <td>{results[row.partnerId]}</td><td><button data-testid={`admin-preview-${row.partnerId}`} disabled={busy}
          onClick={() => void act(row.partnerId, false)}>Preview</button></td></tr>)}</tbody></table>
    {preview && <div data-testid="admin-conversion-confirm">
      <p>{preview.rows} rows across {preview.policies} policies; {preview.convertible} convertible.</p>
      <ul>{preview.unconvertible.map((item) => <li key={`${item.sourceTable}:${item.sourceId}`}>
        {item.policyName ?? 'Standalone'} · {item.name} · {item.reason}
      </li>)}</ul>
      <p>Unconvertible sources remain for review or manual retirement in W05c. W05d processes leftovers.</p>
      <button disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
      <button data-testid="admin-conversion-run" disabled={busy} onClick={() => void act(preview.partnerId, true)}>Convert reviewed scope</button>
    </div>}
  </section>;
}
