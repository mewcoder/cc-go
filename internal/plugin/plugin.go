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

type Downloaded struct {
	Archive string
	Version string
}

type DownloadProgress struct {
	Version        string  `json:"targetVersion"`
	Received       int64   `json:"received"`
	Total          int64   `json:"total"`
	BytesPerSecond float64 `json:"bytesPerSecond"`
	Verifying      bool    `json:"verifying"`
}

type progressWriter struct {
	progress DownloadProgress
	last     time.Time
	rateAt   time.Time
	rateFrom int64
	report   func(DownloadProgress)
}

func (w *progressWriter) Write(b []byte) (int, error) {
	w.progress.Received += int64(len(b))
	now := time.Now()
	if elapsed := now.Sub(w.rateAt).Seconds(); elapsed >= 0.5 {
		rate := float64(w.progress.Received-w.rateFrom) / elapsed
		if w.progress.BytesPerSecond == 0 {
			w.progress.BytesPerSecond = rate
		} else {
			w.progress.BytesPerSecond = (w.progress.BytesPerSecond + rate) / 2
		}
		w.rateAt, w.rateFrom = now, w.progress.Received
	}
	if w.report != nil && now.Sub(w.last) >= 100*time.Millisecond {
		w.report(w.progress)
		w.last = now
	}
	return len(b), nil
}

func Download(ctx context.Context, directory, version, platform string, report func(DownloadProgress)) (Downloaded, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return Downloaded{}, err
	}
	client := &http.Client{Timeout: 15 * time.Minute}
	meta, err := fetchRelease(ctx, client, version, platform)
	if err != nil {
		return Downloaded{}, err
	}
	version = meta.Version
	progress := DownloadProgress{Version: version}
	if report != nil {
		report(progress)
	}
	for _, raw := range []string{meta.Files.Download, meta.Files.SHA256} {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" {
			return Downloaded{}, errors.New("Open VSX returned an invalid download URL")
		}
	}
	hashReq, _ := http.NewRequestWithContext(ctx, "GET", meta.Files.SHA256, nil)
	hashRes, err := client.Do(hashReq)
	if err != nil {
		return Downloaded{}, err
	}
	b, readErr := io.ReadAll(io.LimitReader(hashRes.Body, 4096))
	hashRes.Body.Close()
	if hashRes.StatusCode != 200 || readErr != nil {
		return Downloaded{}, errors.New("could not read the Open VSX checksum")
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 || !regexp.MustCompile(`^[a-fA-F0-9]{64}$`).MatchString(fields[0]) {
		return Downloaded{}, errors.New("invalid Open VSX checksum")
	}
	expected := strings.ToLower(fields[0])
	filename := filepath.Join(directory, "claude-code-"+version+"-"+platform+".vsix")
	if report != nil {
		progress.Verifying = true
		report(progress)
	}
	if actual, err := fileHash(filename); err == nil && actual == expected {
		return Downloaded{Archive: filename, Version: version}, nil
	}
	progress.Verifying = false
	if report != nil {
		report(progress)
	}
	dlReq, _ := http.NewRequestWithContext(ctx, "GET", meta.Files.Download, nil)
	dlRes, err := client.Do(dlReq)
	if err != nil {
		return Downloaded{}, err
	}
	defer dlRes.Body.Close()
	if dlRes.StatusCode != 200 {
		return Downloaded{}, fmt.Errorf("VS Code extension (.vsix) download: %s", dlRes.Status)
	}
	progress.Total = max(0, dlRes.ContentLength)
	if report != nil {
		report(progress)
	}
	f, err := os.CreateTemp(directory, ".download-*.part")
	if err != nil {
		return Downloaded{}, err
	}
	defer os.Remove(f.Name())
	h := sha256.New()
	writer := &progressWriter{progress: progress, report: report, rateAt: time.Now()}
	n, err := io.Copy(io.MultiWriter(f, h, writer), io.LimitReader(dlRes.Body, MaxArchive+1))
	closeErr := f.Close()
	if report != nil {
		writer.progress.Verifying = err == nil && closeErr == nil
		report(writer.progress)
	}
	if err != nil {
		return Downloaded{}, err
	}
	if closeErr != nil {
		return Downloaded{}, closeErr
	}
	if n > MaxArchive || hex.EncodeToString(h.Sum(nil)) != expected {
		return Downloaded{}, errors.New("VS Code extension (.vsix) exceeds size limit or failed SHA-256 verification")
	}
	if err := os.Rename(f.Name(), filename); err != nil {
		return Downloaded{}, err
	}
	return Downloaded{Archive: filename, Version: version}, nil
}

func fileHash(filename string) (string, error) {
	return fileHashContext(context.Background(), filename)
}

func fileHashContext(ctx context.Context, filename string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	f, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	_, err = io.Copy(h, contextReader{ctx, f})
	return hex.EncodeToString(h.Sum(nil)), err
}

type contextReader struct {
	ctx context.Context
	io.Reader
}

func (r contextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(b)
}

