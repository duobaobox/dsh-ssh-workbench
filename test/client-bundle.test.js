import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const bundleSource = source

function loadBundle(options = {}) {
  let registration
  const storage = new Map()
  for (const [key, value] of Object.entries(options.localStorage ?? {})) storage.set(key, String(value))
  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: (key) => { storage.delete(key) },
    },
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  // The bundle is a classic script: evaluate it with a fake window and inspect
  // the registration it makes, exactly like the browser bundle loader does.
  const run = new Function('window', source)
  run(window)
  assert.ok(registration, 'bundle did not register through window.__ModuleLoader__')
  assert.equal(registration.id, 'dsh-ssh-workbench')
  assert.equal(typeof registration.factory, 'function')
  return registration
}

function makeClientContext() {
  const registered = []
  const effects = []
  const services = {
    slots: {
      inject(slot, callback) {
        // Contributions may be a generator that yields registrations.
        const outcome = callback()
        if (outcome && typeof outcome.next === 'function') {
          let step = outcome.next()
          while (!step.done) step = outcome.next(step.value)
        }
      },
      register(options, component) {
        registered.push({ slot: options.name, options, component })
        return () => {}
      },
    },
    locale: {
      register() {},
      bind() {
        return (key) => key
      },
    },
    sidebarRightTabs: {
      register(definition) {
        registered.push({ slot: 'sidebarRightTabs', definition })
        return () => {}
      },
    },
    inputTriggers: {
      registerSource(source) {
        registered.push({ slot: '@source', source })
        return () => {}
      },
    },
    uiConversation: {
      userText: {
        register(rule) {
          registered.push({ slot: 'userText', rule })
          return () => {}
        },
      },
    },
    contextMenus: {
      register(contribution) {
        registered.push({ slot: '@contextMenu', contribution })
        return () => {}
      },
    },
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return () => {}
    },
    inject(names, callback) {
      const inner = {
        get(name) {
          return services[name]
        },
        effect(fn) {
          const dispose = fn()
          effects.push(dispose)
          return () => {}
        },
      }
      // betterSidebar is optional; only invoke the callback when it exists.
      if (names.includes('betterSidebar') && !services.betterSidebar) return
      callback(inner)
    },
  }
  return { ctx, registered }
}

function makeRequire() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }
  return (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  }
}

test('client bundle registers the cordis contract', () => {
  const registration = loadBundle()
  const exports = registration.factory(makeRequire())
  assert.equal(exports.name, 'dsh-ssh-workbench')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
})

