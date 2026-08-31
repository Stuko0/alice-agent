//go:build windows

package main

import (
	"context"
	"net"
	"strings"
)

// Windows single-instance / deep-link handling is a stub for now: a second
// instance simply starts alongside the first, and alice:// URLs are not
// forwarded (the protocol registration + mutex flow is a follow-up). The
// primary-instance socket lives only on POSIX.

func acquireSingleInstance(_ string) (net.Listener, bool) {
	return &stubListener{}, true
}

type stubListener struct{}

func (*stubListener) Accept() (net.Conn, error) { return nil, nil }
func (*stubListener) Close() error              { return nil }
func (*stubListener) Addr() net.Addr            { return nil }

func forwardDeepLink(_ string, _ string) {}

func serveDeepLink(_ net.Listener, _ context.Context) {}

func deepLinkArg(args []string) string {
	for _, a := range args {
		if strings.HasPrefix(a, "alice://") {
			return a
		}
	}
	return ""
}