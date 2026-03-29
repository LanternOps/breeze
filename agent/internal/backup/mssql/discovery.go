//go:build windows

package mssql

import (
	"fmt"
	"log/slog"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

// DiscoverInstances finds SQL Server instances on the local machine using
// three complementary discovery methods:
//  1. Registry scan (HKLM\SOFTWARE\Microsoft\Microsoft SQL Server)
//  2. Windows service enumeration (services named MSSQL$* / MSSQLSERVER)
//  3. SQL Browser UDP probe (port 1434)
//
// Results from all methods are merged and deduplicated by instance name.
func DiscoverInstances() ([]SQLInstance, error) {
	seen := map[string]*SQLInstance{}

	// 1. Registry-based discovery
	regInstances, err := discoverFromRegistry()
	if err != nil {
		slog.Warn("mssql registry discovery failed", "error", err.Error())
	}
	for i := range regInstances {
		inst := &regInstances[i]
		seen[strings.ToUpper(inst.Name)] = inst
	}

	// 2. Service-based discovery
	svcInstances, err := discoverFromServices()
	if err != nil {
		slog.Warn("mssql service discovery failed", "error", err.Error())
	}
	for i := range svcInstances {
		inst := &svcInstances[i]
		key := strings.ToUpper(inst.Name)
		if _, ok := seen[key]; !ok {
			seen[key] = inst
		} else if seen[key].Status == "unknown" && inst.Status != "unknown" {
			seen[key].Status = inst.Status
		}
	}

	// 3. SQL Browser UDP probe
	browserInstances, err := discoverFromBrowser()
	if err != nil {
		slog.Warn("mssql browser discovery failed", "error", err.Error())
	}
	for i := range browserInstances {
		inst := &browserInstances[i]
		key := strings.ToUpper(inst.Name)
		if existing, ok := seen[key]; !ok {
			seen[key] = inst
		} else {
			// Merge port if missing
			if existing.Port == 0 && inst.Port != 0 {
				existing.Port = inst.Port
			}
			if existing.Version == "" && inst.Version != "" {
				existing.Version = inst.Version
			}
		}
	}

	// Enrich instances with database info via sqlcmd
	result := make([]SQLInstance, 0, len(seen))
	for _, inst := range seen {
		enrichInstance(inst)
		result = append(result, *inst)
	}

	return result, nil
}

// discoverFromRegistry reads the SQL Server Instance Names registry key.
func discoverFromRegistry() ([]SQLInstance, error) {
	key, err := registry.OpenKey(
		registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL`,
		registry.READ|registry.WOW64_64KEY,
	)
	if err != nil {
		return nil, fmt.Errorf("open registry key: %w", err)
	}
	defer key.Close()

	names, err := key.ReadValueNames(0)
	if err != nil {
		return nil, fmt.Errorf("read value names: %w", err)
	}

	var instances []SQLInstance
	for _, name := range names {
		inst := SQLInstance{
			Name:     name,
			Status:   "unknown",
			AuthType: "windows",
		}

		// Try to read version from the instance-specific key
		internalName, _, _ := key.GetStringValue(name)
		if internalName != "" {
			verKey, verErr := registry.OpenKey(
				registry.LOCAL_MACHINE,
				fmt.Sprintf(`SOFTWARE\Microsoft\Microsoft SQL Server\%s\MSSQLServer\CurrentVersion`, internalName),
				registry.READ|registry.WOW64_64KEY,
			)
			if verErr == nil {
				ver, _, _ := verKey.GetStringValue("CurrentVersion")
				inst.Version = ver
				verKey.Close()
			}
		}

		instances = append(instances, inst)
	}

	return instances, nil
}

// discoverFromServices looks for SQL Server Windows services.
func discoverFromServices() ([]SQLInstance, error) {
	out, err := exec.Command("sc", "query", "type=", "service", "state=", "all").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("sc query: %w", err)
	}

	var instances []SQLInstance
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "SERVICE_NAME:") {
			continue
		}
		svcName := strings.TrimSpace(strings.TrimPrefix(line, "SERVICE_NAME:"))
		svcNameUpper := strings.ToUpper(svcName)

		var instName string
		if svcNameUpper == "MSSQLSERVER" {
			instName = "MSSQLSERVER"
		} else if strings.HasPrefix(svcNameUpper, "MSSQL$") {
			instName = strings.TrimPrefix(svcNameUpper, "MSSQL$")
		} else {
			continue
		}

		status := "unknown"
		// Check if the service is running
		checkOut, checkErr := exec.Command("sc", "query", svcName).CombinedOutput()
		if checkErr == nil {
			checkStr := string(checkOut)
			if strings.Contains(checkStr, "RUNNING") {
				status = "online"
			} else if strings.Contains(checkStr, "STOPPED") {
				status = "offline"
			}
		}

		instances = append(instances, SQLInstance{
			Name:     instName,
			Status:   status,
			AuthType: "windows",
		})
	}

	return instances, nil
}

// discoverFromBrowser sends a UDP probe to the SQL Browser service on port 1434.
func discoverFromBrowser() ([]SQLInstance, error) {
	conn, err := net.DialTimeout("udp", "127.0.0.1:1434", 2*time.Second)
	if err != nil {
		return nil, fmt.Errorf("dial sql browser: %w", err)
	}
	defer conn.Close()

	// Send probe byte 0x02 (enumerate instances)
	if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		return nil, fmt.Errorf("set deadline: %w", err)
	}
	if _, err := conn.Write([]byte{0x02}); err != nil {
		return nil, fmt.Errorf("write probe: %w", err)
	}

	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	return parseBrowserResponse(buf[:n]), nil
}

// parseBrowserResponse parses the SQL Browser UDP response into instances.
// Response format: 0x05 0xNN followed by semicolon-delimited key=value pairs.
func parseBrowserResponse(data []byte) []SQLInstance {
	if len(data) < 3 || data[0] != 0x05 {
		return nil
	}

	// Skip header bytes (0x05 + 2 byte length)
	payload := string(data[3:])
	blocks := strings.Split(payload, ";;")

	var instances []SQLInstance
	for _, block := range blocks {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		parts := strings.Split(block, ";")
		kv := map[string]string{}
		for i := 0; i+1 < len(parts); i += 2 {
			kv[strings.ToLower(parts[i])] = parts[i+1]
		}

		inst := SQLInstance{
			Name:     kv["instancename"],
			Version:  kv["version"],
			AuthType: "windows",
			Status:   "online", // Browser only reports running instances
		}
		if port, parseErr := strconv.Atoi(kv["tcp"]); parseErr == nil {
			inst.Port = port
		}
		if inst.Name != "" {
			instances = append(instances, inst)
		}
	}

	return instances
}

// enrichInstance queries the instance via sqlcmd for edition and database list.
func enrichInstance(inst *SQLInstance) {
	serverName := buildServerName(inst.Name)

	// Get edition
	editionOut, err := runSqlcmd(serverName, "SELECT SERVERPROPERTY('Edition')")
	if err != nil {
		slog.Debug("mssql enrichInstance edition query failed", "instance", inst.Name, "error", err.Error())
		return
	}
	inst.Edition = strings.TrimSpace(parseSqlcmdSingleValue(editionOut))

	// Get databases
	dbQuery := `SELECT d.name,
		CAST(SUM(mf.size) * 8 / 1024 AS BIGINT) AS size_mb,
		d.recovery_model_desc,
		CAST(CASE WHEN dek.encryption_state IS NOT NULL AND dek.encryption_state = 3 THEN 1 ELSE 0 END AS INT) AS tde_enabled,
		d.compatibility_level
	FROM sys.databases d
	LEFT JOIN sys.master_files mf ON d.database_id = mf.database_id
	LEFT JOIN sys.dm_database_encryption_keys dek ON d.database_id = dek.database_id
	WHERE d.name NOT IN ('master','tempdb','model','msdb')
	GROUP BY d.name, d.recovery_model_desc, dek.encryption_state, d.compatibility_level`

	dbOut, err := runSqlcmd(serverName, dbQuery)
	if err != nil {
		slog.Debug("mssql enrichInstance db query failed", "instance", inst.Name, "error", err.Error())
		return
	}

	inst.Databases = parseDatabaseList(dbOut)
}

// buildServerName constructs the -S parameter for sqlcmd.
func buildServerName(instanceName string) string {
	if strings.ToUpper(instanceName) == "MSSQLSERVER" {
		return "."
	}
	return `.\` + instanceName
}

// runSqlcmd executes a T-SQL query via sqlcmd and returns the output.
func runSqlcmd(serverName, query string) (string, error) {
	sqlcmdPath, err := findSqlcmd()
	if err != nil {
		return "", err
	}

	cmd := exec.Command(sqlcmdPath, "-S", serverName, "-E", "-Q", query, "-W", "-h", "-1", "-s", "|")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("sqlcmd: %w: %s", err, string(out))
	}

	return string(out), nil
}

// findSqlcmd locates sqlcmd.exe on PATH or in known install directories.
func findSqlcmd() (string, error) {
	// Try PATH first
	if path, err := exec.LookPath("sqlcmd.exe"); err == nil {
		return path, nil
	}

	// Common install locations
	knownPaths := []string{
		`C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE`,
		`C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\130\Tools\Binn\SQLCMD.EXE`,
		`C:\Program Files\Microsoft SQL Server\110\Tools\Binn\SQLCMD.EXE`,
		`C:\Program Files\Microsoft SQL Server\150\Tools\Binn\SQLCMD.EXE`,
		`C:\Program Files\Microsoft SQL Server\160\Tools\Binn\SQLCMD.EXE`,
	}
	for _, p := range knownPaths {
		if _, statErr := exec.LookPath(p); statErr == nil {
			return p, nil
		}
	}

	return "", ErrSqlcmdNotFound
}

// parseSqlcmdSingleValue extracts the first non-empty line from sqlcmd output.
func parseSqlcmdSingleValue(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "(") {
			return line
		}
	}
	return ""
}

// parseDatabaseList parses the tabular output of the database query.
func parseDatabaseList(output string) []SQLDatabase {
	var dbs []SQLDatabase
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-") || strings.HasPrefix(line, "(") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 5 {
			continue
		}

		sizeMB, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		tde := strings.TrimSpace(parts[3]) == "1"
		compat, _ := strconv.Atoi(strings.TrimSpace(parts[4]))

		dbs = append(dbs, SQLDatabase{
			Name:          strings.TrimSpace(parts[0]),
			SizeMB:        sizeMB,
			RecoveryModel: strings.TrimSpace(parts[2]),
			TDEEnabled:    tde,
			CompatLevel:   compat,
		})
	}
	return dbs
}
