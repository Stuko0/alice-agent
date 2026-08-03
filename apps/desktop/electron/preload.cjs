const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('lydiaDesktop', {
  getConnection: profile => ipcRenderer.invoke('lydia:connection', profile),
  revalidateConnection: () => ipcRenderer.invoke('lydia:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('lydia:backend:touch', profile),
  getGatewayWsUrl: profile => ipcRenderer.invoke('lydia:gateway:ws-url', profile),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('lydia:window:openSession', sessionId, opts),
  openNewSessionWindow: () => ipcRenderer.invoke('lydia:window:openNewSession'),
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ bounds, screen }`; resolves with the screen bounds it actually used.
    open: request => ipcRenderer.invoke('lydia:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('lydia:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('lydia:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('lydia:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('lydia:pet-overlay:set-focusable', focusable),
    // Main renderer → overlay (forwarded by main): push the latest pet state.
    pushState: payload => ipcRenderer.send('lydia:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer submit.
    control: payload => ipcRenderer.send('lydia:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('lydia:pet-overlay:state', listener)
      return () => ipcRenderer.removeListener('lydia:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('lydia:pet-overlay:control', listener)
      return () => ipcRenderer.removeListener('lydia:pet-overlay:control', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('lydia:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('lydia:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('lydia:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('lydia:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('lydia:connection-config:test', payload),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('lydia:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('lydia:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('lydia:connection-config:oauth-logout', remoteUrl),
  profile: {
    get: () => ipcRenderer.invoke('lydia:profile:get'),
    set: name => ipcRenderer.invoke('lydia:profile:set', name)
  },
  api: request => ipcRenderer.invoke('lydia:api', request),
  notify: payload => ipcRenderer.invoke('lydia:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('lydia:requestMicrophoneAccess'),
  readFileDataUrl: filePath => ipcRenderer.invoke('lydia:readFileDataUrl', filePath),
  readFileText: filePath => ipcRenderer.invoke('lydia:readFileText', filePath),
  selectPaths: options => ipcRenderer.invoke('lydia:selectPaths', options),
  writeClipboard: text => ipcRenderer.invoke('lydia:writeClipboard', text),
  saveImageFromUrl: url => ipcRenderer.invoke('lydia:saveImageFromUrl', url),
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('lydia:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('lydia:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('lydia:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('lydia:watchPreviewFile', url),
  stopPreviewFileWatch: id => ipcRenderer.invoke('lydia:stopPreviewFileWatch', id),
  setTitleBarTheme: payload => ipcRenderer.send('lydia:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('lydia:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('lydia:translucency', payload),
  setPreviewShortcutActive: active => ipcRenderer.send('lydia:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('lydia:openExternal', url),
  openPreviewInBrowser: url => ipcRenderer.invoke('lydia:openPreviewInBrowser', url),
  fetchLinkTitle: url => ipcRenderer.invoke('lydia:fetchLinkTitle', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('lydia:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('lydia:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('lydia:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('lydia:setting:defaultProjectDir:pick')
  },
  revealLogs: () => ipcRenderer.invoke('lydia:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('lydia:logs:recent'),
  readDir: dirPath => ipcRenderer.invoke('lydia:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('lydia:fs:gitRoot', startPath),
  revealPath: targetPath => ipcRenderer.invoke('lydia:fs:reveal', targetPath),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('lydia:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('lydia:fs:writeText', filePath, content),
  trashPath: targetPath => ipcRenderer.invoke('lydia:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('lydia:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('lydia:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('lydia:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('lydia:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('lydia:git:branchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('lydia:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('lydia:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('lydia:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('lydia:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('lydia:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('lydia:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('lydia:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('lydia:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('lydia:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('lydia:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('lydia:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('lydia:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('lydia:git:review:shipInfo', repoPath),
      createPr: repoPath => ipcRenderer.invoke('lydia:git:review:createPr', repoPath)
    }
  },
  terminal: {
    dispose: id => ipcRenderer.invoke('lydia:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('lydia:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('lydia:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('lydia:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `lydia:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `lydia:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('lydia:close-preview-requested', listener)
    return () => ipcRenderer.removeListener('lydia:close-preview-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('lydia:open-updates', listener)
    return () => ipcRenderer.removeListener('lydia:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('lydia:deep-link', listener)
    return () => ipcRenderer.removeListener('lydia:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('lydia:deep-link-ready'),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('lydia:window-state-changed', listener)
    return () => ipcRenderer.removeListener('lydia:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('lydia:focus-session', listener)
    return () => ipcRenderer.removeListener('lydia:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('lydia:notification-action', listener)
    return () => ipcRenderer.removeListener('lydia:notification-action', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('lydia:preview-file-changed', listener)
    return () => ipcRenderer.removeListener('lydia:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('lydia:backend-exit', listener)
    return () => ipcRenderer.removeListener('lydia:backend-exit', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('lydia:power-resume', listener)
    return () => ipcRenderer.removeListener('lydia:power-resume', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('lydia:boot-progress', listener)
    return () => ipcRenderer.removeListener('lydia:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.cjs (apps/desktop/electron/bootstrap-runner.cjs).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('lydia:bootstrap:get'),
  resetBootstrap: () => ipcRenderer.invoke('lydia:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('lydia:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('lydia:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('lydia:bootstrap:event', listener)
    return () => ipcRenderer.removeListener('lydia:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('lydia:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('lydia:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('lydia:uninstall:summary'),
    run: mode => ipcRenderer.invoke('lydia:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('lydia:updates:check'),
    apply: opts => ipcRenderer.invoke('lydia:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('lydia:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('lydia:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('lydia:updates:progress', listener)
      return () => ipcRenderer.removeListener('lydia:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('lydia:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('lydia:vscode-theme:search', query)
  }
})
