// Package tools provides remote management tools for the Breeze agent.
package tools

import (
	"sync"
	"time"
)

// ScheduledTask represents a Windows scheduled task.
type ScheduledTask struct {
	Name           string    `json:"name"`
	Path           string    `json:"path"`
	Enabled        bool      `json:"enabled"`
	State          string    `json:"state"` // Ready, Running, Disabled, Queued
	LastRunTime    time.Time `json:"lastRunTime"`
	NextRunTime    time.Time `json:"nextRunTime"`
	LastTaskResult int       `json:"lastTaskResult"`
	Author         string    `json:"author"`
	Description    string    `json:"description"`
}

// TaskTrigger represents a trigger for a scheduled task.
type TaskTrigger struct {
	Type       string    `json:"type"` // Daily, Weekly, Monthly, OnBoot, OnLogon, etc.
	StartTime  time.Time `json:"startTime"`
	Enabled    bool      `json:"enabled"`
	Repetition string    `json:"repetition"`
}

// TaskAction represents an action that a scheduled task performs.
type TaskAction struct {
	Type       string `json:"type"` // Execute, SendEmail, etc.
	Path       string `json:"path"`
	Arguments  string `json:"arguments"`
	WorkingDir string `json:"workingDir"`
}

// TaskDetails contains detailed information about a scheduled task.
type TaskDetails struct {
	ScheduledTask
	Triggers  []TaskTrigger `json:"triggers"`
	Actions   []TaskAction  `json:"actions"`
	Principal string        `json:"principal"`
	RunLevel  string        `json:"runLevel"` // LeastPrivilege, HighestAvailable
}

// TaskHistory represents a historical execution record for a task.
type TaskHistory struct {
	RecordID  uint64    `json:"recordId"`
	EventID   uint32    `json:"eventId"`
	Level     string    `json:"level"`
	TimeStamp time.Time `json:"timestamp"`
	Message   string    `json:"message"`
}

// TaskSchedulerManager manages Windows scheduled tasks.
type TaskSchedulerManager struct {
	mu sync.Mutex
}

// NewTaskSchedulerManager creates a new TaskSchedulerManager instance.
func NewTaskSchedulerManager() *TaskSchedulerManager {
	return &TaskSchedulerManager{}
}
