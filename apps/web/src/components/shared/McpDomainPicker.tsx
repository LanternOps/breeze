import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AI_TOOL_DOMAIN_LABELS,
  MCP_GRANTABLE_DOMAINS,
  normalizeMcpDomainsInput,
  type McpGrantableDomain,
} from '@breeze/shared';
import '../../lib/i18n';

/**
 * Per-grant MCP tool-domain selection (B-W02 #6156). `null` = every tool
 * (including areas added later). A restricted selection is a non-empty list;
 * the picker emits `[]` while "Only these areas" is chosen with no box ticked
 * so the parent can disable submit via {@link isMcpDomainSelectionValid}.
 */
export type McpDomainPickerProps = {
  value: McpGrantableDomain[] | null;
  onChange: (value: McpGrantableDomain[] | null) => void;
  disabled?: boolean;
  idPrefix: string;
  /** `consent` adds the "revoke and reconnect to narrow" note (D-B10). */
  variant?: 'default' | 'consent';
};

export function isMcpDomainSelectionValid(value: McpGrantableDomain[] | null): boolean {
  return value === null || value.length > 0;
}

export default function McpDomainPicker({
  value,
  onChange,
  disabled = false,
  idPrefix,
  variant = 'default',
}: McpDomainPickerProps) {
  const { t } = useTranslation('common');
  // The radio mode is local: "selected" with zero boxes cannot be represented
  // by `value` alone (null means "all"), and selecting every box normalizes to
  // null without flipping the user back to the "all" radio under their cursor.
  const [mode, setMode] = useState<'all' | 'selected'>(value === null ? 'all' : 'selected');
  const [checked, setChecked] = useState<ReadonlySet<McpGrantableDomain>>(new Set(value ?? []));

  const emit = (next: ReadonlySet<McpGrantableDomain>) => {
    onChange(normalizeMcpDomainsInput(MCP_GRANTABLE_DOMAINS.filter((d) => next.has(d))));
  };

  const chooseAll = () => {
    setMode('all');
    onChange(null);
  };

  const chooseSelected = () => {
    setMode('selected');
    emit(checked);
  };

  const toggle = (domain: McpGrantableDomain) => {
    const next = new Set(checked);
    if (next.has(domain)) next.delete(domain);
    else next.add(domain);
    setChecked(next);
    emit(next);
  };

  const invalid = mode === 'selected' && checked.size === 0;
  // Every box ticked is stored as "All tools", which also covers areas added
  // later — say so rather than let the radio imply a fixed list.
  const allEquivalent = mode === 'selected' && checked.size === MCP_GRANTABLE_DOMAINS.length;

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">{t('longTail.mcpDomains.legend')}</legend>
      <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-mcp-domains-all`}>
        <input
          id={`${idPrefix}-mcp-domains-all`}
          type="radio"
          name={`${idPrefix}-mcp-domains-mode`}
          data-testid="mcp-domains-all"
          checked={mode === 'all'}
          onChange={chooseAll}
        />
        {t('longTail.mcpDomains.allLabel')}
      </label>
      <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-mcp-domains-selected`}>
        <input
          id={`${idPrefix}-mcp-domains-selected`}
          type="radio"
          name={`${idPrefix}-mcp-domains-mode`}
          data-testid="mcp-domains-selected"
          checked={mode === 'selected'}
          onChange={chooseSelected}
        />
        {t('longTail.mcpDomains.selectedLabel')}
      </label>

      {mode === 'selected' && (
        <div className="grid grid-cols-1 gap-1 rounded-md border p-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked disabled data-testid="mcp-domain-core" />
            {t('longTail.mcpDomains.coreLabel')}
          </label>
          {MCP_GRANTABLE_DOMAINS.map((domain) => (
            <label key={domain} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid={`mcp-domain-${domain}`}
                checked={checked.has(domain)}
                onChange={() => toggle(domain)}
              />
              {t(/* i18n-dynamic */ `longTail.mcpDomains.labels.${domain}`, {
                defaultValue: AI_TOOL_DOMAIN_LABELS[domain],
              })}
            </label>
          ))}
        </div>
      )}

      {invalid && (
        <p data-testid="mcp-domains-error" role="alert" className="text-xs text-destructive">
          {t('longTail.mcpDomains.error')}
        </p>
      )}

      {allEquivalent && (
        <p data-testid="mcp-domains-all-equivalent" className="text-xs text-muted-foreground">
          {t('longTail.mcpDomains.allEquivalentNote')}
        </p>
      )}

      {variant === 'consent' && (
        <p data-testid="mcp-domains-reconnect-note" className="text-xs text-muted-foreground">
          {t('longTail.mcpDomains.reconnectNote')}
        </p>
      )}
    </fieldset>
  );
}
