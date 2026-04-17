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

  useEffect(() => { firstInputRef.current?.focus(); }, []);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    if (requiresUsername && !username) return;
    onSubmit(requiresUsername ? { username, password } : { password });
  }, [password, username, requiresUsername, onSubmit]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl"
      >
        <h3 className="mb-2 text-base font-semibold text-gray-100">
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
            className="mb-3 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
        )}
        <input
          ref={requiresUsername ? undefined : firstInputRef}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={requiresUsername ? 'macOS password' : 'Password'}
          className="mb-4 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
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
            className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-amber-400 disabled:opacity-50"
          >
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
