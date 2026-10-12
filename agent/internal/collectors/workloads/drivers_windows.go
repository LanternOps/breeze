package workloads

// DefaultDrivers is the set of runtimes this OS can host. The Hyper-V driver
// registers here in a later wave.
func DefaultDrivers() []Driver {
	return []Driver{newDockerDriver()}
}
