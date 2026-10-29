package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"cc-go/internal/desktop"
	"cc-go/internal/server"
)

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatal(err)
	}
	var cfg server.Config
	var web bool
	flag.StringVar(&cfg.DataDir, "data-dir", filepath.Join(home, ".cc-go"), "Independent application data directory")
	flag.StringVar(&cfg.Workspace, "workspace", "", "Initial project directory (defaults to the last workspace)")
	flag.StringVar(&cfg.VSIX, "vsix", "", "Trusted local Anthropic Claude Code VS Code extension (.vsix); otherwise download the latest stable platform version")
	flag.StringVar(&cfg.Node, "node", "", "Node.js executable")
	flag.StringVar(&cfg.ModulesDir, "node-modules", "", "Optional additional npm module search directory (host dependencies are embedded)")
	flag.StringVar(&cfg.ProjectsDir, "projects-dir", filepath.Join(home, ".claude", "projects"), "Read-only Claude transcript directory")
	flag.BoolVar(&web, "web", false, "Serve to a local browser instead of opening a native window")
	flag.Parse()
	// Finder launches have a small PATH, unlike an interactive developer shell.
	path := os.Getenv("PATH")
	for _, directory := range []string{filepath.Join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"} {
		if !strings.Contains(string(os.PathListSeparator)+path+string(os.PathListSeparator), string(os.PathListSeparator)+directory+string(os.PathListSeparator)) {
			path += string(os.PathListSeparator) + directory
		}
	}
	_ = os.Setenv("PATH", path)
	app, err := server.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()
	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
	fmt.Println("CC Go:", app.ShellURL)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	if web {
		<-stop
		return
	}
	go func() { <-stop; app.Close(); os.Exit(0) }()
	if err := desktop.Run(app); err != nil {
		log.Print(err)
	}
}
