package userhelper

import (
	"fmt"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// pamDialogField is one "label: value" row of the elevation prompt. Shared by
// the custom Win32 dialog (field grid) and the MessageBox fallback (body
// lines) so the two renderings can never drift apart.
type pamDialogField struct {
	Label string
	Value string
}

// pamDialogHeadline names the requesting program: "msiexec.exe is requesting
// elevation". Falls back to a generic line when the path is unknown.
func pamDialogHeadline(req ipc.PamRequestDialog) string {
	base := pamDialogExeBase(req.ExePath)
	if base == "" {
		return "An application is requesting elevation"
	}
	return fmt.Sprintf("%s is requesting elevation", base)
}

func pamDialogExeBase(path string) string {
	path = strings.TrimSpace(strings.ReplaceAll(path, "\x00", " "))
	if i := strings.LastIndexAny(path, `\/`); i >= 0 {
		path = path[i+1:]
	}
	return strings.TrimSpace(path)
}

// pamDialogFields assembles the visible request attributes in display order.
// Optional attributes (command line, reason, AI intent) appear only when the
// capture recorded them.
func pamDialogFields(req ipc.PamRequestDialog) []pamDialogField {
	fields := []pamDialogField{
		{Label: "Program", Value: pamDialogValue(req.ExePath)},
		{Label: "Signer", Value: pamDialogValue(req.Signer)},
		{Label: "User", Value: pamDialogValue(req.SubjectUser)},
	}
	if strings.TrimSpace(req.CommandLine) != "" {
		fields = append(fields, pamDialogField{Label: "Command line", Value: pamDialogValue(req.CommandLine)})
	}
	if req.Reason != "" {
		fields = append(fields, pamDialogField{Label: "Reason", Value: pamDialogValue(req.Reason)})
	}
	if req.IntentSummary != "" {
		fields = append(fields, pamDialogField{Label: "Intent", Value: pamDialogValue(req.IntentSummary)})
	}
	return fields
}

// buildPamDialogBody renders the MessageBox-fallback body from the same field
// list the custom dialog draws.
func buildPamDialogBody(req ipc.PamRequestDialog) string {
	lines := []string{
		"Breeze detected an elevation request.",
		"",
	}
	for _, field := range pamDialogFields(req) {
		lines = append(lines, fmt.Sprintf("%s: %s", field.Label, field.Value))
	}
	lines = append(lines, "", "Approve this elevation request?")
	return strings.Join(lines, "\r\n")
}

// formatPamCountdown renders a remaining duration as M:SS, flooring at 0:00.
func formatPamCountdown(remaining time.Duration) string {
	if remaining < 0 {
		remaining = 0
	}
	total := int(remaining.Round(time.Second) / time.Second)
	return fmt.Sprintf("%d:%02d", total/60, total%60)
}

func pamDialogValue(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", " "))
	if value == "" {
		return "Unknown"
	}
	return value
}
