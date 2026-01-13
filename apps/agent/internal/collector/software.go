package collector

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/breeze-rmm/agent/pkg/models"
	"go.uber.org/zap"
)

// SoftwareCollector collects information about installed software.
// It uses platform-specific methods to detect installed applications:
// - Windows: Registry (HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall)
// - macOS: /Applications directory and Homebrew
// - Linux: dpkg, rpm, or pacman depending on the distribution
type SoftwareCollector struct {
	BaseCollector
}

// NewSoftwareCollector creates a new SoftwareCollector with the given logger
func NewSoftwareCollector(logger *zap.Logger) *SoftwareCollector {
	return &SoftwareCollector{
		BaseCollector: NewBaseCollector(logger),
	}
}

// Name returns the collector's name
func (s *SoftwareCollector) Name() string {
	return "software"
}

// Collect gathers installed software information and returns []models.SoftwareInfo.
// It uses platform-specific detection methods and logs warnings for partial failures.
func (s *SoftwareCollector) Collect() (interface{}, error) {
	s.LogDebug("Starting software collection", zap.String("platform", runtime.GOOS))

	var software []models.SoftwareInfo
	var err error

	switch runtime.GOOS {
	case "windows":
		software, err = s.collectWindows()
	case "darwin":
		software, err = s.collectMacOS()
	case "linux":
		software, err = s.collectLinux()
	default:
		return nil, fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}

	if err != nil {
		s.LogWarning("Software collection had errors", zap.Error(err))
	}

	s.LogDebug("Software collection completed", zap.Int("count", len(software)))

	// Return what we have even if there were some errors
	if len(software) == 0 && err != nil {
		return software, err
	}

	return software, nil
}

// collectWindows reads installed software from the Windows registry
func (s *SoftwareCollector) collectWindows() ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	// Registry paths to check for installed software
	registryPaths := []string{
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
	}

	for _, regPath := range registryPaths {
		apps, err := s.queryWindowsRegistry(regPath)
		if err != nil {
			s.LogWarning("Failed to query registry",
				zap.String("path", regPath),
				zap.Error(err))
			continue
		}
		software = append(software, apps...)
	}

	// Deduplicate by name and version
	software = s.deduplicateSoftware(software)

	if len(software) == 0 {
		return software, fmt.Errorf("no software found in registry")
	}

	return software, nil
}

// queryWindowsRegistry queries a Windows registry path for installed software
func (s *SoftwareCollector) queryWindowsRegistry(regPath string) ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	// Use reg query to enumerate subkeys
	cmd := exec.Command("reg", "query", regPath)
	output, err := cmd.Output()
	if err != nil {
		return software, fmt.Errorf("reg query failed: %w", err)
	}

	// Parse the output to get subkey paths
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "HK") {
			continue
		}

		// Query each subkey for software details
		app, err := s.queryWindowsSoftwareEntry(line)
		if err != nil {
			continue // Skip entries that can't be parsed
		}

		// Only include entries with a display name
		if app.Name != "" {
			software = append(software, app)
		}
	}

	return software, nil
}

// queryWindowsSoftwareEntry queries a single registry entry for software details
func (s *SoftwareCollector) queryWindowsSoftwareEntry(regPath string) (models.SoftwareInfo, error) {
	app := models.SoftwareInfo{}

	cmd := exec.Command("reg", "query", regPath)
	output, err := cmd.Output()
	if err != nil {
		return app, err
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		parts := strings.SplitN(line, "    ", 3)
		if len(parts) < 3 {
			continue
		}

		valueName := strings.TrimSpace(parts[0])
		valueData := strings.TrimSpace(parts[2])

		switch valueName {
		case "DisplayName":
			app.Name = valueData
		case "DisplayVersion":
			app.Version = valueData
		case "Publisher":
			app.Publisher = valueData
		case "InstallDate":
			app.InstallDate = valueData
		case "InstallLocation":
			app.InstallPath = valueData
		case "EstimatedSize":
			// Convert KB to bytes (EstimatedSize is in KB)
			// Parse as uint64 if valid
		}
	}

	return app, nil
}

// collectMacOS collects installed software from macOS
func (s *SoftwareCollector) collectMacOS() ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo
	var collectionErrors []string

	// Collect from /Applications
	apps, err := s.collectMacOSApplications()
	if err != nil {
		s.LogWarning("Failed to collect from /Applications", zap.Error(err))
		collectionErrors = append(collectionErrors, err.Error())
	} else {
		software = append(software, apps...)
	}

	// Collect from Homebrew
	brewApps, err := s.collectHomebrewPackages()
	if err != nil {
		s.LogWarning("Failed to collect Homebrew packages", zap.Error(err))
		collectionErrors = append(collectionErrors, err.Error())
	} else {
		software = append(software, brewApps...)
	}

	// Collect Homebrew casks
	caskApps, err := s.collectHomebrewCasks()
	if err != nil {
		s.LogWarning("Failed to collect Homebrew casks", zap.Error(err))
		// Don't add to errors, casks are optional
	} else {
		software = append(software, caskApps...)
	}

	if len(software) == 0 && len(collectionErrors) > 0 {
		return software, fmt.Errorf("failed to collect software: %v", collectionErrors)
	}

	return software, nil
}

