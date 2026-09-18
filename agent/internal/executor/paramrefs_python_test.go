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
		{
			// A placeholder inside an f-string REPLACEMENT FIELD lands in an
			// expression slot, not in string data, so escaping it is not enough.
			name:        "f-string replacement field is rejected",
			script:      `print(f"{ {{p}} }")`,
			params:      map[string]string{"p": `__import__("os").system("id")`},
			wantErr:     true,
			errContains: "replacement field",
		},
		{
			name:        "f-string nested format spec is rejected",
			script:      `print(f"{x:{{p}}}")`,
			params:      map[string]string{"p": "5"},
			wantErr:     true,
			errContains: "replacement field",
		},
		{
			name:        "f-string replacement field in a triple-quoted literal is rejected",
			script:      "print(f\"\"\"{ {{p}} }\"\"\")",
			params:      map[string]string{"p": "x"},
			wantErr:     true,
			errContains: "replacement field",
		},
		{
			name:   "escaped braces keep the field depth at zero",
			script: `print(f"{{x}} {{p}}")`,
			params: map[string]string{"p": "v"},
			want:   `print(f"{{x}} v")`,
		},
		{
			name:   "text after a closed replacement field is string data",
			script: `print(f"{a[0]} {{p}}")`,
			params: map[string]string{"p": "v"},
			want:   `print(f"{a[0]} v")`,
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
