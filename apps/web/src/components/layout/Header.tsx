import { useState, useEffect, useRef } from 'react';
import {
  Moon,
  Sun,
  Monitor,
  Check,
  ChevronDown,
  LogOut,
  User,
  Settings,
  Key,
  Shield,
  Smartphone,
  Plug,
  Activity,
  Sparkles,
  BookOpen,
  Menu,
  LifeBuoy,
  CreditCard
} from 'lucide-react';
import OrgSwitcher from './OrgSwitcher';
import NotificationCenter from './NotificationCenter';
import CommandPalette from './CommandPalette';
import SupportModal from '../support/SupportModal';
import { useAuthStore, apiLogout, fetchWithAuth } from '../../stores/auth';
import { useAiStore } from '../../stores/aiStore';
import { useHelpStore } from '../../stores/helpStore';
import { useUiStore } from '../../stores/uiStore';
import { useFeaturesStore } from '../../stores/featuresStore';
import { showToast } from '../shared/Toast';
import { navigateTo } from '../../lib/navigation';
import { useAvatarBlobUrl } from '../../lib/avatarBlobCache';

export default function Header() {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [billingLoading, setBillingLoading] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const features = useFeaturesStore((s) => s.features);
  const loadFeatures = useFeaturesStore((s) => s.load);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const themeTriggerRef = useRef<HTMLButtonElement>(null);
  const themePanelRef = useRef<HTMLDivElement>(null);
  const userTriggerRef = useRef<HTMLButtonElement>(null);
  const userPanelRef = useRef<HTMLDivElement>(null);

  const { user, isAuthenticated } = useAuthStore();
  // Resolve the avatar through fetchWithAuth so internal /api/v1/users/<id>/avatar
  // paths return a blob: URL that <img> can render. External URLs pass through.
  const resolvedAvatarUrl = useAvatarBlobUrl(user?.avatarUrl ?? null);
  const { isOpen: isAiOpen, toggle: toggleAi } = useAiStore();
  const { isOpen: isHelpOpen, toggle: toggleHelp } = useHelpStore();
  const { toggleMobileMenu } = useUiStore();

  // Mark as mounted after hydration to avoid SSR/client mismatch
  useEffect(() => {
    setMounted(true);
    const raw = localStorage.getItem('theme');
    const stored = (raw === 'light' || raw === 'dark' || raw === 'system') ? raw : null;
    setTheme(stored || 'system');
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      void loadFeatures();
    }
  }, [isAuthenticated, loadFeatures]);

  const openBillingPortal = async () => {
    if (billingLoading) return;
    setBillingLoading(true);
    try {
      const res = await fetchWithAuth('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error('[billing] portal failed', { status: res.status, body });
        const code = typeof body.error === 'string' ? body.error : '';
        const messages: Record<string, string> = {
          no_billing_record: 'No active subscription. Contact support.',
          not_configured: 'Billing is not available on this deployment.',
          upstream_unavailable: 'Billing service is temporarily unavailable. Please try again in a moment.',
          rate_limited: 'Too many requests. Please wait a few minutes and try again.',
        };
        const message = messages[code] ?? (code || 'Failed to open billing portal');
        showToast({ type: 'error', message });
        return;
      }
      const data = (await res.json()) as { url?: string };
      if (data.url) {
        window.location.href = data.url;
      } else {
        console.error('[billing] upstream returned no url', data);
        showToast({ type: 'error', message: 'Billing portal URL missing from response' });
      }
    } catch (err) {
      console.error('[billing] portal request threw', err);
      showToast({ type: 'error', message: 'Failed to open billing portal' });
    } finally {
      setBillingLoading(false);
    }
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
      if (themeRef.current && !themeRef.current.contains(event.target as Node)) {
        setShowThemeMenu(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // When the theme menu opens, move focus into it; Escape closes it and returns
  // focus to the trigger so keyboard users aren't stranded behind an open panel.
  useEffect(() => {
    if (!showThemeMenu) return;
    themePanelRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowThemeMenu(false);
        themeTriggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showThemeMenu]);

  // Same focus + Escape handling for the account menu.
  useEffect(() => {
    if (!showUserMenu) return;
    userPanelRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowUserMenu(false);
        userTriggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showUserMenu]);

  const applyTheme = (next: 'light' | 'dark' | 'system') => {
    setTheme(next);
    setShowThemeMenu(false);

    const resolved = next === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : next;

    if (resolved === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', next);

    if (isAuthenticated) {
      fetchWithAuth('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ preferences: { theme: next } })
      }).catch((err) => console.warn('[theme] Failed to persist preference:', err));
    }
  };

  // Listen for OS theme changes when in system mode
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const handleSignOut = async () => {
    setIsLoggingOut(true);

    // When CF Access trust is in front of Breeze, a normal SPA-side logout
    // only clears the Breeze session — CF Access still holds a session for
    // the user, so the SSO redirect on the next /login visit silently
    // re-enters them. Route through the server-side cf-access-logout
    // endpoint, which clears the Breeze refresh cookie and bounces the
    // browser through CF Access's own logout endpoint with returnTo set
    // to /login?signedOut=1.
    const cfAccessEnabled = useFeaturesStore.getState().cfAccessLogin.enabled;
    if (cfAccessEnabled) {
      // Drop in-memory state first so any racing component doesn't read
      // stale tokens before the navigation lands.
      try { useAuthStore.getState().logout(); } catch { /* zustand always present */ }
      try { localStorage.removeItem('breeze-auth'); } catch { /* localStorage may be unavailable */ }
      try { localStorage.removeItem('breeze-org'); } catch { /* localStorage may be unavailable */ }
      window.location.assign('/api/v1/auth/cf-access-logout');
      return;
    }

    try {
      await apiLogout();
      await navigateTo('/login', { replace: true });
    } catch {
      // Even if logout fails on server, redirect to login
      await navigateTo('/login', { replace: true });
    }
  };

  // Get user initials for avatar
  const getUserInitials = () => {
    // Guard against whitespace-only names: split() would yield empty strings
    // and indexing [0][0] would throw.
    const parts = user?.name?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (parts.length === 0) return '?';
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }
    return parts[0][0].toUpperCase();
  };

  return (
    <header className="flex h-16 items-center justify-between gap-2 border-b bg-card px-2 sm:px-4 md:px-6">
      <div className={`flex min-w-0 flex-1 items-center gap-2 transition-opacity duration-150 sm:gap-4 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
        {/* Hamburger menu — visible only on mobile (< 768px) */}
        <button
          className="rounded-md p-2 hover:bg-muted transition-colors md:hidden"
          onClick={toggleMobileMenu}
          title="Menu"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5 text-muted-foreground" />
        </button>

        {/* Organization Switcher */}
        <div data-tour="org-switcher">
          <OrgSwitcher />
        </div>

        {/* Global Search — icon-width until xl, flexible bar at xl+ */}
        <div data-tour="search" className="shrink-0 xl:min-w-0 xl:flex-1 xl:max-w-[28rem]">
          <CommandPalette />
        </div>
      </div>

      <div className={`flex shrink-0 items-center gap-1 transition-opacity duration-150 sm:gap-2 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
        {/* AI Assistant */}
        {mounted && isAuthenticated && (
          <button
            type="button"
            data-tour="ai-assistant"
            onClick={toggleAi}
            className="relative rounded-md p-2 hover:bg-muted transition-colors"
            title="AI Assistant (Cmd+Shift+A)"
            aria-label="AI Assistant"
            aria-pressed={isAiOpen}
          >
            <Sparkles className="h-5 w-5" />
            {isAiOpen && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>
        )}

        {/* Help & Docs — grouped with the AI assistant as the "assist" tools */}
        {mounted && isAuthenticated && (
          <button
            type="button"
            onClick={toggleHelp}
            className="relative rounded-md p-2 hover:bg-muted transition-colors"
            title="Help & Docs (Cmd+Shift+H)"
            aria-label="Help and docs"
            aria-pressed={isHelpOpen}
          >
            <BookOpen className="h-5 w-5" />
            {isHelpOpen && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>
        )}

        {/* Divider splits assist tools from status + account so the right side
            reads as two small groups instead of one icon wall. Hidden on the
            narrowest screens to conserve horizontal space. */}
        {mounted && isAuthenticated && (
          <div className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
        )}

        {/* Notifications */}
        {mounted && isAuthenticated && <NotificationCenter />}

        {/* Theme Picker */}
        <div className="relative" ref={themeRef}>
          <button
            type="button"
            ref={themeTriggerRef}
            onClick={() => setShowThemeMenu(!showThemeMenu)}
            className="rounded-md p-2 hover:bg-muted"
            title="Theme"
            aria-label="Theme"
            aria-expanded={showThemeMenu}
            aria-haspopup="true"
          >
            {mounted ? (
              theme === 'dark' ? <Moon className="h-5 w-5" /> :
              theme === 'system' ? <Monitor className="h-5 w-5" /> :
              <Sun className="h-5 w-5" />
            ) : <Moon className="h-5 w-5" />}
          </button>

          {showThemeMenu && (
            <div ref={themePanelRef} className="absolute right-0 top-full z-50 mt-2 w-36 rounded-lg border bg-popover py-1 shadow-lg">
              {([
                { value: 'light' as const, label: 'Light', Icon: Sun },
                { value: 'dark' as const, label: 'Dark', Icon: Moon },
                { value: 'system' as const, label: 'System', Icon: Monitor },
              ]).map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => applyTheme(value)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-sm transition hover:bg-muted"
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 text-left">{label}</span>
                  {theme === value && <Check className="h-4 w-4 text-primary" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* User Menu */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            ref={userTriggerRef}
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 rounded-md p-2 hover:bg-muted"
            title="Account menu"
            aria-label="Account menu"
            aria-expanded={showUserMenu}
            aria-haspopup="true"
          >
            {mounted && resolvedAvatarUrl ? (
              <img
                src={resolvedAvatarUrl}
                alt={user?.name ?? 'User avatar'}
                className="h-8 w-8 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {mounted && isAuthenticated ? getUserInitials() : <User className="h-4 w-4" />}
              </div>
            )}
            <ChevronDown className={`hidden h-4 w-4 transition-transform sm:block ${showUserMenu ? 'rotate-180' : ''}`} />
          </button>

          {showUserMenu && (
            <div ref={userPanelRef} className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border bg-popover shadow-lg">
              {/* User Info Section */}
              <div className="border-b p-4">
                <div className="flex items-center gap-3">
                  {resolvedAvatarUrl ? (
                    <img
                      src={resolvedAvatarUrl}
                      alt={user?.name ?? 'User avatar'}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
                      {isAuthenticated ? getUserInitials() : '?'}
                    </div>
                  )}
                  <div className="flex-1 overflow-hidden">
                    <p className="truncate text-sm font-medium">
                      {user?.name || 'Guest'}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {user?.email || 'Not signed in'}
                    </p>
                  </div>
                </div>
                {user?.mfaEnabled && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600">
                    <Shield className="h-3 w-3" />
                    <span>2FA enabled</span>
                  </div>
                )}
              </div>

              {/* Account */}
              <div className="p-1">
                <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Account
                </p>
                <a
                  href="/settings/profile"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
                  onClick={() => setShowUserMenu(false)}
                >
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span>Profile</span>
                </a>
                <a
                  href="/settings"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
                  onClick={() => setShowUserMenu(false)}
                >
                  <Settings className="h-4 w-4 text-muted-foreground" />
                  <span>Settings</span>
                </a>
              </div>

              {/* Security */}
              <div className="border-t p-1">
                <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Security
                </p>
                <a
                  href="/settings/api-keys"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
                  onClick={() => setShowUserMenu(false)}
                >
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <span>API Keys</span>
                </a>
                <a
                  href="/account/devices"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
                  onClick={() => setShowUserMenu(false)}
                >
                  <Smartphone className="h-4 w-4 text-muted-foreground" />
                  <span>Trusted devices</span>
                </a>
                <a
                  href="/account/connected-apps"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
                  onClick={() => setShowUserMenu(false)}
                >
                  <Plug className="h-4 w-4 text-muted-foreground" />
                  <span>Connected apps</span>
                </a>
              </div>

              {/* Billing & support */}
              {(features.billing || features.support) && (
                <div className="border-t p-1">
                  <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Billing &amp; support
                  </p>
                  {features.billing && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted disabled:opacity-50"
                      disabled={billingLoading}
                      onClick={() => {
                        setShowUserMenu(false);
                        void openBillingPortal();
                      }}
                    >
                      <CreditCard className="h-4 w-4 text-muted-foreground" />
                      <span>{billingLoading ? 'Opening…' : 'Billing'}</span>
                    </button>
                  )}
                  {features.support && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
                      onClick={() => {
                        setShowUserMenu(false);
                        setShowSupportModal(true);
                      }}
                    >
                      <LifeBuoy className="h-4 w-4 text-muted-foreground" />
                      <span>Contact support</span>
                    </button>
                  )}
                </div>
              )}

              {/* Activity Section */}
              <div className="border-t p-1">
                <a
                  href="/audit"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
                  onClick={() => setShowUserMenu(false)}
                >
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  <span>Activity Log</span>
                </a>
              </div>

              {/* Sign Out */}
              <div className="border-t p-1">
                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={isLoggingOut}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" />
                  <span>{isLoggingOut ? 'Signing out...' : 'Sign out'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <SupportModal open={showSupportModal} onClose={() => setShowSupportModal(false)} />
    </header>
  );
}
