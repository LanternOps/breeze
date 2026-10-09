import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiConnectionDto } from '@breeze/shared';

export interface OpenAiDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
  removeKey: boolean;
  /** Passes the client-side checks (the server re-validates everything). */
  valid: boolean;
  readOnly: boolean;
}

/** Mirrors byoBaseUrlSchema: http(s), no credentials, query or fragment. */
function validUrl(v: string): boolean {
  const raw = v.trim();
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '' && !u.username && !u.password && !raw.includes('?') && !raw.includes('#');
  } catch {
    return false;
  }
}

const KEY_MIN = 8; // byoApiKey in @breeze/shared

/** Origin + path, trailing slashes ignored (mirrors the server's endpoint comparison). */
function endpointIdentity(v: string): string | null {
  try {
    const u = new URL(v.trim());
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60';

export function OpenAiCompatibleConnectionForm({
  connection,
  onChange,
  baseUrlError = null,
  disabled = false,
}: {
  connection: AiConnectionDto | null;
  onChange: (d: OpenAiDraft) => void;
  /** The server refused this Base URL (unresolvable / unreachable / egress policy); shown on the field. */
  baseUrlError?: string | null;
  /** The drawer is saving: lock the inputs so the draft cannot drift from what was sent. */
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  const readOnly = connection?.managedBy === 'env';
  const released = readOnly && connection?.envReleased === true;
  const locked = readOnly || disabled;
  const [name, setName] = useState(connection?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  // The parent passes an inline callback; keep the effect keyed on the draft values only.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const keyOk = apiKey.trim() === '' || apiKey.trim().length >= KEY_MIN;
  // The stored key never follows a connection to a new URL (the server refuses
  // it too): a moved endpoint needs its own key, or the key removed.
  const urlMoved = connection !== null && validUrl(baseUrl)
    && endpointIdentity(baseUrl) !== endpointIdentity(connection.baseUrl ?? '');
  const keyRequired = urlMoved && Boolean(connection?.keyLast4) && apiKey.trim() === '' && !removeKey;
  const valid = !readOnly && name.trim().length > 0 && validUrl(baseUrl) && keyOk && !keyRequired;

  useEffect(() => {
    onChangeRef.current({ name, baseUrl, apiKey, removeKey, readOnly, valid });
  }, [name, baseUrl, apiKey, removeKey, readOnly, valid]);

  return (
    <div className="space-y-4" data-testid="ai-connection-openai-form">
      {readOnly && (
        <p data-testid="ai-connection-openai-env-managed" role="status" className="rounded-md border bg-muted/30 p-3 text-sm">
          {released ? t('aiModels.connections.openai.envReleased') : t('aiModels.connections.openai.envManaged')}
        </p>
      )}
      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="ai-connection-openai-name">{t('aiModels.connections.openai.name')}</label>
        <input id="ai-connection-openai-name" data-testid="ai-connection-openai-name" className={inputClass} value={name}
          maxLength={80} disabled={locked} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="ai-connection-openai-base-url">{t('aiModels.connections.openai.baseUrl')}</label>
        <input id="ai-connection-openai-base-url" data-testid="ai-connection-openai-base-url" className={inputClass} value={baseUrl}
          placeholder="https://llm.example.com/v1" inputMode="url" autoComplete="off" disabled={locked}
          aria-invalid={baseUrlError ? true : undefined}
          aria-describedby={baseUrlError ? 'ai-connection-openai-base-url-help ai-connection-openai-base-url-error' : 'ai-connection-openai-base-url-help'}
          onChange={(e) => setBaseUrl(e.target.value)} />
        <p id="ai-connection-openai-base-url-help" className="text-xs text-muted-foreground">{t('aiModels.connections.openai.baseUrlHelp')}</p>
        {baseUrlError && (
          <p id="ai-connection-openai-base-url-error" data-testid="ai-connection-openai-base-url-error" role="alert" className="text-xs text-destructive">
            {baseUrlError}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="ai-connection-openai-api-key">{t('aiModels.connections.openai.apiKey')}</label>
        <input id="ai-connection-openai-api-key" data-testid="ai-connection-openai-api-key" type="password" autoComplete="new-password"
          className={inputClass} value={apiKey} disabled={locked || removeKey}
          placeholder={connection?.keyLast4 ? t('aiModels.connections.openai.keepKey') : t('aiModels.connections.openai.optional')}
          onChange={(e) => setApiKey(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t('aiModels.connections.openai.apiKeyHelp')}</p>
        {!keyOk && (
          <p data-testid="ai-connection-openai-key-short" role="alert" className="text-xs text-destructive">
            {t('aiModels.connections.openai.keyTooShort', { min: KEY_MIN })}
          </p>
        )}
        {keyRequired && (
          <p data-testid="ai-connection-openai-key-required" role="alert" className="text-xs text-destructive">
            {t('aiModels.connections.openai.keyRequiredForNewUrl')}
          </p>
        )}
      </div>
      {connection?.keyLast4 && !readOnly && (
        <label className="flex items-center gap-2 text-sm">
          <input data-testid="ai-connection-openai-remove-key" type="checkbox" checked={removeKey} disabled={disabled}
            onChange={(e) => { setRemoveKey(e.target.checked); if (e.target.checked) setApiKey(''); }} />
          {t('aiModels.connections.openai.removeKey')}
        </label>
      )}
    </div>
  );
}
