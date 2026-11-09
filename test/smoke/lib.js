'use strict';
// Helpers for the release smoke test: starts a clean VS Code profile with the packaged extension
// installed and drives the real user interface with Playwright's Electron support.
//
// Needs: the `playwright-core` package (used only for testing, not shipped), an installed VS Code
// and the packaged .vsix in the project root. Point PLAYWRIGHT_CORE at the package folder when
// it is not resolvable from here, and CODE_DIR at the VS Code install folder when it is not in
// the default per-user location.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try the next */ }
  }
  throw new Error('playwright-core not found. Install it somewhere and set PLAYWRIGHT_CORE to its folder.');
}

function findCode() {
  const base = process.env.CODE_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code');
  const exe = path.join(base, 'Code.exe');
  if (!fs.existsSync(exe)) throw new Error('VS Code not found at ' + base + ' (set CODE_DIR).');
  return { exe: exe, cli: path.join(base, 'bin', 'code.cmd'), dir: base };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function freshProfile(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'edilens-'));
  const profile = {
    dir: dir,
    userData: path.join(dir, 'user'),
    extensions: path.join(dir, 'ext'),
    work: path.join(dir, 'work')
  };
  fs.mkdirSync(path.join(profile.userData, 'User'), { recursive: true });
  fs.mkdirSync(profile.extensions, { recursive: true });
  fs.mkdirSync(profile.work, { recursive: true });
  return profile;
}

