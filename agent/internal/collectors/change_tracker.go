package collectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ChangeType represents the category of change.
type ChangeType string

const (
	ChangeTypeSoftware    ChangeType = "software"
	ChangeTypeService     ChangeType = "service"
	ChangeTypeStartup     ChangeType = "startup"
	ChangeTypeNetwork     ChangeType = "network"
	ChangeTypeTask        ChangeType = "scheduled_task"
	ChangeTypeUserAccount ChangeType = "user_account"
)

// ChangeAction represents the type of detected change.
type ChangeAction string

const (
	ChangeActionAdded    ChangeAction = "added"
	ChangeActionRemoved  ChangeAction = "removed"
	ChangeActionModified ChangeAction = "modified"
	ChangeActionUpdated  ChangeAction = "updated"
)

// ChangeRecord represents a single detected change.
type ChangeRecord struct {
	Timestamp    time.Time      `json:"timestamp"`
	ChangeType   ChangeType     `json:"changeType"`
	ChangeAction ChangeAction   `json:"changeAction"`
	Subject      string         `json:"subject"`
	BeforeValue  map[string]any `json:"beforeValue,omitempty"`
	AfterValue   map[string]any `json:"afterValue,omitempty"`
	Details      map[string]any `json:"details,omitempty"`
}

// TrackedStartupItem captures stable startup metadata for change detection.
type TrackedStartupItem struct {
	Name    string `json:"name"`
	Type    string `json:"type,omitempty"`
	Path    string `json:"path,omitempty"`
	Enabled bool   `json:"enabled"`
}

// TrackedScheduledTask captures task metadata for drift detection.
type TrackedScheduledTask struct {
	Name     string `json:"name"`
	Path     string `json:"path,omitempty"`
	Status   string `json:"status,omitempty"`
	Schedule string `json:"schedule,omitempty"`
	Command  string `json:"command,omitempty"`
}

// TrackedUserAccount captures user account properties for change detection.
type TrackedUserAccount struct {
	Username string `json:"username"`
	FullName string `json:"fullName,omitempty"`
	Disabled bool   `json:"disabled"`
	Locked   bool   `json:"locked"`
}

// Snapshot represents the current state of trackable items.
type Snapshot struct {
	Timestamp       time.Time                       `json:"timestamp"`
	Software        map[string]SoftwareItem         `json:"software"`
	Services        map[string]ServiceInfo          `json:"services"`
	StartupItems    map[string]TrackedStartupItem   `json:"startupItems"`
	NetworkAdapters map[string]NetworkAdapterInfo   `json:"networkAdapters"`
	ScheduledTasks  map[string]TrackedScheduledTask `json:"scheduledTasks"`
	UserAccounts    map[string]TrackedUserAccount   `json:"userAccounts"`
}

// ChangeTrackerCollector tracks changes in system configuration.
type ChangeTrackerCollector struct {
	snapshotPath     string
	lastSnapshot     *Snapshot
	gatherSnapshot   func() (*Snapshot, error)
	now              func() time.Time
	collectorTimeout time.Duration
	ignoreRules      []changeIgnoreRule
	mu               sync.Mutex
}

type changeIgnoreRule struct {
	changeType ChangeType
	pattern    string
}

// NewChangeTrackerCollector creates a new change tracker.
func NewChangeTrackerCollector(snapshotPath string) *ChangeTrackerCollector {
	timeout := 8 * time.Second
	if raw := strings.TrimSpace(os.Getenv("BREEZE_CHANGE_TRACKER_COLLECTOR_TIMEOUT_SECONDS")); raw != "" {
		if parsed, err := time.ParseDuration(raw + "s"); err == nil && parsed > 0 {
			timeout = parsed
		}
	}

	rules := defaultChangeIgnoreRules()
	rules = append(rules, parseChangeIgnoreRules(os.Getenv("BREEZE_CHANGE_TRACKER_IGNORE"))...)

	return &ChangeTrackerCollector{
		snapshotPath:     snapshotPath,
		collectorTimeout: timeout,
		ignoreRules:      rules,
		now: func() time.Time {
			return time.Now().UTC()
		},
	}
}

