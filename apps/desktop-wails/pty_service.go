//go:build !windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"

	"github.com/creack/pty"
)

type TerminalSession struct {
	ID        string
	Shell     string
	Cwd       string
	Cols      uint16
	Rows      uint16
	closeOnce sync.Mutex
	cmd       *exec.Cmd
	pty       *os.File
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

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to start PTY: %w", err)
	}

	session := &TerminalSession{
		ID:    id,
		cmd:   cmd,
		pty:   ptmx,
		Shell: shell,
		Cwd:   cwd,
		Cols:  cols,
		Rows:  rows,
	}

	pts.sessions[id] = session

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				session.bufferMu.Lock()
				session.buffer = append(session.buffer, buf[:n]...)
				session.bufferMu.Unlock()
			}
			if err != nil {
				if err != io.EOF {
					// Handle read errors
				}
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

	if !ok || session.pty == nil {
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

	if !ok || session.pty == nil {
		return fmt.Errorf("terminal session %s not found", id)
	}

	_, err := session.pty.WriteString(data)
	return err
}

func (pts *PTYService) ResizeTerminal(id string, cols, rows uint16) error {
	pts.mu.RLock()
	session, ok := pts.sessions[id]
	pts.mu.RUnlock()

	if !ok || session.pty == nil {
		return fmt.Errorf("terminal session %s not found", id)
	}

	session.Cols = cols
	session.Rows = rows

	return pty.Setsize(session.pty, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
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

	if session.pty != nil {
		_ = session.pty.Close()
	}
	if session.cmd != nil && session.cmd.Process != nil {
		_ = session.cmd.Process.Kill()
	}

	return nil
}
