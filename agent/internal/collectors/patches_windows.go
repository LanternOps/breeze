//go:build windows

package collectors

import (
	"encoding/json"
	"os/exec"
	"strings"
)

// WindowsUpdate represents a Windows Update from PowerShell
type WindowsUpdate struct {
	Title              string `json:"Title"`
	KB                 string `json:"KB"`
	Size               int64  `json:"Size"`
	Categories         string `json:"Categories"`
	IsDownloaded       bool   `json:"IsDownloaded"`
	IsMandatory        bool   `json:"IsMandatory"`
	MsrcSeverity       string `json:"MsrcSeverity"`
	RebootRequired     bool   `json:"RebootRequired"`
	Description        string `json:"Description"`
	LastDeploymentDate string `json:"LastDeploymentDate"`
}

// Collect retrieves available patches/updates on Windows
func (c *PatchCollector) Collect() ([]PatchInfo, error) {
	// Use PowerShell to query Windows Update
	psScript := `
$Session = New-Object -ComObject Microsoft.Update.Session
$Searcher = $Session.CreateUpdateSearcher()
try {
    $Results = $Searcher.Search("IsInstalled=0 and Type='Software'")
    $Updates = @()
    foreach ($Update in $Results.Updates) {
        $Categories = ($Update.Categories | ForEach-Object { $_.Name }) -join ", "
        $KB = ""
        if ($Update.KBArticleIDs.Count -gt 0) {
            $KB = "KB" + $Update.KBArticleIDs[0]
        }
        $Updates += @{
            Title = $Update.Title
            KB = $KB
            Size = $Update.MaxDownloadSize
            Categories = $Categories
            IsDownloaded = $Update.IsDownloaded
            IsMandatory = $Update.IsMandatory
            MsrcSeverity = $Update.MsrcSeverity
            RebootRequired = $Update.RebootBehavior -ne 0
            Description = $Update.Description
            LastDeploymentDate = if ($Update.LastDeploymentChangeTime) { $Update.LastDeploymentChangeTime.ToString("yyyy-MM-dd") } else { "" }
        }
    }
    $Updates | ConvertTo-Json -Depth 3
} catch {
    Write-Output "[]"
}
`

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	// Parse JSON output
	var updates []WindowsUpdate
	if err := json.Unmarshal(output, &updates); err != nil {
		// Try parsing as single object (when only one update)
		var singleUpdate WindowsUpdate
		if err := json.Unmarshal(output, &singleUpdate); err == nil && singleUpdate.Title != "" {
			updates = []WindowsUpdate{singleUpdate}
		} else {
			return nil, err
		}
	}

	// Convert to PatchInfo
	var patches []PatchInfo
	for _, u := range updates {
		patch := PatchInfo{
			Name:        u.Title,
			Version:     u.KB,
			KBNumber:    u.KB,
			Size:        u.Size,
			Category:    c.categorizeWindowsUpdate(u.Categories),
			Severity:    c.mapWindowsSeverity(u.MsrcSeverity),
			IsRestart:   u.RebootRequired,
			ReleaseDate: u.LastDeploymentDate,
			Description: u.Description,
			Source:      "microsoft",
		}
		patches = append(patches, patch)
	}

	return patches, nil
}

// categorizeWindowsUpdate determines the category based on update categories
func (c *PatchCollector) categorizeWindowsUpdate(categories string) string {
	categoriesLower := strings.ToLower(categories)

	if strings.Contains(categoriesLower, "security") {
		return "security"
	}
	if strings.Contains(categoriesLower, "critical") {
		return "security"
	}
	if strings.Contains(categoriesLower, "definition") {
		return "definitions"
	}
	if strings.Contains(categoriesLower, "driver") {
		return "driver"
	}
	if strings.Contains(categoriesLower, "feature pack") {
		return "feature"
	}
	if strings.Contains(categoriesLower, "service pack") {
		return "system"
	}
	if strings.Contains(categoriesLower, "update rollup") {
		return "system"
	}

	return "application"
}

// mapWindowsSeverity maps Windows MSRC severity to our severity levels
func (c *PatchCollector) mapWindowsSeverity(msrcSeverity string) string {
	switch strings.ToLower(msrcSeverity) {
	case "critical":
		return "critical"
	case "important":
		return "important"
	case "moderate":
		return "moderate"
	case "low":
		return "low"
	default:
		return ""
	}
}
