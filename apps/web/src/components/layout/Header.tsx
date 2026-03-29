import { useState, useEffect, useRef } from 'react';
import {
  Moon,
  Sun,
  ChevronDown,
  LogOut,
  User,
  Settings,
  Key,
  Shield,
  Activity,
  Sparkles,
  Menu
} from 'lucide-react';
import OrgSwitcher from './OrgSwitcher';
import NotificationCenter from './NotificationCenter';
import CommandPalette from './CommandPalette';
import HelpMenu from './HelpMenu';
import { useAuthStore, apiLogout, fetchWithAuth } from '../../stores/auth';
import { useAiStore } from '../../stores/aiStore';
import { useUiStore } from '../../stores/uiStore';
import { navigateTo } from '../../lib/navigation';

export default function Header() {
  const [mounted, setMounted] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { user, isAuthenticated } = useAuthStore();
  const { isOpen: isAiOpen, toggle: toggleAi } = useAiStore();
  const { toggleMobileMenu } = useUiStore();

  // Mark as mounted after hydration to avoid SSR/client mismatch
  useEffect(() => {
    setMounted(true);
    setDarkMode(document.documentElement.classList.contains('dark'));
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleDarkMode = () => {
    const newTheme = !darkMode ? 'dark' : 'light';
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', newTheme);

    if (isAuthenticated) {
      fetchWithAuth('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ preferences: { theme: newTheme } })
      }).catch(() => {});
    }
  };

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

        {/* Dark Mode Toggle */}
        <button
          type="button"
          onClick={toggleDarkMode}
          className="rounded-md p-2 hover:bg-muted"
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {mounted ? (darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />) : <Moon className="h-5 w-5" />}
        </button>

        {/* Help Menu */}
        {mounted && isAuthenticated && <HelpMenu />}

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
    </header>
  );
}
