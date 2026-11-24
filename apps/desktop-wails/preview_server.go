package main

// Loopback preview server.
//
// Why this exists: the Wails shell used to point a plain <iframe> at a
// `file://` URL for local HTML previews. WebKitGTK treats `file://` documents
// as opaque origins and applies strict restrictions, so a real project page
// (relative CSS/JS/images, ES modules, fetch) rendered blank or half-broken —
// the Electron shell masked the same case with its <webview>. Serving the
// HTML from a token-scoped loopback HTTP origin restores normal web semantics
// (same-origin assets, module scripts, fetch) without exposing the file
// system outside the previewed file's directory.
//
// Security model:
//   - bind 127.0.0.1 only (never 0.0.0.0);
//   - one random token per preview session, in memory only, never logged;
//   - every request path is resolved and confined to the previewed file's
//     directory, symlinks included;
//   - dotfiles and common secret/key material are refused outright;
//   - responses are `no-store` + `nosniff`, and HTML documents carry a CSP
//     that blocks outbound network access (connect-src 'self'), so a
//     malicious page cannot exfiltrate local content through fetch.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	previewMountPrefix = "/p/"
	previewDefaultPort = 0 // ephemeral

	// previewCSP blocks network egress from previewed documents. Local
	// assets still load because the whole page is served from this origin.
	// `script-src 'unsafe-inline'` is intentional: most hand-written local
	// HTML uses inline handlers/scripts, and this origin is token-scoped,
	// loopback-only and isolated from the app shell.
	previewCSP = "default-src 'self'; " +
		"img-src 'self' data: blob:; " +
		"media-src 'self' data: blob:; " +
		"style-src 'self' 'unsafe-inline'; " +
		"script-src 'self' 'unsafe-inline'; " +
		"font-src 'self' data:; " +
		"connect-src 'self'; " +
		"base-uri 'self'; " +
		"form-action 'self'"

	// Images above this size are downscaled for preview. Below it the file is
	// streamed as-is (cheaper than re-encoding, and preserves animation).
	previewImageThumbSourceDim = 2048
	previewImageThumbTargetDim = 1024
	previewImageCacheLimit     = 32
)

// mimeOverrides wins over the platform mime table. Go's table is incomplete on
// some Linux images for the module/JS types that matter most to HTML previews.
var mimeOverrides = map[string]string{
	".css":  "text/css; charset=utf-8",
	".htm":  "text/html; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".svg":  "image/svg+xml",
	".wasm": "application/wasm",
	".xml":  "application/xml; charset=utf-8",
}

var errPreviewNotFound = errors.New("preview file not found")

type previewSession struct {
	id      string
	token   string
	baseDir string
	entry   string
	image   bool

	// Image sessions serve bytes captured at start time (thumbnail or the
	// original file). File sessions stream from baseDir on every request.
	imageData []byte
	imageMime string

	listener net.Listener
	server   *http.Server
}

type cachedPreviewImage struct {
	data []byte
	mime string
	// lastUsed is a monotonic counter snapshot; eviction is oldest-first.
	lastUsed uint64
}

// PreviewServerService owns every live preview origin. Bound through App so
// the renderer can start/stop one per local HTML (or image) preview.
type PreviewServerService struct {
	mu       sync.Mutex
	sessions map[string]*previewSession // keyed by session id
	byToken  map[string]*previewSession
	seq      int

	images   map[string]*cachedPreviewImage
	imgClock uint64
	imgGen   int // thumbnail generations; observable from tests
}

func NewPreviewServerService() *PreviewServerService {
	return &PreviewServerService{
		sessions: map[string]*previewSession{},
		byToken:  map[string]*previewSession{},
		images:   map[string]*cachedPreviewImage{},
	}
}

func previewToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate preview token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// StartForFile serves the file's directory at the session root, with the file
// itself as the entry document. The returned url is safe to hand to an iframe.
func (ps *PreviewServerService) StartForFile(filePath string) (map[string]string, error) {
	absPath, err := filepath.Abs(strings.TrimSpace(filePath))
	if err != nil || strings.TrimSpace(filePath) == "" {
		return nil, fmt.Errorf("invalid preview path")
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("preview file is not readable: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("preview target is a directory")
	}

	baseDir := filepath.Dir(absPath)
	entry := filepath.Base(absPath)
	if previewPathDenied(entry) {
		return nil, fmt.Errorf("preview target is not allowed")
	}

	return ps.start(absPath, baseDir, entry, false, nil, "")
}

// StartForImage serves a single image. Large raster images are downscaled to
// keep the renderer from decoding a multi-megapixel file into the DOM; animated
// GIFs and formats Go cannot decode are streamed untouched.
func (ps *PreviewServerService) StartForImage(filePath string) (map[string]string, error) {
	absPath, err := filepath.Abs(strings.TrimSpace(filePath))
	if err != nil || strings.TrimSpace(filePath) == "" {
		return nil, fmt.Errorf("invalid preview path")
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("preview file is not readable: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("preview target is a directory")
	}

	data, mimeType, err := ps.imagePayload(absPath, info)
	if err != nil {
		return nil, err
	}

	return ps.start(absPath, filepath.Dir(absPath), filepath.Base(absPath), true, data, mimeType)
}

func (ps *PreviewServerService) start(absPath, baseDir, entry string, isImage bool, data []byte, mimeType string) (map[string]string, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", previewDefaultPort))
	if err != nil {
		return nil, fmt.Errorf("failed to start preview server: %w", err)
	}

	token, err := previewToken()
	if err != nil {
		_ = ln.Close()
		return nil, err
	}

	ps.mu.Lock()
	ps.seq++
	id := fmt.Sprintf("preview-%d-%d", time.Now().UnixNano(), ps.seq)
	session := &previewSession{
		id:        id,
		token:     token,
		baseDir:   baseDir,
		entry:     entry,
		image:     isImage,
		imageData: data,
		imageMime: mimeType,
		listener:  ln,
	}
	session.server = &http.Server{
		Handler:           http.HandlerFunc(ps.handle),
		ReadHeaderTimeout: 5 * time.Second,
	}
	ps.sessions[id] = session
	ps.byToken[token] = session
	ps.mu.Unlock()

	go func() {
		// Serve returns http.ErrServerClosed on Close(); everything else is a
		// dead listener for this preview and there is nothing to recover.
		_ = session.server.Serve(ln)
	}()

	return map[string]string{
		"id":   id,
		"url":  fmt.Sprintf("http://%s%s%s/", ln.Addr().String(), previewMountPrefix, token),
		"path": absPath,
	}, nil
}

// Stop tears a preview origin down. Idempotent: unknown ids return false.
func (ps *PreviewServerService) Stop(id string) (bool, error) {
	ps.mu.Lock()
	session, ok := ps.sessions[id]
	if ok {
		delete(ps.sessions, id)
		delete(ps.byToken, session.token)
	}
	ps.mu.Unlock()

	if !ok {
		return false, nil
	}
	if err := session.server.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return false, err
	}
	return true, nil
}

// Shutdown closes every live preview origin. Wired to app shutdown.
func (ps *PreviewServerService) Shutdown() {
	ps.mu.Lock()
	sessions := make([]*previewSession, 0, len(ps.sessions))
	for _, session := range ps.sessions {
		sessions = append(sessions, session)
	}
	ps.sessions = map[string]*previewSession{}
	ps.byToken = map[string]*previewSession{}
	ps.mu.Unlock()

	for _, session := range sessions {
		_ = session.server.Close()
	}
}

func (ps *PreviewServerService) handle(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, previewMountPrefix) {
		http.NotFound(w, r)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, previewMountPrefix)
	token, rel, _ := strings.Cut(rest, "/")

	ps.mu.Lock()
	session := ps.byToken[token]
	ps.mu.Unlock()

	if session == nil {
		// 404 rather than 403: an invalid token should not confirm that a
		// preview origin is listening.
		http.NotFound(w, r)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if session.image {
		ps.serveImage(w, r, session)
		return
	}

	setPreviewHeaders(w)
	if rel == "" || rel == "." {
		rel = session.entry
	}

	target, err := safePreviewJoin(session.baseDir, rel)
	if err != nil {
		if errors.Is(err, errPreviewNotFound) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if previewPathDenied(rel) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}

	f, err := os.Open(target)
	if err != nil {
		http.Error(w, "unreadable", http.StatusForbidden)
		return
	}
	defer f.Close()

	contentType := previewContentType(target)
	w.Header().Set("Content-Type", contentType)
	// ServeContent handles Range/If-Modified-Since; no-store above keeps
	// hot-reload honest (a cached asset would mask the file change).
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

func (ps *PreviewServerService) serveImage(w http.ResponseWriter, _ *http.Request, session *previewSession) {
	setPreviewHeaders(w)
	w.Header().Set("Content-Type", session.imageMime)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(session.imageData)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(session.imageData)
}

func setPreviewHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", previewCSP)
}

func previewContentType(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if override, ok := mimeOverrides[ext]; ok {
		return override
	}
	if byExt := mime.TypeByExtension(ext); byExt != "" {
		return byExt
	}
	return "application/octet-stream"
}

// safePreviewJoin resolves a URL path inside baseDir, rejecting traversal and
// symlinks that escape the directory. The file must exist.
func safePreviewJoin(baseDir, rel string) (string, error) {
	// URL paths use '/', but a client can smuggle '%5C' (a Windows separator)
	// through. Normalise before cleaning so `..\..\secret` cannot traverse on
	// Windows.
	normalized := strings.ReplaceAll(rel, "\\", "/")
	clean := path.Clean("/" + normalized)
	rel = strings.TrimPrefix(clean, "/")
	if rel == "" || rel == "." {
		return "", fmt.Errorf("empty preview path")
	}

	target := filepath.Join(baseDir, filepath.FromSlash(rel))

	realBase, err := filepath.EvalSymlinks(baseDir)
	if err != nil {
		return "", err
	}
	realTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		if os.IsNotExist(err) {
			return "", errPreviewNotFound
		}
		return "", err
	}

	inside, err := filepath.Rel(realBase, realTarget)
	if err != nil {
		return "", err
	}
	if inside == ".." || strings.HasPrefix(inside, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("preview path escapes the preview directory")
	}
	return realTarget, nil
}