test('file rows reuse the official context menu instead of a private popup', () => {
  const { ctx, registered } = makeClientContext()
  const exports = loadBundle().factory(makeRequire())
  exports.apply(ctx)
  const menu = registered.find((entry) => entry.slot === '@contextMenu')
  assert.ok(menu, 'client should register a contextMenus contribution')
  assert.equal(menu.contribution.id, 'dsh-ssh-workbench.files')
  assert.equal(menu.contribution.target, 'dsh-ssh-workbench.file')
  assert.equal(typeof menu.contribution.resolve, 'function')
  // Actions are resolved lazily and are localized at open time.
  assert.match(bundleSource, /const FILES_MENU_TARGET = `\$\{NS\}\.file`/)
  assert.match(bundleSource, /function resolveFilesMenuActions\(value\)/)
  assert.match(bundleSource, /filesMenuPanels\.set\(panelIdRef\.current, menuBoxRef\.current\)/)
  assert.match(bundleSource, /getTriggerProps\(menuTargetOf\(entry\), rowHandlers\)/)
  assert.match(bundleSource, /renderFactorySlot\('contextMenu\.button'/)
  assert.match(bundleSource, /id: 'delete',\s*\n\s*label: t\('files\.delete'\),\s*\n\s*danger: true/)
})

test('client apply registers settings, right-panel body and sidebar tab type', () => {
  const { ctx, registered } = makeClientContext()
  const exports = loadBundle().factory(makeRequire())
  exports.apply(ctx)
  const slots = registered.map((entry) => entry.slot)
  assert.ok(slots.includes('settings.section'), 'missing settings.section')
  assert.ok(slots.includes('plugins.bundle.config'), 'missing bundle config page')
  const settingsEntry = registered.find((entry) => entry.slot === 'settings.section')
  const settingsElement = settingsEntry.component({ t: (key) => key })
  const settingsPage = settingsElement.type(settingsElement.props)
  const settingsTree = settingsPage.type({ t: (key) => key, mode: 'settings' })
  const settingsJson = JSON.stringify(settingsTree)
  assert.match(settingsJson, /settings\.title/)
  // Settings keeps edit/delete but not the composer Reference action.
  assert.doesNotMatch(settingsJson, /panel\.quote/)
  assert.ok(slots.includes('sidebar.right.pane.tab'), 'missing sidebar.right.pane.tab body')
  assert.ok(slots.includes('sidebarRightTabs'), 'missing sidebarRightTabs registration')
  const tabs = registered.filter((entry) => entry.slot === 'sidebarRightTabs')
  assert.deepEqual(tabs.map((entry) => entry.definition.kind).sort(), ['sdh-file', 'sdh-files', 'sdh-servers'])
  const serversTab = tabs.find((entry) => entry.definition.kind === 'sdh-servers')
  assert.equal(serversTab.definition.id, 'dsh-ssh-workbench/servers')
  const filesTab = tabs.find((entry) => entry.definition.kind === 'sdh-files')
  // The two SSH pages share one guide card (servers + remote files menu).
  assert.equal(serversTab.definition.guide.length, 1)
  assert.equal(serversTab.definition.guide[0].id, 'ssh')
  assert.equal(typeof serversTab.definition.guide[0].icon, 'function')
  assert.equal(filesTab.definition.guide.length, 0)
  const guideEntries = registered.filter((entry) => entry.slot === 'sidebar.right.tab.guide.entry')
  assert.deepEqual(guideEntries.map((entry) => entry.options.key), ['dsh-ssh-workbench/servers'])
  const guideElement = guideEntries[0].component({ t: (key) => key, title: 'SSH', description: 'Servers and remote files' })
  const guideTree = guideElement.type(guideElement.props)
  const guideJson = JSON.stringify(guideTree)
  assert.match(guideJson, /SSH/)
  assert.match(guideJson, /Servers and remote files/)
  // The host suppresses guide descriptions for long lists; the card must too.
  const bareElement = guideEntries[0].component({ t: (key) => key, title: 'SSH' })
  const bareTree = bareElement.type(bareElement.props)
  assert.doesNotMatch(JSON.stringify(bareTree), /guide\.description/)
  const titles = registered.filter((entry) => entry.slot === 'sidebar.right.pane.tab.title')
  assert.deepEqual(titles.map((entry) => entry.options.key).sort(), ['dsh-ssh-workbench/file', 'dsh-ssh-workbench/files', 'dsh-ssh-workbench/servers', 'dsh-ssh-workbench/system-files'])
  const viewerTabs = tabs.filter((entry) => entry.definition.kind === 'sdh-file')
  assert.equal(viewerTabs.length, 1)
  assert.equal(viewerTabs[0].definition.multiple, true)
  const serversTitle = titles.find((entry) => entry.options.key === 'dsh-ssh-workbench/servers')
  const titleTree = serversTitle.component({})
  assert.equal(titleTree.type, 'span')
  assert.equal(titleTree.children.length, 2)
  assert.equal(typeof titleTree.children[0].type, 'function')
  assert.equal(titleTree.children[1].type, 'span')
  // Components must be renderable functions.
  for (const entry of registered.filter((item) => ['settings.section', 'sidebar.right.pane.tab'].includes(item.slot))) {
    assert.equal(typeof entry.component, 'function')
  }
  assert.equal(registered.filter((entry) => entry.slot === 'sidebar.right.pane.tab').length, 4)
  // The right-sidebar servers panel is a Luminax-style managed-resources view;
  // it must render (with the mocked React hooks) and expose search/add rows.
  const panel = registered.find((entry) => entry.slot === 'sidebar.right.pane.tab' && entry.options.key === 'dsh-ssh-workbench/servers')
  assert.ok(panel, 'missing servers panel body')
  const panelElement = panel.component({ t: (key) => key })
  const panelTree = panelElement.type({ t: (key) => key, ...panelElement.props })
  assert.equal(panelTree.type, 'div')
  const panelJson = JSON.stringify(panelTree)
  assert.match(panelJson, /panel\.search/)
  assert.match(panelJson, /panel\.loading/)
  // Left-rail workbench entry: the panel row plus the main page it selects.
  const panelRow = registered.find((entry) => entry.slot === 'sidebar.panellist')
  assert.ok(panelRow, 'missing sidebar.panellist workbench row')
  assert.equal(panelRow.options.id, 'dsh-ssh-workbench/workbench')
  assert.equal(typeof panelRow.component, 'function')
  const mainPage = registered.find((entry) => entry.slot === 'main')
  assert.ok(mainPage, 'missing workbench main page')
  assert.equal(mainPage.options.key, 'dsh-ssh-workbench/workbench')
  const pageElement = mainPage.component({})
  const pageTree = pageElement.type(pageElement.props)
  const pageJson = JSON.stringify(pageTree)
  assert.match(pageJson, /data-sdh-workbench-page/)
  assert.match(pageJson, /data-sdh-workbench-bar/)
  assert.match(pageJson, /workbench\.new/)
  // The strip vertically centers its 28px controls in the 38px bar (no top-only
  // padding), and the "+" menu hangs under the button instead of using viewport
  // fixed coordinates, which used to drop it over the left rail.
  assert.match(bundleSource, /dsh-ssh-workbench-wb-strip\{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:38px;flex:none;padding:0 6px 0 var\(--dsh-dockkit-strip-inline-start,10px\)/)
  assert.match(bundleSource, /role: 'menu', style: \{ position: 'absolute', top: 38/)
  assert.doesNotMatch(bundleSource, /role: 'menu', style: \{ top: 32/)
  // The terminal surface uses the active terminal palette so the strip and the
  // screen meet without a light band in dark mode.
  assert.match(bundleSource, /props\.dark === false \? WORKBENCH_LIGHT_TERM_THEME\.background : WORKBENCH_DARK_TERM_THEME\.background/)
  // The split gutter is one centered hairline, not a bordered 5px band (which
  // read as two stray vertical lines next to a light terminal).
  assert.match(bundleSource, /dsh-ssh-workbench-wb-split\{position:relative;flex:none;width:5px;cursor:col-resize\}/)
  assert.match(bundleSource, /dsh-ssh-workbench-wb-split::after\{content:"";position:absolute;top:0;bottom:0;left:2px;width:\.5px;background:var\(--dsw-alias-border-l3\)\}/)
  assert.doesNotMatch(bundleSource, /borderLeft: '0\.5px solid var\(--dsw-alias-border-l3\)', borderRight/)
  // Composer bridge registration powers the "Reference" action.
  assert.ok(slots.includes('conversation.input.activity'), 'missing composer bridge')
  // @server mentions in sent messages use the same inline reference-chip spec as @file.
  const serverChip = registered.find((entry) => entry.slot === 'conversation.user.text.node')
  assert.ok(serverChip, 'missing @server user-text chip')
  const chipJson = JSON.stringify(serverChip.component({ node: { data: { name: 'web-2' } }, raw: '@web-2' }))
  assert.match(chipJson, /web-2/)
  assert.match(chipJson, /business-primary/)
  const source = registered.find((entry) => entry.slot === '@source')
  assert.ok(source, 'missing @ source registration')
  assert.equal(source.source.trigger, '@')
  assert.equal(typeof source.source.candidates, 'function')
  assert.equal(typeof source.source.onPick, 'function')
  const picked = source.source.onPick({ candidate: { value: JSON.stringify({ name: 'web-1' }) } })
  // Picking a server inserts a native reference chip (same path as @file),
  // serialized back to '@web-1' for the model by the source codec.
  assert.deepEqual(picked, { insert: { source: 'ssh-workbench', ref: '@web-1', label: 'web-1', clipboardText: '@web-1' } })
  assert.equal(source.source.codec.serialize('@web-1') instanceof Promise, true)
  const rule = registered.find((entry) => entry.slot === 'userText')
  assert.ok(rule, 'missing userText matcher')
  assert.equal(rule.rule.id, 'ssh-server')
  assert.equal(typeof rule.rule.match, 'function')

  const toolViews = registered.filter((entry) => entry.slot === 'tool.call.toolview')
  assert.deepEqual(toolViews.map((entry) => entry.options.key), [], 'v2 has no target-selector tool')
})

test('the bundle config form exposes the system file hierarchy switch', () => {
  assert.match(bundleSource, /workbench\.hierarchyTitle/)
  // Flipping a switch commits that one field straight away; the page has no
  // Save button, so the patch must be built from the new value itself.
  assert.match(bundleSource, /commit\(\{ systemFileHierarchy: next \}\)/)
  assert.match(bundleSource, /prefsBody\?\.config\?\.systemFileHierarchy/)
  assert.match(bundleSource, /'data-sdh-switch': options\.key/)
})

test('the hierarchical system files page takes over the native files kind', () => {
  assert.match(bundleSource, /id: 'dsh-ssh-workbench\/system-files'\s*,\s*\n\s*kind: 'files'/, 'registers an extension for the native files kind')
  assert.match(bundleSource, /kind: 'files'\s*,\s*\n\s*keepMounted: true/)
  assert.match(bundleSource, /lockRoot: true/)
  assert.match(bundleSource, /openNative: true/)
  assert.match(bundleSource, /dsh-resource:\/\/file\/session\/\$\{encodeURIComponent\(props\.sessionId\)\}/)
  assert.match(bundleSource, /withinRoot\(target\)/)
  assert.match(bundleSource, /files\.outsideRoot/)
  // The guide entry must reuse DSH's own slot and artwork so the tab keeps its
  // original position on the guide page and reads like the native one.
  assert.match(bundleSource, /id: 'workspace'\s*,\s*\n\s*commandId: 'workspace\.files'/)
  assert.match(bundleSource, /order: 10\s*,\s*\n\s*title: \(\) => t\('files\.systemTitle'\)/)
  assert.match(bundleSource, /primitives\.GuideArtworkFiles/)
  // The tab title uses the official folder glyph rather than bespoke artwork.
  assert.match(bundleSource, /h\(FileTypeIcon, \{ kind: 'folder', size: 16/)
})

test('the bundle config form exposes both the sidebar and remote-write switches', () => {
  assert.match(bundleSource, /workbench\.writeTitle/)
  assert.match(bundleSource, /workbench\.writeHint/)
  assert.match(bundleSource, /'data-sdh-switch': options\.key/)
  assert.match(bundleSource, /commit\(\{ remoteFileWrite: next \}\)/)
  assert.match(bundleSource, /prefsBody\?\.config\?\.remoteFileWrite/)
  assert.match(bundleSource, /workbench\.writeNeedRestart/)
  assert.ok(bundleSource.includes('must be a boolean'), 'legacy prefs schema errors map to the restart hint')
  // The form is fixed by switches alone; no explicit save button remains.
  assert.doesNotMatch(bundleSource, /disabled: busy \|\| !loaded/)
  assert.match(bundleSource, /ctx\.inject\(\['remote\.session'\]/)
  assert.match(bundleSource, /session\.openWorkspacePath\(\{ path \}\)/)
  assert.match(bundleSource, /localChrome/)
  assert.match(bundleSource, /files\.openInApp/)
})

test('the local files page keeps search and the open-in-app split button', () => {
  // Search reuses the Host workspace search, the same one the native page calls.
  assert.match(bundleSource, /ctx\.inject\(\['remote\.workspaceFiles'\]/)
  assert.match(bundleSource, /files\.search\(sessionId, request\)/)
  assert.match(bundleSource, /data-sdh-files-search-toggle/)
  assert.match(bundleSource, /data-sdh-files-search-bar/)
  assert.match(bundleSource, /data-sdh-files-search-results/)
  assert.match(bundleSource, /data-sdh-files-search-row/)
  assert.match(bundleSource, /String\(query \|\| ''\)\.trim\(\)/)
  assert.match(bundleSource, /respectGitignore: true/)
  assert.match(bundleSource, /includeHidden: showHidden === true/)
  assert.match(bundleSource, /FILES_SEARCH_EXCLUDED/)
  // "Open in app" mirrors the native split button: default app plus a menu.
  assert.match(bundleSource, /data-sdh-open-in-app/)
  assert.match(bundleSource, /session\.workspacePathApplications\(\{ path \}\)/)
  assert.match(bundleSource, /openWorkspacePath\(\{ path: dir, application: id \}\)/)
  assert.match(bundleSource, /files\.openInAppWith/)
  assert.match(bundleSource, /files\.openInAppMore/)
  assert.match(bundleSource, /files\.openInAppDefault/)
  assert.match(bundleSource, /dsh-ssh-workbench-files-search-field/)
})

test('the sidebar switch removes the workbench rail entry but keeps the rest', () => {
  const { ctx, registered } = makeClientContext()
  const exports = loadBundle({ localStorage: { 'dsh-ssh-workbench.sidebar.enabled': '0' } }).factory(makeRequire())
  exports.apply(ctx)
  const slots = registered.map((entry) => entry.slot)
  assert.ok(slots.includes('settings.section'), 'settings section stays available')
  assert.ok(slots.includes('plugins.bundle.config'), 'the switch page must stay reachable')
  assert.ok(slots.includes('conversation.input.activity'), 'composer bridge is not a sidebar surface')
  assert.ok(!slots.includes('sidebar.panellist'), 'no left rail row while the switch is off')
  assert.ok(!slots.includes('main'), 'no workbench page while the switch is off')
  assert.ok(slots.includes('sidebarRightTabs'), 'the right sidebar is not controlled by this switch')
})

// Regression guards for the workbench defects fixed in the v1.3.7 QA round. The
// UI itself is hard to drive with the mocked hooks, so these pin the structural
// contracts that the fixes rely on.
test('workbench client fixes: preview, focus, active-tab polling, cleanup', () => {
  // U1: the workbench wires its own preview instead of reporting "unsupported".
  assert.match(bundleSource, /const fileActions = \{/)
  assert.match(bundleSource, /actions: fileActions/)
  assert.match(bundleSource, /onClose: \(\) => setPreview\(null\)/)
  assert.match(bundleSource, /h\(RemoteFileViewer, \{ t, params: preview, onClose: \(\) => setPreview\(null\) \}\)/)
  assert.match(bundleSource, /data-sdh-workbench-preview/)
  // The file panel hands over the row type so links/dirs fall back gracefully.
  assert.match(bundleSource, /type: entry\.type/)
  // U2: no local terminal is auto-opened on mount; the empty state owns entry.
  assert.doesNotMatch(bundleSource, /let opened = false/)
  assert.doesNotMatch(bundleSource, /^\s*void openTab\('local'\)\s*$/m)
  assert.match(bundleSource, /t\('workbench\.empty'\)/)
  // U3: the xterm screen takes focus when it becomes active.
  assert.match(bundleSource, /termRef\.current\?\.focus\(\)/)
  assert.match(bundleSource, /resumePollRef/)
  // P1: non-active tabs pause the long poll and abort their pending request.
  assert.match(bundleSource, /activeRef\.current/)
  assert.match(bundleSource, /pollAbort/)
  assert.match(bundleSource, /typeof AbortController === 'function'/)
  // R1: keyboard input drains through a single ordered queue.
  assert.match(bundleSource, /const flushInput = async \(\) =>/)
  assert.match(bundleSource, /inputQueue\.push\(data\)/)
  // R2: stale directory responses are discarded by sequence number.
  assert.match(bundleSource, /const loadSeqRef = useRef\(0\)/)
  assert.match(bundleSource, /seq !== loadSeqRef\.current/)
  // L4: the newest theme value is read from a ref when xterm is constructed.
  assert.match(bundleSource, /darkRef\.current \? WORKBENCH_DARK_TERM_THEME/)
  // L5: drag listeners are cleaned up and the split ratio is persisted.
  assert.match(bundleSource, /dragCleanupRef/)
  assert.match(bundleSource, /WORKBENCH_RATIO_KEY/)
  // S4: unload-safe close plus orphan-open tracking.
  assert.match(bundleSource, /navigator\.sendBeacon|nav\.sendBeacon/)
  assert.match(bundleSource, /'pagehide'/)
  assert.match(bundleSource, /'beforeunload'/)
  assert.match(bundleSource, /mountedRef\.current/)
  assert.match(bundleSource, /pendingOpensRef/)
  // E1: known open errors map to localized copy, unknown errors stay raw.
  assert.match(bundleSource, /workbench\.errTooManyTerminals/)
  assert.match(bundleSource, /workbench\.errConnect/)
  assert.match(bundleSource, /return text\s*\n\s*\}/)
  // U4: the local file pane labels its root with the real path.
  assert.match(bundleSource, /rootLabel: localRoot/)
  // macOS desktop chrome: the workbench strip occupies the window top band
  // and pads past the traffic lights / leading controls.
  assert.match(bundleSource, /\[data-platform=darwin\] \.dsh-ssh-workbench-wb-strip/)
  assert.match(bundleSource, /--dsh-frame-top-clearance/)
  assert.match(bundleSource, /--dsh-frame-leading-clearance/)
  // Host-key changes are surfaced instead of silently overwriting the trust.
  assert.match(bundleSource, /panel\.trustChangedTitle/)
  assert.match(bundleSource, /panel\.trustChangedButton/)
  assert.match(bundleSource, /knownPrints/)
  assert.match(bundleSource, /trusting\.changed/)
  // Host-key trust copy is a plain TOFU confirmation, not an instruction
  // requiring out-of-band verification.
  assert.match(bundleSource, /'panel\.trustTitle': '是否信任该服务器的主机密钥？'/)
  assert.match(bundleSource, /'panel\.trustButton': '信任'/)
  assert.doesNotMatch(bundleSource, /已核对，信任该指纹/)
  // U5: the remote pane asks for the login home and falls back to '/'.
  assert.match(bundleSource, /post\('\/sftp\/home', \{ ref \}\)/)
  assert.match(bundleSource, /activeRemoteHome \|\| '\/'/)
})


test('Windows local paths keep their separator in breadcrumbs and preview names', () => {
  // One path vocabulary for POSIX and Windows: detect the separator from the
  // root instead of assuming '/'.
  assert.match(bundleSource, /function pathSeparatorFor\(value\)/)
  assert.match(bundleSource, /function baseNameOf\(value\)/)
  assert.match(bundleSource, /relative\.split\(\/\[\\\\\/\]\+\/\)/)
  assert.match(bundleSource, /baseNameOf\(params\.path\)/)
  assert.doesNotMatch(bundleSource, /path\.split\('\/'\)\.pop\(\)/)
  // Resource cards show the dialect badge (Linux/Windows), not a raw token.
  assert.match(bundleSource, /settings\.platformPosix/)
  assert.match(bundleSource, /settings\.platformWindows/)
  assert.match(bundleSource, /platformText\(server\.dialect \?\? server\.platform\)/)
})

test('the composer execution dock mirrors the usage card', () => {
  assert.match(bundleSource, /'target\.execChip'/)
  assert.match(bundleSource, /'target\.runningOne'/)
  assert.match(bundleSource, /'target\.runningMany'/)
  assert.match(bundleSource, /'target\.execTitle'/)
  assert.match(bundleSource, /'target\.popTitle'/)
  assert.match(bundleSource, /'target\.rowCount'/)
  assert.match(bundleSource, /'aria-haspopup': 'dialog'/)
  assert.match(bundleSource, /data-sdh-target-dock/)
  // The panel is portaled to body so a composer stacking context cannot hide it.
  assert.match(bundleSource, /ReactDOM\.createPortal\(panel, document\.body\)/)
  assert.match(bundleSource, /panelRef\.current\.contains/)
  // Same anatomy as the shipped token-usage card: title + total, hairline, label/value grid.
  assert.match(bundleSource, /dsh-ssh-workbench-target-title\{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px/)
  assert.match(bundleSource, /dsh-ssh-workbench-target-rule\{border-top:\.5px solid var\(--dsw-alias-border-l2\);margin-bottom:10px\}/)
  assert.match(bundleSource, /dsh-ssh-workbench-target-details\{display:grid;grid-template-columns:minmax\(76px,auto\) minmax\(0,1fr\);gap:6px 16px/)
  // Read-only projection of the execution ledger: no active target, no switch.
  assert.doesNotMatch(bundleSource, /post\('\/target'/)
  assert.doesNotMatch(bundleSource, /Historical stats/)
  assert.doesNotMatch(bundleSource, /target-row-check/)
  assert.doesNotMatch(bundleSource, /target-badge/)
  const dockStart = bundleSource.indexOf('function TargetDock')
  const dockEnd = bundleSource.indexOf('Insert one native reference chip', dockStart)
  assert.ok(dockStart >= 0 && dockEnd > dockStart)
  const dockSource = bundleSource.slice(dockStart, dockEnd)
  assert.match(dockSource, /const rows = statsServers\.filter/)
  assert.match(dockSource, /runningNames\.length === 0/)
  assert.match(dockSource, /setInterval\(load, 1500\)/)
  assert.match(dockSource, /target\.runningLabel/)
  assert.doesNotMatch(dockSource, /api\('\/servers'/)
})

test('the file preview renders tables, raster and svg, and admits truncation', () => {
  // CSV/TSV are parsed into a header row plus bounded body instead of raw text.
  assert.match(bundleSource, /const FILES_TABLE_TYPES = \{ csv: ',', tsv: '\\t' \}/)
  assert.match(bundleSource, /function parseDelimitedTable\(source, separator\)/)
  assert.match(bundleSource, /if \(char === '"' && cell === ''\) \{ quoted = true/)
  assert.match(bundleSource, /function buildDelimitedTable\(source, separator\)/)
  assert.match(bundleSource, /data-sdh-table-preview/)
  assert.match(bundleSource, /'files\.tableMode'/)
  assert.match(bundleSource, /'files\.tableRows'/)
  assert.match(bundleSource, /'files\.tableTruncatedRows'/)
  assert.match(bundleSource, /'files\.tableTruncatedColumns'/)
  assert.match(bundleSource, /'files\.tableTruncatedBoth'/)
  // SVG is an image type but keeps its source available, so both views exist.
  assert.match(bundleSource, /ico: 'image\/x-icon', svg: 'image\/svg\+xml'/)
  assert.match(bundleSource, /function decodeBase64Text\(base64\)/)
  assert.match(bundleSource, /'files\.imageMode'/)
  assert.match(bundleSource, /const showImage = Boolean\(imageUrl\) && !\(isTextImage && imageSource\)/)
  // A truncated read no longer passes silently: header badge, footer hint and
  // an honest "first N lines" counter.
  assert.match(bundleSource, /'files\.truncated'/)
  assert.match(bundleSource, /'files\.viewerTruncated'/)
  assert.match(bundleSource, /'files\.linesPartial'/)
  assert.match(bundleSource, /const byteTruncated = meta && meta\.truncated === true/)
  // A clipped image payload cannot be decoded, so it says so instead of
  // rendering a broken picture, and clipped tables count "first N rows".
  assert.match(bundleSource, /'files\.viewerImageTruncated'/)
  assert.match(bundleSource, /const imageTruncated = showImage && byteTruncated/)
  assert.match(bundleSource, /'files\.tableRowsPartial'/)
})

test('the hierarchy page scopes local file requests to the session workspace', () => {
  // Windows workspaces can sit outside the local-pane root, so every local
  // file request from the hierarchy page carries the session id.
  assert.match(bundleSource, /const localSession = localMode && typeof props\.sessionId === 'string' && props\.sessionId \? props\.sessionId : undefined/)
  assert.match(bundleSource, /const filesPost = \(path, payload\) => post\(path, localSession \? \{ \.\.\.payload, session: localSession \} : payload\)/)
  assert.match(bundleSource, /filesPost\('\/sftp\/list'/)
  assert.match(bundleSource, /filesPost\('\/sftp\/open-read'/)
  // The full workspace path is shown, with the Windows separator between
  // breadcrumb segments.
  assert.match(bundleSource, /rootLabel: cwd/)
  assert.match(bundleSource, /pathSeparatorFor\(navRoot\)/)
  assert.match(bundleSource, /foldedRoot/)
  assert.match(bundleSource, /uiWorkspaceService/)
  assert.match(bundleSource, /pickDirectory\(\)/)
  assert.match(bundleSource, /chooseDirectory = async/)
  assert.match(bundleSource, /files\.pickDirectory/)
})
