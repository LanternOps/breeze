//go:build !windows && !linux && !darwin

package collectors

func (c *ChangeTrackerCollector) collectStartupItems() ([]TrackedStartupItem, error) {
	return []TrackedStartupItem{}, nil
}

func (c *ChangeTrackerCollector) collectScheduledTasks() ([]TrackedScheduledTask, error) {
	return []TrackedScheduledTask{}, nil
}

func (c *ChangeTrackerCollector) collectUserAccounts() ([]TrackedUserAccount, error) {
	return []TrackedUserAccount{}, nil
}