// CollectChanges detects changes since the previous snapshot.
func (c *ChangeTrackerCollector) CollectChanges() ([]ChangeRecord, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.lastSnapshot == nil {
		if err := c.loadSnapshot(); err != nil && !errors.Is(err, os.ErrNotExist) {
			// Corrupt snapshot or read error: reset baseline on next successful collection.
			c.lastSnapshot = nil
		}
	}

	currentSnapshot, err := c.gatherCurrentSnapshot()
	if err != nil {
		return nil, err
	}

	// First successful run establishes baseline.
	if c.lastSnapshot == nil {
		c.lastSnapshot = currentSnapshot
		return []ChangeRecord{}, c.saveSnapshot()
	}

	changes := make([]ChangeRecord, 0, 16)
	changes = append(changes, c.diffSoftware(currentSnapshot)...)
	changes = append(changes, c.diffServices(currentSnapshot)...)
	changes = append(changes, c.diffStartupItems(currentSnapshot)...)
	changes = append(changes, c.diffNetworkAdapters(currentSnapshot)...)
	changes = append(changes, c.diffScheduledTasks(currentSnapshot)...)
	changes = append(changes, c.diffUserAccounts(currentSnapshot)...)
	changes = c.filterNoise(changes)

	c.lastSnapshot = currentSnapshot
	if err := c.saveSnapshot(); err != nil {
		return changes, err
	}
	return changes, nil
}

func (c *ChangeTrackerCollector) gatherCurrentSnapshot() (*Snapshot, error) {
	if c.gatherSnapshot != nil {
		snapshot, err := c.gatherSnapshot()
		if err != nil {
			return nil, err
		}
		c.ensureSnapshotMaps(snapshot)
		return snapshot, nil
	}

	snapshot := &Snapshot{
		Timestamp:       c.now(),
		Software:        map[string]SoftwareItem{},
		Services:        map[string]ServiceInfo{},
		StartupItems:    map[string]TrackedStartupItem{},
		NetworkAdapters: map[string]NetworkAdapterInfo{},
		ScheduledTasks:  map[string]TrackedScheduledTask{},
		UserAccounts:    map[string]TrackedUserAccount{},
	}

	var (
		software       []SoftwareItem
		services       []ServiceInfo
		adapters       []NetworkAdapterInfo
		startupItems   []TrackedStartupItem
		scheduledTasks []TrackedScheduledTask
		userAccounts   []TrackedUserAccount

		softwareErr       error
		servicesErr       error
		adaptersErr       error
		startupItemsErr   error
		scheduledTasksErr error
		userAccountsErr   error
	)

	softwareCollector := NewSoftwareCollector()
	serviceCollector := NewServiceCollector()
	invCollector := NewInventoryCollector()

	ctx := context.Background()

	var wg sync.WaitGroup
	wg.Add(6)
	go func() {
		defer wg.Done()
		software, softwareErr = collectWithTimeout(ctx, c.collectorTimeout, func(_ context.Context) ([]SoftwareItem, error) {
			return softwareCollector.Collect()
		})
	}()
	go func() {
		defer wg.Done()
		services, servicesErr = collectWithTimeout(ctx, c.collectorTimeout, func(_ context.Context) ([]ServiceInfo, error) {
			return serviceCollector.Collect()
		})
	}()
	go func() {
		defer wg.Done()
		adapters, adaptersErr = collectWithTimeout(ctx, c.collectorTimeout, func(_ context.Context) ([]NetworkAdapterInfo, error) {
			return invCollector.CollectNetworkAdapters()
		})
	}()
	go func() {
		defer wg.Done()
		startupItems, startupItemsErr = collectWithTimeout(ctx, c.collectorTimeout, c.collectStartupItems)
	}()
	go func() {
		defer wg.Done()
		scheduledTasks, scheduledTasksErr = collectWithTimeout(ctx, c.collectorTimeout, c.collectScheduledTasks)
	}()
	go func() {
		defer wg.Done()
		userAccounts, userAccountsErr = collectWithTimeout(ctx, c.collectorTimeout, c.collectUserAccounts)
	}()
	wg.Wait()

	if softwareErr != nil {
		if c.lastSnapshot != nil {
			slog.Warn("software collection failed, using previous snapshot", "error", softwareErr.Error())
			snapshot.Software = maps.Clone(c.lastSnapshot.Software)
		} else {
			return nil, fmt.Errorf("collect software inventory: %w", softwareErr)
		}
	} else {
		for _, sw := range software {
			key := softwareKey(sw)
			snapshot.Software[key] = sw
		}
	}

	if servicesErr != nil {
		slog.Warn("service collection failed, using previous snapshot", "error", servicesErr.Error())
		if c.lastSnapshot != nil {
			snapshot.Services = maps.Clone(c.lastSnapshot.Services)
		}
	} else {
		for _, svc := range services {
			key := serviceKey(svc)
			snapshot.Services[key] = svc
		}
	}

	if adaptersErr != nil {
		if c.lastSnapshot != nil {
			slog.Warn("network adapter collection failed, using previous snapshot", "error", adaptersErr.Error())
			snapshot.NetworkAdapters = maps.Clone(c.lastSnapshot.NetworkAdapters)
		} else {
			return nil, fmt.Errorf("collect network adapters: %w", adaptersErr)
		}
	} else {
		for _, adapter := range adapters {
			key := networkKey(adapter)
			snapshot.NetworkAdapters[key] = adapter
		}
	}

	if startupItemsErr != nil {
		slog.Warn("startup items collection failed, using previous snapshot", "error", startupItemsErr.Error())
		if c.lastSnapshot != nil {
			snapshot.StartupItems = maps.Clone(c.lastSnapshot.StartupItems)
		}
	} else {
		for _, item := range startupItems {
			key := startupKey(item)
			snapshot.StartupItems[key] = item
		}
	}

	if scheduledTasksErr != nil {
		slog.Warn("scheduled tasks collection failed, using previous snapshot", "error", scheduledTasksErr.Error())
		if c.lastSnapshot != nil {
			snapshot.ScheduledTasks = maps.Clone(c.lastSnapshot.ScheduledTasks)
		}
	} else {
		for _, task := range scheduledTasks {
			key := taskKey(task)
			snapshot.ScheduledTasks[key] = task
		}
	}

	if userAccountsErr != nil {
		slog.Warn("user accounts collection failed, using previous snapshot", "error", userAccountsErr.Error())
		if c.lastSnapshot != nil {
			snapshot.UserAccounts = maps.Clone(c.lastSnapshot.UserAccounts)
		}
	} else {
		for _, account := range userAccounts {
			key := userAccountKey(account)
			snapshot.UserAccounts[key] = account
		}
	}

	c.ensureSnapshotMaps(snapshot)
	return snapshot, nil
}

