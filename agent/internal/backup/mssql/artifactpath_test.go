package mssql

import (
	"fmt"
	"strings"
	"testing"
)

func TestBackupArtifactPathCharacters(t *testing.T) {
	for _, value := range []string{`C:\Backups\daily backup.bak`, "archive/o'brien.bak", "archive/日本語.bak", "archive/$(name).bak"} {
		if err := ValidateBackupArtifactPath(value); err != nil {
			t.Fatalf("valid path %q: %v", value, err)
		}
	}
	var refused []string
	for r := rune(0); r <= 0x9f; r++ {
		if r >= 0x20 && r < 0x7f {
			continue
		}
		refused = append(refused, string(r))
	}
	refused = append(refused, "\u2028", "\u2029", "\xff", "\xc3")
	for _, bad := range refused {
		t.Run(fmt.Sprintf("%q", bad), func(t *testing.T) {
			value := "archive/file" + bad + ".bak"
			if err := ValidateBackupArtifactPath(value); err == nil {
				t.Fatal("expected invalid path")
			}
			if err := ValidateBackupArtifactName("file" + bad + ".bak"); err == nil {
				t.Fatal("expected invalid name")
			}
		})
	}
	for _, value := range []string{"", ".", "..", "../daily.bak", `folder\daily.bak`, "folder/daily.bak", "C:daily.bak"} {
		if err := ValidateBackupArtifactName(value); err == nil {
			t.Fatalf("accepted name %q", value)
		}
	}
	if err := ValidateBackupArtifactName("AppDB_full_20260101_000000.bak"); err != nil {
		t.Fatalf("refused a normal name: %v", err)
	}
}

func TestBindNVarcharCarriesValueAsUTF16Hex(t *testing.T) {
	got, err := bindNVarchar("@backup_file", "A'é\U0001F600")
	if err != nil {
		t.Fatal(err)
	}
	want := "DECLARE @backup_file nvarchar(4000); SET @backup_file = CAST(0x41002700E9003DD800DE AS nvarchar(4000));"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got, err := bindNVarchar("@backup_file", ""); err != nil || !strings.Contains(got, "CAST(0x AS nvarchar(4000))") {
		t.Fatalf("empty value: %q %v", got, err)
	}
	if _, err := bindNVarchar("@backup_file", strings.Repeat("a", 4001)); err == nil {
		t.Fatal("accepted a value longer than the declared length")
	}
	if _, err := bindNVarchar("@backup_file", strings.Repeat("\U0001F600", 2001)); err == nil {
		t.Fatal("accepted a value longer than the declared length in UTF-16 units")
	}
	if _, err := bindNVarchar("@backup_file", "\xff"); err == nil {
		t.Fatal("accepted invalid UTF-8")
	}
	for _, name := range []string{"backup_file", "@x; DROP", "@x\n", "@X"} {
		if _, err := bindNVarchar(name, "v"); err == nil {
			t.Fatalf("accepted variable name %q", name)
		}
	}
}

func TestBuildVerifyQueryBindsBackupFile(t *testing.T) {
	p := `D:\Backups\o'brien $(name).bak`
	query, err := buildVerifyQuery(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(query, " RESTORE VERIFYONLY FROM DISK=@backup_file") || strings.Contains(query, "brien") || strings.Contains(query, "$(") {
		t.Fatalf("query = %q", query)
	}
	if bindingFromQuery(t, query) != p {
		t.Fatalf("query = %q", query)
	}
	if err := checkSqlcmdQuery(query); err != nil {
		t.Fatalf("verify statement is not one printable line: %v", err)
	}
	for _, bad := range []string{"", "D:\\a\n.bak", "D:\\a\r.bak", "D:\\a\x00.bak"} {
		if q, err := buildVerifyQuery(bad); err == nil || q != "" {
			t.Fatalf("path %q: query=%q err=%v", bad, q, err)
		}
	}
}

func TestSingleLineCollapsesTemplateWhitespace(t *testing.T) {
	if got := singleLine("SELECT a,\n\t\tb\r\n  FROM t"); got != "SELECT a, b FROM t" {
		t.Fatalf("got %q", got)
	}
}
