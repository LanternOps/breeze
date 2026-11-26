import { useCallback, useEffect, useState } from 'react';
import { Key, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { extractApiError } from '@/lib/apiError';
import { fetchWithAuth } from '../../stores/auth';
import { formatTime } from './backupDashboardHelpers';
import AlphaBadge from '../shared/AlphaBadge';
import { useTranslation } from 'react-i18next';
import { asList } from '@/lib/asList';
import '../../lib/i18n';

// ── Types ──────────────────────────────────────────────────────────

// Shape the API actually returns for GET /backup/encryption/keys.
type EncryptionKey = {
  id: string;
  name: string;
  keyType: string;
  isActive: boolean;
  createdAt: string;
  expiresAt?: string | null;
};

const KEY_TYPE_LABELS: Record<string, string> = {
  aes_256: 'AES-256',
  rsa_2048: 'RSA-2048',
};

// ── Component ─────────────────────────────────────────────────────

// Read-only on purpose: nothing consumes these keys yet, and the old page's
// create, rotate and deactivate requests were malformed against the API
// (missing key material, wrong HTTP verb), so none are offered.
export default function EncryptionKeyList() {
  const { t } = useTranslation('backup');
  const [keys, setKeys] = useState<EncryptionKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchKeys = useCallback(async () => {
    try {
      setError(undefined);
      const response = await fetchWithAuth('/backup/encryption/keys');
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(extractApiError(data, 'Failed to fetch encryption keys'));
      }
      const payload = await response.json();
      const data = asList(payload);
      setKeys(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[EncryptionKeyList] fetchKeys:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('encryptionKeyList.loadingEncryptionKeys')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer={t('encryptionKeyList.unavailableNotice')} />
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card p-5 shadow-xs">
        <h3 className="flex items-center gap-2 font-semibold">
          <Lock className="h-4 w-4" /> {t('encryptionKeyList.encryptionKeys')}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">{t('encryptionKeyList.providerEncryptionNote')}</p>

        {keys.length === 0 ? (
          <div className="mt-4 flex flex-col items-center py-8 text-center">
            <Key className="h-10 w-10 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">{t('encryptionKeyList.noEncryptionKeysConfigured')}</p>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">{t('encryptionKeyList.name')}</th>
                  <th className="pb-2 pr-4 font-medium">{t('encryptionKeyList.type')}</th>
                  <th className="pb-2 pr-4 font-medium">{t('encryptionKeyList.status')}</th>
                  <th className="pb-2 pr-4 font-medium">{t('encryptionKeyList.created')}</th>
                  <th className="pb-2 font-medium">{t('encryptionKeyList.expires')}</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className="border-b last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-foreground">{key.name}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">
                      {KEY_TYPE_LABELS[key.keyType] ?? key.keyType}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          key.isActive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {key.isActive ? t('encryptionKeyList.statusActive') : t('encryptionKeyList.statusInactive')}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{formatTime(key.createdAt)}</td>
                    <td className="py-2.5 text-muted-foreground">{formatTime(key.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