func collectWithTimeout[T any](parent context.Context, timeout time.Duration, collect func(ctx context.Context) (T, error)) (T, error) {
	if timeout <= 0 {
		timeout = 8 * time.Second
	}

	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	type result struct {
		value T
		err   error
	}
	out := make(chan result, 1)
	go func() {
		value, err := collect(ctx)
		out <- result{value: value, err: err}
	}()

	select {
	case res := <-out:
		return res.value, res.err
	case <-ctx.Done():
		var zero T
		if ctx.Err() == context.DeadlineExceeded {
			return zero, fmt.Errorf("collector timed out after %s: %w", timeout, ctx.Err())
		}
		return zero, fmt.Errorf("collector cancelled: %w", ctx.Err())
	}
}

func (c *ChangeTrackerCollector) loadSnapshot() error {
	if strings.TrimSpace(c.snapshotPath) == "" {
		return fmt.Errorf("snapshot path is empty")
	}

	data, err := os.ReadFile(c.snapshotPath)
	if err != nil {
		return err
	}

	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return fmt.Errorf("unmarshal snapshot: %w", err)
	}
	c.ensureSnapshotMaps(&snapshot)
	c.lastSnapshot = &snapshot
	return nil
}

func (c *ChangeTrackerCollector) saveSnapshot() error {
	if c.lastSnapshot == nil {
		return nil
	}
	if strings.TrimSpace(c.snapshotPath) == "" {
		return fmt.Errorf("snapshot path is empty")
	}

	data, err := json.Marshal(c.lastSnapshot)
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}

	path := c.snapshotPath
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		fallback := filepath.Join(os.TempDir(), "breeze", "change_tracker_snapshot.json")
		if mkdirErr := os.MkdirAll(filepath.Dir(fallback), 0700); mkdirErr != nil {
			return fmt.Errorf("create snapshot directory: %w", err)
		}
		path = fallback
		c.snapshotPath = fallback
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("replace snapshot: %w", err)
	}
	return nil
}

