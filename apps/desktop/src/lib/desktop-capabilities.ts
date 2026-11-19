import { wailsCapabilities } from './wails-bridge'

// Detect the Wails shell: only the Wails runtime injects window.go.main.
export function isWailsShell(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).go?.main?.PythonManager !== 'undefined'
}

export type DesktopCapability =
  | 'multiWindow'
  | 'petOverlay'
  | 'vscodeThemes'
  | 'selfUpdate'
  | 'remoteGateway'
  | 'previewConsole'
  | 'previewDevTools'
  | 'previewLocalServer'
  // No <webview> element in WebKit: web previews fall back to <iframe>.
  | 'webview'
  // WebKit blanks cross-origin iframes that carry a `sandbox` attribute.
  | 'iframeSandbox'
  | 'nativeBrowser'

// Capability probe that works in both shells. In Electron everything is true
// (the preload implements all of it); in Wails it defers to wailsCapabilities.
export function desktopSupports(cap: DesktopCapability): boolean {
  if (!isWailsShell()) {
    return true
  }

  return wailsCapabilities[cap]
}
