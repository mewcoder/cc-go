package server

import (
	"context"
	"encoding/json"
	"errors"
)

// EnableNativeViews is set before the desktop shell loads. Browser/debug mode
// retains its HTTP transport; isolated extension frames never get native APIs.
func (a *App) EnableNativeViews() {
	a.mu.Lock()
	a.nativeViews = true
	a.mu.Unlock()
}

func (a *App) nativeView(id, token string) (*View, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	v := a.views[id]
	if !a.nativeViews || v == nil || !equalToken(token, v.Token) {
		return nil, errors.New("view is unavailable")
	}
	select {
	case <-v.done:
		return nil, errors.New("view is closed")
	default:
		return v, nil
	}
}

// StreamNativeView uses the framework's ordered, flow-controlled channel.
// Only unsent messages are retained, not a second replay/ACK protocol.
func (a *App) StreamNativeView(ctx context.Context, id, token string, send func(json.RawMessage) error, closeChannel func()) error {
	v, err := a.nativeView(id, token)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, closeChannel)
	defer stop()
	v.mu.Lock()
	if v.nativeCancel != nil {
		v.nativeCancel()
	}
	v.nativeCancel = cancel
	select {
	case <-v.done:
		cancel()
	default:
	}
	v.mu.Unlock()
	// A reload cancels the old channel before draining the same view again.
	v.nativeStreamMu.Lock()
	defer v.nativeStreamMu.Unlock()
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		v.mu.Lock()
		var message *viewMessage
		if len(v.messages) > 0 {
			value := v.messages[0]
			message = &value
		}
		v.mu.Unlock()
		if message != nil {
			if err := send(message.Data); err != nil {
				return err
			}
			v.mu.Lock()
			v.bytes -= len(v.messages[0].Data)
			v.messages[0] = viewMessage{}
			v.messages = v.messages[1:]
			if len(v.messages) == 0 {
				v.messages = nil
			}
			v.mu.Unlock()
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-v.done:
			return nil
		case <-v.wake:
		}
	}
}

func (a *App) ReceiveNativeView(id, token, endpoint string, value json.RawMessage) error {
	v, err := a.nativeView(id, token)
	if err != nil {
		return err
	}
	if len(value) > 16<<20 || !json.Valid(value) {
		return errors.New("invalid webview message")
	}
	switch endpoint {
	case "message":
		return a.receiveViewMessage(id, value)
	case "state":
		v.mu.Lock()
		v.state = append(json.RawMessage(nil), value...)
		v.mu.Unlock()
		return nil
	case "external":
		var raw string
		if err := json.Unmarshal(value, &raw); err != nil {
			return err
		}
		a.mu.Lock()
		native := a.native
		a.mu.Unlock()
		return openExternal(native, raw)
	default:
		return errors.New("unsupported webview operation")
	}
}