func (c *ChangeTrackerCollector) ensureSnapshotMaps(snapshot *Snapshot) {
	if snapshot.Software == nil {
		snapshot.Software = map[string]SoftwareItem{}
	}
	if snapshot.Services == nil {
		snapshot.Services = map[string]ServiceInfo{}
	}
	if snapshot.StartupItems == nil {
		snapshot.StartupItems = map[string]TrackedStartupItem{}
	}
	if snapshot.NetworkAdapters == nil {
		snapshot.NetworkAdapters = map[string]NetworkAdapterInfo{}
	}
	if snapshot.ScheduledTasks == nil {
		snapshot.ScheduledTasks = map[string]TrackedScheduledTask{}
	}
	if snapshot.UserAccounts == nil {
		snapshot.UserAccounts = map[string]TrackedUserAccount{}
	}
	if snapshot.Timestamp.IsZero() {
		snapshot.Timestamp = c.now()
	}
}

func (c *ChangeTrackerCollector) diffSoftware(current *Snapshot) []ChangeRecord {
	now := c.now()
	changes := make([]ChangeRecord, 0)

	for key, newSw := range current.Software {
		oldSw, existed := c.lastSnapshot.Software[key]
		if !existed {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeSoftware,
				ChangeAction: ChangeActionAdded,
				Subject:      softwareSubject(newSw),
				AfterValue: map[string]any{
					"name":            newSw.Name,
					"version":         newSw.Version,
					"vendor":          newSw.Vendor,
					"installLocation": newSw.InstallLocation,
				},
			})
			continue
		}

		if oldSw.Version != newSw.Version {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeSoftware,
				ChangeAction: ChangeActionUpdated,
				Subject:      softwareSubject(newSw),
				BeforeValue: map[string]any{
					"version": oldSw.Version,
				},
				AfterValue: map[string]any{
					"version": newSw.Version,
				},
			})
		}
	}

	for key, oldSw := range c.lastSnapshot.Software {
		if _, exists := current.Software[key]; exists {
			continue
		}
		changes = append(changes, ChangeRecord{
			Timestamp:    now,
			ChangeType:   ChangeTypeSoftware,
			ChangeAction: ChangeActionRemoved,
			Subject:      softwareSubject(oldSw),
			BeforeValue: map[string]any{
				"name":    oldSw.Name,
				"version": oldSw.Version,
				"vendor":  oldSw.Vendor,
			},
		})
	}

	return changes
}

func (c *ChangeTrackerCollector) diffServices(current *Snapshot) []ChangeRecord {
	now := c.now()
	changes := make([]ChangeRecord, 0)

	for key, newSvc := range current.Services {
		oldSvc, existed := c.lastSnapshot.Services[key]
		if !existed {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeService,
				ChangeAction: ChangeActionAdded,
				Subject:      serviceSubject(newSvc),
				AfterValue: map[string]any{
					"state":       newSvc.State,
					"startupType": newSvc.StartupType,
					"account":     newSvc.Account,
				},
			})
			continue
		}

		if oldSvc.StartupType != newSvc.StartupType {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeService,
				ChangeAction: ChangeActionModified,
				Subject:      serviceSubject(newSvc),
				BeforeValue: map[string]any{
					"startupType": oldSvc.StartupType,
				},
				AfterValue: map[string]any{
					"startupType": newSvc.StartupType,
				},
				Details: map[string]any{
					"field": "startup_type",
				},
			})
		}

		if oldSvc.Account != newSvc.Account {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeService,
				ChangeAction: ChangeActionModified,
				Subject:      serviceSubject(newSvc),
				BeforeValue: map[string]any{
					"account": oldSvc.Account,
				},
				AfterValue: map[string]any{
					"account": newSvc.Account,
				},
				Details: map[string]any{
					"field": "service_account",
				},
			})
		}
	}

	for key, oldSvc := range c.lastSnapshot.Services {
		if _, exists := current.Services[key]; exists {
			continue
		}
		changes = append(changes, ChangeRecord{
			Timestamp:    now,
			ChangeType:   ChangeTypeService,
			ChangeAction: ChangeActionRemoved,
			Subject:      serviceSubject(oldSvc),
		})
	}

	return changes
}

