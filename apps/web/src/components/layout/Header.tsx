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

  const { user, isAuthenticated } = useAuthStore();
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
          no_billing_record: 'No active subscription — contact support.',
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
    if (!user?.name) return '?';
    const parts = user.name.split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }
    return user.name[0].toUpperCase();
  };

  return (
    <header className="flex h-16 items-center justify-between border-b bg-card px-4 md:px-6">
      <div className={`flex items-center gap-4 transition-opacity duration-150 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
        {/* Hamburger menu — visible only on mobile (< 768px) */}
        <button
          className="rounded-md p-2 hover:bg-muted transition-colors md:hidden"
          onClick={toggleMobileMenu}
          title="Menu"
        >
          <Menu className="h-5 w-5 text-muted-foreground" />
        </button>

        {/* Organization Switcher */}
        <div data-tour="org-switcher">
          <OrgSwitcher />
        </div>

        {/* Global Search */}
        <div data-tour="search">
          <CommandPalette />
        </div>
      </div>

      <div className={`flex items-center gap-2 transition-opacity duration-150 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
        {/* AI Assistant */}
        {mounted && isAuthenticated && (
          <button
            type="button"
            data-tour="ai-assistant"
            onClick={toggleAi}
            className="relative rounded-md p-2 hover:bg-muted transition-colors"
            title="AI Assistant (Cmd+Shift+A)"
          >
            <Sparkles className="h-5 w-5" />
            {isAiOpen && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>
        )}

        {/* Notifications */}
        {mounted && isAuthenticated && <NotificationCenter />}

        {/* Theme Picker */}
        <div className="relative" ref={themeRef}>
          <button
            type="button"
            onClick={() => setShowThemeMenu(!showThemeMenu)}
            className="rounded-md p-2 hover:bg-muted"
            title="Theme"
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
            <div className="absolute right-0 top-full z-50 mt-2 w-36 rounded-lg border bg-popover py-1 shadow-lg">
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

        {/* Help & Docs */}
        {mounted && isAuthenticated && (
          <button
            type="button"
            onClick={toggleHelp}
            className="relative rounded-md p-2 hover:bg-muted transition-colors"
            title="Help & Docs (Cmd+Shift+H)"
          >
            <BookOpen className="h-5 w-5" />
            {isHelpOpen && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>
        )}

        {/* User Menu */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 rounded-md p-2 hover:bg-muted"
            title="Account menu"
            aria-expanded={showUserMenu}
            aria-haspopup="true"
          >
            {mounted && user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.name}
                className="h-8 w-8 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {mounted && isAuthenticated ? getUserInitials() : <User className="h-4 w-4" />}
              </div>
            )}
            <ChevronDown className={`h-4 w-4 transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
          </button>

          {showUserMenu && (
            <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border bg-popover shadow-lg">
              {/* User Info Section */}
              <div className="border-b p-4">
                <div className="flex items-center gap-3">
                  {user?.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt={user.name}
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

              {/* Menu Items */}
              <div className="p-1">
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
                <a
                  href="/settings/api-keys"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
                  onClick={() => setShowUserMenu(false)}
                >
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <span>API Keys</span>
                </a>
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
