### R-150: macOS warranty readers now use bounded `ioreg` and `plutil` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/warranty_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/warranty_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The warranty collector now runs both hardware-serial discovery and plist conversion through the shared timeout/output-budget helper instead of direct `exec.CommandContext(...).Output()` calls.
- This removes two more unbounded local command readers from the darwin collector surface.

### R-151: macOS warranty cache and plist parsing now rejects oversized files and truncates extracted fields
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/warranty_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/warranty_darwin.go)

Summary:
- Warranty JSON cache files and plist inputs are now size-checked before read/parse, and extracted coverage/device fields are truncated before entering agent state.
- This closes a local memory-amplification path in the warranty collector and prevents oversized metadata from propagating downstream.

### R-152: macOS hardware inventory now uses bounded `system_profiler` and `sysctl` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/hardware_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/hardware_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The darwin hardware collector now routes `system_profiler` and `sysctl` through the shared collector wrappers and truncates model, serial, BIOS, and GPU fields.
- This hardens the remaining macOS hardware-inventory command readers against hung or oversized local output.

### R-153: macOS fallback metrics now use bounded `top` and `ioreg` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/metrics_fallback_darwin_nocgo.go](/Users/toddhebebrand/breeze/agent/internal/collectors/metrics_fallback_darwin_nocgo.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The non-CGO darwin CPU and disk fallback paths now execute `top` and `ioreg` under the shared timeout/output budget.
- This closes the last unbounded local command readers in the metrics fallback path used by stripped-down macOS builds.

### R-154: macOS connection inventory now caps result fan-out and truncates reflected connection metadata
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/connections_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/connections_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The darwin connections collector now limits both gopsutil-backed and `netstat`-backed results, parses fallback output with a bounded scanner, and truncates reflected address/state/process fields.
- This reduces transport amplification risk when a host has a large connection table or unusually large reflected metadata.

### R-155: macOS patch enumeration now uses bounded `softwareupdate`, `brew`, and `system_profiler` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/patches_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/patches_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The darwin patch collector now routes Apple update listing, Homebrew outdated checks, and install-history collection through the shared collector command wrappers.
- This removes another cluster of direct local process reads from the collector surface.

### R-156: macOS patch parsers now cap result counts and truncate update/install-history metadata
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/patches_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/patches_darwin.go)

Summary:
- Apple update entries, brew outdated lines, and installed patch history now parse with bounded scanners, cap list fan-out, and truncate reflected fields before returning them.
- This closes several remaining structured-output amplification paths in the patch inventory layer.

### R-157: macOS software inventory now uses bounded `system_profiler` execution and sanitized returned items
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/software_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/software_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The darwin software collector now runs `system_profiler SPApplicationsDataType` under the shared timeout/output budget, caps result count, and truncates stored software fields.
- This hardens the macOS application inventory path against oversized local inventory output.

