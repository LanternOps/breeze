# Security Best Practices Report: R-175 through R-177

### R-175: Helper-side launch-process requests now enforce path, argument-count, and control-character validation
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go)

Summary:
- The helper now validates `launch_process` requests before execution, rejecting oversized binary paths, oversized or excessive arguments, and arguments containing control characters.
- This tightens the helper IPC boundary so malformed or abuse-oriented launch requests fail closed before they reach OS process creation.

### R-176: Helper-side desktop start and stop requests now validate session identity and SDP/ICE payload size
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/desktop.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/desktop.go)

Summary:
- Desktop helper requests now require a normalized session ID, cap SDP offer and ICE-server payload size, and bound allowed display indices before session startup or teardown.
- This closes another malformed-message and oversized-payload path in the desktop helper boundary.

### R-177: Broker now rebinds helper-reported capabilities to the authenticated helper session scopes
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go)

Summary:
- When a helper reports its capabilities, the broker now trims reflected metadata and masks capability booleans back down to the scopes granted during helper authentication.
- This prevents a compromised or buggy helper from self-advertising broader notify, tray, clipboard, or desktop authority than the broker session actually allows.
