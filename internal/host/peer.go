package host

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

type Message struct {
	Kind   string          `json:"kind"`
	ID     int64           `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Args   json.RawMessage `json:"args,omitempty"`
	Value  json.RawMessage `json:"value,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Message string `json:"message"`
}

type Handler func(context.Context, string, json.RawMessage) (any, error)

type Peer struct {
	cmd       *exec.Cmd
	input     io.WriteCloser
	writeMu   sync.Mutex
	mu        sync.Mutex
	pending   map[int64]chan Message
	sequence  atomic.Int64
	ready     chan struct{}
	done      chan struct{}
	readyOnce sync.Once
	handler   Handler
	event     func(string, json.RawMessage)
}

func Start(node, script, directory string, env []string, handler Handler, event func(string, json.RawMessage), output io.Writer) (*Peer, error) {
	cmd := exec.Command(node, script)
	cmd.Dir, cmd.Env, cmd.Stderr = directory, env, output
	configureProcess(cmd)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	p := &Peer{cmd: cmd, input: in, pending: make(map[int64]chan Message), ready: make(chan struct{}), done: make(chan struct{}), handler: handler, event: event}
	if err := cmd.Start(); err != nil {
		in.Close()
		out.Close()
		return nil, err
	}
	go func() {
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 65536), 32<<20)
		for scanner.Scan() {
			var m Message
			if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
				fmt.Fprintf(output, "Invalid plugin protocol frame: %v\n", err)
				continue
			}
			switch m.Kind {
			case "result":
				p.mu.Lock()
				ch := p.pending[m.ID]
				delete(p.pending, m.ID)
				p.mu.Unlock()
				if ch != nil {
					ch <- m
				}
			case "event":
				if m.Method == "host.ready" {
					p.readyOnce.Do(func() { close(p.ready) })
				}
				// Preserve create/options/html ordering; calls are dispatched separately.
				if event != nil {
					event(m.Method, m.Args)
				}
			case "call":
				go p.respond(m)
			}
		}
		if err := scanner.Err(); err != nil {
			fmt.Fprintf(output, "Plugin protocol read: %v\n", err)
			terminateProcess(cmd)
		}
		err := cmd.Wait()
		close(p.done)
		if event != nil {
			b, _ := json.Marshal(map[string]any{"message": fmt.Sprintf("Plugin host exited: %v", err)})
			event("host.exit", b)
		}
	}()
	return p, nil
}

func (p *Peer) respond(m Message) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var value any
	var err error
	if p.handler == nil {
		err = fmt.Errorf("unsupported host RPC: %s", m.Method)
	} else {
		value, err = p.handler(ctx, m.Method, m.Args)
	}
	result := Message{Kind: "result", ID: m.ID}
	if err != nil {
		result.Error = &RPCError{Message: err.Error()}
	} else {
		result.Value, _ = json.Marshal(value)
	}
	_ = p.send(result)
}

func (p *Peer) send(m Message) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	select {
	case <-p.done:
		return errors.New("plugin host disconnected")
	default:
	}
	return json.NewEncoder(p.input).Encode(m)
}

func (p *Peer) Ready(ctx context.Context) error {
	select {
	case <-p.ready:
		return nil
	case <-p.done:
		return errors.New("plugin host exited before initialization")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *Peer) Call(ctx context.Context, method string, args any) (json.RawMessage, error) {
	id := p.sequence.Add(1)
	ch := make(chan Message, 1)
	p.mu.Lock()
	p.pending[id] = ch
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, id); p.mu.Unlock() }()
	b, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	if err := p.send(Message{Kind: "call", ID: id, Method: method, Args: b}); err != nil {
		return nil, err
	}
	select {
	case m := <-ch:
		if m.Error != nil {
			return nil, errors.New(m.Error.Message)
		}
		return m.Value, nil
	case <-p.done:
		return nil, errors.New("plugin host disconnected")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *Peer) Notify(method string, args any) error {
	b, err := json.Marshal(args)
	if err != nil {
		return err
	}
	return p.send(Message{Kind: "event", Method: method, Args: b})
}

func (p *Peer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = p.Call(ctx, "shutdown", nil)
	_ = p.input.Close()
	select {
	case <-p.done:
	case <-ctx.Done():
	}
	// Also terminate any CLI processes left behind by the extension.
	terminateProcess(p.cmd)
}
