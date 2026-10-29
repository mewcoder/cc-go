package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)

type release struct {
	Namespace, Name, Version, TargetPlatform string
	PreRelease                               bool
	Files                                    struct{ Download, SHA256 string }
}

func fetchRelease(ctx context.Context, client *http.Client, version, platform string) (release, error) {
	var meta release
	if version != "latest" && !versionPattern.MatchString(version) {
		return meta, errors.New("invalid extension version")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://open-vsx.org/api/Anthropic/claude-code/"+url.PathEscape(platform)+"/"+url.PathEscape(version), nil)
	if err != nil {
		return meta, err
	}
	res, err := client.Do(req)
	if err != nil {
		return meta, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return meta, fmt.Errorf("Open VSX metadata: %s", res.Status)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&meta); err != nil {
		return meta, err
	}
	if meta.Namespace != "Anthropic" || meta.Name != "claude-code" || meta.TargetPlatform != platform || !versionPattern.MatchString(meta.Version) || version != "latest" && meta.Version != version {
		return meta, errors.New("Open VSX returned the wrong publisher, version or platform")
	}
	if version == "latest" && (meta.PreRelease || prerelease(meta.Version)) {
		return meta, errors.New("Open VSX latest version is not a stable release")
	}
	return meta, nil
}

func LatestVersion(ctx context.Context, platform string) (string, error) {
	meta, err := fetchRelease(ctx, &http.Client{Timeout: 10 * time.Second}, "latest", platform)
	return meta.Version, err
}

// NewerVersion compares stable registry releases without downgrading a newer
// manually imported extension. Build metadata does not affect precedence.
func NewerVersion(next, current string) bool {
	if !versionPattern.MatchString(next) || !versionPattern.MatchString(current) || prerelease(next) {
		return false
	}
	core := func(version string) []string {
		return strings.Split(strings.SplitN(strings.SplitN(version, "+", 2)[0], "-", 2)[0], ".")
	}
	n, c := core(next), core(current)
	for i := range n {
		a, errA := strconv.ParseUint(n[i], 10, 64)
		b, errB := strconv.ParseUint(c[i], 10, 64)
		if errA != nil || errB != nil {
			return false
		}
		if a != b {
			return a > b
		}
	}
	return prerelease(current)
}

func prerelease(version string) bool {
	return strings.Contains(strings.SplitN(version, "+", 2)[0], "-")
}
