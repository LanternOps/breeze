//go:build !windows

package hwhealth

func newStorageSpaces(map[string]string) Source {
	return unavailableSource("storage_spaces", TierRAID)
}
