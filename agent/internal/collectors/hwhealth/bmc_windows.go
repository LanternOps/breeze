//go:build windows

package hwhealth

func bmcToolNames(kind Kind) []string {
	switch kind {
	case "ipmi":
		return []string{"ipmitool.exe", "ipmitool"}
	case "racadm":
		return []string{"racadm.exe", "racadm"}
	case "hponcfg":
		return []string{"hponcfg.exe", "hponcfg"}
	default:
		return nil
	}
}