func (c *ChangeTrackerCollector) diffStartupItems(current *Snapshot) []ChangeRecord {
	now := c.now()
	changes := make([]ChangeRecord, 0)

	for key, newItem := range current.StartupItems {
		oldItem, existed := c.lastSnapshot.StartupItems[key]
		if !existed {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeStartup,
				ChangeAction: ChangeActionAdded,
				Subject:      startupSubject(newItem),
				AfterValue: map[string]any{
					"type":    newItem.Type,
					"path":    newItem.Path,
					"enabled": newItem.Enabled,
				},
			})
			continue
		}

		if oldItem.Path != newItem.Path || oldItem.Enabled != newItem.Enabled || oldItem.Type != newItem.Type {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeStartup,
				ChangeAction: ChangeActionModified,
				Subject:      startupSubject(newItem),
				BeforeValue: map[string]any{
					"type":    oldItem.Type,
					"path":    oldItem.Path,
					"enabled": oldItem.Enabled,
				},
				AfterValue: map[string]any{
					"type":    newItem.Type,
					"path":    newItem.Path,
					"enabled": newItem.Enabled,
				},
			})
		}
	}

	for key, oldItem := range c.lastSnapshot.StartupItems {
		if _, exists := current.StartupItems[key]; exists {
			continue
		}
		changes = append(changes, ChangeRecord{
			Timestamp:    now,
			ChangeType:   ChangeTypeStartup,
			ChangeAction: ChangeActionRemoved,
			Subject:      startupSubject(oldItem),
			BeforeValue: map[string]any{
				"type":    oldItem.Type,
				"path":    oldItem.Path,
				"enabled": oldItem.Enabled,
			},
		})
	}

	return changes
}

func (c *ChangeTrackerCollector) diffNetworkAdapters(current *Snapshot) []ChangeRecord {
	now := c.now()
	changes := make([]ChangeRecord, 0)

	for key, newAdapter := range current.NetworkAdapters {
		oldAdapter, existed := c.lastSnapshot.NetworkAdapters[key]
		if !existed {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeNetwork,
				ChangeAction: ChangeActionAdded,
				Subject:      newAdapter.InterfaceName,
				AfterValue: map[string]any{
					"ipAddress":  newAdapter.IPAddress,
					"macAddress": newAdapter.MACAddress,
					"ipType":     newAdapter.IPType,
					"isPrimary":  newAdapter.IsPrimary,
				},
			})
			continue
		}

		if oldAdapter.IPAddress != newAdapter.IPAddress || oldAdapter.MACAddress != newAdapter.MACAddress || oldAdapter.IsPrimary != newAdapter.IsPrimary {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeNetwork,
				ChangeAction: ChangeActionModified,
				Subject:      newAdapter.InterfaceName,
				BeforeValue: map[string]any{
					"ipAddress":  oldAdapter.IPAddress,
					"macAddress": oldAdapter.MACAddress,
					"isPrimary":  oldAdapter.IsPrimary,
				},
				AfterValue: map[string]any{
					"ipAddress":  newAdapter.IPAddress,
					"macAddress": newAdapter.MACAddress,
					"isPrimary":  newAdapter.IsPrimary,
				},
			})
		}
	}

	for key, oldAdapter := range c.lastSnapshot.NetworkAdapters {
		if _, exists := current.NetworkAdapters[key]; exists {
			continue
		}
		changes = append(changes, ChangeRecord{
			Timestamp:    now,
			ChangeType:   ChangeTypeNetwork,
			ChangeAction: ChangeActionRemoved,
			Subject:      oldAdapter.InterfaceName,
			BeforeValue: map[string]any{
				"ipAddress":  oldAdapter.IPAddress,
				"macAddress": oldAdapter.MACAddress,
				"ipType":     oldAdapter.IPType,
			},
		})
	}

	return changes
}

