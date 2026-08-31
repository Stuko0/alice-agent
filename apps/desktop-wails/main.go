package main

import (
	"context"
	"embed"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// ProxyApiRequest represents an API request to proxy to the Python backend
type ProxyApiRequest struct {
	Path   string `json:"path"`
	Method string `json:"method"`
	Body   string `json:"body"`
}

// ProxyApiResponse represents the response from the Python backend
type ProxyApiResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	pm := NewPythonManager()
	// Use the SAME PythonManager instance for both the app and the gateway
	app.PythonManager = pm
	gitService := NewGitService()
	fsService := NewFSService()
	logService := NewLogService()
	ptyService := NewPTYService()
	updateService := NewUpdateService()

	err := wails.Run(&options.App{
		Title:  "Alice Agent Desktop",
		Width:  1200,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 27, B: 27, A: 1},
		OnStartup: func(ctx context.Context) {
			app.startup(ctx)
			updateService.SetContext(ctx, pm.ResolveProjectRoot())
			pm.StartGateway()
		},
		Bind: []interface{}{
			app,
			pm,
			gitService,
			fsService,
			logService,
			ptyService,
			updateService,
		},
	})

	if err != nil {
		log.Fatal(err)
	}
}

// App struct
type App struct {
	PythonManager *PythonManager
	GitService    *GitService
	FSService     *FSService
	LogService    *LogService
	PTYService    *PTYService
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		PythonManager: NewPythonManager(),
		GitService:    NewGitService(),
		FSService:     NewFSService(),
		LogService:    NewLogService(),
		PTYService:    NewPTYService(),
	}
}

// NewUpdateService builds the self-update service, wired to the shared
// PythonManager for the project root + backend PID sparing.
func NewUpdateService() *UpdateService {
	pm := NewPythonManager()
	return &UpdateService{
		aliceHome: pm.aliceHome,
		backendPID: func() []int {
			return pm.GetBackendPIDs()
		},
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(_ context.Context) {
	// Note: StartGateway is called in main.go OnStartup, not here
}

// shutdown is called when the app is shutting down
func (a *App) shutdown(_ context.Context) {
	_ = a.PythonManager.StopGateway()
}

// GetAliceHome returns the Alice home directory
func (a *App) GetAliceHome() string {
	homeDir, _ := os.UserHomeDir()
	aliceHome := os.Getenv("ALICE_HOME")
	if aliceHome == "" {
		aliceHome = filepath.Join(homeDir, ".alice")
	}
	return aliceHome
}

// IsGatewayHealthy returns whether the backend is healthy
func (a *App) IsGatewayHealthy() bool {
	return a.PythonManager.IsHealthy()
}

// RestartGateway restarts the backend gateway
func (a *App) RestartGateway() error {
	if err := a.PythonManager.StopGateway(); err != nil {
		return err
	}
	return a.PythonManager.StartGateway()
}

// RevealLogs opens the logs directory in the OS file manager
func (a *App) RevealLogs() error {
	return a.LogService.RevealLogs()
}

// GetRecentLogs returns the last N lines of the agent log
func (a *App) GetRecentLogs(maxLines int) ([]string, error) {
	return a.LogService.GetRecentLogs(maxLines)
}

// ReadFileText reads a text file and returns its contents
func (a *App) ReadFileText(filePath string) (string, error) {
	return a.FSService.ReadFileText(filePath)
}

// ReadFileDataUrl reads a file and returns it as a data URL
func (a *App) ReadFileDataUrl(filePath string) (string, error) {
	return a.FSService.ReadFileDataUrl(filePath)
}

// WriteTextFile writes a text file
func (a *App) WriteTextFile(filePath string, content string) error {
	return a.FSService.WriteTextFile(filePath, content)
}

// TrashPath moves a file/directory to the trash
func (a *App) TrashPath(targetPath string) error {
	return a.FSService.TrashPath(targetPath)
}

// RenamePath renames a file/directory
func (a *App) RenamePath(targetPath string, newName string) (string, error) {
	return a.FSService.RenamePath(targetPath, newName)
}

// RevealPath shows a file in the OS file manager
func (a *App) RevealPath(targetPath string) error {
	return a.FSService.RevealPath(targetPath)
}

// PathExists checks if a path exists
func (a *App) PathExists(targetPath string) bool {
	return a.FSService.PathExists(targetPath)
}

// OpenExternal opens a URL in the default browser
func (a *App) OpenExternal(url string) error {
	return a.FSService.OpenExternal(url)
}

// ProxyApi forwards an API request to the Python backend and returns the result.
// This avoids WebKit CORS/origin issues when calling Python directly from the browser.
func (a *App) ProxyApi(req ProxyApiRequest) (*ProxyApiResponse, error) {
	pm := a.PythonManager
	pm.mu.Lock()
	port := pm.port
	token := pm.sessionToken
	pm.mu.Unlock()

	if port == 0 {
		return nil, fmt.Errorf("backend not ready")
	}

	url := fmt.Sprintf("http://127.0.0.1:%d%s", port, req.Path)
	log.Printf("[Proxy] %s %s", req.Method, url)

	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = strings.NewReader(req.Body)
	}
	httpReq, err := http.NewRequest(req.Method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	if token != "" {
		httpReq.Header.Set("X-Alice-Session-Token", token)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		log.Printf("[Proxy] ERROR: %v", err)
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	log.Printf("[Proxy] Response: status=%d body_len=%d body_preview=%.100s", resp.StatusCode, len(body), string(body))

	return &ProxyApiResponse{
		Status: resp.StatusCode,
		Body:   string(body),
	}, nil
}

// WriteFrontendLog writes a message from the frontend to the debug log file
func (a *App) WriteFrontendLog(msg string) {
	f, err := os.OpenFile(filepath.Join(os.TempDir(), "wails-debug.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "[Frontend] %s\n", msg)
}

// WriteErrorLog writes an error message to the error log file
func (a *App) WriteErrorLog(msg string) {
	f, err := os.OpenFile(filepath.Join(os.TempDir(), "wails-errors.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "[ERROR] %s\n", msg)
}
