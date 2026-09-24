//go:build linux

package hwhealth

func bmcToolNames(kind Kind) []string {
	switch kind {
	case "ipmi":
		return []string{"ipmitool"}
	case "racadm":
		return []string{"racadm"}
	case "hponcfg":
		return []string{"hponcfg"}
	default:
		return nil
	}
}
