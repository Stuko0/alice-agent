//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
)

// Windows build of the terminal service. Windows has no POSIX PTY device, so
// this implementation drives the shell through stdio pipes: input is written
// to the child's stdin, output is captured from its stdout (stderr merged in).
// Resize is a no-op (no terminal emulation at the OS level); the frontend
// terminal still works but without real resize semantics.
//
// The exported TerminalSession shape mirrors the POSIX build so the Wails
// bindings (and the renderer) are identical on both platforms.

type TerminalSession struct {
	ID        string
	Shell     string
	Cwd       string
	Cols      uint16
	Rows      uint16
	closeOnce sync.Mutex
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    io.ReadCloser
	buffer    []byte
	bufferMu  sync.Mutex
}

type PTYService struct {
	sessions map[string]*TerminalSession
	mu       sync.RWMutex
	nextID   int
}

func NewPTYService() *PTYService {
	return &PTYService{
		sessions: make(map[string]*TerminalSession),
	}
}

func (pts *PTYService) StartTerminal(cwd string, cols, rows uint16) (*TerminalSession, error) {
	pts.mu.Lock()
	defer pts.mu.Unlock()

	pts.nextID++
	id := fmt.Sprintf("term-%d", pts.nextID)

	shell := os.Getenv("SHELL")
	if shell == "" {
		if runtime.GOOS == "windows" {
			shell = "powershell.exe"
		} else {
			shell = "/bin/bash"
		}
	}

	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}

	cmd := exec.Command(shell)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to open stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to open stdout pipe: %w", err)
	}
	// Merge stderr into the captured stream so error output is not lost.
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start shell: %w", err)
	}

	session := &TerminalSession{
		ID:     id,
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		Shell:  shell,
		Cwd:    cwd,
		Cols:   cols,
		Rows:   rows,
	}

	pts.sessions[id] = session

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				session.bufferMu.Lock()
				session.buffer = append(session.buffer, buf[:n]...)
				session.bufferMu.Unlock()
			}
			if err != nil {
				break
			}
		}

		_ = cmd.Wait()
		pts.DisposeTerminal(id)
	}()

	return session, nil
}

func (pts *PTYService) ReadTerminal(id string) string {
	pts.mu.RLock()
	session, ok := pts.sessions[id]
	pts.mu.RUnlock()

	if !ok || session.stdout == nil {
		return ""
	}

	session.bufferMu.Lock()
	data := string(session.buffer)
	session.buffer = nil
	session.bufferMu.Unlock()

	return data
}

func (pts *PTYService) WriteTerminal(id string, data string) error {
	pts.mu.RLock()
	session, ok := pts.sessions[id]
	pts.mu.RUnlock()

	if !ok || session.stdin == nil {
		return fmt.Errorf("terminal session %s not found", id)
	}

	_, err := io.WriteString(session.stdin, data)
	return err
}

func (pts *PTYService) ResizeTerminal(id string, cols, rows uint16) error {
	pts.mu.RLock()
	session, ok := pts.sessions[id]
	pts.mu.RUnlock()

	if !ok {
		return fmt.Errorf("terminal session %s not found", id)
	}

	session.Cols = cols
	session.Rows = rows
	// No PTY on Windows — nothing to resize at the OS level.
	return nil
}

func (pts *PTYService) DisposeTerminal(id string) error {
	pts.mu.Lock()
	session, ok := pts.sessions[id]
	if ok {
		delete(pts.sessions, id)
	}
	pts.mu.Unlock()

	if !ok || session == nil {
		return nil
	}

	session.closeOnce.Lock()
	defer session.closeOnce.Unlock()

	if session.stdin != nil {
		_ = session.stdin.Close()
	}
	if session.stdout != nil {
		_ = session.stdout.Close()
	}
	if session.cmd != nil && session.cmd.Process != nil {
		_ = session.cmd.Process.Kill()
	}

	return nil
}