function writeSettings(profile, extra) {
  const settings = Object.assign({
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.enableExperiments': false,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'window.dialogStyle': 'custom',
    'window.commandCenter': false,
    'files.simpleDialog.enable': true,
    'files.autoSave': 'off',
    'editor.minimap.enabled': false,
    'chat.commandCenter.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.layoutControl.enabled': false,
    'window.zoomLevel': 0
  }, JSON.parse(process.env.EDI_LENS_EXTRA_SETTINGS || '{}'), extra || {});
  fs.writeFileSync(path.join(profile.userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
}

/** Installs the packaged extension into the profile through the command line. */
function installVsix(profile, vsixPath) {
  const code = findCode();
  const r = cp.spawnSync('"' + code.cli + '"', [
    '--user-data-dir', '"' + profile.userData + '"',
    '--extensions-dir', '"' + profile.extensions + '"',
    '--install-extension', '"' + vsixPath + '"', '--force'
  ], { shell: true, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** Starts VS Code on the profile. Returns { app, page }. */
async function launch(profile, folderOrFiles, opts) {
  const o = opts || {};
  const pw = loadPlaywright();
  const code = findCode();
  const args = [
    '--user-data-dir=' + profile.userData,
    '--extensions-dir=' + profile.extensions,
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-telemetry', '--disable-updates', '--disable-gpu', '--new-window',
    '--password-store=basic',
    '--window-size=1500,950'
  ].concat(o.extraArgs || []);
  (Array.isArray(folderOrFiles) ? folderOrFiles : [folderOrFiles]).filter(Boolean).forEach(function (f) { args.push(f); });
  const env = Object.assign({}, process.env, o.env || {});
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await pw._electron.launch({ executablePath: code.exe, args: args, env: env, timeout: 90000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
  await sleep(2500);
  return { app: app, page: page };
}

/** Runs a Command Palette command by its title text. */
async function runCommand(page, title) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('F1');
  const sel = '.quick-input-widget:not([style*="display: none"]) input';
  try {
    await page.waitForSelector(sel, { timeout: 3000 });
  } catch (e) {
    // Focus may sit inside a web view: click the title bar to give it back to the workbench.
    for (const target of ['.tabs-container .tab', '.activitybar .action-item', '.titlebar-container .window-title']) {
      await page.click(target, { timeout: 2000 }).catch(function () {});
      await page.keyboard.press('F1');
      try { await page.waitForSelector(sel, { timeout: 3000 }); break; } catch (e2) { /* try the next target */ }
    }
    await page.waitForSelector(sel, { timeout: 10000 });
  }
  await page.keyboard.type('>' + title, { delay: 8 });
  await sleep(600);
  // Choose the row whose label is exactly the title; fall back to the first row.
  const rows = await page.$$('.quick-input-widget .quick-input-list .monaco-list-row');
  let chosen = null;
  for (const row of rows) {
    const nameEl = await row.$('.label-name');
    const label = nameEl ? ((await nameEl.textContent()) || '').trim() : '';
    if (label === title) { chosen = row; break; }
  }
  if (chosen) await chosen.click();
  else await page.keyboard.press('Enter');
  await sleep(500);
}

/** Opens a file through Quick Open (Ctrl+P) by its path. */
async function openFile(page, filePath) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.quick-input-widget:not([style*="display: none"]) input', { timeout: 10000 });
  await page.keyboard.type(filePath.replace(/\\/g, '/'), { delay: 4 });
  await sleep(700);
  await page.keyboard.press('Enter');
  await sleep(1200);
}

/** Returns the texts of the notifications currently on screen. */
async function notifications(page) {
  return page.$$eval('.notifications-toasts .notification-list-item, .notifications-center .notification-list-item', function (els) {
    return els.map(function (e) {
      const m = e.querySelector('.notification-list-item-message');
      const b = Array.from(e.querySelectorAll('.monaco-button')).map(function (x) { return x.textContent.trim(); });
      return { text: m ? m.textContent.trim() : e.textContent.trim(), buttons: b };
    });
  });
}

/** Waits until a notification containing `needle` shows up; resolves to it or null. */
async function waitNotification(page, needle, timeoutMs) {
  const end = Date.now() + (timeoutMs || 8000);
  while (Date.now() < end) {
    const list = await notifications(page);
    const hit = list.find(function (n) { return n.text.indexOf(needle) !== -1; });
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

/** Clicks the button with the given label inside the notification containing `needle`. */
async function clickNotificationButton(page, needle, label) {
  const items = await page.$$('.notifications-toasts .notification-list-item, .notifications-center .notification-list-item');
  for (const item of items) {
    const text = await item.textContent();
    if (text.indexOf(needle) === -1) continue;
    const buttons = await item.$$('.monaco-button');
    for (const b of buttons) {
      if ((await b.textContent()).trim() === label) { await b.click(); return true; }
    }
  }
  return false;
}

/** Closes every notification. */
async function clearNotifications(page) {
  await page.keyboard.press('Escape');
  try { await page.evaluate(function () { return null; }); } catch (e) { /* ignore */ }
  const clear = await page.$('.notifications-toasts .codicon-notifications-clear, .notification-toast .codicon-close');
  if (clear) { try { await clear.click({ timeout: 1000 }); } catch (e) { /* ignore */ } }
  await runCommand(page, 'Notifications: Clear All Notifications').catch(function () {});
}

/** Text of the status bar. */
async function statusBar(page) {
  return page.$$eval('.statusbar .statusbar-item', function (els) {
    return els.map(function (e) { return (e.getAttribute('aria-label') || e.textContent || '').trim(); }).filter(Boolean);
  });
}

/** Text of the active editor's view lines (what is currently rendered). */
async function editorText(page) {
  return page.$$eval('.editor-instance .monaco-editor .view-lines .view-line', function (els) {
    return els.map(function (e) { return e.textContent.replace(/ /g, ' '); }).join('\n');
  }).catch(function () { return ''; });
}

/** Closes all editors without saving. */
async function closeAll(page) {
  await runCommand(page, 'View: Close All Editors');
  await sleep(600);
  const dlg = await page.$('.monaco-dialog-box');
  if (dlg) {
    const buttons = await page.$$('.monaco-dialog-box .dialog-buttons .monaco-button');
    for (const b of buttons) {
      if (((await b.textContent()) || '').trim() === "Don't Save") { await b.click(); break; }
    }
    await sleep(500);
  }
}

function shot(page, file) { return page.screenshot({ path: file }); }

module.exports = {
  ROOT: ROOT, sleep: sleep, loadPlaywright: loadPlaywright, findCode: findCode,
  freshProfile: freshProfile, writeSettings: writeSettings, installVsix: installVsix, launch: launch,
  runCommand: runCommand, openFile: openFile, notifications: notifications, waitNotification: waitNotification,
  clickNotificationButton: clickNotificationButton, clearNotifications: clearNotifications,
  statusBar: statusBar, editorText: editorText, closeAll: closeAll, shot: shot
};
