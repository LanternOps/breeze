//go:build windows

package userhelper

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/ipc"
)

var pamDialogUser32 = syscall.NewLazyDLL("user32.dll")
var procMessageBoxW = pamDialogUser32.NewProc("MessageBoxW")

const (
	mbYesNo         = 0x00000004
	mbIconWarning   = 0x00000030
	mbSystemModal   = 0x00001000
	mbSetForeground = 0x00010000
	mbTopMost       = 0x00040000

	idYes = 6
)

func showPamDialog(req ipc.PamRequestDialog) ipc.PamDialogResult {
	title := syscall.StringToUTF16Ptr("Breeze — Elevation Request")
	body := syscall.StringToUTF16Ptr(buildPamDialogBody(req))
	flags := uintptr(mbYesNo | mbIconWarning | mbTopMost | mbSystemModal | mbSetForeground)

	ret, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), flags)
	if ret == idYes {
		return ipc.PamDialogResult{Approved: true}
	}
	return ipc.PamDialogResult{Approved: false, DismissedByUser: true}
}

func buildPamDialogBody(req ipc.PamRequestDialog) string {
	lines := []string{
		"Breeze detected an elevation request.",
		"",
		fmt.Sprintf("Program: %s", pamDialogValue(req.ExePath)),
		fmt.Sprintf("Signer: %s", pamDialogValue(req.Signer)),
		fmt.Sprintf("User: %s", pamDialogValue(req.SubjectUser)),
	}
	if req.Reason != "" {
		lines = append(lines, fmt.Sprintf("Reason: %s", pamDialogValue(req.Reason)))
	}
	if req.IntentSummary != "" {
		lines = append(lines, fmt.Sprintf("Intent: %s", pamDialogValue(req.IntentSummary)))
	}
	lines = append(lines, "", "Approve this elevation request?")
	return strings.Join(lines, "\r\n")
}

func pamDialogValue(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", " "))
	if value == "" {
		return "Unknown"
	}
	return value
}
