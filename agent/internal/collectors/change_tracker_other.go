//go:build !windows && !linux && !darwin

package collectors

import "context"

func (c *ChangeTrackerCollector) collectStartupItems(_ context.Context) ([]TrackedStartupItem, error) {
	return []TrackedStartupItem{}, nil
}

func (c *ChangeTrackerCollector) collectScheduledTasks(_ context.Context) ([]TrackedScheduledTask, error) {
	return []TrackedScheduledTask{}, nil
}

func (c *ChangeTrackerCollector) collectUserAccounts(_ context.Context) ([]TrackedUserAccount, error) {
	return []TrackedUserAccount{}, nil
}
