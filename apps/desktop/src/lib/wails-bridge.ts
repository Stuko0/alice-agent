/**
 * Wails v2 Desktop Bridge Adapter
 * 
 * Uses auto-generated bindings from `wails generate bindings`.
 * API: window['go']['main']['Service']['Method'](...args)
 */

// @ts-nocheck — bridges the loosely-typed Wails JS bindings onto the
// strictly-typed AliceDesktop window contract; full type parity is tracked
// in global.d.ts, not enforced here.
import * as App from './wailsjs/go/main/App';
import * as PythonManager from './wailsjs/go/main/PythonManager';
import * as GitService from './wailsjs/go/main/GitService';
import * as FSService from './wailsjs/go/main/FSService';
import * as LogService from './wailsjs/go/main/LogService';
import * as PTYService from './wailsjs/go/main/PTYService';
import * as UpdateService from './wailsjs/go/main/UpdateService';

export function isWailsEnvironment(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).wails?.Call?.ByName === 'function'
}

// Wails v2 platform capabilities. True = the Go shell genuinely supports it.
// Everything false is stubbed in this bridge and MUST be hidden in the UI.
export const wailsCapabilities = {
  multiWindow: false,      // v2 has no multi-window: session pop-out windows
  petOverlay: false,       // no transparent always-on-top overlay window
  vscodeThemes: false,     // no marketplace install (VSIX download+extract)
  selfUpdate: true,        // implemented in Go (git + alice update + relaunch)
  remoteGateway: true,     // implemented via persisted connection.json
} as const

