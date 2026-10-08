package heartbeat

// CompiledSecurityCapabilities returns the capability set this build declares
// on every heartbeat. Exported for agent/tools/agentsim, which must send the
// same declaration a real agent of this build sends. Pure accessor: it adds no
// behaviour to the shipped agent.
func CompiledSecurityCapabilities() SecurityCapabilities {
	return compiledSecurityCapabilities()
}
