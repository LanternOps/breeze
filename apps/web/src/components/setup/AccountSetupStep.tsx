import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { fetchWithAuth, apiLogin, useAuthStore } from '../../stores/auth';

interface AccountSetupStepProps {
  onNext: () => void;
}

export default function AccountSetupStep({ onNext }: AccountSetupStepProps) {
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const user = useAuthStore((s) => s.user);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);

    if (newPassword && newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (newPassword && newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setLoading(true);

    try {
      // Update email if changed
      if (email && email !== user?.email) {
        const emailRes = await fetchWithAuth('/users/me', {
          method: 'PATCH',
          body: JSON.stringify({ email })
        });
        if (!emailRes.ok) {
          let msg = 'Failed to update email';
          try { const data = await emailRes.json(); msg = data.error || msg; } catch { /* ignore parse error */ }
          setError(msg);
          setLoading(false);
          return;
        }
        // Update auth store so downstream requests use new email
        useAuthStore.getState().updateUser({ email });
      }

      // Change password if provided
      if (newPassword && currentPassword) {
        const pwRes = await fetchWithAuth('/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword })
        });
        if (!pwRes.ok) {
          let msg = 'Failed to change password';
          try { const data = await pwRes.json(); msg = data.error || msg; } catch { /* ignore parse error */ }
          setError(msg);
          setLoading(false);
          return;
        }

        // Password change invalidates session — re-login transparently
        const loginEmail = email || user?.email || '';
        const loginResult = await apiLogin(loginEmail, newPassword);
        if (loginResult.success && loginResult.user && loginResult.tokens) {
          useAuthStore.getState().login(loginResult.user, loginResult.tokens);
        } else {
          setError('Password changed but re-login failed. Please log in again.');
          setLoading(false);
          return;
        }
      }

      setSuccess('Account updated successfully');
      setTimeout(() => onNext(), 600);
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const hasChanges = !!(email || (currentPassword && newPassword));
  const partialPassword = !!(currentPassword ? !newPassword : newPassword);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Secure Your Account</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Change the default admin email and password. You can skip this step and update them later in Settings.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="setup-email" className="block text-sm font-medium">
            Email Address
          </label>
          <input
            id="setup-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={user?.email || 'admin@breeze.local'}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="border-t pt-4">
          <p className="mb-3 text-sm font-medium">Change Password</p>

          <div className="space-y-3">
            <div>
              <label htmlFor="setup-current-pw" className="block text-sm text-muted-foreground">
                Current Password
              </label>
              <input
                id="setup-current-pw"
                type={showPasswords ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label htmlFor="setup-new-pw" className="block text-sm text-muted-foreground">
                New Password
              </label>
              <input
                id="setup-new-pw"
                type={showPasswords ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label htmlFor="setup-confirm-pw" className="block text-sm text-muted-foreground">
                Confirm New Password
              </label>
              <input
                id="setup-confirm-pw"
                type={showPasswords ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <button
              type="button"
              onClick={() => setShowPasswords(!showPasswords)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showPasswords ? 'Hide' : 'Show'} passwords
            </button>
          </div>
        </div>

        {partialPassword && (
          <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-700 dark:text-yellow-400">
            Both current and new password are required to change your password.
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-md border border-green-500/50 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            {success}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onNext}
            className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Skip
          </button>
          <button
            type="submit"
            disabled={loading || !hasChanges}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Save & Continue
          </button>
        </div>
      </form>
    </div>
  );
}
