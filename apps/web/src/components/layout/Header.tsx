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
  Activity
} from 'lucide-react';
import OrgSwitcher from './OrgSwitcher';
import NotificationCenter from './NotificationCenter';
import CommandPalette from './CommandPalette';
import { useAuthStore, apiLogout } from '../../stores/auth';

export default function Header() {
  const [darkMode, setDarkMode] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { user, isAuthenticated } = useAuthStore();

  // Initialize dark mode from document class
  useEffect(() => {
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
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
    // Persist preference
    localStorage.setItem('theme', !darkMode ? 'dark' : 'light');
  };

  const handleSignOut = async () => {
    setIsLoggingOut(true);
    try {
      await apiLogout();
      window.location.href = '/login';
    } catch {
      // Even if logout fails on server, redirect to login
      window.location.href = '/login';
    }
  };

  // Get user initials for avatar
  const getUserInitials = () => {
    if (!user?.name) return '?';
    const parts = user.name.split(' ');
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      if (first && last) {
        return `${first[0]}${last[0]}`.toUpperCase();
      }
    }
    return user.name[0]?.toUpperCase() ?? '?';
  };

  return (
    <header className="flex h-16 items-center justify-between border-b bg-card px-6">
      <div className="flex items-center gap-4">
        {/* Organization Switcher */}
        <OrgSwitcher />

        {/* Global Search */}
        <CommandPalette />
      </div>

      <div className="flex items-center gap-2">
        {/* Notifications */}
        <NotificationCenter />

        {/* Dark Mode Toggle */}
        <button
          type="button"
          onClick={toggleDarkMode}
          className="rounded-md p-2 hover:bg-muted"
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>

        {/* User Menu */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 rounded-md p-2 hover:bg-muted"
            aria-expanded={showUserMenu}
            aria-haspopup="true"
          >
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.name}
                className="h-8 w-8 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {isAuthenticated ? getUserInitials() : <User className="h-4 w-4" />}
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
