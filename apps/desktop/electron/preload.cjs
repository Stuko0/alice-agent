const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('lydiaDesktop', {
  getConnection: profile => ipcRenderer.invoke('alice:connection', profile),
  revalidateConnection: () => ipcRenderer.invoke('alice:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('alice:backend:touch', profile),
  getGatewayWsUrl: profile => ipcRenderer.invoke('alice:gateway:ws-url', profile),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('alice:window:openSession', sessionId, opts),
  openNewSessionWindow: () => ipcRenderer.invoke('alice:window:openNewSession'),
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ bounds, screen }`; resolves with the screen bounds it actually used.
    open: request => ipcRenderer.invoke('alice:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('alice:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('alice:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('alice:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('alice:pet-overlay:set-focusable', focusable),
    // Main renderer → overlay (forwarded by main): push the latest pet state.
    pushState: payload => ipcRenderer.send('alice:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer submit.
    control: payload => ipcRenderer.send('alice:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('alice:pet-overlay:state', listener)
      return () => ipcRenderer.removeListener('alice:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('alice:pet-overlay:control', listener)
      return () => ipcRenderer.removeListener('alice:pet-overlay:control', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('alice:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('alice:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('alice:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('alice:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('alice:connection-config:test', payload),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('alice:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('alice:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('alice:connection-config:oauth-logout', remoteUrl),
  profile: {
    get: () => ipcRenderer.invoke('alice:profile:get'),
    set: name => ipcRenderer.invoke('alice:profile:set', name)
  },
  api: request => ipcRenderer.invoke('alice:api', request),
  notify: payload => ipcRenderer.invoke('alice:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('alice:requestMicrophoneAccess'),
  readFileDataUrl: filePath => ipcRenderer.invoke('alice:readFileDataUrl', filePath),
  readFileText: filePath => ipcRenderer.invoke('alice:readFileText', filePath),
  selectPaths: options => ipcRenderer.invoke('alice:selectPaths', options),
  writeClipboard: text => ipcRenderer.invoke('alice:writeClipboard', text),
  saveImageFromUrl: url => ipcRenderer.invoke('alice:saveImageFromUrl', url),
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('alice:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('alice:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('alice:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('alice:watchPreviewFile', url),
  stopPreviewFileWatch: id => ipcRenderer.invoke('alice:stopPreviewFileWatch', id),
  setTitleBarTheme: payload => ipcRenderer.send('alice:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('alice:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('alice:translucency', payload),
  setPreviewShortcutActive: active => ipcRenderer.send('alice:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('alice:openExternal', url),
  openPreviewInBrowser: url => ipcRenderer.invoke('alice:openPreviewInBrowser', url),
  fetchLinkTitle: url => ipcRenderer.invoke('alice:fetchLinkTitle', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('alice:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('alice:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('alice:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('alice:setting:defaultProjectDir:pick')
  },
  revealLogs: () => ipcRenderer.invoke('alice:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('alice:logs:recent'),
  readDir: dirPath => ipcRenderer.invoke('alice:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('alice:fs:gitRoot', startPath),
  revealPath: targetPath => ipcRenderer.invoke('alice:fs:reveal', targetPath),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('alice:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('alice:fs:writeText', filePath, content),
  trashPath: targetPath => ipcRenderer.invoke('alice:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('alice:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('alice:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('alice:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('alice:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('alice:git:branchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('alice:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('alice:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('alice:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('alice:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('alice:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('alice:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('alice:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('alice:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('alice:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('alice:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('alice:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('alice:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('alice:git:review:shipInfo', repoPath),
      createPr: repoPath => ipcRenderer.invoke('alice:git:review:createPr', repoPath)
    }
  },
  terminal: {
    dispose: id => ipcRenderer.invoke('alice:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('alice:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('alice:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('alice:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `alice:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `alice:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('alice:close-preview-requested', listener)
    return () => ipcRenderer.removeListener('alice:close-preview-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('alice:open-updates', listener)
    return () => ipcRenderer.removeListener('alice:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('alice:deep-link', listener)
    return () => ipcRenderer.removeListener('alice:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('alice:deep-link-ready'),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('alice:window-state-changed', listener)
    return () => ipcRenderer.removeListener('alice:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('alice:focus-session', listener)
    return () => ipcRenderer.removeListener('alice:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('alice:notification-action', listener)
    return () => ipcRenderer.removeListener('alice:notification-action', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('alice:preview-file-changed', listener)
    return () => ipcRenderer.removeListener('alice:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('alice:backend-exit', listener)
    return () => ipcRenderer.removeListener('alice:backend-exit', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('alice:power-resume', listener)
    return () => ipcRenderer.removeListener('alice:power-resume', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('alice:boot-progress', listener)
    return () => ipcRenderer.removeListener('alice:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.cjs (apps/desktop/electron/bootstrap-runner.cjs).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('alice:bootstrap:get'),
  resetBootstrap: () => ipcRenderer.invoke('alice:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('alice:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('alice:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('alice:bootstrap:event', listener)
    return () => ipcRenderer.removeListener('alice:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('alice:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('alice:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('alice:uninstall:summary'),
    run: mode => ipcRenderer.invoke('alice:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('alice:updates:check'),
    apply: opts => ipcRenderer.invoke('alice:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('alice:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('alice:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('alice:updates:progress', listener)
      return () => ipcRenderer.removeListener('alice:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('alice:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('alice:vscode-theme:search', query)
  }
})
