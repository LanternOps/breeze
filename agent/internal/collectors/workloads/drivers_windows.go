package workloads

// DefaultDrivers is the set of runtimes this OS can host.
func DefaultDrivers() []Driver {
	return []Driver{newDockerDriver(), newHyperVDriver()}
}
