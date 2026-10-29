package plugin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDownloadReportsBytesWithAndWithoutContentLength(t *testing.T) {
	for _, known := range []bool{true, false} {
		t.Run(map[bool]string{true: "known-size", false: "unknown-size"}[known], func(t *testing.T) {
			payload := bytes.Repeat([]byte("vsix"), 32768)
			digest := sha256.Sum256(payload)
			original := http.DefaultTransport
			http.DefaultTransport = releaseTransport(func(r *http.Request) (*http.Response, error) {
				var body []byte
				total := int64(-1)
				switch {
				case strings.Contains(r.URL.Path, "/api/"):
					body, _ = json.Marshal(map[string]any{"namespace": "Anthropic", "name": "claude-code", "version": "2.1.312", "targetPlatform": Platform(), "files": map[string]string{"download": "https://fixture.invalid/plugin.vsix", "sha256": "https://fixture.invalid/sha256"}})
				case r.URL.Path == "/sha256":
					body = []byte(hex.EncodeToString(digest[:]))
				default:
					body = payload
					if known {
						total = int64(len(body))
					}
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: total}, nil
			})
			t.Cleanup(func() { http.DefaultTransport = original })
			directory := t.TempDir()
			var events []DownloadProgress
			report := func(p DownloadProgress) { events = append(events, p) }
			download, err := Download(context.Background(), directory, "latest", Platform(), report)
			if err != nil {
				t.Fatal(err)
			}
			var intermediate bool
			for _, p := range events {
				if p.Version != "2.1.312" || p.Total < 0 {
					t.Fatalf("invalid progress: %+v", p)
				}
				if p.Received > 0 && p.Received < int64(len(payload)) && !p.Verifying {
					intermediate = true
				}
			}
			last := events[len(events)-1]
			if !intermediate || last.Received != int64(len(payload)) || !last.Verifying || known && last.Total != int64(len(payload)) || !known && last.Total != 0 {
				t.Fatalf("missing transfer/verification progress: %+v", events)
			}
			b, err := os.ReadFile(download.Archive)
			if err != nil || !bytes.Equal(b, payload) {
				t.Fatal("download was not preserved:", err)
			}
			events = nil
			if _, err := Download(context.Background(), directory, "latest", Platform(), report); err != nil {
				t.Fatal("cache reuse failed:", err)
			}
			if last := events[len(events)-1]; !last.Verifying || last.Received != 0 {
				t.Fatalf("cached archive must report verification, not a fake transfer: %+v", events)
			}
			if parts, _ := filepath.Glob(filepath.Join(directory, "*.part")); len(parts) != 0 {
				t.Fatal("temporary downloads remain:", parts)
			}
		})
	}
}

func TestProgressWriterSamplesSpeedAndThrottlesReports(t *testing.T) {
	var events []DownloadProgress
	w := &progressWriter{rateAt: time.Now().Add(-time.Second), report: func(p DownloadProgress) { events = append(events, p) }}
	_, _ = w.Write(make([]byte, 1<<20))
	if len(events) != 1 || events[0].BytesPerSecond < 512<<10 || events[0].BytesPerSecond > 2<<20 {
		t.Fatalf("missing measured transfer speed: %+v", events)
	}
	_, _ = w.Write([]byte("next"))
	if len(events) != 1 || w.progress.Received != (1<<20)+4 {
		t.Fatal("progress must count every byte without reporting every write")
	}
}