// previewPathDenied refuses dotfile segments and common secret/key stores.
// A preview only needs ordinary web assets; `.env`, `.git/`, private keys and
// local databases have no business travelling over an iframe origin.
func previewPathDenied(rel string) bool {
	normalized := strings.ReplaceAll(rel, "\\", "/")
	for _, segment := range strings.Split(normalized, "/") {
		if segment == "" || segment == "." {
			continue
		}
		if strings.HasPrefix(segment, ".") {
			return true
		}
	}

	base := strings.ToLower(path.Base(normalized))
	ext := strings.ToLower(path.Ext(base))

	switch ext {
	// Secret material and local state.
	case ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".db", ".sqlite", ".sqlite3", ".kdbx":
		return true
	// Native executables/libraries: a preview has no use for them and serving
	// them only widens what an iframe can pull off disk. Downloads of ordinary
	// assets (zip, pdf, wasm) stay available.
	case ".exe", ".dll", ".so", ".dylib", ".msi", ".scr", ".com", ".apk", ".dmg":
		return true
	}

	switch {
	case strings.HasPrefix(base, "id_rsa"),
		strings.HasPrefix(base, "id_ed25519"),
		strings.HasPrefix(base, "id_ecdsa"):
		return true
	}
	return false
}

// imagePayload returns the bytes to serve for an image preview. Raster images
// larger than previewImageThumbSourceDim on either axis are downscaled and
// cached (keyed by path+mtime+size); everything else streams unchanged.
func (ps *PreviewServerService) imagePayload(absPath string, info os.FileInfo) ([]byte, string, error) {
	mimeType := previewContentType(absPath)
	ext := strings.ToLower(filepath.Ext(absPath))

	// Animated GIFs must keep their frames. SVG is vector and already cheap.
	if ext == ".gif" || ext == ".svg" || ext == ".webp" || ext == ".bmp" {
		data, err := os.ReadFile(absPath)
		if err != nil {
			return nil, "", fmt.Errorf("failed to read image: %w", err)
		}
		return data, mimeType, nil
	}

	key := fmt.Sprintf("%s|%d|%d", absPath, info.ModTime().UnixNano(), info.Size())

	ps.mu.Lock()
	if cached, ok := ps.images[key]; ok {
		ps.imgClock++
		cached.lastUsed = ps.imgClock
		data, mime := cached.data, cached.mime
		ps.mu.Unlock()
		return data, mime, nil
	}
	ps.mu.Unlock()

	data, thumbMime, generated, err := generatePreviewThumbnail(absPath, previewImageThumbSourceDim, previewImageThumbTargetDim)
	if err != nil {
		// Undecodable format (or a corrupt image): let the renderer try the
		// original bytes instead of failing the preview outright.
		raw, readErr := os.ReadFile(absPath)
		if readErr != nil {
			return nil, "", fmt.Errorf("failed to read image: %w", readErr)
		}
		return raw, mimeType, nil
	}
	if !generated {
		raw, readErr := os.ReadFile(absPath)
		if readErr != nil {
			return nil, "", fmt.Errorf("failed to read image: %w", readErr)
		}
		return raw, mimeType, nil
	}

	ps.mu.Lock()
	ps.imgGen++
	ps.imgClock++
	ps.images[key] = &cachedPreviewImage{data: data, mime: thumbMime, lastUsed: ps.imgClock}
	ps.evictImagesLocked()
	ps.mu.Unlock()

	return data, thumbMime, nil
}

