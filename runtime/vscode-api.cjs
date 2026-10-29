const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const picomatch = require('picomatch');
const types = require('./vscode-types.cjs');
const { JsonStore } = require('./host-storage.cjs');
const { Uri, EventEmitter, Disposable, FileType, FileSystemError } = types;

const desktopConfigurationDefaults = {
  'claudeCode.allowDangerouslySkipPermissions': true,
  'claudeCode.hideOnboarding': true,
  'claudeCode.disableLoginPrompt': true,
};

async function createVscodeApi(options, peer) {
  const { extensionPath, packageJSON, workspacePath, storageRoot } = options;
  const subscriptions = [];
  const stores = [];
  const workspaceId = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 24);
  const workspaceStorage = path.join(storageRoot, 'workspaces', workspaceId);
  const globalStorage = path.join(storageRoot, 'global-storage');
  const logDirectory = path.join(storageRoot, 'logs');
  await Promise.all([workspaceStorage, globalStorage, logDirectory].map(directory => fs.promises.mkdir(directory, { recursive: true })));
  const store = filename => { const value = new JsonStore(filename); stores.push(value); return value; };
  const globalSettings = store(path.join(storageRoot, 'settings.json'));
  const workspaceSettings = store(path.join(workspaceStorage, 'settings.json'));
  const defaults = {
    'editor.fontFamily': 'Menlo, Monaco, monospace', 'editor.fontSize': 13, 'editor.fontWeight': 'normal',
    'chat.fontSize': 14, 'files.exclude': {}, 'search.exclude': {}, 'search.useIgnoreFiles': true,
    'workbench.editor.enablePreview': false,
  };
  for (const config of [packageJSON.contributes?.configuration].flat().filter(Boolean)) {
    for (const [key, value] of Object.entries(config.properties ?? {})) defaults[key] = value.default;
  }
  for (const [key, value] of Object.entries(desktopConfigurationDefaults)) {
    if (Object.hasOwn(defaults, key)) defaults[key] = value;
  }
  const event = () => { const emitter = new EventEmitter(); subscriptions.push(emitter); return emitter; };
  const configurationChanged = event();
  const foldersChanged = event();
  const documentsChanged = event();
  const documentOpened = event();
  const documentClosed = event();
  const documentSaved = event();
  const documentWillSave = event();
  const activeEditorChanged = event();
  const visibleEditorsChanged = event();
  const selectionChanged = event();
  const diagnosticsChanged = event();
  const tabsChanged = event();
  const groupsChanged = event();
  const windowStateChanged = event();
  const themeChanged = event();
  const secretsChanged = event();
  const providers = new Map();
  const contentProviders = new Map();
  const registeredCommands = new Map();
  const viewProviders = new Map();
  const serializers = new Map();
  const panels = new Map();
  const contexts = new Map();
  const uriHandlers = new Set();
  const environment = new Map();
  const statusItems = new Map();
  const group = { isActive: true, viewColumn: 1, tabs: [], activeTab: undefined, isLocked: false };
  const unsupported = name => { throw new Error(`Unsupported VS Code host capability: ${name}`); };
  const log = (level, text) => peer.notify('host.log', { level, text });
  const configValue = key => workspaceSettings.get(key, globalSettings.get(key, defaults[key]));

  function getConfiguration(section = '') {
    const keyFor = key => section ? `${section}.${key}` : key;
    const configuration = {
      get(key, fallback) { const value = configValue(keyFor(key)); return value === undefined ? fallback : value; },
      has(key) { return configValue(keyFor(key)) !== undefined; },
      inspect(key) {
        const fullKey = keyFor(key);
        return { key: fullKey, defaultValue: defaults[fullKey], globalValue: globalSettings.get(fullKey), workspaceValue: workspaceSettings.get(fullKey) };
      },
      async update(key, value, target) {
        const fullKey = keyFor(key);
        const destination = target === true || target === types.ConfigurationTarget.Global ? globalSettings : workspaceSettings;
        await destination.update(fullKey, value);
        configurationChanged.fire({ affectsConfiguration: name => fullKey === name || fullKey.startsWith(`${name}.`) || name.startsWith(`${fullKey}.`) });
      },
    };
    for (const key of new Set([...Object.keys(defaults), ...globalSettings.keys(), ...workspaceSettings.keys()])) {
      if (section && key.startsWith(`${section}.`)) {
        const property = key.slice(section.length + 1);
        if (!property.includes('.') && !Object.hasOwn(configuration, property)) configuration[property] = configValue(key);
      }
    }
    return configuration;
  }

  async function fileOperation(uri, method, ...args) {
    const provider = providers.get(uri.scheme);
    if (provider) return provider[method](uri, ...args);
    if (uri.scheme !== 'file') throw FileSystemError.Unavailable(`No file system provider for ${uri.scheme}`);
    try {
      if (method === 'stat') {
        const value = await fs.promises.stat(uri.fsPath);
        return { type: value.isDirectory() ? FileType.Directory : FileType.File, ctime: value.ctimeMs, mtime: value.mtimeMs, size: value.size };
      }
      if (method === 'readFile') return new Uint8Array(await fs.promises.readFile(uri.fsPath));
      if (method === 'writeFile') return fs.promises.writeFile(uri.fsPath, args[0]);
      if (method === 'readDirectory') return (await fs.promises.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]);
      if (method === 'createDirectory') return fs.promises.mkdir(uri.fsPath, { recursive: true });
      if (method === 'delete') return fs.promises.rm(uri.fsPath, { recursive: Boolean(args[0]?.recursive) });
      if (method === 'rename' || method === 'copy') {
        const [destination, settings] = args;
        if (destination.scheme !== 'file') return unsupported(`workspace.fs.${method} across providers`);
        if (!settings?.overwrite && fs.existsSync(destination.fsPath)) throw FileSystemError.FileExists(destination);
        return method === 'rename' ? fs.promises.rename(uri.fsPath, destination.fsPath) : fs.promises.cp(uri.fsPath, destination.fsPath, { recursive: true, force: Boolean(settings?.overwrite) });
      }
      return unsupported(`workspace.fs.${method}`);
    } catch (error) {
      if (error.code === 'ENOENT') throw FileSystemError.FileNotFound(uri);
      if (error.code === 'EACCES' || error.code === 'EPERM') throw FileSystemError.NoPermissions(uri);
      throw error;
    }
  }

  function createWatcher(glob, ignoreCreate, ignoreChange, ignoreDelete) {
    const base = typeof glob === 'string' ? workspacePath : (glob.baseUri?.fsPath ?? glob.base?.fsPath ?? glob.base);
    const pattern = typeof glob === 'string' ? glob : glob.pattern;
    const matches = picomatch(pattern, { dot: true });
    const created = event(), changed = event(), deleted = event();
    let root = path.resolve(base);
    while (!fs.existsSync(root) && path.dirname(root) !== root) root = path.dirname(root);
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (kind, filename) => {
      if (!filename) return;
      const absolute = path.resolve(root, String(filename));
      const relative = path.relative(base, absolute).split(path.sep).join('/');
      if (relative.startsWith('../') || !matches(relative)) return;
      const uri = Uri.file(absolute);
      if (kind === 'change') { if (!ignoreChange) changed.fire(uri); }
      else fs.promises.access(absolute).then(() => { if (!ignoreCreate) created.fire(uri); }, () => { if (!ignoreDelete) deleted.fire(uri); });
    });
    watcher.on('error', error => log('warn', `File watcher: ${error.message}`));
    const result = {
      ignoreCreateEvents: Boolean(ignoreCreate), ignoreChangeEvents: Boolean(ignoreChange), ignoreDeleteEvents: Boolean(ignoreDelete),
      onDidCreate: created.event, onDidChange: changed.event, onDidDelete: deleted.event,
      dispose() { watcher.close(); created.dispose(); changed.dispose(); deleted.dispose(); },
    };
    subscriptions.push(result);
    return result;
  }

  function focusPanel(id) {
    const selected = panels.get(id);
    if (!selected) return;
    for (const panel of panels.values()) {
      const active = panel === selected;
      const didChange = panel.active !== active;
      panel.active = active;
      panel.visible = active;
      panel.tab.isActive = active;
      if (didChange) panel.stateChanged.fire({ webviewPanel: panel });
    }
    group.activeTab = selected.tab;
    tabsChanged.fire({ opened: [], closed: [], changed: [...group.tabs] });
    peer.notify('webview.focus', { id });
  }

  function createPanel(viewType, title, showOptions, webviewOptions = {}) {
    const id = crypto.randomUUID();
    const resourceToken = crypto.randomBytes(24).toString('hex');
    const received = event(), disposed = event(), stateChanged = event();
    let html = '', currentTitle = title, panelOptions = {}, viewOptions = webviewOptions;
    const updateOptions = () => peer.notify('webview.options', { id, localResourceRoots: (viewOptions.localResourceRoots ?? [Uri.file(extensionPath), Uri.file(workspacePath)]).map(uri => uri.fsPath) });
    const panel = {
      id, viewType, viewColumn: 1, active: false, visible: false, stateChanged,
      get title() { return currentTitle; },
      set title(value) { currentTitle = value; panel.tab.label = value; peer.notify('webview.title', { id, title: value }); },
      get options() { return panelOptions; }, set options(value) { panelOptions = value; },
      onDidDispose: disposed.event, onDidChangeViewState: stateChanged.event,
      reveal() { focusPanel(id); },
      dispose() {
        if (!panels.has(id)) return;
        panels.delete(id);
        group.tabs = group.tabs.filter(tab => tab !== panel.tab);
        if (group.activeTab === panel.tab) group.activeTab = undefined;
        peer.notify('webview.dispose', { id });
        disposed.fire();
        tabsChanged.fire({ opened: [], closed: [panel.tab], changed: [] });
        received.dispose(); disposed.dispose(); stateChanged.dispose();
        if (group.tabs.length) focusPanel(group.tabs.at(-1).id);
      },
      webview: {
        get html() { return html; },
        set html(value) { html = value; peer.notify('webview.html', { id, html: value }); },
        get options() { return viewOptions; },
        set options(value) { viewOptions = value; updateOptions(); },
        cspSource: options.webviewOrigin ?? `claude-resource://${id}`,
        asWebviewUri(uri) {
          if (uri.scheme !== 'file') return unsupported(`webview resource scheme ${uri.scheme}`);
          if (options.webviewOrigin) {
            const resourcePath = uri.path.split('/').map(encodeURIComponent).join('/');
            return Uri.parse(`${options.webviewOrigin}/resource/${id}/${resourceToken}${resourcePath}`);
          }
          return uri.with({ scheme: 'claude-resource', authority: id });
        },
        onDidReceiveMessage: received.event,
        postMessage(message) { return peer.call('webview.post', { id, message }); },
      },
      receive(message) { received.fire(message); },
    };
    panel.tab = { id, label: title, input: new types.TabInputWebview(viewType), isActive: false, isDirty: false, isPinned: true, isPreview: false, group };
    panels.set(id, panel);
    group.tabs.push(panel.tab);
    peer.notify('webview.create', { id, viewType, title, resourceToken });
    updateOptions();
    tabsChanged.fire({ opened: [panel.tab], closed: [], changed: [] });
    focusPanel(id);
    return panel;
  }

  const commands = {
    registerCommand(command, callback, thisArg) {
      if (registeredCommands.has(command)) throw new Error(`Command already registered: ${command}`);
      registeredCommands.set(command, (...args) => callback.apply(thisArg, args));
      return new Disposable(() => registeredCommands.delete(command));
    },
    async getCommands() { return [...registeredCommands.keys()]; },
    async executeCommand(command, ...args) {
      if (registeredCommands.has(command)) return registeredCommands.get(command)(...args);
      if (command.endsWith('.focus')) {
        const providerId = command.slice(0, -6);
        const registration = viewProviders.get(providerId);
        if (registration) {
          if (!registration.view) {
            const panel = createPanel(providerId, providerId === 'claudeVSCodeSessionsList' ? 'Sessions' : 'Claude Code', 1, {});
            const visibility = event();
            const view = { webview: panel.webview, viewType: providerId, title: panel.title, visible: true, onDidDispose: panel.onDidDispose, onDidChangeVisibility: visibility.event, show: () => panel.reveal() };
            registration.view = view;
            registration.panel = panel;
            panel.onDidChangeViewState(() => { view.visible = panel.visible; visibility.fire(); });
            panel.onDidDispose(() => { registration.view = undefined; registration.panel = undefined; });
            const token = new types.CancellationTokenSource();
            await registration.provider.resolveWebviewView(view, { state: undefined }, token.token);
          }
          registration.panel.reveal();
          return;
        }
      }
      return unsupported(`command ${command}`);
    },
  };
  commands.registerCommand('setContext', (key, value) => { contexts.set(key, value); });
  commands.registerCommand('workbench.action.lockEditorGroup', () => { group.isLocked = true; });
  commands.registerCommand('workbench.action.unlockEditorGroup', () => { group.isLocked = false; });
  for (const command of ['workbench.action.focusActiveEditorGroup', 'workbench.action.focusFirstEditorGroup']) {
    commands.registerCommand(command, () => { if (group.activeTab) focusPanel(group.activeTab.id); });
  }
  commands.registerCommand('workbench.action.closeActiveEditor', () => panels.get(group.activeTab?.id)?.dispose());
  commands.registerCommand('workbench.action.closeAllEditors', () => { for (const panel of [...panels.values()]) panel.dispose(); });

  const workspace = {
    name: path.basename(workspacePath), rootPath: workspacePath, workspaceFile: undefined, isTrusted: true,
    workspaceFolders: [{ uri: Uri.file(workspacePath), name: path.basename(workspacePath), index: 0 }],
    textDocuments: [], notebookDocuments: [],
    getConfiguration,
    getWorkspaceFolder(uri) {
      const relative = path.relative(workspacePath, uri.fsPath);
      return uri.scheme === 'file' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? workspace.workspaceFolders[0] : undefined;
    },
    asRelativePath(value, includeWorkspaceFolder = false) {
      const filename = typeof value === 'string' ? value : value.fsPath;
      const relative = path.relative(workspacePath, filename);
      if (relative === '..' || relative.startsWith(`..${path.sep}`)) return filename;
      return includeWorkspaceFolder ? path.join(workspace.name, relative) : relative;
    },
    onDidChangeConfiguration: configurationChanged.event, onDidChangeWorkspaceFolders: foldersChanged.event,
    onDidChangeTextDocument: documentsChanged.event, onDidOpenTextDocument: documentOpened.event,
    onDidCloseTextDocument: documentClosed.event, onDidSaveTextDocument: documentSaved.event,
    onWillSaveTextDocument: documentWillSave.event,
    registerFileSystemProvider(scheme, provider) { providers.set(scheme, provider); return new Disposable(() => providers.delete(scheme)); },
    registerTextDocumentContentProvider(scheme, provider) { contentProviders.set(scheme, provider); return new Disposable(() => contentProviders.delete(scheme)); },
    createFileSystemWatcher: createWatcher,
    fs: Object.fromEntries(['stat', 'readFile', 'writeFile', 'readDirectory', 'createDirectory', 'delete', 'rename', 'copy'].map(method => [method, (uri, ...args) => fileOperation(uri, method, ...args)])),
    async findFiles(include, exclude, maxResults = Infinity, token) {
      const base = typeof include === 'string' ? workspacePath : (include.baseUri?.fsPath ?? include.base);
      const matches = picomatch(typeof include === 'string' ? include : include.pattern, { dot: true });
      const excludes = exclude ? picomatch(typeof exclude === 'string' ? exclude : exclude.pattern, { dot: true }) : () => false;
      const result = [];
      async function walk(directory) {
        for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
          if (result.length >= maxResults || token?.isCancellationRequested) return;
          const filename = path.join(directory, entry.name);
          const relative = path.relative(base, filename).split(path.sep).join('/');
          if (entry.name === '.git' || excludes(relative)) continue;
          if (entry.isDirectory()) await walk(filename);
          else if (entry.isFile() && matches(relative)) result.push(Uri.file(filename));
        }
      }
      await walk(base);
      return result;
    },
    openTextDocument() { return unsupported('workspace.openTextDocument'); },
    applyEdit() { return unsupported('workspace.applyEdit'); },
    async saveAll() { return true; },
  };

  const window = {
    activeTextEditor: undefined, activeNotebookEditor: undefined, visibleTextEditors: [],
    activeTerminal: undefined, terminals: [], state: { focused: true, active: true }, activeColorTheme: { kind: 2 },
    onDidChangeActiveTextEditor: activeEditorChanged.event, onDidChangeVisibleTextEditors: visibleEditorsChanged.event,
    onDidChangeTextEditorSelection: selectionChanged.event, onDidChangeWindowState: windowStateChanged.event,
    onDidChangeActiveColorTheme: themeChanged.event,
    onDidChangeTerminalShellIntegration: event().event, onDidStartTerminalShellExecution: event().event,
    onDidEndTerminalShellExecution: event().event, onDidOpenTerminal: event().event, onDidCloseTerminal: event().event,
    tabGroups: {
      all: [group], activeTabGroup: group, onDidChangeTabs: tabsChanged.event, onDidChangeTabGroups: groupsChanged.event,
      async close(tabs) { for (const tab of [tabs].flat()) panels.get(tab.id)?.dispose(); return true; },
    },
    createWebviewPanel: createPanel,
    registerWebviewViewProvider(id, provider) { viewProviders.set(id, { provider }); return new Disposable(() => viewProviders.delete(id)); },
    registerWebviewPanelSerializer(id, serializer) { serializers.set(id, serializer); return new Disposable(() => serializers.delete(id)); },
    registerUriHandler(handler) { uriHandlers.add(handler); return new Disposable(() => uriHandlers.delete(handler)); },
    createOutputChannel(name) {
      let buffer = '';
      const append = value => { buffer += value; log('info', `[${name}] ${value}`); };
      return {
        name, append, appendLine: value => append(`${value}\n`), replace: value => { buffer = ''; append(value); },
        clear: () => { buffer = ''; }, show: () => peer.notify('logs.show'), hide: () => peer.notify('logs.hide'),
        trace: (...args) => log('trace', `[${name}] ${args.join(' ')}`), debug: (...args) => log('debug', `[${name}] ${args.join(' ')}`),
        info: (...args) => log('info', `[${name}] ${args.join(' ')}`), warn: (...args) => log('warn', `[${name}] ${args.join(' ')}`),
        error: (...args) => log('error', `[${name}] ${args.join(' ')}`), dispose: () => { buffer = ''; },
        logLevel: 3, onDidChangeLogLevel: event().event,
      };
    },
    createStatusBarItem() {
      const id = crypto.randomUUID();
      const item = { text: '', tooltip: '', command: undefined, show() { statusItems.set(id, item); }, hide() { statusItems.delete(id); }, dispose() { statusItems.delete(id); } };
      return item;
    },
    setStatusBarMessage(message) { peer.notify('host.status', { message }); return new Disposable(() => peer.notify('host.status', { message: '' })); },
    async showInformationMessage(message, ...items) { return peer.call('dialog.message', { type: 'info', message, items }); },
    async showWarningMessage(message, ...items) { return peer.call('dialog.message', { type: 'warning', message, items }); },
    async showErrorMessage(message, ...items) { return peer.call('dialog.message', { type: 'error', message, items }); },
    showInputBox() { return unsupported('window.showInputBox'); },
    showQuickPick() { return unsupported('window.showQuickPick'); },
    showTextDocument() { return unsupported('window.showTextDocument'); },
    createTextEditorDecorationType() { return unsupported('window.createTextEditorDecorationType'); },
    createTerminal() { return unsupported('window.createTerminal'); },
    async withProgress(settings, task) {
      if (settings.cancellable) return unsupported('cancellable window.withProgress');
      const cancellation = new types.CancellationTokenSource();
      try { return await task({ report: value => peer.notify('host.status', { message: value.message ?? settings.title ?? '' }) }, cancellation.token); }
      finally { cancellation.dispose(); peer.notify('host.status', { message: '' }); }
    },
  };
  const extension = { id: `${packageJSON.publisher}.${packageJSON.name}`, extensionPath, extensionUri: Uri.file(extensionPath), packageJSON, isActive: false, exports: undefined, extensionKind: 1 };
  const globalState = store(path.join(globalStorage, 'state.json'));
  globalState.setKeysForSync = keys => { globalState.syncKeys = [...keys]; };
  const context = {
    subscriptions, extension, extensionMode: types.ExtensionMode.Production, extensionPath, extensionUri: Uri.file(extensionPath),
    asAbsolutePath: relative => path.join(extensionPath, relative),
    globalState, workspaceState: store(path.join(workspaceStorage, 'state.json')),
    globalStorageUri: Uri.file(globalStorage), globalStoragePath: globalStorage,
    storageUri: Uri.file(workspaceStorage), storagePath: workspaceStorage,
    logUri: Uri.file(logDirectory), logPath: logDirectory,
    secrets: {
      onDidChange: secretsChanged.event,
      get: key => peer.call('secrets.get', { key }),
      store: async (key, value) => { await peer.call('secrets.store', { key, value }); secretsChanged.fire({ key }); },
      delete: async key => { await peer.call('secrets.delete', { key }); secretsChanged.fire({ key }); },
    },
    environmentVariableCollection: {
      persistent: true, description: undefined,
      replace: (key, value) => environment.set(key, { value, type: 1 }),
      append: (key, value) => environment.set(key, { value, type: 2 }),
      prepend: (key, value) => environment.set(key, { value, type: 3 }),
      get: key => environment.get(key), delete: key => environment.delete(key), clear: () => environment.clear(),
      forEach: callback => environment.forEach(callback), [Symbol.iterator]: () => environment[Symbol.iterator](),
    },
  };
  const vscode = {
    ...types, version: '1.94.0', commands, workspace, window,
    env: {
      appName: 'CC Go', appHost: 'desktop', language: options.language ?? 'en', uriScheme: 'claude-vsix',
      uiKind: types.UIKind.Desktop, remoteName: undefined, shell: process.env.SHELL ?? '/bin/sh',
      sessionId: crypto.randomUUID(), machineId: options.machineId, isTelemetryEnabled: false,
      onDidChangeTelemetryEnabled: event().event,
      openExternal: uri => peer.call('external.open', { uri: uri.toString() }),
      clipboard: { readText: () => peer.call('clipboard.read'), writeText: text => peer.call('clipboard.write', { text }) },
    },
    extensions: { all: [extension], getExtension: id => id.toLowerCase() === extension.id.toLowerCase() ? extension : undefined, onDidChange: event().event },
    languages: { getDiagnostics: uri => uri ? [] : [], onDidChangeDiagnostics: diagnosticsChanged.event },
    comments: { createCommentController: () => unsupported('comments.createCommentController') },
  };
  function settingsSchema() {
    const properties = {};
    for (const config of [packageJSON.contributes?.configuration].flat().filter(Boolean)) {
      for (const [key, property] of Object.entries(config.properties ?? {})) {
        properties[key] = { ...property, default: defaults[key] };
      }
    }
    return properties;
  }
  function getSettings() {
    const properties = settingsSchema();
    return {
      title: [packageJSON.contributes?.configuration].flat().find(Boolean)?.title ?? 'Claude Code',
      properties,
      values: Object.fromEntries(Object.keys(properties).map(key => [key, configValue(key)])),
    };
  }
  async function updateSetting(key, value) {
    if (!Object.hasOwn(settingsSchema(), key)) throw new Error(`Unknown setting: ${key}`);
    await getConfiguration().update(key, value, types.ConfigurationTarget.Global);
    return getSettings();
  }
  peer.events.on('webview.receive', ({ id, message }) => panels.get(id)?.receive(message));
  peer.events.on('webview.select', ({ id }) => focusPanel(id));
  peer.events.on('webview.close', ({ id }) => panels.get(id)?.dispose());
  peer.events.on('window.focus', ({ focused }) => { window.state = { focused, active: focused }; windowStateChanged.fire(window.state); });
  peer.events.on('uri.open', ({ uri }) => { for (const handler of uriHandlers) handler.handleUri(Uri.parse(uri)); });
  return {
    vscode, context, getSettings, updateSetting,
    receiveWebviewMessage: (id, message) => panels.get(id)?.receive(message),
    async dispose() {
      for (const panel of [...panels.values()]) panel.dispose();
      for (const subscription of subscriptions.splice(0).reverse()) subscription.dispose();
      await Promise.all(stores.map(value => value.flush()));
    },
  };
}

module.exports = { createVscodeApi };
