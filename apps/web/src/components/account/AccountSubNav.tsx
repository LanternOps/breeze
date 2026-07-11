import { Smartphone, Plug, UserX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface AccountSubNavProps {
  current: 'devices' | 'connected-apps' | 'delete';
}

const links = [
  { key: 'devices', href: '/account/devices', labelKey: 'account.nav.devices', icon: Smartphone },
  { key: 'connected-apps', href: '/account/connected-apps', labelKey: 'account.nav.connectedApps', icon: Plug },
  { key: 'delete', href: '/account/delete', labelKey: 'account.nav.delete', icon: UserX },
] as const;

export default function AccountSubNav({ current }: AccountSubNavProps) {
  const { t } = useTranslation('common');
  return (
    <nav aria-label={t('account.nav.label')} className="border-b">
      <ul className="-mb-px flex flex-wrap gap-x-6 gap-y-2">
        {links.map((link) => {
          const Icon = link.icon;
          const active = current === link.key;
          return (
            <li key={link.key}>
              <a
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'inline-flex items-center gap-2 border-b-2 border-primary px-1 py-3 text-sm font-medium text-foreground'
                    : 'inline-flex items-center gap-2 border-b-2 border-transparent px-1 py-3 text-sm font-medium text-muted-foreground transition hover:text-foreground'
                }
              >
                <Icon className="h-4 w-4" aria-hidden />
                {t(/* i18n-dynamic */ link.labelKey)}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
