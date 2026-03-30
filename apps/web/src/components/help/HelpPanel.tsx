import { useEffect, useState } from 'react';
import { BookOpen, ExternalLink, Loader2, X } from 'lucide-react';
import { useHelpStore } from '@/stores/helpStore';

export default function HelpPanel() {
  const { isOpen, docsUrl, label, toggle, close } = useHelpStore();
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeError, setIframeError] = useState(false);

  // Keyboard shortcut: Cmd+Shift+H to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'h') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle]);

  useEffect(() => {
    setIframeLoaded(false);
    setIframeError(false);
  }, [docsUrl]);

  // Timeout fallback if iframe never loads
  useEffect(() => {
    if (!isOpen || iframeLoaded || iframeError) return;
    const timer = setTimeout(() => {
      if (!iframeLoaded) {
        console.warn('[HelpPanel] Iframe load timed out after 15s:', docsUrl);
        setIframeError(true);
      }
    }, 15000);
    return () => clearTimeout(timer);
  }, [isOpen, docsUrl, iframeLoaded, iframeError]);

  const handleOpenInNewTab = () => {
    window.open(docsUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      <div
        className={`fixed right-0 top-0 z-40 flex h-full w-[400px] flex-col border-l bg-card shadow-2xl transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b bg-card px-4 py-3">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">{label}</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleOpenInNewTab}
              className="flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Open in new tab"
            >
              <ExternalLink className="h-4 w-4" />
              <span>Open in new tab</span>
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Close (Cmd+Shift+H)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="relative flex flex-1">
          {!iframeLoaded && !iframeError && (
            <div className="absolute inset-0 flex items-center justify-center bg-card">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {iframeError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card">
              <p className="text-sm text-muted-foreground">Could not load documentation.</p>
              <button
                type="button"
                onClick={handleOpenInNewTab}
                className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open in new tab
              </button>
            </div>
          )}

          <iframe
            key={docsUrl}
            src={docsUrl}
            title={label}
            onLoad={() => setIframeLoaded(true)}
            onError={(e) => {
              console.error('[HelpPanel] Iframe failed to load:', docsUrl, e);
              setIframeError(true);
            }}
            className="h-full w-full flex-1 border-0 bg-background"
          />
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={close}
        />
      )}
    </>
  );
}
