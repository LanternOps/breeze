import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiModelChoicesDto } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { formatCentsPerM, formatContextTokens } from '@/components/ai/modelPickerFormat';

/**
 * W05 (#7603): the agent policy model (spec §5.6) — the `ai_agents` permitted
 * offerings, by id. A read-only picker over GET /ai/models/choices/ai-agents;
 * the save (bindAgentOffering) re-checks everything. Null = follow the
 * `ai_agents` default.
 */
export default function AgentModelSelect({ orgId, value, onChange, disabled }: {
  orgId: string | null;
  value: string | null;
  onChange: (offeringId: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  const [data, setData] = useState<AiModelChoicesDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
    (async () => {
      try {
        const res = await fetchWithAuth(`/ai/models/choices/ai-agents${qs}`);
        if (!live) return;
        if (!res?.ok) { setFailed(true); return; }
        const body = (await res.json()) as { data?: AiModelChoicesDto };
        if (!live) return;
        if (!body.data || !Array.isArray(body.data.choices)) { setFailed(true); return; }
        setFailed(false);
        setData(body.data);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [orgId]);

  if (failed) {
    return <p className="text-xs text-destructive" data-testid="ai-agent-model-error">{t('aiAgentsPage.fields.modelLoadFailed')}</p>;
  }
  if (!data) return null;
  const defaultName = data.choices.find((c) => c.offeringId === data.defaultOfferingId)?.displayName
    ?? t('aiAgentsPage.fields.modelDefaultUnknown');
  const known = new Set(data.choices.map((c) => c.offeringId));

  const label = (c: AiModelChoicesDto['choices'][number]): string => {
    const ctx = formatContextTokens(c.contextTokens);
    const price = `${formatCentsPerM(c.priceHint.inputCentsPerM)}/${formatCentsPerM(c.priceHint.outputCentsPerM)}`;
    const detail = ctx ? `${ctx} · ${price}` : price;
    const gate = c.disabled
      ? ` — ${c.disabled.roleNames.length
        ? t('aiAgentsPage.fields.modelRequiresRole', { roles: c.disabled.roleNames.join(', ') })
        : t('aiAgentsPage.fields.modelRequiresPermission')}`
      : '';
    return `${c.displayName} (${detail})${gate}`;
  };

  return (
    <label className="flex flex-col gap-1 text-sm md:col-span-2">
      <span className="font-medium">{t('aiAgentsPage.fields.model')}</span>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        data-testid="ai-agent-model"
        className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
      >
        <option value="" data-testid="ai-agent-model-option-default">
          {t('aiAgentsPage.fields.modelDefault', { model: defaultName })}
        </option>
        {data.choices.map((c) => (
          <option
            key={c.offeringId}
            value={c.offeringId}
            disabled={c.disabled !== null}
            data-testid={`ai-agent-model-option-${c.offeringId}`}
          >
            {label(c)}
          </option>
        ))}
        {value && !known.has(value) && (
          <option value={value} disabled data-testid={`ai-agent-model-option-${value}`}>
            {t('aiAgentsPage.fields.modelUnavailable')}
          </option>
        )}
      </select>
      <span className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.modelHint')}</span>
    </label>
  );
}
