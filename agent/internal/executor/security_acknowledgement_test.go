package executor

import (
	"runtime"
	"strings"
	"testing"
)

// #5129. Strict-level patterns are acknowledgeable per script: the server
// dispatches the SET OF PATTERN DESCRIPTIONS an admin signed off on, and the
// validator allows exactly those. Basic-level patterns are never
// acknowledgeable, and an absent or empty set must behave exactly as the agent
// did before this existed (fail closed), so an old API talking to a new agent
// cannot silently loosen anything.

const (
	hklmScript      = `Set-ItemProperty -Path 'HKLM:\SOFTWARE\Contoso' -Name Enabled -Value 1`
	hklmDescription = "PowerShell HKLM modification"

	schtasksScript      = `schtasks /create /tn Nightly /tr C:\x.exe /sc daily`
	schtasksDescription = "scheduled task creation"

	// Basic level: an unconditional hard block with no override path.
	forkBombScript      = `:(){ :|:& };:`
	forkBombDescription = "fork bomb pattern"

	formatVolumeScript      = `Format-Volume -DriveLetter D`
	formatVolumeDescription = "PowerShell volume format"
)

func TestValidateWithAcknowledgements(t *testing.T) {
	validator := NewSecurityValidator(SecurityLevelStrict)

	tests := []struct {
		name string
		// content is the (already parameter-substituted) script body.
		content string
		// acknowledged is the set dispatched by the server.
		acknowledged []string
		// wantBlockedBy is the pattern description the validator must refuse
		// on, or "" when the script must be allowed to run.
		wantBlockedBy string
		// wantAcknowledgeable asserts whether the refusal offers the
		// acknowledge-it remediation (Strict) or states the block is absolute
		// (Basic).
		wantAcknowledgeable bool
	}{
		{
			name:          "strict pattern blocked when nothing is acknowledged",
			content:       hklmScript,
			acknowledged:  nil,
			wantBlockedBy: hklmDescription,

			wantAcknowledgeable: true,
		},
		{
			name:          "strict pattern blocked when the set is empty",
			content:       hklmScript,
			acknowledged:  []string{},
			wantBlockedBy: hklmDescription,

			wantAcknowledgeable: true,
		},
		{
			name:          "strict pattern allowed when its description is acknowledged",
			content:       hklmScript,
			acknowledged:  []string{hklmDescription},
			wantBlockedBy: "",
		},
		{
			name:          "acknowledging one strict pattern does not permit another",
			content:       schtasksScript,
			acknowledged:  []string{hklmDescription},
			wantBlockedBy: schtasksDescription,

			wantAcknowledgeable: true,
		},
		{
			name:          "a script matching two strict patterns needs both acknowledged",
			content:       hklmScript + "\n" + schtasksScript,
			acknowledged:  []string{hklmDescription},
			wantBlockedBy: schtasksDescription,

			wantAcknowledgeable: true,
		},
		{
			name:          "a script matching two strict patterns runs when both are acknowledged",
			content:       hklmScript + "\n" + schtasksScript,
			acknowledged:  []string{hklmDescription, schtasksDescription},
			wantBlockedBy: "",
		},
		{
			name:          "basic pattern blocked even when its description is acknowledged",
			content:       forkBombScript,
			acknowledged:  []string{forkBombDescription},
			wantBlockedBy: forkBombDescription,

			wantAcknowledgeable: false,
		},
		{
			name:          "basic volume format blocked even when acknowledged",
			content:       formatVolumeScript,
			acknowledged:  []string{formatVolumeDescription},
			wantBlockedBy: formatVolumeDescription,

			wantAcknowledgeable: false,
		},
		{
			name:    "basic pattern wins over an acknowledged strict pattern in the same script",
			content: hklmScript + "\n" + forkBombScript,
			// Every strict description acknowledged; the basic one still wins.
			acknowledged:  []string{hklmDescription, forkBombDescription},
			wantBlockedBy: forkBombDescription,

			wantAcknowledgeable: false,
		},
		{
			name:          "an unknown acknowledgement grants nothing",
			content:       hklmScript,
			acknowledged:  []string{"not a real pattern description", ""},
			wantBlockedBy: hklmDescription,

			wantAcknowledgeable: true,
		},
		{
			name:          "surrounding whitespace on an acknowledgement is tolerated",
			content:       hklmScript,
			acknowledged:  []string{"  " + hklmDescription + "\n"},
			wantBlockedBy: "",
		},
		{
			name:          "acknowledgement is case sensitive",
			content:       hklmScript,
			acknowledged:  []string{strings.ToUpper(hklmDescription)},
			wantBlockedBy: hklmDescription,

			wantAcknowledgeable: true,
		},
		{
			name:          "benign script runs with no acknowledgements",
			content:       `Write-Output "hello"`,
			acknowledged:  nil,
			wantBlockedBy: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validator.ValidateWithAcknowledgements(tc.content, tc.acknowledged)

			if tc.wantBlockedBy == "" {
				if err != nil {
					t.Fatalf("expected the script to be allowed, got error: %v", err)
				}
				return
			}

			if err == nil {
				t.Fatalf("expected a block on %q, got nil", tc.wantBlockedBy)
			}
			if !strings.Contains(err.Error(), tc.wantBlockedBy) {
				t.Fatalf("error %q does not name the blocking pattern %q", err, tc.wantBlockedBy)
			}

			// #5129: the message must tell the operator what to do next. The
			// original text named the pattern and stopped, which is what
			// generated the support question this issue came from.
			mentionsAcknowledge := strings.Contains(strings.ToLower(err.Error()), "acknowledge")
			if mentionsAcknowledge != tc.wantAcknowledgeable {
				t.Fatalf("acknowledge-remediation present = %v, want %v; message: %q",
					mentionsAcknowledge, tc.wantAcknowledgeable, err)
			}
			if !tc.wantAcknowledgeable && !strings.Contains(err.Error(), "cannot be overridden") {
				t.Fatalf("a basic-level block must say it cannot be overridden; message: %q", err)
			}
		})
	}
}