// collectMacOSApplications scans the /Applications directory
func (s *SoftwareCollector) collectMacOSApplications() ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	applicationsDir := "/Applications"
	entries, err := os.ReadDir(applicationsDir)
	if err != nil {
		return software, fmt.Errorf("failed to read /Applications: %w", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasSuffix(entry.Name(), ".app") {
			continue
		}

		appName := strings.TrimSuffix(entry.Name(), ".app")
		appPath := filepath.Join(applicationsDir, entry.Name())

		app := models.SoftwareInfo{
			Name:        appName,
			InstallPath: appPath,
		}

		// Try to get version from Info.plist
		version, err := s.getMacOSAppVersion(appPath)
		if err == nil {
			app.Version = version
		}

		software = append(software, app)
	}

	return software, nil
}

// getMacOSAppVersion reads the version from an app's Info.plist
func (s *SoftwareCollector) getMacOSAppVersion(appPath string) (string, error) {
	// Use defaults to read the version from Info.plist
	plistPath := filepath.Join(appPath, "Contents", "Info.plist")

	// Try CFBundleShortVersionString first
	cmd := exec.Command("defaults", "read", plistPath, "CFBundleShortVersionString")
	output, err := cmd.Output()
	if err == nil {
		return strings.TrimSpace(string(output)), nil
	}

	// Fall back to CFBundleVersion
	cmd = exec.Command("defaults", "read", plistPath, "CFBundleVersion")
	output, err = cmd.Output()
	if err == nil {
		return strings.TrimSpace(string(output)), nil
	}

	return "", fmt.Errorf("could not read version from plist")
}

// collectHomebrewPackages collects packages installed via Homebrew
func (s *SoftwareCollector) collectHomebrewPackages() ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	// Check if brew is installed
	brewPath, err := exec.LookPath("brew")
	if err != nil {
		return software, fmt.Errorf("homebrew not installed")
	}

	// Get list of installed formulae with versions
	cmd := exec.Command(brewPath, "list", "--versions")
	output, err := cmd.Output()
	if err != nil {
		return software, fmt.Errorf("brew list failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}

		app := models.SoftwareInfo{
			Name:      parts[0],
			Version:   parts[len(parts)-1], // Latest version
			Publisher: "Homebrew",
		}

		software = append(software, app)
	}

	return software, nil
}

// collectHomebrewCasks collects cask applications installed via Homebrew
func (s *SoftwareCollector) collectHomebrewCasks() ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	brewPath, err := exec.LookPath("brew")
	if err != nil {
		return software, fmt.Errorf("homebrew not installed")
	}

	// Get list of installed casks with versions
	cmd := exec.Command(brewPath, "list", "--cask", "--versions")
	output, err := cmd.Output()
	if err != nil {
		return software, fmt.Errorf("brew list --cask failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}

		app := models.SoftwareInfo{
			Name:      parts[0],
			Version:   parts[len(parts)-1],
			Publisher: "Homebrew Cask",
		}

		software = append(software, app)
	}

	return software, nil
}

// collectLinux collects installed software from Linux systems
func (s *SoftwareCollector) collectLinux() ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo
	var collectionErrors []string

	// Try dpkg (Debian/Ubuntu)
	if dpkgPath, err := exec.LookPath("dpkg"); err == nil {
		apps, err := s.collectDpkgPackages(dpkgPath)
		if err != nil {
			s.LogWarning("Failed to collect dpkg packages", zap.Error(err))
			collectionErrors = append(collectionErrors, err.Error())
		} else {
			software = append(software, apps...)
		}
	}

	// Try rpm (RHEL/CentOS/Fedora)
	if rpmPath, err := exec.LookPath("rpm"); err == nil && len(software) == 0 {
		apps, err := s.collectRpmPackages(rpmPath)
		if err != nil {
			s.LogWarning("Failed to collect rpm packages", zap.Error(err))
			collectionErrors = append(collectionErrors, err.Error())
		} else {
			software = append(software, apps...)
		}
	}

	// Try pacman (Arch Linux)
	if pacmanPath, err := exec.LookPath("pacman"); err == nil && len(software) == 0 {
		apps, err := s.collectPacmanPackages(pacmanPath)
		if err != nil {
			s.LogWarning("Failed to collect pacman packages", zap.Error(err))
			collectionErrors = append(collectionErrors, err.Error())
		} else {
			software = append(software, apps...)
		}
	}

	// Also try snap if available
	if snapPath, err := exec.LookPath("snap"); err == nil {
		apps, err := s.collectSnapPackages(snapPath)
		if err != nil {
			s.LogWarning("Failed to collect snap packages", zap.Error(err))
		} else {
			software = append(software, apps...)
		}
	}

	// Also try flatpak if available
	if flatpakPath, err := exec.LookPath("flatpak"); err == nil {
		apps, err := s.collectFlatpakPackages(flatpakPath)
		if err != nil {
			s.LogWarning("Failed to collect flatpak packages", zap.Error(err))
		} else {
			software = append(software, apps...)
		}
	}

	if len(software) == 0 {
		return software, fmt.Errorf("no package manager found or all failed: %v", collectionErrors)
	}

	return software, nil
}

