### R-158: Linux audit-policy collection now uses bounded `systemctl` and `auditctl` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The Linux audit-policy collector now routes `systemctl is-enabled auditd` and `auditctl -s` through the shared collector command wrappers and truncates reflected raw output and error text.
- This removes another pair of unbounded local command readers from the compliance snapshot path.

### R-159: Linux audit and distro config reads now use bounded scanners and size-limited file parsing
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/classify_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/classify_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- `auditd.conf`, `/etc/os-release`, and chassis-type reads now use explicit size budgets, while their parsers use bounded scanners and truncate captured values before storing them.
- This closes several low-level local file-amplification edges in Linux compliance and host-classification collection.

### R-160: Linux host classification and hardware inventory now use bounded `systemctl` and `lspci` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/classify_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/classify_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/hardware_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/hardware_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- Linux server-role detection now runs `systemctl get-default` under the shared timeout wrapper, and Linux hardware inventory now routes `lspci` through the same bounded helper.
- DMI-derived hardware fields and detected GPU strings are also truncated before entering the hardware snapshot.

### R-161: Linux patch enumeration now uses bounded `apt`, `yum`, and `dnf` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/patches_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/patches_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The Linux patch collector now routes `apt list --upgradable` and `yum`/`dnf check-update` through the shared collector command wrappers.
- This removes another package-inventory cluster of direct local process reads from the collector surface.

### R-162: Linux patch parsers now cap fan-out and truncate reflected package metadata
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/patches_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/patches_linux.go)

Summary:
- Parsed apt and yum/dnf update entries now use bounded scanners, explicit result caps, and truncated reflected package fields before they leave the collector.
- This closes the remaining structured-output amplification path in the Linux patch inventory layer.

### R-163: Linux software inventory now uses bounded package-manager execution and sanitized returned items
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/software_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/software_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- `dpkg-query` and `rpm -qa` now run under the shared collector timeout/output budget, parse through bounded scanners, cap result counts, and truncate returned software fields.
- This hardens the Linux installed-software inventory path against oversized package-manager output.

