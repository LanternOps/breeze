import { useTranslation } from 'react-i18next';

import '@/lib/i18n';

export default function RemoteAccessPage() {
  const { t } = useTranslation('remote');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('remoteAccessPage.title')}</h1>
        <p className="text-muted-foreground">{t('remoteAccessPage.subtitle')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <a href="/remote/terminal" className="rounded-lg border bg-card p-6 transition-colors hover:bg-muted/50">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                <line x1="2" x2="22" y1="20" y2="20" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold">{t('remoteAccessPage.terminal.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('remoteAccessPage.terminal.description')}</p>
            </div>
          </div>
        </a>

        <a href="/remote/files" className="rounded-lg border bg-card p-6 transition-colors hover:bg-muted/50">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold">{t('remoteAccessPage.files.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('remoteAccessPage.files.description')}</p>
            </div>
          </div>
        </a>

        <a href="/remote/sessions" className="rounded-lg border bg-card p-6 transition-colors hover:bg-muted/50">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-green-500/10 text-green-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20v-6M6 20V10M18 20V4" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold">{t('remoteAccessPage.sessions.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('remoteAccessPage.sessions.description')}</p>
            </div>
          </div>
        </a>
      </div>
    </div>
  );
}