func (ps *PreviewServerService) evictImagesLocked() {
	for len(ps.images) > previewImageCacheLimit {
		var oldestKey string
		var oldest uint64
		for key, entry := range ps.images {
			if oldestKey == "" || entry.lastUsed < oldest {
				oldestKey, oldest = key, entry.lastUsed
			}
		}
		delete(ps.images, oldestKey)
	}
}

// generatePreviewThumbnail decodes a raster image and scales it down when
// either dimension exceeds maxSourceDim. Pure stdlib (nearest-neighbour): the
// preview only needs a legible proxy, and keeping x/image out of go.mod avoids
// a new supply-chain surface in the desktop shell.
func generatePreviewThumbnail(filePath string, maxSourceDim, targetDim int) ([]byte, string, bool, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, "", false, err
	}
	defer f.Close()

	src, _, err := image.Decode(io.LimitReader(f, 64<<20))
	if err != nil {
		return nil, "", false, err
	}

	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, "", false, fmt.Errorf("empty image")
	}
	if max(width, height) <= maxSourceDim {
		return nil, "", false, nil
	}

	dst := scaleNearest(src, targetDim)
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, "", false, err
	}
	return out.Bytes(), "image/png", true, nil
}

func scaleNearest(src image.Image, maxDim int) *image.RGBA {
	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	scale := float64(maxDim) / float64(max(width, height))
	dstW := int(float64(width) * scale)
	dstH := int(float64(height) * scale)
	if dstW < 1 {
		dstW = 1
	}
	if dstH < 1 {
		dstH = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	for y := 0; y < dstH; y++ {
		srcY := bounds.Min.Y + y*height/dstH
		for x := 0; x < dstW; x++ {
			srcX := bounds.Min.X + x*width/dstW
			dst.Set(x, y, src.At(srcX, srcY))
		}
	}
	return dst
}
