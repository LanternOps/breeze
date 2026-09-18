package executor

import "testing"

func TestRenderPythonStringLiterals(t *testing.T) {
	runRenderCases(t, ScriptTypePython, []renderCase{
		{
			name:   "double-quoted literal escapes the value",
			script: `print("{{p}}")`,
			params: map[string]string{"p": `a"b\c`},
			want:   `print("a\"b\\c")`,
		},
		{
			name:   "single-quoted literal escapes the value",
			script: `print('{{p}}')`,
			params: map[string]string{"p": `it's`},
			want:   `print('it\'s')`,
		},
		{
			name:   "newlines become escapes inside a single-line literal",
			script: `print("{{p}}")`,
			params: map[string]string{"p": "a\nb"},
			want:   `print("a\nb")`,
		},
		{
			name:   "triple-quoted literal",
			script: `print("""v={{p}}""")`,
			params: map[string]string{"p": "line1\nline2"},
			want:   `print("""v=line1\nline2""")`,
		},
		{
			name:   "f-string doubles braces",
			script: `print(f"{x} {{p}}")`,
			params: map[string]string{"p": "a{b}"},
			want:   `print(f"{x} a{{b}}")`,
		},
		{
			name:   "implicit concatenation is preserved",
			script: `print("a {{p}}" "b")`,
			params: map[string]string{"p": "v"},
			want:   `print("a v" "b")`,
		},
		{
			name:   "raw literal accepts a plain value",
			script: `print(r"{{p}}")`,
			params: map[string]string{"p": "abc"},
			want:   `print(r"abc")`,
		},
		{
			name:   "bytes literal accepts ASCII",
			script: `print(b"{{p}}")`,
			params: map[string]string{"p": `a"b`},
			want:   `print(b"a\"b")`,
		},
		{
			name:          "unknown key is left as written",
			script:        `print("{{nope}}")`,
			params:        map[string]string{"p": "v"},
			want:          `print("{{nope}}")`,
			wantUntouched: true,
		},
		{
			name:        "raw literal rejects a backslash",
			script:      `print(r"{{p}}")`,
			params:      map[string]string{"p": `C:\Users\x`},
			wantErr:     true,
			errContains: "raw string literal",
		},
		{
			name:        "raw literal rejects its own quote",
			script:      `print(r"{{p}}")`,
			params:      map[string]string{"p": `a"b`},
			wantErr:     true,
			errContains: "raw string literal",
		},
		{
			name:        "single-line raw literal rejects a newline",
			script:      `print(r"{{p}}")`,
			params:      map[string]string{"p": "a\nb"},
			wantErr:     true,
			errContains: "raw string literal",
		},
		{
			name:        "bytes literal rejects non-ASCII",
			script:      `print(b"{{p}}")`,
			params:      map[string]string{"p": "caf\u00e9"},
			wantErr:     true,
			errContains: "bytes literal",
		},
	})
}

func TestRenderPythonCodeContexts(t *testing.T) {
	runRenderCases(t, ScriptTypePython, []renderCase{
		{
			name:   "integer passthrough keeps arithmetic working",
			script: `x = {{n}} + 1`,
			params: map[string]string{"n": "41"},
			want:   `x = 41 + 1`,
		},
		{
			name:   "decimal passthrough",
			script: `x = {{n}}`,
			params: map[string]string{"n": "1.5"},
			want:   `x = 1.5`,
		},
		{
			name:   "non-numeric code context becomes an environ lookup",
			script: `x = {{p}}`,
			params: map[string]string{"p": "hello"},
			want:   `x = __import__("os").environ["BREEZE_PARAM_P"]`,
		},
		{
			name:   "dollar form is consumed whole",
			script: `x = ${{p}}`,
			params: map[string]string{"p": "hello"},
			want:   `x = __import__("os").environ["BREEZE_PARAM_P"]`,
		},
		{
			name:   "comment reference is inert",
			script: `# p={{p}}`,
			params: map[string]string{"p": "hello"},
			want:   `# p=os.environ["BREEZE_PARAM_P"]`,
		},
	})
}