func (c *ChangeTrackerCollector) diffScheduledTasks(current *Snapshot) []ChangeRecord {
	now := c.now()
	changes := make([]ChangeRecord, 0)

	for key, newTask := range current.ScheduledTasks {
		oldTask, existed := c.lastSnapshot.ScheduledTasks[key]
		if !existed {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeTask,
				ChangeAction: ChangeActionAdded,
				Subject:      taskSubject(newTask),
				AfterValue: map[string]any{
					"path":     newTask.Path,
					"status":   newTask.Status,
					"schedule": newTask.Schedule,
					"command":  newTask.Command,
				},
			})
			continue
		}

		if oldTask.Status != newTask.Status || oldTask.Schedule != newTask.Schedule || oldTask.Command != newTask.Command || oldTask.Path != newTask.Path {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeTask,
				ChangeAction: ChangeActionModified,
				Subject:      taskSubject(newTask),
				BeforeValue: map[string]any{
					"path":     oldTask.Path,
					"status":   oldTask.Status,
					"schedule": oldTask.Schedule,
					"command":  oldTask.Command,
				},
				AfterValue: map[string]any{
					"path":     newTask.Path,
					"status":   newTask.Status,
					"schedule": newTask.Schedule,
					"command":  newTask.Command,
				},
			})
		}
	}

	for key, oldTask := range c.lastSnapshot.ScheduledTasks {
		if _, exists := current.ScheduledTasks[key]; exists {
			continue
		}
		changes = append(changes, ChangeRecord{
			Timestamp:    now,
			ChangeType:   ChangeTypeTask,
			ChangeAction: ChangeActionRemoved,
			Subject:      taskSubject(oldTask),
			BeforeValue: map[string]any{
				"path":    oldTask.Path,
				"status":  oldTask.Status,
				"command": oldTask.Command,
			},
		})
	}

	return changes
}

func (c *ChangeTrackerCollector) diffUserAccounts(current *Snapshot) []ChangeRecord {
	now := c.now()
	changes := make([]ChangeRecord, 0)

	for key, newAccount := range current.UserAccounts {
		oldAccount, existed := c.lastSnapshot.UserAccounts[key]
		if !existed {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeUserAccount,
				ChangeAction: ChangeActionAdded,
				Subject:      newAccount.Username,
				AfterValue: map[string]any{
					"fullName": newAccount.FullName,
					"disabled": newAccount.Disabled,
					"locked":   newAccount.Locked,
				},
			})
			continue
		}

		if oldAccount.FullName != newAccount.FullName || oldAccount.Disabled != newAccount.Disabled || oldAccount.Locked != newAccount.Locked {
			changes = append(changes, ChangeRecord{
				Timestamp:    now,
				ChangeType:   ChangeTypeUserAccount,
				ChangeAction: ChangeActionModified,
				Subject:      newAccount.Username,
				BeforeValue: map[string]any{
					"fullName": oldAccount.FullName,
					"disabled": oldAccount.Disabled,
					"locked":   oldAccount.Locked,
				},
				AfterValue: map[string]any{
					"fullName": newAccount.FullName,
					"disabled": newAccount.Disabled,
					"locked":   newAccount.Locked,
				},
			})
		}
	}

	for key, oldAccount := range c.lastSnapshot.UserAccounts {
		if _, exists := current.UserAccounts[key]; exists {
			continue
		}
		changes = append(changes, ChangeRecord{
			Timestamp:    now,
			ChangeType:   ChangeTypeUserAccount,
			ChangeAction: ChangeActionRemoved,
			Subject:      oldAccount.Username,
			BeforeValue: map[string]any{
				"fullName": oldAccount.FullName,
				"disabled": oldAccount.Disabled,
				"locked":   oldAccount.Locked,
			},
		})
	}

	return changes
}

