//go:build !windows

package hwhealth

func newStorageSpaces() Source {
	return unavailableSource("storage_spaces", TierRAID)
}
