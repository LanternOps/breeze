//go:build linux

package hwhealth

func wellKnownDirs() []string {
	return []string{
		"/opt/MegaRAID/storcli/",
		"/opt/MegaRAID/perccli/",
		"/opt/MegaRAID/MegaCli/",
		"/usr/sbin",
		"/usr/local/sbin",
		"/opt/smartstorageadmin/ssacli/bin/",
		"/usr/Arcconf/",
		"/usr/StorMan/",
		"/opt/dell/srvadmin/bin/",
		"/opt/dell/srvadmin/sbin/",
		"/usr/bin",
	}
}
