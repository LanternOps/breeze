package executor

import (
	"errors"
	"strings"
	"testing"
)

// renderCase is the shared shape of the per-language render tables.
type renderCase struct {
	name    string
	script  string
	params  map[string]string
	want    string
	wantErr bool
	// errContains, when set, must appear in the error message.
	errContains string
	// wantRendered asserts the "did we rewrite anything" flag. Defaults to
	// true for the success cases, so it is only set explicitly for the
	// untouched-script cases.
	wantUntouched bool
}

func runRenderCases(t *testing.T, scriptType string, cases []renderCase) {
	t.Helper()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, rendered, err := RenderParameterReferences(tc.script, scriptType, tc.params)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got rendered script %q", got)
				}
				var pre *ParameterRenderError
				if !errors.As(err, &pre) {
					t.Fatalf("expected a *ParameterRenderError, got %T: %v", err, err)
				}
				if pre.Param == "" || pre.Context == "" || pre.Hint == "" {
					t.Fatalf("error must name the parameter, the context and an alternative: %+v", pre)
				}
				if tc.errContains != "" && !strings.Contains(err.Error(), tc.errContains) {
					t.Fatalf("error %q does not contain %q", err.Error(), tc.errContains)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("rendered\n got: %q\nwant: %q", got, tc.want)
			}
			if tc.wantUntouched && rendered {
				t.Fatalf("expected rendered=false for a script with no parameter placeholders")
			}
			if !tc.wantUntouched && !rendered {
				t.Fatalf("expected rendered=true")
			}
		})
	}
}

func TestRenderBashQuotingContexts(t *testing.T) {
	p := map[string]string{"p": "v", "site-name": "hq"}
	runRenderCases(t, ScriptTypeBash, []renderCase{
		{
			name:   "unquoted becomes a quoted reference",
			script: `echo {{p}}`,
			params: p,
			want:   `echo "${BREEZE_PARAM_P}"`,
		},
		{
			name:   "dollar form is consumed whole",
			script: `echo ${{p}}`,
			params: p,
			want:   `echo "${BREEZE_PARAM_P}"`,
		},
		{
			name:   "double quotes keep the surrounding literal",
			script: `echo "a {{p}} b"`,
			params: p,
			want:   `echo "a ${BREEZE_PARAM_P} b"`,
		},
		{
			name:   "single quotes are spliced, staying one word",
			script: `echo 'a {{p}} b'`,
			params: p,
			want:   `echo 'a '"${BREEZE_PARAM_P}"' b'`,
		},
		{
			name:   "ansi-c quoting reopens with dollar-quote",
			script: `echo $'a{{p}}b'`,
			params: p,
			want:   `echo $'a'"${BREEZE_PARAM_P}"$'b'`,
		},
		{
			name:   "command substitution resets quoting",
			script: `echo "$(echo '{{p}}')"`,
			params: p,
			want:   `echo "$(echo ''"${BREEZE_PARAM_P}"'')"`,
		},
		{
			name:   "backtick body is a code context",
			script: "echo `basename {{p}}`",
			params: p,
			want:   "echo `basename \"${BREEZE_PARAM_P}\"`",
		},
		{
			name:   "comment reference is inert",
			script: `# uses {{p}} today`,
			params: p,
			want:   `# uses ${BREEZE_PARAM_P} today`,
		},
		{
			name:   "hyphenated key maps to underscores",
			script: `echo {{site-name}}`,
			params: p,
			want:   `echo "${BREEZE_PARAM_SITE_NAME}"`,
		},
		{
			name:          "unknown key is left exactly as written",
			script:        `echo {{nope}} ${{alsonope}}`,
			params:        p,
			want:          `echo {{nope}} ${{alsonope}}`,
			wantUntouched: true,
		},
		{
			name:   "parameter expansion default value expands",
			script: `echo "${HOME:-{{p}}}"`,
			params: p,
			want:   `echo "${HOME:-${BREEZE_PARAM_P}}"`,
		},
		{
			name:   "conditional expression operand is quoted",
			script: `[[ $a == {{p}} ]]`,
			params: p,
			want:   `[[ $a == "${BREEZE_PARAM_P}" ]]`,
		},
	})
}

