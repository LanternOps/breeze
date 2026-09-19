package agentapp

// hostLooksEnrolled decides whether `service install` should treat this host as
// already enrolled — which, on Windows, decides whether the install starts the
// service it just registered (#5299).
//
// The interesting case is loadErr. config.Load reports no error when the config
// file is simply absent (a genuinely fresh host, agentID ""); it errors only
// when a config that IS present cannot be read or parsed. Treating that as "not
// enrolled" would leave the service stopped on exactly the host nobody can
// diagnose remotely, which is the stranding failure this fix exists to prevent
// — so an unreadable config counts as enrolled and the caller says so out loud.
// Guessing wrong the other way costs an un-enrolled agent sitting in
// waitForEnrollment, which is what the MSI install produces anyway.
//
// Lives in an untagged file so this decision is covered by the Linux
// `test-agent` job: internal/agentapp is not in the Test Agent (Windows)
// package list, so a windows-tagged test of it would run nowhere.
func hostLooksEnrolled(agentID string, loadErr error) bool {
	return loadErr != nil || agentID != ""
}
