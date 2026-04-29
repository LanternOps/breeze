interface PasswordStrengthProps {
  password: string;
}

interface Rule {
  label: string;
  test: (pw: string) => boolean;
}

const RULES: Rule[] = [
  { label: 'At least 8 characters', test: (pw) => pw.length >= 8 },
  { label: 'Contains a letter', test: (pw) => /[A-Za-z]/.test(pw) },
  { label: 'Contains a number', test: (pw) => /\d/.test(pw) },
  { label: 'Contains a symbol', test: (pw) => /[^A-Za-z0-9]/.test(pw) },
];

const LEVELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'] as const;
const LEVEL_COLORS = [
  'bg-muted',
  'bg-destructive',
  'bg-warning',
  'bg-primary',
  'bg-success',
] as const;

function strengthScore(password: string): number {
  if (password.length === 0) return 0;
  if (password.length < 8) return 1;
  let score = 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (password.length >= 12) score = Math.min(4, score + 1);
  return Math.min(4, score);
}

export default function PasswordStrength({ password }: PasswordStrengthProps) {
  const score = strengthScore(password);
  const level = LEVELS[score];
  return (
    <div className="space-y-2">
      <div
        className="flex gap-1"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        aria-valuetext={level}
      >
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              segment <= score && password ? LEVEL_COLORS[score] : 'bg-muted'
            }`}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {RULES.map((rule) => {
          const passed = rule.test(password);
          return (
            <li
              key={rule.label}
              className={`flex items-center gap-1.5 transition-colors ${
                passed ? 'text-success' : 'text-muted-foreground'
              }`}
            >
              <span aria-hidden="true" className="font-mono leading-none">
                {passed ? '✓' : '·'}
              </span>
              <span>{rule.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