type receiptEntry struct {
	Path string `json:"path"`
	Hash string `json:"sha256"`
}

// Prepare extracts only into a fresh private directory and verifies reused cache files.
// A VS Code extension (.vsix) is trusted executable code, not a sandboxed document.
func Prepare(archive, directory, platform, version string) (*Prepared, error) {
	return prepare(context.Background(), archive, directory, platform, version)
}

func prepare(ctx context.Context, archive, directory, platform, version string) (*Prepared, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	stat, err := os.Stat(archive)
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > MaxArchive {
		return nil, errors.New("invalid or oversized VS Code extension (.vsix)")
	}
	digest, err := fileHashContext(ctx, archive)
	if err != nil {
		return nil, err
	}
	// Keep legacy digest-only caches readable. New installations stay in their
	// original unique directory; the completion marker publishes them for reuse.
	roots := []string{filepath.Join(directory, digest)}
	entries, err := os.ReadDir(directory)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), digest+"-") {
			roots = append(roots, filepath.Join(directory, entry.Name()))
		}
	}
	for i, root := range roots {
		info, err := os.Lstat(root)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("unsafe extension cache")
		}
		if i != 0 {
			marker, err := os.Lstat(filepath.Join(root, ".complete"))
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if !marker.Mode().IsRegular() || marker.Size() != 0 {
				return nil, errors.New("invalid extension cache completion marker")
			}
		}
		if err := verifyReceipt(ctx, root); err != nil {
			return nil, fmt.Errorf("extension cache altered (remove it to re-extract): %w", err)
		}
		return validate(root, platform, version)
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	root, err := os.MkdirTemp(directory, digest+"-")
	if err != nil {
		return nil, err
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(root)
		}
	}()
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
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name, err := safeName(entry.Name)
		if err != nil {
			return nil, err
		}
		key := strings.ToLower(name)
		if seen[key] || key == ".receipt.json" || key == ".complete" {
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
		filename := filepath.Join(root, filepath.FromSlash(name))
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
		if err := extractFile(ctx, entry, filename, perm); err != nil {
			return nil, err
		}
		hash, err := fileHashContext(ctx, filename)
		if err != nil {
			return nil, err
		}
		receipt = append(receipt, receiptEntry{name, hash})
	}
	prepared, err := validate(root, platform, version)
	if err != nil {
		return nil, err
	}
	b, _ := json.Marshal(receipt)
	if err := os.WriteFile(filepath.Join(root, ".receipt.json"), b, 0600); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(root, ".complete"), nil, 0600); err != nil {
		return nil, err
	}
	complete = true
	return prepared, nil
}

func safeName(name string) (string, error) {
	name = strings.TrimSuffix(name, "/")
	if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") || path.Clean(name) != name || name == "." || strings.HasPrefix(name, "../") {
		return "", fmt.Errorf("unsafe VS Code extension (.vsix) path: %q", name)
	}
	return name, nil
}

func extractFile(ctx context.Context, entry *zip.File, filename string, mode os.FileMode) error {
	in, err := entry.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, contextReader{ctx, io.LimitReader(in, int64(entry.UncompressedSize64)+1)})
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

func verifyReceipt(ctx context.Context, root string) error {
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
		if err := ctx.Err(); err != nil {
			return err
		}
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
		hash, err := fileHashContext(ctx, filename)
		if err != nil {
			return err
		}
		if hash != entry.Hash {
			return fmt.Errorf("changed cached file: %s", name)
		}
	}
	if !listed["extension/package.json"] || !listed["extension.vsixmanifest"] {
		return errors.New("cache receipt is missing extension manifests")
	}
	return filepath.WalkDir(root, func(filename string, entry os.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
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
			if name == ".complete" {
				info, err := entry.Info()
				if err != nil {
					return err
				}
				if !info.Mode().IsRegular() || info.Size() != 0 {
					return errors.New("invalid extension cache completion marker")
				}
			} else if name != ".receipt.json" && !listed[name] {
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
	return validateExtension(filepath.Join(root, "extension"), filepath.Join(root, "extension.vsixmanifest"), platform, version)
}

func validateExtension(extensionPath, platformManifest, platform, version string) (*Prepared, error) {
	filename := filepath.Join(extensionPath, "package.json")
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
	manifestVersion, _ := manifest["version"].(string)
	if !versionPattern.MatchString(manifestVersion) {
		return nil, errors.New("invalid extension version in manifest")
	}
	if version != "" && manifestVersion != version {
		return nil, ErrVersionMismatch
	}
	main, ok := manifest["main"].(string)
	if !ok || main == "" || strings.ContainsAny(main, "\\:\x00") || path.IsAbs(main) {
		return nil, errors.New("invalid extension entry point")
	}
	entry, err := inside(extensionPath, main)
	if err != nil {
		return nil, err
	}
	if stat, err := os.Stat(entry); err != nil || !stat.Mode().IsRegular() {
		return nil, errors.New("invalid extension entry point")
	}
	x, err := os.ReadFile(platformManifest)
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
