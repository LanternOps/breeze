import { useState, useCallback, useRef, useEffect } from 'react';

interface Props {
  requiresUsername: boolean;
  onSubmit: (creds: { username?: string; password: string }) => void;
  onCancel: () => void;
}

export default function CredentialsPromptModal({ requiresUsername, onSubmit, onCancel }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const firstInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Focus the first field on open, and restore focus to whatever held it
  // before the prompt opened when the prompt closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    firstInputRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    if (requiresUsername && !username) return;
    onSubmit(requiresUsername ? { username, password } : { password });
  }, [password, username, requiresUsername, onSubmit]);

  // Trap focus within the prompt: a credential entry should not let Tab wander
  // back to the obscured viewer behind the scrim. Esc still cancels.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onCancel(); return; }
    if (e.key !== 'Tab' || !formRef.current) return;
    const focusable = Array.from(
      formRef.current.querySelectorAll<HTMLElement>('input, button')
    ).filter((el) => !el.hasAttribute('disabled'));
    // Unreachable today (the password input is always present and enabled), but
    // a future refactor that disables every field would silently drop the trap
    // and let Tab escape to the obscured viewer — make that loud instead.
    if (focusable.length === 0) {
      console.warn('Credentials modal has no focusable elements; focus trap disabled');
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, [onCancel]);

  const inputClass =
    'w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 ' +
    'placeholder:text-gray-400 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="creds-title"
      onKeyDown={handleKeyDown}
    >
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl"
      >
        <h3 id="creds-title" className="mb-2 text-base font-semibold text-gray-100">
          {requiresUsername ? 'macOS login required' : 'VNC password required'}
        </h3>
        <p className="mb-4 text-sm text-gray-400">
          {requiresUsername
            ? 'Enter a macOS user account with Screen Sharing access.'
            : 'Enter the VNC password configured in System Settings.'}
        </p>
        {requiresUsername && (
          <input
            ref={firstInputRef}
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="macOS username"
            className={`mb-3 ${inputClass}`}
          />
        )}
        <input
          ref={requiresUsername ? undefined : firstInputRef}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={requiresUsername ? 'macOS password' : 'Password'}
          className={`mb-4 ${inputClass}`}
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-800 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password || (requiresUsername && !username)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
