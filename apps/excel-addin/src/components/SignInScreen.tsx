export function SignInScreen({ failed, onSignIn }: { failed: boolean; onSignIn: () => void }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-base font-semibold text-gray-800">Breeze AI</div>
      <p className="text-sm text-gray-500">
        Sign in with your work account to use the AI assistant for this workbook.
      </p>
      {failed && (
        <p className="text-xs text-red-600" data-testid="signin-error">
          Sign-in didn&apos;t complete. Try again.
        </p>
      )}
      <button
        type="button"
        onClick={onSignIn}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white"
        data-testid="signin-button"
      >
        Sign in with Microsoft
      </button>
    </div>
  );
}
