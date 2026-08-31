//go:build !windows

package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const deepLinkProtocol = "alice://"

// acquireSingleInstance binds a unix socket at $ALICE_HOME/desktop.sock.
// Returns a listener when this process is the primary instance; if another
// instance already holds the socket, returns (nil, false) — the caller should
// forward any deep link and exit.
func acquireSingleInstance(aliceHome string) (net.Listener, bool) {
	sockPath := filepath.Join(aliceHome, "desktop.sock")
	_ = os.Remove(sockPath) // stale socket left by a previous crash
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, false
	}
	return ln, true
}

// forwardDeepLink sends a URL to the primary instance's socket (fire and
// forget — the primary emits it to the frontend).
func forwardDeepLink(aliceHome, url string) {
	conn, err := net.Dial("unix", filepath.Join(aliceHome, "desktop.sock"))
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(url))
}

// serveDeepLink accepts deep-link URLs on the socket and relays them to the
// renderer via the "alice:deep-link" Wails event.
func serveDeepLink(ln net.Listener, ctx context.Context) {
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			buf := make([]byte, 4096)
			n, _ := conn.Read(buf)
			_ = conn.Close()
			url := strings.TrimSpace(string(buf[:n]))
			if url != "" && ctx != nil {
				wailsruntime.EventsEmit(ctx, "alice:deep-link", url)
			}
		}
	}()
}

// deepLinkArg returns the alice:// URL in argv, if any.
func deepLinkArg(args []string) string {
	for _, a := range args {
		if strings.HasPrefix(a, deepLinkProtocol) {
			return a
		}
	}
	return ""
}