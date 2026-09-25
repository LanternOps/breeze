//go:build !linux

package hwhealth

func newMDADM(extra []string, run toolRunner, members map[string]string) Source {
	return unavailableSource("mdadm", TierRAID)
}
