package plugin

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const MaxArchive = 1 << 30
const MaxExpanded = 2 << 30

var ErrVersionMismatch = errors.New("VS Code extension (.vsix) version does not match the installed Claude Code")

type Prepared struct {
	ExtensionPath string         `json:"extensionPath"`
	PackageJSON   map[string]any `json:"packageJSON"`
}

func Platform() string {
	osname, arch := runtime.GOOS, runtime.GOARCH
	if osname == "windows" {
		osname = "win32"
	}
	if arch == "amd64" {
		arch = "x64"
	}
	return osname + "-" + arch
}

var cliVersion = regexp.MustCompile(`^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s+\(Claude Code\)\s*$`)

func Detect(ctx context.Context, executable string, nodePath ...string) (string, error) {
	home, _ := os.UserHomeDir()
	candidates := []string{executable}
	if executable == "" {
		candidates = []string{"claude", filepath.Join(home, ".local", "bin", "claude")}
		if runtime.GOOS == "windows" {
			candidates = append(candidates, filepath.Join(home, ".local", "bin", "claude.exe"))
			if directory := os.Getenv("APPDATA"); directory != "" {
				candidates = append(candidates, filepath.Join(directory, "npm", "claude.cmd"))
			}
			if directory := os.Getenv("LOCALAPPDATA"); directory != "" {
				candidates = append(candidates, filepath.Join(directory, "Microsoft", "WinGet", "Links", "claude.exe"))
			}
		}
	}
	for _, candidate := range candidates {
		command, args := candidate, []string{"--version"}
		if runtime.GOOS == "windows" {
			if resolved, err := exec.LookPath(candidate); err == nil {
				command = resolved
			}
			if strings.EqualFold(filepath.Ext(command), ".cmd") {
				// npm's launcher is a batch file; invoke its JS entry without a shell.
				script := filepath.Join(filepath.Dir(command), "node_modules", "@anthropic-ai", "claude-code", "cli.js")
				command = "node.exe"
				if len(nodePath) > 0 && nodePath[0] != "" {
					command = nodePath[0]
				}
				args = []string{script, "--version"}
			}
		}
		probe, cancel := context.WithTimeout(ctx, 8*time.Second)
		cmd := exec.CommandContext(probe, command, args...)
		configureProbe(cmd)
		out, err := cmd.Output()
		cancel()
		if err == nil {
			if m := cliVersion.FindStringSubmatch(strings.TrimSpace(string(out))); len(m) > 1 {
				return m[1], nil
			}
		}
	}
	return "", errors.New("Claude Code not found; install it or pass --claude=/path/to/claude")
}

