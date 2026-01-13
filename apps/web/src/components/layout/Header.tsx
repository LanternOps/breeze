import { useState } from 'react';
import {
  Bell,
  Search,
  Moon,
  Sun,
  ChevronDown,
  LogOut,
  User
} from 'lucide-react';
import OrgSwitcher from './OrgSwitcher';

export default function Header() {
  const [darkMode, setDarkMode] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
  };

  return (
    <header className="flex h-16 items-center justify-between border-b bg-card px-6">
      <div className="flex items-center gap-4">
        {/* Organization Switcher */}
        <OrgSwitcher />

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search devices, scripts..."
            className="h-9 w-80 rounded-md border bg-background pl-9 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Notifications */}
        <button className="relative rounded-md p-2 hover:bg-muted">
          <Bell className="h-5 w-5" />
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive" />
        </button>

        {/* Dark Mode Toggle */}
        <button onClick={toggleDarkMode} className="rounded-md p-2 hover:bg-muted">
          {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>

        {/* User Menu */}
        <div className="relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 rounded-md p-2 hover:bg-muted"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <User className="h-4 w-4" />
            </div>
            <ChevronDown className="h-4 w-4" />
          </button>
          {showUserMenu && (
            <div className="absolute right-0 top-full mt-1 w-48 rounded-md border bg-popover p-1 shadow-lg">
              <div className="border-b px-2 py-1.5">
                <div className="text-sm font-medium">John Doe</div>
                <div className="text-xs text-muted-foreground">john@acme.com</div>
              </div>
              <a
                href="/profile"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <User className="h-4 w-4" />
                Profile
              </a>
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-muted">
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
