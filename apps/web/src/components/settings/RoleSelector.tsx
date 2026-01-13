type RoleSelectorProps = {
  roles: string[];
  value: string;
  onChange: (role: string) => void;
  disabled?: boolean;
};

export default function RoleSelector({
  roles,
  value,
  onChange,
  disabled
}: RoleSelectorProps) {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Current role</p>
        <p className="text-base font-semibold">{value}</p>
      </div>
      <div className="space-y-2">
        <label htmlFor="role-selector" className="text-sm font-medium">
          Assign new role
        </label>
        <select
          id="role-selector"
          value={value}
          onChange={event => onChange(event.target.value)}
          disabled={disabled}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {roles.map(role => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