func TestRenderBashHeredocs(t *testing.T) {
	p := map[string]string{"p": "v"}
	runRenderCases(t, ScriptTypeBash, []renderCase{
		{
			name:   "unquoted heredoc expands the reference",
			script: "cat <<EOF\nv={{p}}\nEOF\n",
			params: p,
			want:   "cat <<EOF\nv=${BREEZE_PARAM_P}\nEOF\n",
		},
		{
			name:   "tab-stripping heredoc still terminates",
			script: "cat <<-EOF\n\tv={{p}}\n\tEOF\n",
			params: p,
			want:   "cat <<-EOF\n\tv=${BREEZE_PARAM_P}\n\tEOF\n",
		},
		{
			name:        "quoted heredoc cannot expand anything",
			script:      "cat <<'EOF'\nv={{p}}\nEOF\n",
			params:      p,
			wantErr:     true,
			errContains: "quoted heredoc",
		},
		{
			name:        "backslash-escaped delimiter is also quoted",
			script:      "cat <<\\EOF\nv={{p}}\nEOF\n",
			params:      p,
			wantErr:     true,
			errContains: "quoted heredoc",
		},
		{
			name:   "text after the heredoc is still scanned",
			script: "cat <<EOF\nbody\nEOF\necho {{p}}\n",
			params: p,
			want:   "cat <<EOF\nbody\nEOF\necho \"${BREEZE_PARAM_P}\"\n",
		},
	})
}

func TestRenderBashArithmeticContexts(t *testing.T) {
	ok := map[string]string{"n": "5"}
	negative := map[string]string{"n": "-5"}
	bad := map[string]string{"n": "a[$(id)]"}
	runRenderCases(t, ScriptTypeBash, []renderCase{
		{name: "dollar double paren integer", script: `echo $(( {{n}} + 1 ))`, params: ok, want: `echo $(( 5 + 1 ))`},
		{name: "negative integer passes", script: `echo $(( {{n}} ))`, params: negative, want: `echo $(( -5 ))`},
		{name: "nested parens still close", script: `echo $(( ({{n}} + 1) * 2 ))`, params: ok, want: `echo $(( (5 + 1) * 2 ))`},
		{name: "bare double paren", script: `(( {{n}} > 1 )) && echo hi`, params: ok, want: `(( 5 > 1 )) && echo hi`},
		{name: "for double paren", script: `for (( i=0; i<{{n}}; i++ )); do echo $i; done`, params: ok, want: `for (( i=0; i<5; i++ )); do echo $i; done`},
		{name: "dollar bracket arithmetic", script: `echo $[{{n}}+1]`, params: ok, want: `echo $[5+1]`},
		{name: "substring offset", script: `echo "${x:{{n}}}"`, params: ok, want: `echo "${x:5}"`},
		{name: "array subscript", script: `arr[{{n}}]=1`, params: ok, want: `arr[5]=1`},
		{name: "array length subscript", script: `echo "${#arr[{{n}}]}"`, params: ok, want: `echo "${#arr[5]}"`},
		{name: "declare -i", script: `declare -i total={{n}}`, params: ok, want: `declare -i total=5`},
		{name: "let", script: `let x={{n}}+1`, params: ok, want: `let x=5+1`},
		{name: "numeric comparison operand", script: `[[ {{n}} -gt 3 ]]`, params: ok, want: `[[ 5 -gt 3 ]]`},
		{name: "numeric comparison right operand", script: `[[ 3 -eq {{n}} ]]`, params: ok, want: `[[ 3 -eq 5 ]]`},

		{name: "arithmetic rejects non-integer", script: `echo $(( {{n}} ))`, params: bad, wantErr: true, errContains: "arithmetic"},
		{name: "bare double paren rejects non-integer", script: `(( {{n}} ))`, params: bad, wantErr: true},
		{name: "subscript rejects non-integer", script: `arr[{{n}}]=1`, params: bad, wantErr: true},
		{name: "offset rejects non-integer", script: `echo "${x:{{n}}}"`, params: bad, wantErr: true},
		{name: "declare -i rejects non-integer", script: `declare -i total={{n}}`, params: bad, wantErr: true},
		{name: "numeric comparison rejects non-integer", script: `[[ 1 -eq {{n}} ]]`, params: bad, wantErr: true},
		{name: "let rejects non-integer", script: `let x={{n}}`, params: bad, wantErr: true},
	})
}

