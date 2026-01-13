import { useState } from 'react';
import { ChevronDown, LogOut, UserCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePortalBranding } from './BrandingProvider';

type PortalUser = {
  name: string;
  email: string;
  avatarUrl?: string;
};

type PortalHeaderProps = {
  user: PortalUser;
  onSignOut?: () => void;
  onProfile?: () => void;
  className?: string;
};

export default function PortalHeader({
  user,
  onSignOut,
  onProfile,
  className
}: PortalHeaderProps) {
  const branding = usePortalBranding();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header
      className={cn(
        'flex h-16 items-center justify-between border-b bg-card px-6',
        className
      )}
    >
      <div className="flex items-center gap-3">
        {branding.logoUrl ? (
          <img
            src={branding.logoUrl}
            alt={branding.logoAlt ?? branding.name}
            className="h-8 w-auto"
          />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            {branding.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="leading-tight">
          <div className="text-sm font-semibold text-foreground">{branding.name}</div>
          <div className="text-xs text-muted-foreground">Customer Portal</div>
        </div>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.name}
              className="h-7 w-7 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UserCircle className="h-5 w-5" />
            </div>
          )}
          <span className="text-sm font-medium">{user.name}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full z-10 mt-2 w-56 rounded-md border bg-popover p-1 shadow-lg">
            <div className="border-b px-3 py-2">
              <div className="text-sm font-medium">{user.name}</div>
              <div className="text-xs text-muted-foreground">{user.email}</div>
            </div>
            <button
              type="button"
              onClick={onProfile}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
            >
              <UserCircle className="h-4 w-4" />
              Profile
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive hover:bg-muted"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
