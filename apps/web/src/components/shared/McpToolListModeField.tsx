import { useTranslation } from 'react-i18next';
import type { McpToolListMode, ResolvedMcpToolListMode } from '@breeze/shared';
import '../../lib/i18n';

/**
 * The MCP tool list mode of one credential (#12429): an API key, or a person's
 * connection(s) to one app. `null` inherits the deployment default, which the
 * field always names; `'mixed'` stands for several connections storing
 * different values, shows no effective value and can only be left.
 */
export type McpToolListModeFieldValue = McpToolListMode | null | 'mixed';

const INHERIT = 'inherit';

export type McpToolListModeFieldProps = {
  value: McpToolListModeFieldValue;
  onChange: (value: McpToolListMode | null) => void;
  /** The server's resolution of `value`; null when `value` is an unsaved choice. */
  effective: ResolvedMcpToolListMode | null;
  deploymentDefault: McpToolListMode;
  /** What the mode is set on, for the copy. */
  variant: 'key' | 'connection';
  idPrefix: string;
  disabled?: boolean;
};

export default function McpToolListModeField({
  value,
  onChange,
  effective,
  deploymentDefault,
  variant,
  idPrefix,
  disabled = false,
}: McpToolListModeFieldProps) {
  const { t } = useTranslation('common');
  const id = `${idPrefix}-mcp-tool-list-mode`;
  const modeLabel = (mode: McpToolListMode) => {
    if (mode === 'progressive') return t('longTail.mcpToolListMode.progressive');
    return t('longTail.mcpToolListMode.full');
  };
  const sourceLabel = (source: ResolvedMcpToolListMode['source']) => {
    if (source === 'deployment_default') return t('longTail.mcpToolListMode.sourceDeploymentDefault');
    if (variant === 'connection') return t('longTail.mcpToolListMode.sourceConnection');
    return t('longTail.mcpToolListMode.sourceKey');
  };
  const shown: ResolvedMcpToolListMode | null = value === 'mixed'
    ? null
    : effective ?? (value === null
      ? { mode: deploymentDefault, source: 'deployment_default' }
      : { mode: value, source: 'credential' });

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">{t('longTail.mcpToolListMode.label')}</label>
      <select
        id={id}
        data-testid="mcp-tool-list-mode"
        value={value ?? INHERIT}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === INHERIT ? null : (e.target.value as McpToolListMode))}
        className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      >
        {value === 'mixed' && <option value="mixed" disabled>{t('longTail.mcpToolListMode.mixed')}</option>}
        <option value={INHERIT}>{t('longTail.mcpToolListMode.inherit', { mode: modeLabel(deploymentDefault) })}</option>
        <option value="full">{t('longTail.mcpToolListMode.full')}</option>
        <option value="progressive">{t('longTail.mcpToolListMode.progressive')}</option>
      </select>
      {shown && (
        <p data-testid="mcp-tool-list-effective" className="text-xs font-medium">
          {t('longTail.mcpToolListMode.effective', { mode: modeLabel(shown.mode), source: sourceLabel(shown.source) })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t('longTail.mcpToolListMode.hint')}</p>
      <p className="text-xs text-muted-foreground">
        {variant === 'connection' ? t('longTail.mcpToolListMode.perConnection') : t('longTail.mcpToolListMode.perKey')}
      </p>
    </div>
  );
}
