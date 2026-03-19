import { useState, useEffect, useRef } from 'react';
import { HelpCircle, ExternalLink } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { WEB_VERSION } from '../../lib/version';

export default function HelpMenu() {
  const [open, setOpen] = useState(false);
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const fetched = useRef(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleToggle = () => {
    const opening = !open;
    setOpen(opening);
    if (opening && !fetched.current) {
      fetchWithAuth('/system/version')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data: { version: string }) => {
          setApiVersion(data.version);
          fetched.current = true;
        })
        .catch((err) => {
          console.error('[HelpMenu] Failed to fetch API version:', err);
          setApiVersion('unavailable');
        });
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={handleToggle}
        className="rounded-md p-2 hover:bg-muted"
        title="Help"
        aria-label="Help menu"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <HelpCircle className="h-5 w-5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border bg-popover shadow-lg">
          <div className="p-1">
            <a
              href="https://docs.breezermm.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted"
              onClick={() => setOpen(false)}
            >
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
              <span>Documentation</span>
            </a>
          </div>

          <div className="border-t px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">Version Info</p>
            <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              <p>Web: {WEB_VERSION}</p>
              <p>API: {apiVersion ?? '...'}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
