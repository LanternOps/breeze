package workloads

// DefaultDrivers is the set of runtimes this OS can host. Hyper-V and Proxmox
// drivers register here in a later wave.
func DefaultDrivers() []Driver {
	return []Driver{newDockerDriver(), newPodmanDriver(), newContainerdDriver()}
}
