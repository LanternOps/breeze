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
		{
			// `call` only re-parses ITS OWN statement, so an earlier call on the
			// same line must not condemn a later statement.
			name:   "a statement after a call is not a call",
			script: `call foo & echo {{p}}`,
			params: p,
			want:   `call foo & echo !BREEZE_PARAM_P!`,
		},
		{
			name:   "a piped statement after a call is not a call",
			script: `call foo | findstr {{p}}`,
			params: p,
			want:   `call foo | findstr !BREEZE_PARAM_P!`,
		},
		{
			name:   "a parenthesised block after a call is not a call",
			script: `call foo & if exist x ( echo {{p}} )`,
			params: p,
			want:   `call foo & if exist x ( echo !BREEZE_PARAM_P! )`,
		},
		{
			name:        "an if-prefixed call is still rejected",
			script:      `if exist x call y {{p}}`,
			params:      p,
			wantErr:     true,
			errContains: "call",
		},
		{
			name:        "a call after an earlier statement is still rejected",
			script:      `echo start & call y {{p}}`,
			params:      p,
			wantErr:     true,
			errContains: "call",
		},

		// A caret escapes the next character, so `^&` is a literal ampersand
		// passed to the command — NOT a statement separator. Splitting on it
		// hid the `call` that still re-parses the whole line.
		{
			name:        "a caret-escaped ampersand does not end the call statement",
			script:      `call x ^& echo {{p}}`,
			params:      p,
			wantErr:     true,
			errContains: "call",
		},
		{
			name:        "a caret-escaped pipe does not end the call statement",
			script:      `call x ^| echo {{p}}`,
			params:      p,
			wantErr:     true,
			errContains: "call",
		},
		{
			name:        "a caret-escaped open paren does not end the call statement",
			script:      `call x ^( echo {{p}}`,
			params:      p,
			wantErr:     true,
			errContains: "call",
		},
		{
			name:        "a caret-escaped close paren does not end the call statement",
			script:      `call x ^) echo {{p}}`,
			params:      p,
			wantErr:     true,
			errContains: "call",
		},

		// A trailing caret escapes the newline, so cmd parses the continued
		// physical lines as ONE logical line. Line-scoped guards missed both.
		{
			name:        "a caret continuation keeps the call statement",
			script:      "call ^\nfoo {{p}}\n",
			params:      p,
			wantErr:     true,
			errContains: "call",
		},
		{
			name:        "a CRLF caret continuation keeps the call statement",
			script:      "call ^\r\nfoo {{p}}\r\n",
			params:      p,
			wantErr:     true,
			errContains: "call",
		},
		{
			name:        "a caret continuation keeps the for /f in-clause",
			script:      "for /f \"tokens=*\" %%a in (^\n'echo {{p}}'^\n) do @echo %%a\n",
			params:      p,
			wantErr:     true,
			errContains: "for /f",
		},
		// The in-clause scan has to be quote- and caret-aware, exactly like the
		// statement scan: a `)` that cmd does NOT read as the end of the clause
		// — one escaped with a caret, or one inside the clause's own quoted
		// command string — used to end the guard's view of the clause and let
		// the value render into a region cmd parses as a command.
		{
			name:        "a caret-escaped paren does not end the for /f in-clause",
			script:      `for /f "tokens=*" %%a in ('echo ^) {{p}}') do @echo %%a`,
			params:      p,
			wantErr:     true,
			errContains: "for /f",
		},
		{
			name:        "a quoted paren does not end the for /f in-clause",
			script:      `for /f "tokens=*" %%a in ('echo )' {{p}}) do @echo %%a`,
			params:      p,
			wantErr:     true,
			errContains: "for /f",
		},
		{
			name:        "a double-quoted paren does not end the for /f in-clause",
			script:      `for /f %%a in ("a)b" {{p}}) do @echo %%a`,
			params:      p,
			wantErr:     true,
			errContains: "for /f",
		},
		{
			name:        "a nested paren does not end the for /f in-clause",
			script:      `for /f %%a in ((a) {{p}}) do @echo %%a`,
			params:      p,
			wantErr:     true,
			errContains: "for /f",
		},
		{
			// Positive control: the clause really does close, so the body is
			// not condemned by the quote- and caret-aware scan either.
			name:   "a body after a clause holding a quoted paren is fine",
			script: `for /f "tokens=*" %%a in ('echo )') do @echo %%a {{p}}`,
			params: p,
			want:   `for /f "tokens=*" %%a in ('echo )') do @echo %%a !BREEZE_PARAM_P!`,
		},
		{
			name:   "a for-in set with no in-clause does not condemn the line",
			script: `for %%a in (1 2) do @echo %%a {{p}}`,
			params: p,
			want:   `for %%a in (1 2) do @echo %%a !BREEZE_PARAM_P!`,
		},
		{
			name:   "the word in outside a for statement is not an in-clause",
			script: `echo in (x) {{p}}`,
			params: p,
			want:   `echo in (x) !BREEZE_PARAM_P!`,
		},
		{
			name:   "a doubled caret at end of line is not a continuation",
			script: "echo ^^\necho {{p}}\n",
			params: p,
			want:   "echo ^^\necho !BREEZE_PARAM_P!\n",
		},
		{
			name:   "a plain preceding line is not joined",
			script: "call foo\necho {{p}}\n",
			params: p,
			want:   "call foo\necho !BREEZE_PARAM_P!\n",
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