func (c *ChangeTrackerCollector) filterNoise(changes []ChangeRecord) []ChangeRecord {
	if len(changes) == 0 || len(c.ignoreRules) == 0 {
		return changes
	}

	filtered := make([]ChangeRecord, 0, len(changes))
	for _, change := range changes {
		if c.shouldIgnoreChange(change) {
			continue
		}
		filtered = append(filtered, change)
	}
	return filtered
}

func (c *ChangeTrackerCollector) shouldIgnoreChange(change ChangeRecord) bool {
	subject := strings.ToLower(strings.TrimSpace(change.Subject))
	if subject == "" {
		return false
	}

	for _, rule := range c.ignoreRules {
		if rule.changeType != change.ChangeType {
			continue
		}

		matched, err := filepath.Match(rule.pattern, subject)
		if err == nil && matched {
			return true
		}
		if rule.pattern == subject {
			return true
		}
	}
	return false
}

func defaultChangeIgnoreRules() []changeIgnoreRule {
	return []changeIgnoreRule{
		{changeType: ChangeTypeSoftware, pattern: "security intelligence update*"},
		{changeType: ChangeTypeSoftware, pattern: "definition update for microsoft defender*"},
	}
}

func parseChangeIgnoreRules(raw string) []changeIgnoreRule {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}

	validTypes := map[ChangeType]struct{}{
		ChangeTypeSoftware:    {},
		ChangeTypeService:     {},
		ChangeTypeStartup:     {},
		ChangeTypeNetwork:     {},
		ChangeTypeTask:        {},
		ChangeTypeUserAccount: {},
	}

	rules := make([]changeIgnoreRule, 0)
	for _, token := range strings.Split(raw, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		parts := strings.SplitN(token, ":", 2)
		if len(parts) != 2 {
			continue
		}

		changeType := ChangeType(strings.TrimSpace(parts[0]))
		if _, ok := validTypes[changeType]; !ok {
			continue
		}

		pattern := strings.ToLower(strings.TrimSpace(parts[1]))
		if pattern == "" {
			continue
		}
		rules = append(rules, changeIgnoreRule{
			changeType: changeType,
			pattern:    pattern,
		})
	}
	return rules
}

func softwareKey(item SoftwareItem) string {
	name := normalizeString(item.Name)
	vendor := normalizeString(item.Vendor)
	installLocation := normalizeString(item.InstallLocation)
	uninstall := normalizeString(item.UninstallString)

	identity := []string{name, vendor}
	switch {
	case installLocation != "":
		identity = append(identity, installLocation)
	case uninstall != "":
		identity = append(identity, uninstall)
	default:
		identity = append(identity, "_default")
	}
	return strings.Join(identity, "|")
}

func serviceKey(item ServiceInfo) string {
	return normalizeString(item.Name)
}

func startupKey(item TrackedStartupItem) string {
	return strings.Join([]string{
		normalizeString(item.Name),
		normalizeString(item.Type),
		normalizeString(item.Path),
	}, "|")
}

func networkKey(item NetworkAdapterInfo) string {
	return strings.Join([]string{
		normalizeString(item.InterfaceName),
		normalizeString(item.IPType),
		normalizeString(item.MACAddress),
	}, "|")
}

func taskKey(item TrackedScheduledTask) string {
	return strings.Join([]string{
		normalizeString(item.Name),
		normalizeString(item.Path),
	}, "|")
}

func userAccountKey(item TrackedUserAccount) string {
	return normalizeString(item.Username)
}

func softwareSubject(item SoftwareItem) string {
	if strings.TrimSpace(item.Name) != "" {
		return item.Name
	}
	return "unknown software"
}

func serviceSubject(item ServiceInfo) string {
	if strings.TrimSpace(item.DisplayName) != "" {
		return item.DisplayName
	}
	if strings.TrimSpace(item.Name) != "" {
		return item.Name
	}
	return "unknown service"
}

func startupSubject(item TrackedStartupItem) string {
	if strings.TrimSpace(item.Name) != "" {
		return item.Name
	}
	return "unknown startup item"
}

func taskSubject(item TrackedScheduledTask) string {
	if strings.TrimSpace(item.Name) != "" {
		return item.Name
	}
	return "unknown scheduled task"
}

func normalizeString(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
