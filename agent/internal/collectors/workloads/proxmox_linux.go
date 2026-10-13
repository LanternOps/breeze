package workloads

import (
	"os"
	"time"
)

// newProxmoxDriver wires the Proxmox driver to the host. It is registered on
// every Linux agent; on anything but a Proxmox VE node Detect finds no pvesh
// and reports absent without running anything.
func newProxmoxDriver() Driver {
	return &proxmoxDriver{
		pvesh:      proxmoxPvesh,
		pveDir:     "/etc/pve",
		dpkgStatus: "/var/lib/dpkg/status",
		stat:       os.Stat,
		readlink:   os.Readlink,
		readConf:   readFileLimited,
		run:        runReadOnly,
		now:        time.Now,
	}
}