func TestRenderBashNameAndEvalContexts(t *testing.T) {
	name := map[string]string{"v": "COUNT"}
	bad := map[string]string{"v": "x; touch /tmp/pwned"}
	runRenderCases(t, ScriptTypeBash, []renderCase{
		{name: "read variable name", script: `read {{v}}`, params: name, want: `read "${BREEZE_PARAM_V}"`},
		{name: "unset variable name", script: `unset {{v}}`, params: name, want: `unset "${BREEZE_PARAM_V}"`},
		{name: "printf -v target", script: `printf -v {{v}} '%s' x`, params: name, want: `printf -v "${BREEZE_PARAM_V}" '%s' x`},
		{name: "for loop variable", script: `for {{v}} in a b; do echo $x; done`, params: name, want: `for "${BREEZE_PARAM_V}" in a b; do echo $x; done`},
		{name: "declare -n nameref", script: `declare -n {{v}}=other`, params: name, want: `declare -n "${BREEZE_PARAM_V}"=other`},
		{name: "for loop list item is a normal word", script: `for i in {{v}}; do echo $i; done`, params: name, want: `for i in "${BREEZE_PARAM_V}"; do echo $i; done`},

		{name: "read rejects a non-identifier", script: `read {{v}}`, params: bad, wantErr: true, errContains: "variable-name position"},
		{name: "eval is rejected", script: `eval {{v}}`, params: name, wantErr: true, errContains: "eval"},
		{name: "eval is rejected inside quotes too", script: `eval "run {{v}}"`, params: name, wantErr: true, errContains: "eval"},
		{name: "trap is rejected", script: `trap {{v}} EXIT`, params: name, wantErr: true, errContains: "trap"},
		{name: "alias is rejected", script: `alias ll={{v}}`, params: name, wantErr: true, errContains: "alias"},
	})
}

func TestRenderParameterKeyCollisionIsRejected(t *testing.T) {
	_, _, err := RenderParameterReferences(`echo {{a-b}}`, ScriptTypeBash, map[string]string{"a-b": "1", "a_b": "2"})
	if err == nil {
		t.Fatal("expected colliding parameter keys to be rejected")
	}
	if !strings.Contains(err.Error(), "BREEZE_PARAM_A_B") {
		t.Fatalf("error should name the colliding environment variable: %v", err)
	}
}

func TestRenderParameterReferencesNoParamsIsIdentity(t *testing.T) {
	script := `echo {{p}}`
	got, rendered, err := RenderParameterReferences(script, ScriptTypeBash, nil)
	if err != nil || rendered || got != script {
		t.Fatalf("expected an untouched script, got %q rendered=%v err=%v", got, rendered, err)
	}
}

func TestParameterEnvNameMatchesBuildEnvironment(t *testing.T) {
	// The reference we emit is worthless if it names a variable
	// buildEnvironment does not export.
	e := newTestExecutor()
	env := e.buildEnvironment(ScriptExecution{
		ID:         "exec-env",
		Parameters: map[string]string{"site-name": "hq", "MixedCase": "x"},
	})
	for key, value := range map[string]string{"site-name": "hq", "MixedCase": "x"} {
		if !hasEnvEntry(env, parameterEnvName(key), value) {
			t.Fatalf("buildEnvironment did not export %s for key %q: %v", parameterEnvName(key), key, env)
		}
	}
}