// The pre-#5129 entry point must keep behaving exactly as it did — it is what
// every caller that has no acknowledgement set still uses.
func TestValidateIsUnchangedByAcknowledgementSupport(t *testing.T) {
	validator := NewSecurityValidator(SecurityLevelStrict)

	if err := validator.Validate(hklmScript); err == nil {
		t.Fatal("Validate must still block an unacknowledged strict pattern")
	}
	if err := validator.Validate(`Write-Output "hello"`); err != nil {
		t.Fatalf("Validate must still allow a benign script, got: %v", err)
	}
}

// SecurityLevelNone still disables everything, acknowledgements or not.
func TestValidateWithAcknowledgementsHonoursLevelNone(t *testing.T) {
	validator := NewSecurityValidator(SecurityLevelNone)
	if err := validator.ValidateWithAcknowledgements(forkBombScript, nil); err != nil {
		t.Fatalf("SecurityLevelNone must validate nothing, got: %v", err)
	}
}

// A SecurityLevelBasic validator never even consults the strict patterns, so
// an acknowledgement cannot make it stricter or looser.
func TestValidateWithAcknowledgementsAtBasicLevel(t *testing.T) {
	validator := NewSecurityValidator(SecurityLevelBasic)

	if err := validator.ValidateWithAcknowledgements(hklmScript, nil); err != nil {
		t.Fatalf("basic level must ignore strict patterns, got: %v", err)
	}
	if err := validator.ValidateWithAcknowledgements(forkBombScript, []string{forkBombDescription}); err == nil {
		t.Fatal("basic level must still block a basic pattern despite an acknowledgement")
	}
}

// Executor.Execute is the real caller. It must thread the acknowledgement set
// from the dispatched ScriptExecution into validation, and refuse a strict
// pattern that was not acknowledged.
func TestExecuteHonoursAcknowledgedSecurityPatterns(t *testing.T) {
	tests := []struct {
		name         string
		acknowledged []string
		wantRefusal  bool
	}{
		{name: "unacknowledged strict pattern is refused", acknowledged: nil, wantRefusal: true},
		{name: "acknowledged strict pattern is not refused", acknowledged: []string{hklmDescription}, wantRefusal: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := newTestExecutor()
			// Execute() checks platform availability BEFORE validating, so
			// the script type has to be one this platform actually supports.
			// The validator itself is language-agnostic — it pattern-matches
			// the content — so the HKLM line is a valid probe either way. On a
			// unix runner the acknowledged case then really runs and fails as
			// "command not found", which is fine: the contract under test is
			// whether a VALIDATION refusal happened, and that is
			// distinguishable by its message.
			scriptType := "bash"
			if runtime.GOOS == "windows" {
				scriptType = "powershell"
			}
			result, _ := e.Execute(ScriptExecution{
				ID:                           "exec-" + tc.name,
				ScriptType:                   scriptType,
				Script:                       hklmScript,
				AcknowledgedSecurityPatterns: tc.acknowledged,
				Timeout:                      5,
			})
			if result == nil {
				t.Fatal("expected a result")
			}
			refused := strings.Contains(result.Error, "script validation failed")
			if refused != tc.wantRefusal {
				t.Fatalf("validation refusal = %v, want %v; error was %q", refused, tc.wantRefusal, result.Error)
			}
			if tc.wantRefusal && !strings.Contains(result.Error, hklmDescription) {
				t.Fatalf("refusal must name the pattern; got %q", result.Error)
			}
		})
	}
}
