const { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

function readAgendaDocument(file){
  if(!existsSync(file))return {schema_version:1,events:[]};
  if(statSync(file).size>1024*1024)throw new Error('日程文件过大');
  return JSON.parse(readFileSync(file,'utf8'));
}
exports.readAgendaDocument=readAgendaDocument;

exports.createCountdown = async function ({ dataDir, icon, onChange = () => {} }) {
  const { BrowserWindow, ipcMain, screen, shell } = require('electron');
  const { cleanPreferences, agendaEvents, upcomingEvents, fitBounds } = await import('./countdown-model.mjs');
  const stateFile = join(dataDir, 'countdown-window.json');
  const agendaFile = join(dataDir, 'personal-agenda.json');
  const pageURL = pathToFileURL(join(__dirname, 'countdown.html')).href;
  let preferences;
  try { preferences = cleanPreferences(JSON.parse(readFileSync(stateFile, 'utf8'))); }
  catch { preferences = cleanPreferences(null); }
  let win = null, poll = null, moveTimer = null, dragOrigin = null, stopping = false, lastSnapshot = '', preferenceError = false;
  const areas = () => screen.getAllDisplays().map(display => display.workArea);
  function save() {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(stateFile + '.tmp', JSON.stringify(preferences, null, 2) + '\n');
      renameSync(stateFile + '.tmp', stateFile);
      preferenceError = false;
    } catch (error) { preferenceError = true; console.warn('[countdown] preferences:', error.message); }
  }
  function snapshot() {
    let events = [], error = null;
    try {
      events=agendaEvents(readAgendaDocument(agendaFile));
      if (preferences.selectedId && !upcomingEvents(events).some(event => event.id === preferences.selectedId)) {
        preferences.selectedId = null;
        save();
      }
    } catch { error = '暂时读不到日程，正在自动重试'; }
    return { events, preferences: { ...preferences }, error,
      preferenceError: preferenceError ? '位置设置暂时未能保存' : null };
  }
  function publish(force = false) {
    if (!win || win.isDestroyed()) return;
    const next = snapshot(), encoded = JSON.stringify(next);
    if (force || encoded !== lastSnapshot) { lastSnapshot = encoded; win.webContents.send('countdown:snapshot', next); }
  }
  function rememberPosition() {
    if (!win || win.isDestroyed()) return;
    const { x, y } = win.getBounds();
    preferences.x = x; preferences.y = y; save();
  }
  function resize(height) {
    if (!win || win.isDestroyed() || !Number.isFinite(height)) return;
    const maximum = Math.min(720, screen.getDisplayMatching(win.getBounds()).workArea.height);
    const bounds = fitBounds(win.getBounds(), areas(), 360, Math.max(100, Math.min(maximum, Math.ceil(height))));
    if (win.getBounds().height !== bounds.height) win.setBounds(bounds, false);
  }
  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({ ...fitBounds(preferences, areas()), title: 'Coopanion 倒计时', icon,
      frame: false, transparent: false, backgroundColor: '#1c1d28', roundedCorners: true, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true,
      alwaysOnTop: preferences.topmost, show: false, hasShadow: true, autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, 'countdown-preload.cjs'), contextIsolation: true,
        sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false,
        partition: 'coopanion-countdown' },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('page-title-updated', event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.once('ready-to-show', () => { publish(true); if (preferences.visible) win.showInactive(); });
    win.on('move', () => { clearTimeout(moveTimer); moveTimer = setTimeout(rememberPosition, 250); });
    win.on('close', event => { if (!stopping) { event.preventDefault(); hide(); } });
    win.on('closed', () => { win = null; });
    void win.loadFile(join(__dirname, 'countdown.html')).catch(error => console.warn('[countdown] page:', error.message));
    return win;
  }
  function show() {
    preferences.visible = true; save();
    const current = ensureWindow();
    current.showInactive(); publish(true); onChange();
  }
  function hide() {
    rememberPosition(); preferences.visible = false; save(); win?.hide(); publish(true); onChange();
  }
  const authorized = event => win && !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === pageURL;
  const get = event => { if (!authorized(event)) throw new Error('Unknown countdown window'); return snapshot(); };
  const action = async (event, command, value) => {
    if (!authorized(event)) throw new Error('Unknown countdown window');
    if (command === 'drag-start') { dragOrigin = win.getBounds(); return; }
    if (command === 'drag' || command === 'drag-end') {
      if (!dragOrigin || !Number.isFinite(value?.dx) || !Number.isFinite(value?.dy) ||
        Math.abs(value.dx) > 20000 || Math.abs(value.dy) > 20000) return;
      const next = { ...dragOrigin, x: Math.round(dragOrigin.x + value.dx), y: Math.round(dragOrigin.y + value.dy) };
      win.setPosition(next.x, next.y, false);
      if (command === 'drag-end') {
        win.setBounds(fitBounds(next, areas(), 360, next.height), false);
        dragOrigin = null; rememberPosition();
      }
      return;
    }
    if (command === 'height') { resize(value); return; }
    if (command === 'hide') { hide(); return; }
    if (command === 'select') {
      if (value !== null && !upcomingEvents(snapshot().events).some(item => item.id === value)) return;
      preferences.selectedId = value;
    } else if (command === 'topmost') {
      preferences.topmost = !preferences.topmost; win.setAlwaysOnTop(preferences.topmost);
    } else if (command === 'collapse') preferences.collapsed = !preferences.collapsed;
    else if (command === 'open') {
      const item = snapshot().events.find(item => item.id === value);
      const url = item && (item.stream || item.url);
      if (url) await shell.openExternal(url);
      return;
    } else return;
    save(); publish(true);
  };
  ipcMain.handle('countdown:get', get);
  ipcMain.handle('countdown:action', action);
  function displaysChanged() {
    if (!win || win.isDestroyed()) return;
    win.setBounds(fitBounds(win.getBounds(), areas(), 360, win.getBounds().height), false);
    rememberPosition();
  }
  screen.on('display-removed', displaysChanged);
  screen.on('display-metrics-changed', displaysChanged);
  return {
    start() { if (preferences.visible) ensureWindow(); poll = setInterval(publish, 5000); poll.unref(); },
    show, hide, refresh() { publish(true); }, isVisible: () => preferences.visible,
    stop() {
      stopping = true; clearInterval(poll); clearTimeout(moveTimer); rememberPosition();
      ipcMain.removeHandler('countdown:get'); ipcMain.removeHandler('countdown:action');
      screen.removeListener('display-removed', displaysChanged); screen.removeListener('display-metrics-changed', displaysChanged);
      win?.destroy();
    },
  };
};
