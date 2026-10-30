package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	runtimefiles "cc-go/runtime"

	"golang.org/x/net/websocket"
)

type viewMessage struct {
	Sequence int64           `json:"sequence"`
	Data     json.RawMessage `json:"data"`
}

type View struct {
	ID, Title, Token, HTML string
	SessionID              string
	HasDraft               bool
	Roots                  []string
	Started                bool
	PendingInput           bool
	Revision               int
	mu                     sync.Mutex
	sequence               int64
	messages               []viewMessage
	bytes                  int
	wake                   chan struct{}
	done                   chan struct{}
	closeOnce              sync.Once
	state                  json.RawMessage
}

func newView(id, title, token string) *View {
	return &View{ID: id, Title: title, Token: token, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

func (v *View) close() { v.closeOnce.Do(func() { close(v.done) }) }

func (v *View) post(message json.RawMessage) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(message) > 16<<20 {
		return errors.New("webview message exceeds 16 MiB")
	}
	if v.bytes+len(message) > 32<<20 {
		return errors.New("webview replay buffer full; reload the conversation")
	}
	v.sequence++
	v.messages = append(v.messages, viewMessage{v.sequence, append(json.RawMessage(nil), message...)})
	v.bytes += len(message)
	select {
	case v.wake <- struct{}{}:
	default:
	}
	return nil
}

func equalToken(a, b string) bool {
	return len(a) > 0 && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (a *App) ViewHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, _ := url.Parse(a.ViewURL)
		if u == nil || r.Host != u.Host {
			http.Error(w, "Forbidden host", 403)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 4)
		if len(parts) != 4 || (parts[0] != "view" && parts[0] != "resource") {
			http.NotFound(w, r)
			return
		}
		a.mu.Lock()
		view := a.views[parts[1]]
		var roots []string
		var html, theme, transcriptWidth string
		if view != nil {
			roots = append([]string(nil), view.Roots...)
			html, theme = view.HTML, a.state.Theme
			transcriptWidth = a.state.TranscriptWidth
		}
		a.mu.Unlock()
		if view == nil || !equalToken(parts[2], view.Token) {
			http.NotFound(w, r)
			return
		}
		if parts[0] == "resource" {
			if r.Method != "GET" && r.Method != "HEAD" {
				http.Error(w, "Method not allowed", 405)
				return
			}
			filename, err := allowedResource(roots, "/"+parts[3])
			if err != nil {
				http.Error(w, "Resource denied", 403)
				return
			}
			http.ServeFile(w, r, filename)
			return
		}
		base := a.ViewURL + "/view/" + view.ID + "/" + view.Token + "/"
		switch parts[3] {
		case "index.html":
			if r.Method != "GET" {
				http.Error(w, "Method not allowed", 405)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, injectBridge(html, base))
		case "bridge.js", "composer.js":
			if r.Method != "GET" {
				http.Error(w, "Method not allowed", 405)
				return
			}
			if parts[3] == "composer.js" {
				w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
				b, _ := a.readWebFile("composer.js")
				_, _ = w.Write(b)
				return
			}
			view.mu.Lock()
			state := view.state
			view.mu.Unlock()
			if len(state) == 0 {
				state = json.RawMessage("null")
			}
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			b, _ := a.readWebFile("bridge.js")
			prefix, _ := json.Marshal(map[string]any{"base": base, "state": state, "theme": theme, "transcriptWidth": transcriptWidth, "shellOrigin": a.ShellURL})
			_, _ = fmt.Fprintf(w, "const __claudeBridge = %s;\n", prefix)
			_, _ = w.Write(b)
		case "theme.css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
			name := "theme.css"
			if theme == "light" {
				name = "theme-light.css"
			}
			b, _ := runtimefiles.Files.ReadFile(name)
			_, _ = w.Write(b)
			composer, _ := a.readWebFile("composer.css")
			_, _ = w.Write(append([]byte("\n"), composer...))
			scrollbars, _ := a.readWebFile("scrollbars.css")
			_, _ = w.Write(append([]byte("\n"), scrollbars...))
		case "events":
			if r.Method != "GET" {
				http.Error(w, "Method not allowed", 405)
				return
			}
			a.viewEvents(w, r, view)
		case "socket":
			if r.Method != "GET" || r.Header.Get("Origin") != a.ViewURL {
				http.Error(w, "Forbidden", 403)
				return
			}
			a.viewSocket(w, r, view)
		case "message", "state", "external":
			if r.Method != "POST" || r.Header.Get("Origin") != a.ViewURL {
				http.Error(w, "Forbidden", 403)
				return
			}
			var value json.RawMessage
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&value); err != nil {
				http.Error(w, "Invalid message", 400)
				return
			}
			a.mu.Lock()
			peer, native := a.peer, a.native
			a.mu.Unlock()
			var err error
			switch parts[3] {
			case "message":
				if peer == nil {
					err = errors.New("plugin host is not running")
				} else {
					err = a.receiveViewMessage(view.ID, value)
				}
			case "state":
				view.mu.Lock()
				view.state = value
				view.mu.Unlock()
			case "external":
				var raw string
				if json.Unmarshal(value, &raw) != nil {
					err = errors.New("invalid URL")
				} else {
					err = openExternal(native, raw)
				}
			}
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			w.WriteHeader(204)
		default:
			http.NotFound(w, r)
		}
	})
}

var noncePattern = regexp.MustCompile(`nonce=["']([^"']+)["']`)
var headPattern = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
var scriptPattern = regexp.MustCompile(`(?i)<script(?:\s|>)`)
var cspMetaPattern = regexp.MustCompile(`(?i)<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>`)
var cspContentPattern = regexp.MustCompile(`(?i)content="([^"]*)"`)