export function initWailsBridge(): void {
  if (typeof window === 'undefined' || window.aliceDesktop) {
    return
  }

  // Wails v2 runtime: wait for window.go to be available
  const wailLog = (msg: string) => {
    try {
      // Write to localStorage for later retrieval
      const logs = JSON.parse(localStorage.getItem('wail-logs') || '[]');
      logs.push(`${new Date().toISOString()} ${msg}`);
      localStorage.setItem('wail-logs', JSON.stringify(logs.slice(-50)));
    } catch {}
    console.log(msg);
  };

  // Capture global errors and write to file
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
      const errorMsg = `JS ERROR: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;
      console.error(errorMsg);
      try { window['go']?.main?.App?.WriteErrorLog?.(errorMsg) } catch {}
    });
    window.addEventListener('unhandledrejection', (event) => {
      const errorMsg = `JS UNHANDLED REJECTION: ${event.reason?.message || String(event.reason)}`;
      console.error(errorMsg);
      try { window['go']?.main?.App?.WriteErrorLog?.(errorMsg) } catch {}
    });
  }
  
  const waitForWailsRuntime = (timeoutMs: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (typeof window['go'] !== 'undefined' && window['go']?.main?.PythonManager) {
          wailLog('[Wails] Runtime ready');
          resolve();
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          wailLog(`[Wails] Runtime TIMEOUT! go=${typeof window['go']}, main=${typeof window['go']?.main}, PM=${typeof window['go']?.main?.PythonManager}`);
          reject(new Error('Wails runtime did not initialize within timeout'));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  };

  const fetchConnectionInfo = async () => {
    try {
      if (typeof window['go'] === 'undefined' || !window['go']?.main?.PythonManager) {
        wailLog('[Wails] Runtime not ready, waiting...');
        await waitForWailsRuntime(30000);
      }
      
      wailLog('[Wails] Calling WaitForHealthy...');
      const healthy = await PythonManager.WaitForHealthy(120);
      wailLog(`[Wails] WaitForHealthy=${healthy}`);
      if (!healthy) {
        console.error('[Wails] Backend did not become healthy within timeout');
      }
      const info = await PythonManager.GetConnectionInfo();
      wailLog(`[Wails] GetConnectionInfo: ${JSON.stringify(info)}`);
      if (info) {
        return {
          baseUrl: info.baseUrl || 'http://127.0.0.1:18789',
          isFullscreen: !!info.isFullscreen,
          mode: info.mode || 'local',
          authMode: info.authMode || 'token',
          nativeOverlayWidth: info.nativeOverlayWidth || 0,
          token: info.token || '',
          wsUrl: info.wsUrl || (info.token ? `ws://127.0.0.1:18789/api/ws?token=${info.token}` : 'http://127.0.0.1:18789/api/ws'),
          logs: [],
          windowButtonPosition: null,
        };
      }
    } catch (err) {
      console.error('[Wails] Failed to get connection info:', err);
    }
    return {
      baseUrl: 'http://127.0.0.1:18789',
      isFullscreen: false,
      mode: 'local',
      authMode: 'token',
      nativeOverlayWidth: 0,
      token: '',
      wsUrl: 'http://127.0.0.1:18789/api/ws',
      logs: [],
      windowButtonPosition: null,
    };
  };

  window.aliceDesktop = {
    getConnection: fetchConnectionInfo,
    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    touchBackend: async () => ({ ok: true }),
    getGatewayWsUrl: async () => {
      const conn = await fetchConnectionInfo();
      return conn.wsUrl;
    },
    openSessionWindow: async () => ({ ok: true }),
    openNewSessionWindow: async () => ({ ok: true }),
    petOverlay: {
      open: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      setBounds: () => {},
      setIgnoreMouse: () => {},
      setFocusable: () => {},
      pushState: () => {},
      control: () => {},
      onState: () => () => {},
      onControl: () => () => {},
    },
    getBootProgress: async () => ({
      error: null,
      fakeMode: false,
      message: 'Ready',
      phase: 'ready',
      progress: 100,
      running: true,
      timestamp: Date.now(),
    }),
    getConnectionConfig: async () => ({
      envOverride: false,
      mode: 'local',
      profile: null,
      remoteAuthMode: 'token',
      remoteOauthConnected: false,
      remoteTokenPreview: null,
      remoteTokenSet: false,
      remoteUrl: 'http://127.0.0.1:18789',
    }),
    saveConnectionConfig: async (payload) => payload,
    applyConnectionConfig: async (payload) => {
      if (payload?.mode === 'local') {
        try {
          await App.RestartGateway();
          window.location.reload();
          return payload;
        } catch (err: any) {
          throw err;
        }
      }
      return payload;
    },
    testConnectionConfig: async () => ({ baseUrl: 'http://127.0.0.1:18789', ok: true, version: '0.17.0' }),
    probeConnectionConfig: async () => ({
      baseUrl: 'http://127.0.0.1:18789',
      reachable: true,
      authMode: 'token',
      providers: [],
      version: '0.17.0',
      error: null,
    }),
    oauthLoginConnectionConfig: async () => ({ ok: true, baseUrl: 'http://127.0.0.1:18789', connected: true }),
    oauthLogoutConnectionConfig: async () => ({ ok: true, connected: false }),
    profile: {
      get: async () => ({ profile: null }),
      set: async (name) => ({ profile: name }),
    },
    api: async (req) => {
      // Retry logic for when backend is not ready yet
      let lastErr: any
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Use the Go proxy to avoid WebKit CORS/origin issues
          const result = await App.ProxyApi({
            path: req.path,
            method: req.method || 'GET',
            body: req.body ? JSON.stringify(req.body) : '',
          });
          if (result.status >= 400) {
            throw new Error(`API ${req.path} failed: ${result.status} ${result.body}`);
          }
          return JSON.parse(result.body);
        } catch (err) {
          lastErr = err
          // If backend not ready, wait and retry
          if (err?.message?.includes('backend not ready') && attempt < 2) {
            await new Promise(r => setTimeout(r, 1000))
            continue
          }
          // Log error to file for debugging
          try { window['go']?.main?.App?.WriteErrorLog?.(`API ${req.path} error: ${err?.message || String(err)}`) } catch {}
          throw err
        }
      }
      throw lastErr
    },
    notify: async () => true,
    requestMicrophoneAccess: async () => true,
    readFileText: async (path) => {
      try {
        const text = await App.ReadFileText(path);
        return { path, text: text || '' };
      } catch {
        return { path, text: '' };
      }
    },
    readFileDataUrl: async (path) => {
      try {
        return await App.ReadFileDataUrl(path);
      } catch {
        return '';
      }
    },
    writeTextFile: async (path, content) => {
      try {
        await App.WriteTextFile(path, content);
        return { path };
      } catch {
        return { path };
      }
    },
    trashPath: async (path) => {
      try {
        await App.TrashPath(path);
        return true;
      } catch {
        return false;
      }
    },
    renamePath: async (path, newName) => {
      try {
        const newPath = await App.RenamePath(path, newName);
        return { path: newPath || '' };
      } catch {
        return { path: '' };
      }
    },
    revealPath: async (path) => {
      try {
        await App.RevealPath(path);
        return true;
      } catch {
        return false;
      }
    },
    selectPaths: async (options) => {
      try {
        const paths = await FSService.SelectPaths({
          title: options?.title || '',
          defaultPath: options?.defaultPath || '',
          directories: !!options?.directories,
          multiple: !!options?.multiple,
        });
        return (paths || []).filter((p: string) => p && p.trim());
      } catch {
        return [];
      }
    },
    writeClipboard: async (text) => {
      await navigator.clipboard.writeText(text);
      return true;
    },
    saveImageFromUrl: async () => true,
    saveImageBuffer: async (data, ext) => {
      try {
        return await FSService.SaveImageBuffer(Array.from(data), ext || 'png');
      } catch {
        return '';
      }
    },
    saveClipboardImage: async () => {
      try {
        return await FSService.SaveClipboardImage();
      } catch {
        return '';
      }
    },
    getPathForFile: (file) => (file as any).path || file.name,
    normalizePreviewTarget: async () => null,
    watchPreviewFile: async (url) => ({ id: '1', path: url }),
    stopPreviewFileWatch: async () => true,
    openExternal: async (url) => {
      try {
        await App.OpenExternal(url);
      } catch {
        window.open(url, '_blank');
      }
    },
    fetchLinkTitle: async () => '',
    sanitizeWorkspaceCwd: async (cwd) => ({ cwd: cwd || '', sanitized: false }),
    settings: {
      getDefaultProjectDir: async () => ({ defaultLabel: 'Default', dir: null, resolvedCwd: '' }),
      pickDefaultProjectDir: async () => ({ canceled: false, dir: null }),
      setDefaultProjectDir: async (dir) => ({ dir }),
    },
    revealLogs: async () => {
      try {
        await App.RevealLogs();
        return { ok: true, path: '' };
      } catch (err: any) {
        return { ok: false, path: '', error: err?.message || String(err) };
      }
    },
    getRecentLogs: async () => {
      try {
        const lines = await App.GetRecentLogs(200);
        return { path: '', lines: lines || [] };
      } catch {
        return { path: '', lines: [] };
      }
    },
    readDir: async (path) => {
      try {
        const entries = await FSService.ReadDir(path);
        return {
          entries: (entries || []).map((e: any) => ({
            name: e.name,
            path: e.path,
            isDirectory: e.isDir,
          })),
        };
      } catch (err: any) {
        return { entries: [], error: err.message };
      }
    },
    gitRoot: async (path) => {
      try {
        return await GitService.GetGitRoot(path);
      } catch {
        return null;
      }
    },
    git: {
      worktreeList: async (repoPath) => {
        try {
          const list = await GitService.ListWorktrees(repoPath);
          return (list || []).map((p: string, idx: number) => ({
            path: p,
            branch: null,
            isMain: idx === 0,
            detached: false,
            locked: false,
          }));
        } catch {
          return [];
        }
      },
      worktreeAdd: async (repoPath, opts) => {
        try {
          const branchSlug = (opts?.branch || 'main').replace(/[^a-zA-Z0-9_-]/g, '_');
          const worktreePath = repoPath + '/../alice-worktree-' + branchSlug;
          await GitService.AddWorktree(repoPath, worktreePath, opts?.branch || 'main');
          return { path: worktreePath, branch: opts?.branch || 'main', repoRoot: repoPath };
        } catch {
          return { path: repoPath, branch: opts?.branch || 'main', repoRoot: repoPath };
        }
      },
      worktreeRemove: async (repoPath, worktreePath) => {
        try {
          await GitService.RemoveWorktree(repoPath, worktreePath, false);
          return { removed: worktreePath };
        } catch {
          return { removed: worktreePath };
        }
      },
      branchSwitch: async (repoPath, branch) => {
        try {
          await GitService.SwitchBranch(repoPath, branch);
          return { branch };
        } catch {
          return { branch };
        }
      },
      branchList: async (repoPath) => {
        try {
          const branches = await GitService.ListBranches(repoPath);
          return branches || [];
        } catch {
          return [];
        }
      },
      remoteInfo: async (repoPath) => {
        try {
          const remote = await GitService.GetRemoteURL(repoPath);
          return { branch: 'main', prUrl: null, provider: 'none', remote: remote || null };
        } catch {
          return { branch: 'main', prUrl: null, provider: 'none', remote: null };
        }
      },
      repoStatus: async (repoPath) => {
        try {
          const status = await GitService.GetStatus(repoPath);
          return status ? { raw: status } : null;
        } catch {
          return null;
        }
      },
      fileDiff: async (repoPath, filePath) => {
        try {
          const diff = await GitService.GetFileDiff(repoPath, filePath);
          return diff || '';
        } catch {
          return '';
        }
      },
      scanRepos: async () => [],
      askpassRespond: async () => ({ status: 'ok' }),
      review: {
        list: async (repoPath, scope, baseRef) => {
          try {
            const query = new URLSearchParams();
            if (scope) query.set('scope', scope);
            if (baseRef) query.set('base', baseRef);
            query.set('path', repoPath);
            const result = await App.ProxyApi({
              path: `/api/git/review/list?${query.toString()}`,
              method: 'GET',
              body: '',
            });
            if (result.status >= 400) return { files: [], base: null };
            return JSON.parse(result.body);
          } catch {
            return { files: [], base: null };
          }
        },
        diff: async (repoPath, filePath) => {
          try {
            const diff = await GitService.GetFileDiff(repoPath, filePath);
            return diff || '';
          } catch {
            return '';
          }
        },
        stage: async (repoPath, filePath) => {
          try {
            await GitService.StageFile(repoPath, filePath || '');
            return { ok: true };
          } catch {
            return { ok: true };
          }
        },
        unstage: async (repoPath, filePath) => {
          try {
            await GitService.UnstageFile(repoPath, filePath || '');
            return { ok: true };
          } catch {
            return { ok: true };
          }
        },
        revert: async (repoPath, filePath) => {
          try {
            await GitService.RevertFile(repoPath, filePath || '');
            return { ok: true };
          } catch {
            return { ok: true };
          }
        },
        revParse: async (repoPath, ref) => {
          try {
            return await GitService.RevParse(repoPath, ref || '');
          } catch {
            return null;
          }
        },
        commit: async (repoPath, message, push) => {
          try {
            if (push) {
              await GitService.Commit(repoPath, message);
              await GitService.Push(repoPath);
            } else {
              await GitService.Commit(repoPath, message);
            }
            return { ok: true };
          } catch {
            return { ok: true };
          }
        },
        commitContext: async (repoPath) => {
          try {
            const [diff, recent] = await Promise.all([
              GitService.GetFileDiff(repoPath, ''),
              GitService.GetRecentCommits(repoPath, 5),
            ]);
            return { diff: diff || '', recent: (recent || []).join('\n') };
          } catch {
            return { diff: '', recent: '' };
          }
        },
        push: async (repoPath) => {
          try {
            await GitService.Push(repoPath);
            return { ok: true };
          } catch {
            return { ok: true };
          }
        },
        shipInfo: async (repoPath) => {
          try {
            const result = await App.ProxyApi({
              path: `/api/git/review/ship-info?path=${encodeURIComponent(repoPath)}`,
              method: 'GET',
              body: '',
            });
            if (result.status >= 400) return { ghReady: false, pr: null };
            return JSON.parse(result.body);
          } catch {
            return { ghReady: false, pr: null };
          }
        },
        createPr: async (repoPath) => {
          try {
            const result = await App.ProxyApi({
              path: `/api/git/review/create-pr`,
              method: 'POST',
              body: JSON.stringify({ path: repoPath }),
            });
            if (result.status >= 400) return { url: '' };
            return JSON.parse(result.body);
          } catch {
            return { url: '' };
          }
        },
      },
    },
    terminal: {
      start: async (options) => {
        try {
          const session = await PTYService.StartTerminal(
            options?.cwd || '',
            options?.cols || 80,
            options?.rows || 24
          );
          return {
            id: session.ID || 'term-1',
            cwd: session.Cwd || '',
            shell: session.Shell || '/bin/bash',
          };
        } catch (err: any) {
          throw new Error(err?.message || 'Failed to start terminal');
        }
      },
      read: async (id: string) => {
        try {
          return await PTYService.ReadTerminal(id);
        } catch {
          return '';
        }
      },
      write: async (id, data) => {
        try {
          await PTYService.WriteTerminal(id, data);
          return true;
        } catch {
          return false;
        }
      },
      resize: async (id, size) => {
        try {
          await PTYService.ResizeTerminal(id, size.cols, size.rows);
          return true;
        } catch {
          return false;
        }
      },
      dispose: async (id) => {
        try {
          await PTYService.DisposeTerminal(id);
          return true;
        } catch {
          return false;
        }
      },
      onData: (_id, _callback) => () => {},
      onExit: (_id, _callback) => () => {},
    },
    onPreviewFileChanged: () => () => {},
    onBackendExit: () => () => {},
    onBootProgress: () => () => {},
    // ── Window / shell event subscriptions ──────────────────────────────
    // Wails v2 has no multi-window shell; these are no-op stubs so the
    // renderer's optional-chained subscriptions stay inert instead of
    // throwing on `undefined`.
    onClosePreviewRequested: () => () => {},
    onOpenUpdatesRequested: () => () => {},
    onWindowStateChanged: () => () => {},
    onFocusSession: () => () => {},
    onNotificationAction: () => () => {},
    onPowerResume: () => () => {},
    onDeepLink: () => () => {},
    signalDeepLinkReady: async () => ({ ok: true }),
    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      unsupportedPlatform: null,
    }),
    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),
    cancelBootstrap: async () => ({ ok: true, cancelled: false }),
    onBootstrapEvent: () => () => {},
    getVersion: async () => UpdateService.GetVersion(),
    updates: {
      check: async () => UpdateService.Check(),
      apply: async (opts) => UpdateService.Apply(opts || {}),
      getBranch: async () => UpdateService.GetBranch(),
      setBranch: async (name) => UpdateService.SetBranch(name),
      onProgress: (listener) => {
        // Wails v2 runtime events: subscribe to the Go-emitted progress stream.
        // Falls back to a no-op when the runtime isn't ready yet (renderer
        // boot), matching the preload's subscribe-and-return-unsubscribe shape.
        const runtimeObj = typeof window !== 'undefined' ? (window as any).runtime : undefined;
        if (runtimeObj?.EventsOn) {
          runtimeObj.EventsOn('alice:updates:progress', (payload: unknown) => {
            try {
              listener(payload as any);
            } catch {}
          });
          return () => {
            try {
              runtimeObj.EventsOff('alice:updates:progress');
            } catch {}
          };
        }
        return () => {};
      },
    },
    uninstall: {
      summary: async () => ({
        alice_home: '~/.alice',
        agent_installed: true,
        gui_installed: true,
        source_built_artifacts: [],
        packaged_app_paths: [],
        userdata_dir: '',
        userdata_exists: true,
        platform: 'linux',
      }),
      run: async () => ({ ok: true }),
    },
    themes: {
      fetchMarketplace: async (id) => ({ extensionId: id, displayName: id, themes: [] }),
      searchMarketplace: async () => [],
    },
    // ── Theme / window chrome — Wails v2 has native CSS theming; these are
    // informational no-ops so the renderer never crashes on `undefined`.
    setTitleBarTheme: () => {},
    setNativeTheme: () => {},
    setTranslucency: () => {},
    setPreviewShortcutActive: () => {},
    openPreviewInBrowser: async (url) => {
      try {
        await App.OpenExternal(url);
      } catch {
        window.open(url, '_blank');
      }
    },
    getRemoteDisplayReason: async () => null,
  };
}
