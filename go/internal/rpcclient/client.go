// Package rpcclient is a client for the Alice JSON-RPC gateway.
//
// It owns the transport concerns the UI clients share: spawning the backend,
// waiting for gateway.ready, matching responses to requests by id, and
// delivering events on a channel. It knows nothing about individual methods.
package rpcclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"

	"github.com/Stuko0/alice-agent/go/internal/protocol"
)

// ErrClosed is returned by calls made after the backend went away.
var ErrClosed = errors.New("rpcclient: connection closed")

// Options configures Start.
type Options struct {
	// Python is the interpreter that owns alice_cli/tui_gateway.
	Python string
	// Args defaults to ["-m", "tui_gateway.entry"].
	Args []string
	// Dir is the working directory for the child (a checkout root, so the
	// package resolves without being installed).
	Dir string
	// Env replaces the child environment when non-nil; nil inherits os.Environ.
	Env []string
	// EventBuffer is the events channel capacity (default 64).
	EventBuffer int
}

// Client is a live gateway connection.
type Client struct {
	events chan protocol.Event
	writer *protocol.Writer
	close  func() error

	done chan struct{}
	once sync.Once
	// doneOnce guards close(done): Close() and the read loop can both end the
	// connection, and a non-atomic "is it closed?" check would double-close.
	doneOnce sync.Once

	mu      sync.Mutex
	pending map[string]chan *protocol.Response
	nextID  int64
	err     error

	// Ready is the gateway.ready frame received during Start.
	Ready protocol.Event
}

// Start spawns the backend and waits for gateway.ready.
func Start(ctx context.Context, opts Options) (*Client, error) {
	if opts.Python == "" {
		return nil, errors.New("rpcclient: Python interpreter is required")
	}
	args := opts.Args
	if len(args) == 0 {
		args = []string{"-m", "tui_gateway.entry"}
	}
	env := opts.Env
	if env == nil {
		env = os.Environ()
	}

	cmd := exec.Command(opts.Python, args...)
	cmd.Dir = opts.Dir
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("rpcclient: stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("rpcclient: stdout: %w", err)
	}
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("rpcclient: start gateway: %w", err)
	}

	client := newClient(stdout, stdin, func() error {
		_ = stdin.Close()
		return cmd.Wait()
	}, opts.EventBuffer)

	if err := client.waitReady(ctx); err != nil {
		_ = client.Close()
		return nil, err
	}
	return client, nil
}

func newClient(r io.Reader, w io.WriteCloser, closeFn func() error, eventBuffer int) *Client {
	if eventBuffer <= 0 {
		eventBuffer = 64
	}
	c := &Client{
		events:  make(chan protocol.Event, eventBuffer),
		writer:  protocol.NewWriter(w),
		close:   closeFn,
		done:    make(chan struct{}),
		pending: make(map[string]chan *protocol.Response),
	}
	go c.readLoop(r)
	return c
}

// Events delivers backend events. It is closed when the connection ends.
func (c *Client) Events() <-chan protocol.Event { return c.events }

// Done is closed when the connection ends.
func (c *Client) Done() <-chan struct{} { return c.done }

// Err reports why the connection ended, if it did.
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Call sends one request and returns its raw result.
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	payload := json.RawMessage(`{}`)
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return nil, fmt.Errorf("rpcclient: encode params: %w", err)
		}
		payload = raw
	}

	c.mu.Lock()
	c.nextID++
	id := strconv.FormatInt(c.nextID, 10)
	ch := make(chan *protocol.Response, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	if err := c.writer.Write(protocol.Request{
		JSONRPC: protocol.Version,
		ID:      json.RawMessage(id),
		Method:  method,
		Params:  payload,
	}); err != nil {
		return nil, fmt.Errorf("rpcclient: write %s: %w", method, err)
	}

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-c.done:
		if err := c.Err(); err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		return nil, ErrClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// CallInto sends a request and decodes the result into out.
func (c *Client) CallInto(ctx context.Context, method string, params, out any) error {
	raw, err := c.Call(ctx, method, params)
	if err != nil {
		return err
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// Close stops the backend and releases resources. It is idempotent.
func (c *Client) Close() error {
	var err error
	c.once.Do(func() {
		c.markDone()
		if c.close != nil {
			err = c.close()
		}
	})
	return err
}

func (c *Client) markDone() { c.doneOnce.Do(func() { close(c.done) }) }

func (c *Client) readLoop(r io.Reader) {
	reader := protocol.NewReader(r)
	defer close(c.events)

	for {
		frame, err := reader.Next()
		if err != nil {
			c.mu.Lock()
			c.err = err
			c.mu.Unlock()
			c.markDone()
			return
		}

		switch frame.Kind {
		case protocol.KindResponse:
			key := string(frame.Response.ID)
			c.mu.Lock()
			ch := c.pending[key]
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- frame.Response:
				default:
					// A duplicate response for the same id: keep the first.
				}
			}

		case protocol.KindEvent:
			select {
			case c.events <- *frame.Event:
			case <-c.done:
				return
			}
		}
	}
}

func (c *Client) waitReady(ctx context.Context) error {
	for {
		select {
		case ev, ok := <-c.events:
			if !ok {
				return fmt.Errorf("rpcclient: gateway closed before gateway.ready: %w", c.Err())
			}
			if ev.Type == "gateway.ready" {
				c.Ready = ev
				return nil
			}
		case <-c.done:
			return fmt.Errorf("rpcclient: gateway closed before gateway.ready: %w", c.Err())
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