func injectBridge(html, base string) string {
	// A VS Code webview transports messages outside the page's fetch policy.
	// Our replacement uses HTTP, so permit only this view's bridge endpoints.
	connectSources := base + " " + strings.Replace(base, "http", "ws", 1)
	html = cspMetaPattern.ReplaceAllStringFunc(html, func(meta string) string {
		return cspContentPattern.ReplaceAllStringFunc(meta, func(content string) string {
			policy := cspContentPattern.FindStringSubmatch(content)[1]
			directives := strings.Split(policy, ";")
			found := false
			for i, directive := range directives {
				fields := strings.Fields(directive)
				if len(fields) > 0 && strings.EqualFold(fields[0], "connect-src") {
					found = true
					directives[i] = strings.ReplaceAll(directive, "'none'", "") + " " + connectSources
				}
			}
			if !found {
				directives = append(directives, "connect-src "+connectSources)
			}
			return `content="` + strings.Join(directives, ";") + `"`
		})
	})
	nonce := ""
	if match := noncePattern.FindStringSubmatch(html); len(match) > 1 {
		// Only accept CSP-safe nonce characters from the plugin document.
		if regexp.MustCompile(`^[A-Za-z0-9+/_=-]+$`).MatchString(match[1]) {
			nonce = ` nonce="` + match[1] + `"`
		}
	}
	bridge := `<script` + nonce + ` src="` + base + `bridge.js"></script><script` + nonce + ` src="` + base + `composer.js"></script><link id="claude-host-theme" rel="stylesheet" href="` + base + `theme.css">`
	if loc := scriptPattern.FindStringIndex(html); loc != nil {
		return html[:loc[0]] + bridge + html[loc[0]:]
	}
	if loc := headPattern.FindStringIndex(html); loc != nil {
		return html[:loc[1]] + bridge + html[loc[1]:]
	}
	return bridge + html
}

func allowedResource(roots []string, requested string) (string, error) {
	if strings.ContainsRune(requested, '\x00') || strings.Contains(requested, "\\") {
		return "", errors.New("invalid resource path")
	}
	// vscode-uri encodes Windows file paths as /C:/... .
	if len(requested) > 3 && requested[0] == '/' && requested[2] == ':' {
		requested = requested[1:]
	}
	real, err := filepath.EvalSymlinks(filepath.FromSlash(requested))
	if err != nil {
		return "", err
	}
	for _, root := range roots {
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(realRoot, real)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			if stat, err := os.Stat(real); err == nil && stat.Mode().IsRegular() {
				return real, nil
			}
		}
	}
	return "", errors.New("resource is outside localResourceRoots")
}

func (a *App) viewEvents(w http.ResponseWriter, r *http.Request, view *View) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	since, _ := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	if since == 0 {
		since, _ = strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	}
	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()
	streamViewMessages(r.Context(), view, since, func(msg viewMessage) error {
		_, err := fmt.Fprintf(w, "id: %d\ndata: %s\n\n", msg.Sequence, msg.Data)
		flusher.Flush()
		return err
	}, func() error {
		_, err := fmt.Fprint(w, ": ping\n\n")
		flusher.Flush()
		return err
	})
}

func (a *App) viewSocket(w http.ResponseWriter, r *http.Request, view *View) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "WebSocket upgrade required", 400)
		return
	}
	// Upgraded sockets do not consume the browser's six HTTP/1 connections.
	// Each view keeps its token and exact Origin checks.
	server := websocket.Server{
		Handshake: func(_ *websocket.Config, request *http.Request) error {
			if request.Header.Get("Origin") != a.ViewURL {
				return errors.New("forbidden origin")
			}
			return nil
		},
		Handler: func(conn *websocket.Conn) {
			defer conn.Close()
			conn.MaxPayloadBytes = 1024
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			go func() {
				// This is receive-only. A read also detects the client closing.
				var ignored string
				_ = websocket.Message.Receive(conn, &ignored)
				cancel()
			}()
			send := func(value any) error {
				if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
					return err
				}
				return websocket.JSON.Send(conn, value)
			}
			since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
			streamViewMessages(ctx, view, since, func(msg viewMessage) error { return send(msg) },
				func() error { return send(map[string]bool{"ping": true}) })
		},
	}
	server.ServeHTTP(w, r)
}

func streamViewMessages(ctx context.Context, view *View, since int64, send func(viewMessage) error, heartbeat func() error) {
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		view.mu.Lock()
		var batch []viewMessage
		for _, msg := range view.messages {
			if msg.Sequence > since {
				batch = append(batch, msg)
			}
		}
		view.mu.Unlock()
		for _, msg := range batch {
			if err := send(msg); err != nil {
				return
			}
			since = msg.Sequence
		}
		if len(batch) > 0 {
			// The extension rehydrates a freshly loaded page. Keep only unacknowledged
			// messages plus a small reconnect window, not an entire conversation.
			view.mu.Lock()
			for len(view.messages) > 256 && view.messages[0].Sequence < since-128 {
				view.bytes -= len(view.messages[0].Data)
				view.messages = view.messages[1:]
			}
			view.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-view.done:
			return
		case <-view.wake:
		case <-ping.C:
			if err := heartbeat(); err != nil {
				return
			}
		}
	}
}

func openExternal(native Native, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http" && u.Scheme != "mailto") {
		return errors.New("only http, https and mailto links can be opened")
	}
	if native.OpenURL == nil {
		return errors.New("external links require desktop mode")
	}
	return native.OpenURL(raw)
}
