package security

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

type wscProductRaw struct {
	DisplayName              string `json:"displayName"`
	ProductState             any    `json:"productState"`
	PathToSignedProductExe   string `json:"pathToSignedProductExe"`
	PathToSignedReportingExe string `json:"pathToSignedReportingExe"`
	Timestamp                string `json:"timestamp"`
	InstanceGUID             string `json:"instanceGuid"`
}

// wscQueryPS lists the AV products registered with Windows Security Center.
const wscQueryPS = "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName,productState,pathToSignedProductExe,pathToSignedReportingExe,timestamp,instanceGuid | ConvertTo-Json -Compress"

// runWSCQuery runs the Security Center query. It is the only spawn path for
// it, so tests can count spawns.
var runWSCQuery = func() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := procspawn.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", wscQueryPS)
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("wsc query timed out")
	}
	if err != nil {
		return "", fmt.Errorf("wsc query failed: %w", err)
	}
	return string(output), nil
}

// GetWindowsSecurityCenterProducts returns AV providers from root/SecurityCenter2.
// It returns ErrNotSupported off Windows and on Windows Server, where the
// root/SecurityCenter2 namespace does not exist (#10907); the status collector
// then relies on the Defender probe alone.
func GetWindowsSecurityCenterProducts() ([]AVProduct, error) {
	return getWindowsSecurityCenterProductsFor(runtime.GOOS)
}

func getWindowsSecurityCenterProductsFor(goos string) ([]AVProduct, error) {
	if goos != "windows" || hostIsWindowsServer() {
		return nil, ErrNotSupported
	}

	output, err := runWSCQuery()
	if err != nil {
		return nil, err
	}

	payload := strings.TrimSpace(output)
	if payload == "" || payload == "null" {
		return nil, nil
	}

	var raws []wscProductRaw
	if strings.HasPrefix(payload, "[") {
		if err := json.Unmarshal([]byte(payload), &raws); err != nil {
			return nil, fmt.Errorf("failed to parse WSC product list: %w", err)
		}
	} else {
		var single wscProductRaw
		if err := json.Unmarshal([]byte(payload), &single); err != nil {
			return nil, fmt.Errorf("failed to parse WSC product: %w", err)
		}
		raws = []wscProductRaw{single}
	}

	products := make([]AVProduct, 0, len(raws))
	for _, raw := range raws {
		state := parseAnyInt(raw.ProductState)
		realTime, defsCurrent := parseWSCProductState(state)
		product := AVProduct{
			DisplayName:          strings.TrimSpace(raw.DisplayName),
			Provider:             providerFromName(raw.DisplayName),
			ProductState:         state,
			ProductStateHex:      fmt.Sprintf("0x%06X", state),
			Registered:           strings.TrimSpace(raw.DisplayName) != "",
			RealTimeProtection:   realTime,
			DefinitionsUpToDate:  defsCurrent,
			PathToSignedProduct:  strings.TrimSpace(raw.PathToSignedProductExe),
			PathToSignedReporter: strings.TrimSpace(raw.PathToSignedReportingExe),
			Timestamp:            strings.TrimSpace(raw.Timestamp),
			InstanceGUID:         strings.TrimSpace(raw.InstanceGUID),
		}
		products = append(products, product)
	}

	return products, nil
}

func parseAnyInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int32:
		return int(typed)
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0
		}
		if parsed, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
			return int(parsed)
		}
		if parsed, err := strconv.ParseInt(strings.TrimPrefix(trimmed, "0x"), 16, 64); err == nil {
			return int(parsed)
		}
	}
	return 0
}

// Product state appears as a 3-byte hex value: provider/state/signature.
func parseWSCProductState(state int) (realTimeProtection bool, definitionsUpToDate bool) {
	hexState := fmt.Sprintf("%06x", state)
	if len(hexState) < 6 {
		return false, false
	}

	stateByte := hexState[2:4]
	signatureByte := hexState[4:6]

	realTimeProtection = stateByte == "10" || stateByte == "11"
	definitionsUpToDate = signatureByte == "00"
	return realTimeProtection, definitionsUpToDate
}
