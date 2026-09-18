package executor

import "testing"

func TestRenderCMDContexts(t *testing.T) {
	p := map[string]string{"p": "a & echo pwned"}
	runRenderCases(t, ScriptTypeCMD, []renderCase{
		{
			name:   "placeholder becomes a delayed-expansion reference",
			script: `echo {{p}}`,
			params: p,
			want:   `echo !BREEZE_PARAM_P!`,
		},
		{
			name:   "dollar form is consumed whole",
			script: `echo ${{p}}`,
			params: p,
			want:   `echo !BREEZE_PARAM_P!`,
		},
		{
			name:   "quoted argument is the same reference",
			script: `echo "v={{p}}"`,
			params: p,
			want:   `echo "v=!BREEZE_PARAM_P!"`,
		},
		{
			name:          "unknown key is left as written",
			script:        `echo {{nope}}`,
			params:        p,
			want:          `echo {{nope}}`,
			wantUntouched: true,
		},
		{
			name:        "values with line breaks are rejected",
			script:      `echo {{p}}`,
			params:      map[string]string{"p": "a\r\nb"},
			wantErr:     true,
			errContains: "line break",
		},
		{
			name:        "call statements are rejected",
			script:      `call :label {{p}}`,
			params:      p,
			wantErr:     true,
			errContains: "call",
		},
		{
			name:        "for /f clauses are rejected",
			script:      `for /f "tokens=*" %%i in ('{{p}}') do echo %%i`,
			params:      p,
			wantErr:     true,
			errContains: "for /f",
		},
		{
			name:   "a for body outside the in-clause is fine",
			script: "for /f \"tokens=*\" %%i in ('dir /b') do echo %%i {{p}}",
			params: p,
			want:   "for /f \"tokens=*\" %%i in ('dir /b') do echo %%i !BREEZE_PARAM_P!",
		},
	})
}

// TestWithDelayedExpansion pins the interpreter flag that makes the rendered
// `!BREEZE_PARAM_X!` references expand at all. Without /V:ON a rendered cmd
// script would echo the reference text verbatim.
func TestWithDelayedExpansion(t *testing.T) {
	tests := []struct {
		name       string
		scriptType string
		rendered   bool
		in         []string
		want       []string
	}{
		{name: "rendered cmd gets /V:ON before /C", scriptType: ScriptTypeCMD, rendered: true, in: []string{"/C"}, want: []string{"/V:ON", "/C"}},
		{name: "case-insensitive script type", scriptType: "CMD", rendered: true, in: []string{"/C"}, want: []string{"/V:ON", "/C"}},
		{name: "cmd without placeholders is untouched", scriptType: ScriptTypeCMD, rendered: false, in: []string{"/C"}, want: []string{"/C"}},
		{name: "bash is untouched", scriptType: ScriptTypeBash, rendered: true, in: []string{}, want: []string{}},
		{name: "powershell is untouched", scriptType: ScriptTypePowerShell, rendered: true, in: []string{"-File"}, want: []string{"-File"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := withDelayedExpansion(tt.in, tt.scriptType, tt.rendered)
			if len(got) != len(tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("got %v, want %v", got, tt.want)
				}
			}
		})
	}
}