// collectDpkgPackages collects packages from dpkg (Debian/Ubuntu)
func (s *SoftwareCollector) collectDpkgPackages(dpkgPath string) ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	// dpkg-query with custom format
	cmd := exec.Command(dpkgPath+"-query", "-W", "-f=${Package}|${Version}|${Installed-Size}\n")
	output, err := cmd.Output()
	if err != nil {
		return software, fmt.Errorf("dpkg-query failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) < 2 {
			continue
		}

		app := models.SoftwareInfo{
			Name:      parts[0],
			Version:   parts[1],
			Publisher: "dpkg",
		}

		// Installed-Size is in KB
		if len(parts) >= 3 && parts[2] != "" {
			var sizeKB uint64
			if _, err := fmt.Sscanf(parts[2], "%d", &sizeKB); err == nil {
				app.Size = sizeKB * 1024 // Convert to bytes
			}
		}

		software = append(software, app)
	}

	return software, nil
}

// collectRpmPackages collects packages from rpm (RHEL/CentOS/Fedora)
func (s *SoftwareCollector) collectRpmPackages(rpmPath string) ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	// rpm query with custom format
	cmd := exec.Command(rpmPath, "-qa", "--queryformat", "%{NAME}|%{VERSION}|%{VENDOR}|%{SIZE}\n")
	output, err := cmd.Output()
	if err != nil {
		return software, fmt.Errorf("rpm query failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) < 2 {
			continue
		}

		app := models.SoftwareInfo{
			Name:    parts[0],
			Version: parts[1],
		}

		if len(parts) >= 3 && parts[2] != "(none)" {
			app.Publisher = parts[2]
		}

		if len(parts) >= 4 {
			var size uint64
			if _, err := fmt.Sscanf(parts[3], "%d", &size); err == nil {
				app.Size = size
			}
		}

		software = append(software, app)
	}

	return software, nil
}

// collectPacmanPackages collects packages from pacman (Arch Linux)
func (s *SoftwareCollector) collectPacmanPackages(pacmanPath string) ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	// pacman query for explicitly installed packages
	cmd := exec.Command(pacmanPath, "-Q")
	output, err := cmd.Output()
	if err != nil {
		return software, fmt.Errorf("pacman query failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}

		app := models.SoftwareInfo{
			Name:      parts[0],
			Version:   parts[1],
			Publisher: "pacman",
		}

		software = append(software, app)
	}

	return software, nil
}

// collectSnapPackages collects packages installed via Snap
func (s *SoftwareCollector) collectSnapPackages(snapPath string) ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	cmd := exec.Command(snapPath, "list")
	output, err := cmd.Output()
	if err != nil {
		return software, fmt.Errorf("snap list failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		if lineNum == 1 {
			continue // Skip header line
		}

		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}

		app := models.SoftwareInfo{
			Name:      parts[0],
			Version:   parts[1],
			Publisher: "Snap",
		}

		software = append(software, app)
	}

	return software, nil
}

// collectFlatpakPackages collects packages installed via Flatpak
func (s *SoftwareCollector) collectFlatpakPackages(flatpakPath string) ([]models.SoftwareInfo, error) {
	var software []models.SoftwareInfo

	cmd := exec.Command(flatpakPath, "list", "--columns=name,version")
	output, err := cmd.Output()
	if err != nil {
		return software, fmt.Errorf("flatpak list failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		// Flatpak output is tab-separated
		parts := strings.Split(line, "\t")
		if len(parts) < 1 {
			continue
		}

		app := models.SoftwareInfo{
			Name:      parts[0],
			Publisher: "Flatpak",
		}

		if len(parts) >= 2 {
			app.Version = parts[1]
		}

		software = append(software, app)
	}

	return software, nil
}

// deduplicateSoftware removes duplicate software entries based on name and version
func (s *SoftwareCollector) deduplicateSoftware(software []models.SoftwareInfo) []models.SoftwareInfo {
	seen := make(map[string]bool)
	var result []models.SoftwareInfo

	for _, app := range software {
		key := app.Name + "|" + app.Version
		if !seen[key] {
			seen[key] = true
			result = append(result, app)
		}
	}

	return result
}
