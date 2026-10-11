package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Concurrent identical GETs must share one upstream request. Several session
// composers poll the same endpoint (model.options), so without coalescing the
// backend receives N copies of the same work at once.
func TestDoProxyCoalescesIdenticalInFlightGets(t *testing.T) {
	var hits int32
	release := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		<-release
		io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	a := &App{}
	url := srv.URL + "/api/model/options?x=1"

	const n = 5
	results := make([]*ProxyApiResponse, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = a.doProxy("GET", url, "tok", "")
		}(i)
	}

	// Let every goroutine join the in-flight call before the upstream answers.
	time.Sleep(150 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("upstream hits = %d, want 1 (coalesced)", got)
	}
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("call %d error: %v", i, errs[i])
		}
		if results[i].Status != 200 || results[i].Body != `{"ok":true}` {
			t.Fatalf("call %d got status=%d body=%q", i, results[i].Status, results[i].Body)
		}
	}
}

// Non-GET requests must never be coalesced: each one has side effects.
func TestDoProxyDoesNotCoalescePosts(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		time.Sleep(50 * time.Millisecond)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	a := &App{}
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = a.doProxy("POST", srv.URL+"/api/x", "", `{"a":1}`)
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&hits); got != 3 {
		t.Fatalf("POST upstream hits = %d, want 3", got)
	}
}

// Different tokens are different callers; a coalesced response must not leak
// across session tokens.
func TestDoProxyDoesNotCoalesceAcrossTokens(t *testing.T) {
	var hits int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		<-release
		io.WriteString(w, r.Header.Get("X-Alice-Session-Token"))
	}))
	defer srv.Close()

	a := &App{}
	url := srv.URL + "/api/status"
	var wg sync.WaitGroup
	bodies := make([]string, 2)
	for i, tok := range []string{"a", "b"} {
		wg.Add(1)
		go func(i int, tok string) {
			defer wg.Done()
			r, _ := a.doProxy("GET", url, tok, "")
			bodies[i] = r.Body
		}(i, tok)
	}
	time.Sleep(150 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("hits = %d, want 2 (different tokens)", got)
	}
	if bodies[0] != "a" || bodies[1] != "b" {
		t.Fatalf("bodies = %q, want [a b]", bodies)
	}
}
