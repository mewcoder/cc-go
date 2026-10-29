package host

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type NodeInfo struct {
	Executable string
	Version    string
}

func CheckNode(ctx context.Context, explicit, home string) (NodeInfo, error) {
	filename, err := FindNode(explicit, home)
	if err != nil {
		return NodeInfo{}, err
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(probe, filename, "--version")
	configureProbe(command)
	out, err := command.Output()
	if err != nil {
		return NodeInfo{}, fmt.Errorf("cannot read Node.js version: %w", err)
	}
	version := strings.TrimSpace(string(out))
	match := regexp.MustCompile(`^v(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`).FindStringSubmatch(version)
	if len(match) < 2 {
		return NodeInfo{}, fmt.Errorf("invalid Node.js version: %q", version)
	}
	major, err := strconv.Atoi(match[1])
	if err != nil || major < 22 {
		return NodeInfo{}, fmt.Errorf("Node.js %s is unsupported; install Node.js 22 or newer", version)
	}
	return NodeInfo{Executable: filename, Version: version}, nil
}

// FindNode also checks stable version-manager locations because Finder does not
// inherit an interactive shell's PATH. No runtime is downloaded or bundled.
func FindNode(explicit, home string) (string, error) {
	if explicit != "" {
		path, err := exec.LookPath(explicit)
		if err != nil {
			return "", fmt.Errorf("cannot run the selected Node.js executable: %w", err)
		}
		return path, nil
	}
	name := "node"
	if runtime.GOOS == "windows" {
		name = "node.exe"
	}
	candidates := []string{
		name,
		filepath.Join(home, ".local", "bin", name),
		filepath.Join(home, ".volta", "bin", name),
		filepath.Join(home, ".asdf", "shims", name),
		filepath.Join(home, ".local", "share", "fnm", "aliases", "default", "bin", name),
		filepath.Join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin", name),
		filepath.Join(home, ".fnm", "aliases", "default", "bin", name),
		filepath.Join("/opt", "homebrew", "bin", name),
		filepath.Join("/usr", "local", "bin", name),
	}
	if runtime.GOOS == "windows" {
		for _, variable := range []string{"NVM_SYMLINK", "VOLTA_HOME", "FNM_DIR"} {
			if directory := os.Getenv(variable); directory != "" {
				if variable == "VOLTA_HOME" {
					directory = filepath.Join(directory, "bin")
				}
				if variable == "FNM_DIR" {
					directory = filepath.Join(directory, "aliases", "default")
				}
				candidates = append(candidates, filepath.Join(directory, name))
			}
		}
		for _, variable := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
			if directory := os.Getenv(variable); directory != "" {
				candidates = append(candidates, filepath.Join(directory, "nodejs", name))
			}
		}
		if directory := os.Getenv("LOCALAPPDATA"); directory != "" {
			candidates = append(candidates, filepath.Join(directory, "Programs", "nodejs", name), filepath.Join(directory, "fnm", "aliases", "default", name))
		}
		if directory := os.Getenv("APPDATA"); directory != "" {
			candidates = append(candidates, filepath.Join(directory, "fnm", "aliases", "default", name))
		}
	}
	for _, candidate := range candidates {
		if path, err := exec.LookPath(candidate); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("Node.js not found; install Node 22+ or pass --node=/path/to/node (this app does not bundle Node.js)")
}
