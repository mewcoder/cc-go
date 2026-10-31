package sessions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpeningHistoryDoesNotChangeActivityOrOrder(t *testing.T) {
	projects, workspace := t.TempDir(), t.TempDir()
	directory := filepath.Join(projects, ProjectDirectory(workspace))
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	ids := []string{"11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"}
	for i, stamp := range []string{"2026-10-29T01:00:00Z", "2026-10-30T01:00:00Z"} {
		row := `{"type":"user","timestamp":"` + stamp + `","message":{"content":"Hello"}}` + "\n"
		if err := os.WriteFile(filepath.Join(directory, ids[i]+".jsonl"), []byte(row), 0600); err != nil {
			t.Fatal(err)
		}
	}
	before := List(projects, workspace, nil)
	filename := filepath.Join(directory, ids[0]+".jsonl")
	appendRow := func(row string) {
		t.Helper()
		f, err := os.OpenFile(filename, os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := f.WriteString(row + "\n"); err != nil {
			t.Fatal(err)
		}
	}
	appendRow(`{"type":"file-history-snapshot","timestamp":"2026-10-31T01:00:00Z"}`)
	appendRow(`{"type":"user","isMeta":true,"timestamp":"2026-10-31T01:00:01Z"}`)
	after := List(projects, workspace, nil)
	if len(after) != len(before) {
		t.Fatalf("opening history changed visible sessions: before %+v; after %+v", before, after)
	}
	for i := range before {
		if before[i].ID != after[i].ID || before[i].UpdatedAt != after[i].UpdatedAt {
			t.Fatalf("opening history changed activity/order: before %+v; after %+v", before, after)
		}
	}
	appendRow(`{"type":"assistant","timestamp":"2026-10-31T01:00:03Z"}`)
	updated := List(projects, workspace, nil)
	if updated[0].ID != ids[0] || updated[0].UpdatedAt != time.Date(2026, 10, 31, 1, 0, 3, 0, time.UTC).UnixMilli() {
		t.Fatalf("a real reply did not update recency: %+v", updated)
	}
}

func TestLastMessageTimeAcrossLargeRowsAndMetadataTail(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "session.jsonl")
	content := `{"type":"user","timestamp":"2026-10-29T00:00:00Z"}` + "\n" +
		`{"type":"assistant","timestamp":"2026-10-30T00:00:00Z","message":{"content":"` + strings.Repeat("x", 150000) + `"}}` + "\n" +
		strings.Repeat("{\"type\":\"file-history-snapshot\",\"timestamp\":\"2026-10-31T00:00:00Z\"}\n", 6000) +
		`{"type":"assistant","timestamp":"broken"}`
	if err := os.WriteFile(filename, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	if got, want := readUpdatedAt(filename), time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC).UnixMilli(); got != want {
		t.Fatalf("activity = %d, want %d", got, want)
	}
}
