import { Smartphone, Plug, UserX } from 'lucide-react';

interface AccountSubNavProps {
  current: 'devices' | 'connected-apps' | 'delete';
}

const links = [
  { key: 'devices', href: '/account/devices', label: 'Trusted devices', icon: Smartphone },
  { key: 'connected-apps', href: '/account/connected-apps', label: 'Connected apps', icon: Plug },
  { key: 'delete', href: '/account/delete', label: 'Delete account', icon: UserX },
] as const;

export default function AccountSubNav({ current }: AccountSubNavProps) {
  return (
    <nav aria-label="Account sections" className="border-b">
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
                {link.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
