package plugin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type releaseTransport func(*http.Request) (*http.Response, error)

func (f releaseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLatestReleaseRejectsWrongIdentityPlatformAndPrereleases(t *testing.T) {
	for _, field := range []string{"namespace", "name", "targetPlatform", "version", "preRelease"} {
		t.Run(field, func(t *testing.T) {
			meta := map[string]any{"namespace": "Anthropic", "name": "claude-code", "targetPlatform": "win32-x64", "version": "2.1.312"}
			meta[field] = "wrong"
			if field == "version" {
				meta[field] = "2.1.313-beta.1"
			}
			if field == "preRelease" {
				meta[field] = true
			}
			body, _ := json.Marshal(meta)
			client := &http.Client{Transport: releaseTransport(func(r *http.Request) (*http.Response, error) {
				if !strings.HasSuffix(r.URL.Path, "/win32-x64/latest") {
					t.Fatal("wrong platform/latest endpoint")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
			})}
			if _, err := fetchRelease(context.Background(), client, "latest", "win32-x64"); err == nil {
				t.Fatal("invalid release accepted")
			}
		})
	}
}