func Download(ctx context.Context, directory, version, platform string) (string, error) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`).MatchString(version) {
		return "", errors.New("invalid Claude Code version")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 15 * time.Minute}
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://open-vsx.org/api/Anthropic/claude-code/"+url.PathEscape(platform)+"/"+url.PathEscape(version), nil)
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Open VSX metadata: %s", res.Status)
	}
	var meta struct {
		Namespace, Name, Version, TargetPlatform string
		Files                                    struct{ Download, SHA256 string }
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&meta); err != nil {
		return "", err
	}
	if meta.Namespace != "Anthropic" || meta.Name != "claude-code" || meta.Version != version || meta.TargetPlatform != platform {
		return "", errors.New("Open VSX returned the wrong publisher, version or platform")
	}
	for _, raw := range []string{meta.Files.Download, meta.Files.SHA256} {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" {
			return "", errors.New("Open VSX returned an invalid download URL")
		}
	}
	hashReq, _ := http.NewRequestWithContext(ctx, "GET", meta.Files.SHA256, nil)
	hashRes, err := client.Do(hashReq)
	if err != nil {
		return "", err
	}
	b, readErr := io.ReadAll(io.LimitReader(hashRes.Body, 4096))
	hashRes.Body.Close()
	if hashRes.StatusCode != 200 || readErr != nil {
		return "", errors.New("could not read the Open VSX checksum")
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 || !regexp.MustCompile(`^[a-fA-F0-9]{64}$`).MatchString(fields[0]) {
		return "", errors.New("invalid Open VSX checksum")
	}
	expected := strings.ToLower(fields[0])
	filename := filepath.Join(directory, "claude-code-"+version+"-"+platform+".vsix")
	if actual, err := fileHash(filename); err == nil && actual == expected {
		return filename, nil
	}
	dlReq, _ := http.NewRequestWithContext(ctx, "GET", meta.Files.Download, nil)
	dlRes, err := client.Do(dlReq)
	if err != nil {
		return "", err
	}
	defer dlRes.Body.Close()
	if dlRes.StatusCode != 200 {
		return "", fmt.Errorf("VS Code extension (.vsix) download: %s", dlRes.Status)
	}
	f, err := os.CreateTemp(directory, ".download-*.part")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(dlRes.Body, MaxArchive+1))
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if n > MaxArchive || hex.EncodeToString(h.Sum(nil)) != expected {
		return "", errors.New("VS Code extension (.vsix) exceeds size limit or failed SHA-256 verification")
	}
	if err := os.Rename(f.Name(), filename); err != nil {
		return "", err
	}
	return filename, nil
}

func fileHash(filename string) (string, error) {
	f, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	_, err = io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), err
}

type receiptEntry struct {
	Path string `json:"path"`
	Hash string `json:"sha256"`
}

// Prepare extracts only into a fresh private directory and verifies reused cache files.
// A VS Code extension (.vsix) is trusted executable code, not a sandboxed document.
func Prepare(archive, directory, platform, version string) (*Prepared, error) {
	stat, err := os.Stat(archive)
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > MaxArchive {
		return nil, errors.New("invalid or oversized VS Code extension (.vsix)")
	}
	digest, err := fileHash(archive)
	if err != nil {
		return nil, err
	}
	root := filepath.Join(directory, digest)
	if info, err := os.Lstat(root); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("unsafe extension cache")
		}
		if err := verifyReceipt(root); err != nil {
			return nil, fmt.Errorf("extension cache altered (remove it to re-extract): %w", err)
		}
		return validate(root, platform, version)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	tmp, err := os.MkdirTemp(directory, ".extract-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	z, err := zip.OpenReader(archive)
	if err != nil {
		return nil, err
	}
	defer z.Close()
	if len(z.File) > 50000 {
		return nil, errors.New("too many VS Code extension (.vsix) entries")
	}
	seen := make(map[string]bool)
	var total uint64
	var receipt []receiptEntry
	for _, entry := range z.File {
		name, err := safeName(entry.Name)
		if err != nil {
			return nil, err
		}
		key := strings.ToLower(name)
		if seen[key] || key == ".receipt.json" {
			return nil, fmt.Errorf("duplicate or reserved VS Code extension (.vsix) path: %s", name)
		}
		seen[key] = true
		mode := entry.Mode()
		if !mode.IsRegular() && !mode.IsDir() {
			return nil, errors.New("VS Code extension (.vsix) symlinks and special files are forbidden")
		}
		if entry.UncompressedSize64 > MaxExpanded || total > MaxExpanded-entry.UncompressedSize64 {
			return nil, errors.New("expanded VS Code extension (.vsix) exceeds 2 GiB")
		}
		total += entry.UncompressedSize64
		filename := filepath.Join(tmp, filepath.FromSlash(name))
		if mode.IsDir() {
			if err := os.MkdirAll(filename, 0700); err != nil {
				return nil, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			return nil, err
		}
		perm := os.FileMode(0600)
		if mode&0111 != 0 {
			perm = 0700
		}
		if err := extractFile(entry, filename, perm); err != nil {
			return nil, err
		}
		hash, err := fileHash(filename)
		if err != nil {
			return nil, err
		}
		receipt = append(receipt, receiptEntry{name, hash})
	}
	if _, err := validate(tmp, platform, version); err != nil {
		return nil, err
	}
	b, _ := json.Marshal(receipt)
	if err := os.WriteFile(filepath.Join(tmp, ".receipt.json"), b, 0600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, root); err != nil {
		return nil, err
	}
	return validate(root, platform, version)
}

func safeName(name string) (string, error) {
	name = strings.TrimSuffix(name, "/")
	if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") || path.Clean(name) != name || name == "." || strings.HasPrefix(name, "../") {
		return "", fmt.Errorf("unsafe VS Code extension (.vsix) path: %q", name)
	}
	return name, nil
}

func extractFile(entry *zip.File, filename string, mode os.FileMode) error {
	in, err := entry.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(in, int64(entry.UncompressedSize64)+1))
	closeErr := out.Close()
	if err != nil {
		return err
	}
	if uint64(n) != entry.UncompressedSize64 {
		return errors.New("VS Code extension (.vsix) entry size mismatch")
	}
	return closeErr
}

func inside(root, name string) (string, error) {
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(name)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", errors.New("file escapes extension directory")
	}
	return real, nil
}

func verifyReceipt(root string) error {
	r, err := inside(root, ".receipt.json")
	if err != nil {
		return err
	}
	b, err := os.ReadFile(r)
	if err != nil || len(b) > 16<<20 {
		return errors.New("invalid cache receipt")
	}
	var entries []receiptEntry
	if err := json.Unmarshal(b, &entries); err != nil || len(entries) == 0 {
		return errors.New("invalid cache receipt")
	}
	listed := make(map[string]bool)
	for _, entry := range entries {
		name, err := safeName(entry.Path)
		if err != nil {
			return err
		}
		if listed[name] {
			return errors.New("duplicate cache receipt entry")
		}
		listed[name] = true
		filename, err := inside(root, name)
		if err != nil {
			return err
		}
		hash, err := fileHash(filename)
		if err != nil || hash != entry.Hash {
			return fmt.Errorf("changed cached file: %s", name)
		}
	}
	if !listed["extension/package.json"] || !listed["extension.vsixmanifest"] {
		return errors.New("cache receipt is missing extension manifests")
	}
	return filepath.WalkDir(root, func(filename string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("symlink in extension cache")
		}
		if !entry.IsDir() {
			rel, err := filepath.Rel(root, filename)
			if err != nil {
				return err
			}
			name := filepath.ToSlash(rel)
			if name != ".receipt.json" && !listed[name] {
				return fmt.Errorf("unexpected cached file: %s", name)
			}
		}
		return nil
	})
}

func validate(root, platform, version string) (*Prepared, error) {
	var err error
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	filename := filepath.Join(root, "extension", "package.json")
	f, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var manifest map[string]any
	if err := json.NewDecoder(io.LimitReader(f, 1<<20)).Decode(&manifest); err != nil {
		return nil, err
	}
	if manifest["publisher"] != "Anthropic" || manifest["name"] != "claude-code" {
		return nil, errors.New("only the Anthropic Claude Code VS Code extension (.vsix) is supported")
	}
	if version != "" && manifest["version"] != version {
		return nil, ErrVersionMismatch
	}
	main, ok := manifest["main"].(string)
	if !ok || main == "" || strings.ContainsAny(main, "\\:\x00") || path.IsAbs(main) {
		return nil, errors.New("invalid extension entry point")
	}
	extensionPath := filepath.Join(root, "extension")
	entry, err := inside(extensionPath, main)
	if err != nil {
		return nil, err
	}
	if stat, err := os.Stat(entry); err != nil || !stat.Mode().IsRegular() {
		return nil, errors.New("invalid extension entry point")
	}
	x, err := os.ReadFile(filepath.Join(root, "extension.vsixmanifest"))
	if err != nil || len(x) > 1<<20 {
		return nil, errors.New("missing VS Code extension (.vsix) platform manifest")
	}
	var vsix struct {
		Metadata struct {
			Identity struct {
				Target string `xml:"TargetPlatform,attr"`
			} `xml:"Identity"`
		} `xml:"Metadata"`
	}
	if xml.Unmarshal(x, &vsix) != nil || vsix.Metadata.Identity.Target != platform {
		return nil, fmt.Errorf("VS Code extension (.vsix) platform mismatch (need %s)", platform)
	}
	return &Prepared{ExtensionPath: extensionPath, PackageJSON: manifest}, nil
}
