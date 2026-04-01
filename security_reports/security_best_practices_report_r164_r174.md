### R-164: Linux event-log collection now uses bounded `journalctl` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The Linux event-log collector now routes `journalctl` through the shared collector timeout/output-budget helper instead of direct process reads.
- This removes the remaining unbounded command reader from the Linux event-log surface.

### R-165: Linux journal JSONL parsing now uses bounded scanners, capped fan-out, and truncated reflected metadata
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_linux.go)

Summary:
- Parsed journal entries now flow through a bounded JSONL scanner, cap result count, and truncate reflected identifiers, PIDs, boot IDs, and detail fields before they are returned.
- This closes the remaining structured-output amplification path in Linux event-log collection.

### R-166: Windows shared PowerShell JSON helper now uses the collector timeout/output budget
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The shared Windows JSON helper now executes PowerShell through the collector timeout/output-budget wrapper rather than raw `exec.CommandContext(...).Output()`.
- This hardens the common PowerShell boundary used by change-tracker, service, and update inventory on Windows.

### R-167: Windows change-tracker snapshots now cap startup/task/user fan-out and truncate reflected fields
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_windows.go)

Summary:
- Startup items, scheduled tasks, and local user accounts collected on Windows now use explicit result caps and truncation before entering snapshot state.
- This reduces snapshot amplification risk from large local inventories or unexpectedly long reflected strings.

### R-168: Windows event-log collection now uses bounded PowerShell execution and sanitized parsed events
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- Windows event-log queries now run through the shared collector command wrapper, parsed event rows are capped, and reflected provider/log/message fields are truncated before return.
- This closes the remaining oversized-output and reflected-string amplification path in the Windows event-log layer.

### R-169: Windows service inventory now reuses the bounded PowerShell JSON helper and sanitizes returned rows
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/services_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/services_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_windows.go)

Summary:
- Windows service collection now reuses the shared bounded PowerShell JSON helper, caps returned rows, and truncates reflected service metadata.
- This removes another raw PowerShell read from the service inventory surface.

### R-170: Windows update inventory now reuses the bounded PowerShell JSON helper and truncates reflected update metadata
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/patches_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/patches_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_windows.go)

Summary:
- Windows update enumeration now reuses the shared bounded PowerShell JSON helper, caps update count, and truncates reflected title/KB/category/severity/description fields.
- This hardens the Windows patch inventory path against oversized update metadata.

### R-171: Windows audit-policy collection now uses bounded `auditpol` and `wevtutil` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The Windows audit-policy collector now routes `auditpol` and `wevtutil` through the shared collector wrappers and truncates the raw output stored in snapshot state.
- This removes another pair of direct unbounded command readers from the compliance collection path.

### R-172: Windows audit-policy CSV parsing now streams records and caps fan-out
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_windows.go)

Summary:
- The `auditpol /r` CSV parser now streams rows instead of `ReadAll`, caps parsed row count, and truncates normalized keys/values before they enter settings state.
- This reduces memory pressure and reflected-string amplification in the Windows audit-policy parser.

### R-173: Windows audit baseline apply now uses bounded command execution and truncates reflected errors
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/audit_policy_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The Windows audit baseline apply path now executes `auditpol /set` under the shared combined-output budget and truncates reflected stderr/stdout when reporting failures.
- This narrows the remaining command-output reflection path in the Windows compliance mutator.

### R-174: Windows bandwidth and hardware inventory now use bounded PowerShell/WMIC execution and truncated returned values
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/bandwidth_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/bandwidth_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/hardware_windows.go](/Users/toddhebebrand/breeze/agent/internal/collectors/hardware_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- Windows link-speed lookup now uses bounded non-interactive PowerShell execution, and WMIC-based hardware inventory now runs through the shared timeout helper and truncates returned values.
- This removes the last small direct command readers from the Windows bandwidth and hardware inventory paths.

