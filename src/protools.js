'use strict';
// Commands of the Pro tools added in 0.2.0: anonymise, partner rules, query and the envelope
// tools, and the Query Results view. The work itself is done by the modules in src/pro, which do
// not use the editor API; this file connects them to the editor: it asks the questions, reads
// and writes files, shows progress with a cancel button and reports the outcome.
//
// registerProTools(app, h) is called by registerCommands() with its helpers: h.reg, h.requirePro,
// h.ediEditor, h.info, h.warn, h.incomplete and h.tooLargeForPro. Every command passes the same
// Pro gate (licence first, then the trial) as the older Pro commands.

const nodePath = require('node:path');
const { decodeUtf8, exceedsLimit, languageIdForFormat, formatLabel, isSupportedLanguage, shorten } = require('./format');

const MAX_FOLDER_FILES = 2000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SAVED_QUERIES = 50;
const SAVED_QUERIES_KEY = 'ediLens.savedQueries';
const BOM = '﻿';
const EXTENSION_OF = { edifact: '.edi', x12: '.x12', hl7: '.hl7' };

/** Checks the text of a start value; returns an error text or null. */
function startNumberError(input) {
  const text = String(input === undefined || input === null ? '' : input).trim();
  if (!/^[0-9]{1,9}$/.test(text) || Number(text) < 1) return 'Enter a whole number from 1 to 999999999.';
  return null;
}

/** Normalises the list of saved queries read from the workspace state. */
function savedQueryList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(function (q) { return q && typeof q.name === 'string' && typeof q.text === 'string' && q.name.trim() !== '' && q.text.trim() !== ''; })
    .map(function (q) { return { name: q.name.trim().slice(0, 80), text: q.text.trim().slice(0, 1000) }; })
    .slice(0, MAX_SAVED_QUERIES);
}

/** Splits a file name into [base, extension]; the extension includes the dot. */
function splitName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|]/g, '_');
  const dot = clean.lastIndexOf('.');
  if (dot <= 0) return [clean || 'message', ''];
  return [clean.slice(0, dot), clean.slice(dot)];
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

function registerProTools(app, h) {
  const vscode = app.vscode;
  const reg = h.reg;
  const info = h.info;
  const warn = h.warn;
  const disposables = [];

  const rulesCollection = vscode.languages.createDiagnosticCollection('ediLens.rules');
  disposables.push(rulesCollection);
  const session = { rewriter: null, seeded: false, rulesRun: null, query: null };
  // The positions of rule violations belong to the text that was checked. When that text is
  // edited they are removed instead of drifting; the command is run again for a fresh list.
  const checkedTexts = new Set();
  disposables.push(vscode.workspace.onDidChangeTextDocument(function (event) {
    if (!event || !event.document || !event.contentChanges || event.contentChanges.length === 0) return;
    const key = event.document.uri.toString();
    if (checkedTexts.has(key)) {
      checkedTexts.delete(key);
      rulesCollection.delete(event.document.uri);
    }
  }));

  function pro() { return app.getPro(); }
  // Shows an input box that stays open when the focus moves away. The question is the title.
  function inputBox(options) {
    return vscode.window.showInputBox(Object.assign({ ignoreFocusOut: true }, options));
  }
  function settings() { return app.getSettings(); }
  function documentText(editor) { return editor.document.getText(); }
  function labelOf(uri) { return vscode.workspace.asRelativePath(uri, false); }
  function baseName(uri) { return String(uri.path || '').split('/').pop() || ''; }

  // ---- files ----------------------------------------------------------------------------------

  function folderOf(uri) {
    if (uri && typeof vscode.workspace.getWorkspaceFolder === 'function') {
      const f = vscode.workspace.getWorkspaceFolder(uri);
      if (f) return f.uri;
    }
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.length ? folders[0].uri : null;
  }

  function childUri(base, relative) {
    const parts = String(relative).split(/[\\/]+/).filter(function (p) { return p !== '' && p !== '.'; });
    const path = base.path.replace(/\/+$/, '') + '/' + parts.join('/');
    return base.with({ path: path });
  }

  // The location of a rule file named by a setting: an absolute path, or a path inside the folder.
  function configUri(value, folder) {
    const text = String(value || '').trim();
    if (text === '') return null;
    if (nodePath.isAbsolute(text)) return vscode.Uri.file(text);
    if (!folder) return null;
    return childUri(folder, text);
  }

  // Reads a small text file. Returns { text }, { missing: true } or { error }.
  async function readConfig(uri) {
    if (!uri) return { missing: true };
    let bytes;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (e) {
      return { missing: true };
    }
    if (bytes.length > MAX_CONFIG_BYTES) return { error: 'The file ' + labelOf(uri) + ' is larger than 1 MB, so it was not read.' };
    const decoded = decodeUtf8(bytes);
    if (!decoded) return { error: 'The file ' + labelOf(uri) + ' is not valid UTF-8 text. Save it as UTF-8 and try again.' };
    return { text: decoded.text };
  }

  // Reads one message file of a folder run. Returns { text, bom } or { skipped: reason }.
  async function readMessageFile(uri) {
    const limit = settings().maxFileSizeMB;
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size === 0) return { skipped: 'The file is empty.' };
      if (st.size > limit * 1024 * 1024 * 4) return { skipped: 'Larger than the ' + limit + ' MB limit (setting ediLens.maxFileSizeMB).' };
      const decoded = decodeUtf8(await vscode.workspace.fs.readFile(uri));
      if (!decoded) return { skipped: 'Not valid UTF-8 text.' };
      if (exceedsLimit(decoded.text.length, limit)) return { skipped: 'Larger than the ' + limit + ' MB limit (setting ediLens.maxFileSizeMB).' };
      return { text: decoded.text, bom: decoded.bom };
    } catch (e) {
      return { skipped: 'The file could not be read.' };
    }
  }

  // The folder a command was started on from the Explorer, or null. A command started from the
  // context menu of an editor receives the file of that editor instead, which is no folder.
  async function folderArgument(arg) {
    if (!arg || !arg.scheme || typeof arg.path !== 'string') return null;
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.toString() === arg.toString()) return null;
    try {
      const st = await vscode.workspace.fs.stat(arg);
      if (vscode.FileType && st.type === vscode.FileType.File) return null;
    } catch (e) { /* not readable as a file: treat it as the folder it was offered as */ }
    return arg;
  }

  // The folder a folder command works on: the Explorer item, the only workspace folder, or a pick.
  async function pickFolder(arg, placeHolder) {
    const given = await folderArgument(arg);
    if (given) return given;
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) {
      warn('Open a folder first (File > Open Folder), then run this command again or right-click a folder in the Explorer.');
      return null;
    }
    if (folders.length === 1) return folders[0].uri;
    const chosen = await vscode.window.showQuickPick(folders.map(function (f) { return { label: f.name, description: f.uri.fsPath, uri: f.uri }; }), { placeHolder: placeHolder });
    return chosen ? chosen.uri : null;
  }

  // The message files of a folder (by the include and exclude settings), sorted by path.
  async function listFolder(folder) {
    const s = settings();
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, s.workspaceInclude), s.workspaceExclude, MAX_FOLDER_FILES + 1);
    const sorted = found.slice().sort(function (a, b) { return a.toString() < b.toString() ? -1 : a.toString() > b.toString() ? 1 : 0; });
    return { files: sorted.slice(0, MAX_FOLDER_FILES), more: found.length > MAX_FOLDER_FILES };
  }

  function folderText(folder) { return folder.scheme === 'file' ? folder.fsPath : folder.toString(); }

  // Runs `work(file, index)` over files with a progress notification that can be cancelled.
  async function overFiles(title, files, work) {
    let cancelled = false;
    const failed = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: title, cancellable: true }, async function (progress, token) {
      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) { cancelled = true; break; }
        progress.report({ message: (i + 1) + ' of ' + files.length + ': ' + labelOf(files[i]), increment: 100 / files.length });
        try {
          await work(files[i], i, token);
        } catch (e) {
          failed.push(labelOf(files[i]));
        }
      }
    });
    if (failed.length) {
      warn(plural(failed.length, 'file') + ' could not be processed because of an unexpected error and ' + (failed.length === 1 ? 'was' : 'were') + ' left out: ' +
        failed.slice(0, 5).join(', ') + (failed.length > 5 ? ', ...' : '') + '. Nothing was written for ' + (failed.length === 1 ? 'it' : 'them') + '. Please run "EDI Lens: Report A Problem".');
    }
    return cancelled;
  }

  async function openText(content, language, beside) {
    const doc = await vscode.workspace.openTextDocument({ content: content, language: language });
    await vscode.window.showTextDocument(doc, { viewColumn: beside ? vscode.ViewColumn.Beside : undefined, preview: false });
    return doc;
  }

  // Asks where to save and writes the text there. Returns true when a file was written.
  async function saveText(defaultName, text, filters) {
    const folders = vscode.workspace.workspaceFolders || [];
    const target = await vscode.window.showSaveDialog({
      defaultUri: folders.length ? childUri(folders[0].uri, defaultName) : undefined,
      filters: filters
    });
    if (!target) return false;
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    return true;
  }

  function editorFor(verb) {
    const editor = h.ediEditor();
    if (!editor) return null;
    if (h.tooLargeForPro(editor, verb)) return null;
    return editor;
  }

  // ---- anonymise ------------------------------------------------------------------------------

  // Loads the anonymise rule file (optional) and builds the rule set. Returns null after a message.
  async function anonymiseRules(folder) {
    const mod = pro().anonymise;
    const s = settings().anonymise;
    const read = await readConfig(configUri(s.rulesFile, folder));
    if (read.error) { warn(read.error); return null; }
    let config = null;
    if (read.text !== undefined) {
      const loaded = mod.loadRules(read.text);
      if (!loaded.ok) {
        vscode.window.showErrorMessage('EDI Lens: the anonymise rule file ' + s.rulesFile + ' is not valid, so nothing was anonymised (' + loaded.code + '). ' + loaded.errors.slice(0, 3).join(' '));
        return null;
      }
      config = loaded.config;
    }
    const compiled = mod.compile(config, s.profiles, { envelopeIds: s.envelopeIds });
    // The envelope ids alone are not a rule set: something must name values of the body.
    if (!compiled.list.some(function (r) { return !r.envelope; })) {
      warn('No anonymise rules are active (' + mod.CODES.nothingToDo + '). Choose at least one profile in the setting ediLens.anonymise.profiles or add rules to ' + s.rulesFile + '.');
      return null;
    }
    return { compiled: compiled, fromFile: read.text !== undefined };
  }

  async function askSeed() {
    const seed = await inputBox({
      title: 'EDI Lens anonymise: seed (optional). The same seed gives the same replacements in every run.',
      placeHolder: 'Leave empty for a random seed that is used for this run only',
      password: true
    });
    return seed === undefined ? null : String(seed);
  }

  async function showAnonymiseReport(entries, seeded, rewriter) {
    const text = pro().anonymise.toReport(entries, { seeded: seeded, mapSize: rewriter.size() });
    await openText(text, 'markdown', false);
  }

  reg('ediLens.anonymise', async function () {
    if (!(await h.requirePro('Anonymise Message'))) return;
    const editor = editorFor('anonymised');
    if (!editor) return;
    const mod = pro().anonymise;
    if (!mod) { h.incomplete('anonymise module'); return; }
    const rules = await anonymiseRules(folderOf(editor.document.uri));
    if (!rules) return;
    const seed = await askSeed();
    if (seed === null) return;
    const result = mod.anonymiseText(documentText(editor), rules.compiled, { seed: seed });
    if (!result.ok) { warn(result.message + ' (' + result.code + ')'); return; }
    const r = result.report;
    // No rule matched anything in the body: such a text must not look like an anonymised copy.
    if (r.changedBody === 0) {
      warn('No rule matched a value in this ' + formatLabel(result.format) + ' file, so no anonymised copy was made. The active profiles and rules name no value that occurs in it. Add rules for the paths that identify somebody to ' + settings().anonymise.rulesFile + ', or choose another profile in ediLens.anonymise.profiles.');
      return;
    }
    session.rewriter = result.rewriter;
    session.seeded = seed !== '';
    await openText(result.text, languageIdForFormat(result.format), true);
    const report = 'Show Report';
    const pick = await info('Anonymised copy opened in a new editor: ' + plural(r.changed, 'value') + ' replaced in ' + plural(r.segments, 'segment') +
      (r.changedEnvelope ? ' (' + r.changedEnvelope + ' of them sender and receiver ids of the envelope)' : settings().anonymise.envelopeIds === 'keep' ? ' (the sender and receiver ids of the envelope were kept, as set)' : '') +
      (r.protectedSkipped ? ', ' + plural(r.protectedSkipped, 'protected envelope value') + ' left as they are' : '') +
      '. The original file was not changed. Check the copy before you share it: only the values named by the rules were replaced.', report);
    if (pick === report) await showAnonymiseReport([{ label: labelOf(editor.document.uri), report: r }], session.seeded, result.rewriter);
  });

  reg('ediLens.anonymiseFolder', async function (arg) {
    if (!(await h.requirePro('Anonymise Folder'))) return;
    const mod = pro().anonymise;
    if (!mod) { h.incomplete('anonymise module'); return; }
    const folder = await pickFolder(arg, 'Folder to anonymise');
    if (!folder) return;
    const rules = await anonymiseRules(folder);
    if (!rules) return;
    const listed = await listFolder(folder);
    if (listed.files.length === 0) { info('No EDI files (by extension) were found in that folder. The files are matched by the setting ediLens.workspace.include.'); return; }
    const target = folder.with({ path: folder.path.replace(/\/+$/, '') + '-anonymised' });
    const go = 'Anonymise';
    const answer = await vscode.window.showWarningMessage(
      'Anonymise ' + plural(listed.files.length, 'file') + (listed.more ? ' (the first ' + MAX_FOLDER_FILES + ' of more)' : '') + ' from ' + folderText(folder) +
      '? The copies are written to ' + folderText(target) + ' with the same file names; files that are already there are replaced. The source files are not changed.',
      { modal: true }, go);
    if (answer !== go) return;
    const seed = await askSeed();
    if (seed === null) return;
    const rewriter = mod.createRewriter(seed);
    const entries = [];
    let written = 0;
    let untouched = 0;
    const copyUnchanged = settings().anonymise.copyUnchanged;
    const cancelled = await overFiles('EDI Lens: anonymising files', listed.files, async function (uri) {
      const label = labelOf(uri);
      const read = await readMessageFile(uri);
      if (read.skipped) { entries.push({ label: label, skipped: read.skipped }); return; }
      const result = mod.anonymiseText(read.text, rules.compiled, { rewriter: rewriter });
      if (!result.ok) { entries.push({ label: label, skipped: result.message }); return; }
      const relative = uri.path.slice(folder.path.replace(/\/+$/, '').length);
      const out = childUri(target, relative);
      // No rule matched a value in the body: the file is not anonymised and is not written into
      // the folder of anonymised copies, unless the user asked for unchanged copies as well.
      if (result.report.changedBody === 0) {
        untouched++;
        let copied = false;
        if (copyUnchanged) {
          try {
            await vscode.workspace.fs.writeFile(out, Buffer.from((read.bom ? BOM : '') + read.text, 'utf8'));
            copied = true;
          } catch (e) { copied = false; }
        }
        entries.push({ label: label, report: result.report, unchanged: true, copied: copied });
        return;
      }
      try {
        await vscode.workspace.fs.writeFile(out, Buffer.from((read.bom ? BOM : '') + result.text, 'utf8'));
        written++;
        entries.push({ label: label, report: result.report });
      } catch (e) {
        entries.push({ label: label, skipped: 'The copy could not be written.' });
      }
    });
    session.rewriter = rewriter;
    session.seeded = seed !== '';
    await showAnonymiseReport(entries, session.seeded, rewriter);
    const leftOut = entries.length - written - untouched;
    const summary = 'Anonymise finished' + (cancelled ? ' (cancelled, partial result)' : '') + ': ' + written + (written === 1 ? ' anonymised copy' : ' anonymised copies') + ' written to ' + folderText(target) + ', ' +
      plural(leftOut, 'file') + ' left out. The report is open in the editor; it lists counts only.';
    if (untouched > 0) {
      warn(plural(untouched, 'file') + ' unchanged: no rule matched a value in ' + (untouched === 1 ? 'it' : 'them') + ', so ' + (untouched === 1 ? 'it is' : 'they are') + ' NOT anonymised' +
        (copyUnchanged ? ' and ' + (untouched === 1 ? 'was' : 'were') + ' copied as ' + (untouched === 1 ? 'it is' : 'they are') + ' (setting ediLens.anonymise.copyUnchanged); the report names ' + (untouched === 1 ? 'it' : 'them') + '. ' : ' and ' + (untouched === 1 ? 'was' : 'were') + ' not written to the target folder. ') + summary);
    } else {
      info(summary);
    }
  });

  reg('ediLens.exportPseudonymMap', async function () {
    if (!(await h.requirePro('Export Pseudonym Map'))) return;
    const mod = pro().anonymise;
    if (!mod) { h.incomplete('anonymise module'); return; }
    if (!session.rewriter || session.rewriter.size() === 0) {
      info('There is no replacement table to export. Run "EDI Lens: Anonymise Message" or "EDI Lens: Anonymise Folder" first; the table of the last run is kept in memory only until this window is closed.');
      return;
    }
    const go = 'Export';
    const answer = await vscode.window.showWarningMessage(
      'Export the replacement table of the last anonymise run (' + plural(session.rewriter.size(), 'value') + ')? The file lists every original value next to its replacement, so it is as sensitive as the original messages. Nothing is written unless you choose Export.',
      { modal: true }, go);
    if (answer !== go) return;
    const text = mod.mapToCsv(session.rewriter, settings().exportNeutraliseFormulas);
    const saved = await saveText('pseudonym-map.csv', text, { CSV: ['csv'] });
    if (saved) info('The replacement table was written' + (session.rewriter.overflowed() ? ' (the first 100,000 values; the table was full)' : '') + '. Keep it as safe as the original messages.');
  });

  // ---- partner rules --------------------------------------------------------------------------

  // Loads the partner rule file. Returns the guide or null after a message.
  async function loadGuide(folder, offerCreate) {
    const mod = pro().rules;
    const file = settings().rules.file;
    const read = await readConfig(configUri(file, folder));
    if (read.error) { warn(read.error); return null; }
    if (read.missing) {
      const create = 'Create Rules From This Message';
      const text = 'No partner rule file was found at ' + file + (folder ? ' in ' + folderText(folder) : ' (open a folder, or set an absolute path in ediLens.rules.file)') +
        '. Create one there, or let EDI Lens write a starting rule file from a message.';
      if (offerCreate) {
        const pick = await vscode.window.showWarningMessage(text, create);
        if (pick === create) await vscode.commands.executeCommand('ediLens.createRules');
      } else {
        warn(text);
      }
      return null;
    }
    const loaded = mod.loadRules(read.text);
    if (!loaded.ok) {
      vscode.window.showErrorMessage('EDI Lens: the partner rule file ' + file + ' is not valid, so nothing was checked (' + loaded.code + '). ' + loaded.errors.slice(0, 3).join(' '));
      return null;
    }
    return loaded.guide;
  }

  function toDiagnostics(violations) {
    const severities = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };
    return violations.map(function (v) {
      const d = new vscode.Diagnostic(new vscode.Range(v.line, v.column, v.endLine, v.endColumn), v.message, severities[v.severity]);
      d.code = v.code;
      d.source = 'EDI Lens rules';
      return d;
    });
  }

  function notApplicableText(guide, result) {
    return 'The rule file' + (guide.name ? ' "' + shorten(guide.name, 60) + '"' : '') + ' is for ' + formatLabel(guide.format) +
      (guide.messageTypes && guide.messageTypes.length ? ' messages of type ' + guide.messageTypes.slice(0, 6).join(', ') : ' messages') +
      '; this file is ' + formatLabel(result.format) + ' with ' + plural(result.units, 'message') + ', none of which the rules apply to. Nothing was checked.';
  }

  reg('ediLens.validateWithRules', async function () {
    if (!(await h.requirePro('Validate With Partner Rules'))) return;
    const editor = editorFor('checked against the partner rules');
    if (!editor) return;
    const mod = pro().rules;
    if (!mod) { h.incomplete('partner rules module'); return; }
    const guide = await loadGuide(folderOf(editor.document.uri), true);
    if (!guide) return;
    const result = mod.validateText(documentText(editor), guide, { maxIssues: settings().maxIssues });
    if (!result.ok) { warn(result.message + ' (' + result.code + ')'); return; }
    if (!result.applicable) {
      rulesCollection.delete(editor.document.uri);
      info(notApplicableText(guide, result));
      return;
    }
    rulesCollection.set(editor.document.uri, toDiagnostics(result.violations));
    checkedTexts.add(editor.document.uri.toString());
    const n = result.violations.length;
    if (n === 0) {
      info('No rule violations: ' + plural(result.unitsChecked, 'message') + ' checked against ' + plural(guide.rules.length, 'partner rule') + '.');
      return;
    }
    const pick = await info(plural(n, 'rule violation') + (result.truncated ? ' (the list was cut at the limit of ediLens.maxIssues)' : '') + ' in ' + plural(result.unitsChecked, 'message') +
      '. They are listed in the Problems view with the rule id; "EDI Lens: Clear Partner Rules Results" removes them.', h.BUTTONS.problems);
    if (pick === h.BUTTONS.problems) await vscode.commands.executeCommand('workbench.actions.view.problems');
  });

  reg('ediLens.createRules', async function () {
    if (!(await h.requirePro('Create Rules From This Message'))) return;
    const editor = editorFor('read');
    if (!editor) return;
    const mod = pro().rules;
    if (!mod) { h.incomplete('partner rules module'); return; }
    const result = mod.inferRules(documentText(editor), { label: baseName(editor.document.uri) || 'a message' });
    if (!result.ok) { warn(result.message + ' (' + result.code + ')'); return; }
    await openText(JSON.stringify(result.guide, null, 2) + '\n', 'json', true);
    info('A starting rule file with ' + plural(result.guide.rules.length, 'rule') + ' was created from ' + plural(result.units, 'message') +
      ' and opened in a new editor. It describes only what this file shows: review it, remove what is too strict, then save it as ' + settings().rules.file + ' in your workspace folder.');
  });

  reg('ediLens.validateFolderWithRules', async function (arg) {
    if (!(await h.requirePro('Validate Folder With Partner Rules'))) return;
    const mod = pro().rules;
    if (!mod) { h.incomplete('partner rules module'); return; }
    const folder = await pickFolder(arg, 'Folder to check against the partner rules');
    if (!folder) return;
    const guide = await loadGuide(folder, false);
    if (!guide) return;
    const listed = await listFolder(folder);
    if (listed.files.length === 0) { info('No EDI files (by extension) were found in that folder. The files are matched by the setting ediLens.workspace.include.'); return; }
    const files = [];
    rulesCollection.clear();
    checkedTexts.clear();
    const cancelled = await overFiles('EDI Lens: checking files against the partner rules', listed.files, async function (uri) {
      const label = labelOf(uri);
      const read = await readMessageFile(uri);
      if (read.skipped) { files.push({ label: label, skipped: read.skipped }); return; }
      const result = mod.validateText(read.text, guide, { maxIssues: settings().maxIssues });
      if (!result.ok) { files.push({ label: label, skipped: result.message }); return; }
      files.push({ label: label, result: result });
      if (result.applicable && result.violations.length) {
        rulesCollection.set(uri, toDiagnostics(result.violations));
        checkedTexts.add(uri.toString());
      }
    });
    const options = { guideName: guide.name, cancelled: cancelled, reportDate: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' };
    session.rulesRun = { files: files, options: options };
    const html = mod.toHtml(files, options);
    const panel = vscode.window.createWebviewPanel('ediLensRulesReport', 'EDI Lens: partner rules report', vscode.ViewColumn.Active, { enableScripts: false });
    panel.webview.html = html;
    const checked = files.filter(function (f) { return f.result && f.result.applicable; });
    let total = 0;
    checked.forEach(function (f) { total += f.result.violations.length; });
    const saveHtml = 'Save HTML Report...';
    const saveCsv = 'Save CSV Report...';
    const pick = await info('Checked ' + plural(checked.length, 'file') + ' against ' + plural(guide.rules.length, 'partner rule') + ': ' + plural(total, 'violation') + ', ' +
      plural(files.length - checked.length, 'file') + ' not checked' + (cancelled ? ' (cancelled, partial result)' : '') + (listed.more ? ' (only the first ' + MAX_FOLDER_FILES + ' files were read)' : '') +
      '. The report is open; the violations are also in the Problems view.', saveHtml, saveCsv);
    if (pick === saveHtml) await saveText('partner-rules-report.html', html, { HTML: ['html'] });
    else if (pick === saveCsv) await saveText('partner-rules-report.csv', mod.toCsv(files, settings().exportNeutraliseFormulas), { CSV: ['csv'] });
  });

  reg('ediLens.clearRulesResults', function () {
    rulesCollection.clear();
    checkedTexts.clear();
    info('The partner rules results were cleared from the Problems view.');
  });

  // ---- query ----------------------------------------------------------------------------------

  const treeChanged = new vscode.EventEmitter();
  disposables.push(treeChanged);

  function resultNodes() {
    if (!session.query) return [];
    return session.query.files.filter(function (f) { return f.result && f.result.matches.length > 0; }).map(function (f) { return { kind: 'file', file: f }; });
  }

  const provider = {
    onDidChangeTreeData: treeChanged.event,
    getChildren: function (node) {
      if (!node) return resultNodes();
      if (node.kind === 'file') return node.file.result.matches.map(function (m) { return { kind: 'match', file: node.file, match: m }; });
      if (node.kind === 'match') return node.match.hits.map(function (hit) { return { kind: 'hit', file: node.file, match: node.match, hit: hit }; });
      return [];
    },
    getTreeItem: function (node) {
      const states = vscode.TreeItemCollapsibleState;
      let item;
      if (node.kind === 'file') {
        item = new vscode.TreeItem(shorten(node.file.label, 80), states.Expanded);
        item.description = plural(node.file.result.matches.length, 'message');
        item.tooltip = node.file.label;
        item.iconPath = new vscode.ThemeIcon('file');
        item.contextValue = 'ediLens.queryFile';
        item.command = { command: 'ediLens.revealQueryResult', title: 'Reveal', arguments: [node.file.uri, 0, 0, 0] };
      } else if (node.kind === 'match') {
        const m = node.match;
        item = new vscode.TreeItem('Message ' + m.unit + (m.type ? ' · ' + shorten(m.type, 30) : '') + (m.ref ? ' · ' + shorten(m.ref, 40) : ''), m.hits.length ? states.Collapsed : states.None);
        item.description = 'line ' + (m.line + 1);
        item.iconPath = new vscode.ThemeIcon('mail');
        item.contextValue = 'ediLens.queryMatch';
        item.command = { command: 'ediLens.revealQueryResult', title: 'Reveal', arguments: [node.file.uri, m.line, m.column, 3] };
      } else {
        const hit = node.hit;
        item = new vscode.TreeItem(hit.path + ' = ' + shorten(hit.value, 60), states.None);
        item.description = 'line ' + (hit.line + 1);
        item.tooltip = hit.path + ' (line ' + (hit.line + 1) + ', column ' + (hit.column + 1) + ')';
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        item.contextValue = 'ediLens.queryHit';
        item.command = { command: 'ediLens.revealQueryResult', title: 'Reveal', arguments: [node.file.uri, hit.line, hit.column, hit.length] };
      }
      return item;
    }
  };
  const view = vscode.window.createTreeView('ediLens.queryResults', { treeDataProvider: provider, showCollapseAll: true });
  disposables.push(view);

  function refreshResults() {
    const q = session.query;
    view.message = q ? 'Query: ' + shorten(q.text, 120) + ': ' + plural(q.total, 'message') + ' in ' + plural(q.filesWithMatches, 'file') + (q.truncated ? ' (cut at the limit)' : '') + (q.cancelled ? ' (cancelled)' : '') : undefined;
    treeChanged.fire(undefined);
  }

  function savedQueries() { return savedQueryList(app.context.workspaceState.get(SAVED_QUERIES_KEY)); }

  // Asks for the query: a saved one or a new one (which may be saved under a name).
  async function askQuery(mod) {
    const s = settings().query;
    const saved = savedQueries();
    let text = null;
    if (saved.length) {
      const items = saved.map(function (q) { return { label: q.name, description: shorten(q.text, 80), text: q.text }; });
      items.push({ label: '$(add) New query...', description: '', fresh: true });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Run a saved query or write a new one', matchOnDescription: true });
      if (!pick) return null;
      if (!pick.fresh) text = pick.text;
    }
    if (text === null) {
      const typed = await inputBox({
        title: 'EDI Lens query: a condition checked for every message. Brackets hold a qualifier (NAD[BY]); #2 counts.',
        placeHolder: 'NAD[BY]-2.1 == "5412*" AND count(LIN) > 2',
        validateInput: function (value) {
          if (!value || value.trim() === '') return null;
          const c = mod.compile(value, { ignoreCase: s.ignoreCase });
          return c.ok ? null : c.message;
        }
      });
      if (typed === undefined || typed.trim() === '') return null;
      text = typed.trim();
      if (!saved.some(function (q) { return q.text === text; })) {
        const name = await inputBox({
          title: 'EDI Lens query: name to save this query under in this workspace',
          placeHolder: 'Leave empty to run the query without saving it'
        });
        if (name === undefined) return null;
        if (name.trim() !== '') {
          const list = saved.filter(function (q) { return q.name !== name.trim(); });
          list.unshift({ name: name.trim().slice(0, 80), text: text });
          await app.context.workspaceState.update(SAVED_QUERIES_KEY, list.slice(0, MAX_SAVED_QUERIES));
        }
      }
    }
    const compiled = mod.compile(text, { ignoreCase: s.ignoreCase });
    if (!compiled.ok) { warn(compiled.message + ' (' + compiled.code + ')'); return null; }
    return compiled;
  }

  reg('ediLens.query', async function (arg) {
    if (!(await h.requirePro('Query'))) return;
    const mod = pro().query;
    if (!mod) { h.incomplete('query module'); return; }
    const active = vscode.window.activeTextEditor;
    const haveEditor = !!(active && isSupportedLanguage(active.document.languageId));
    const folders = vscode.workspace.workspaceFolders || [];
    let scope = null;
    const startFolder = await folderArgument(arg);
    if (startFolder) scope = { folder: startFolder };
    else {
      const items = [];
      if (haveEditor) items.push({ label: 'The file in the active editor', description: labelOf(active.document.uri), editor: active });
      folders.forEach(function (f) { items.push({ label: 'Folder: ' + f.name, description: folderText(f.uri), folder: f.uri }); });
      if (items.length === 0) {
        warn('Query needs a UN/EDIFACT, ANSI X12 or HL7 v2 file in the active editor, or an open folder to search. Open one of them and run the command again.');
        return;
      }
      scope = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: 'Where to search' });
      if (!scope) return;
    }
    if (scope.editor && h.tooLargeForPro(scope.editor, 'searched')) return;
    const compiled = await askQuery(mod);
    if (!compiled) return;
    const s = settings().query;
    const out = { text: compiled.text, files: [], total: 0, filesWithMatches: 0, truncated: false, cancelled: false, skipped: 0, scanned: 0 };
    function add(label, uri, result) {
      out.scanned++;
      out.files.push({ label: label, uri: uri, result: result });
      out.total += result.matches.length;
      if (result.matches.length) out.filesWithMatches++;
      if (result.truncated) out.truncated = true;
    }
    if (scope.editor) {
      const result = mod.scanText(documentText(scope.editor), compiled, { maxResults: s.maxResults });
      if (!result.ok) { warn(result.message + ' (' + result.code + ')'); return; }
      add(labelOf(scope.editor.document.uri), scope.editor.document.uri, result);
    } else {
      const listed = await listFolder(scope.folder);
      if (listed.files.length === 0) { info('No EDI files (by extension) were found in that folder. The files are matched by the setting ediLens.workspace.include.'); return; }
      out.cancelled = await overFiles('EDI Lens: searching files', listed.files, async function (uri, index, token) {
        if (out.total >= s.maxResults) { out.truncated = true; return; }
        const read = await readMessageFile(uri);
        if (read.skipped) { out.skipped++; return; }
        const result = mod.scanText(read.text, compiled, { maxResults: s.maxResults - out.total, isCancelled: function () { return token.isCancellationRequested; } });
        if (!result.ok) { out.skipped++; return; }
        add(labelOf(uri), uri, result);
      });
      if (listed.more) out.truncated = true;
    }
    session.query = out;
    refreshResults();
    if (out.total === 0) {
      info('No message matches the query in ' + plural(out.scanned, 'file') + (out.skipped ? ' (' + plural(out.skipped, 'file') + ' left out)' : '') + (out.cancelled ? ' (cancelled, partial result)' : '') + '.');
      return;
    }
    vscode.commands.executeCommand('ediLens.queryResults.focus').then(undefined, function () { /* the view is not available in this editor */ });
    const csv = 'Export As CSV';
    const pick = await info(plural(out.total, 'message') + ' in ' + plural(out.filesWithMatches, 'file') + ' match the query' + (out.truncated ? ' (cut at the limit of ediLens.query.maxResults or at ' + MAX_FOLDER_FILES + ' files)' : '') +
      (out.cancelled ? ' (cancelled, partial result)' : '') + '. They are listed in the Query Results view of EDI Lens; select an entry to jump to it.', csv);
    if (pick === csv) await vscode.commands.executeCommand('ediLens.queryExportCsv');
  });

  reg('ediLens.queryExportCsv', async function () {
    if (!(await h.requirePro('Export Query Results'))) return;
    const mod = pro().query;
    if (!mod) { h.incomplete('query module'); return; }
    if (!session.query || session.query.total === 0) { info('There are no query results to export. Run "EDI Lens: Query" first.'); return; }
    const neutralise = settings().exportNeutraliseFormulas;
    await openText(mod.toCsv(session.query.files, neutralise), 'plaintext', false);
    const save = 'Save As...';
    info('The results of the query were written as CSV into a new editor.' + (neutralise ? ' Values that start with =, +, -, @, a tab or a carriage return got a leading apostrophe (setting ediLens.export.neutraliseFormulas).' : ''), save).then(function (pick) {
      if (pick === save) vscode.commands.executeCommand('workbench.action.files.saveAs');
    });
  });

  reg('ediLens.clearQueryResults', function () {
    session.query = null;
    refreshResults();
  });

  reg('ediLens.deleteSavedQuery', async function () {
    const saved = savedQueries();
    if (saved.length === 0) { info('No queries are saved in this workspace.'); return; }
    const pick = await vscode.window.showQuickPick(saved.map(function (q) { return { label: q.name, description: shorten(q.text, 80) }; }), { placeHolder: 'Saved query to delete' });
    if (!pick) return;
    await app.context.workspaceState.update(SAVED_QUERIES_KEY, saved.filter(function (q) { return q.name !== pick.label; }));
    info('The saved query "' + pick.label + '" was deleted.');
  });

  reg('ediLens.revealQueryResult', async function (uri, line, column, length) {
    if (!uri || typeof line !== 'number') return;
    const key = uri.toString();
    let doc = vscode.workspace.textDocuments.find(function (d) { return d.uri.toString() === key; });
    if (!doc) doc = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(line, column || 0, line, (column || 0) + (length || 0));
    await vscode.window.showTextDocument(doc, { selection: range, preview: true });
  });

  // ---- envelope tools -------------------------------------------------------------------------

  async function askStart(title) {
    const answer = await inputBox({ title: title + ': first control number (1 to 999999999)', value: String(settings().envelope.startNumber), validateInput: startNumberError });
    if (answer === undefined) return null;
    if (startNumberError(answer)) { warn(startNumberError(answer) + ' Nothing was changed.'); return null; }
    return Number(String(answer).trim());
  }

  reg('ediLens.splitInterchange', async function () {
    if (!(await h.requirePro('Split Interchange Into Messages'))) return;
    const editor = editorFor('split');
    if (!editor) return;
    const mod = pro().envelope;
    if (!mod) { h.incomplete('envelope module'); return; }
    const result = mod.split(documentText(editor), { start: settings().envelope.startNumber });
    if (!result.ok) { warn(result.message + ' (' + result.code + ')'); return; }
    const docUri = editor.document.uri;
    const isFile = docUri.scheme !== 'untitled';
    const chosen = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      openLabel: 'Write ' + plural(result.parts.length, 'File') + ' Here',
      defaultUri: isFile ? docUri.with({ path: docUri.path.replace(/\/[^/]*$/, '') || '/' }) : undefined
    });
    if (!chosen || chosen.length === 0) return;
    const names = splitName(isFile ? baseName(docUri) : '');
    const ext = names[1] || EXTENSION_OF[result.format] || '.txt';
    const width = Math.max(3, String(result.parts.length).length);
    const targets = result.parts.map(function (p) { return childUri(chosen[0], names[0] + '-' + String(p.number).padStart(width, '0') + ext); });
    let existing = 0;
    for (const t of targets) {
      try { await vscode.workspace.fs.stat(t); existing++; } catch (e) { /* free */ }
    }
    if (existing > 0) {
      const replace = 'Replace';
      const answer = await vscode.window.showWarningMessage(plural(existing, 'file') + ' with the same name already exist in ' + folderText(chosen[0]) + '. Replace them? Nothing is written unless you choose Replace.', { modal: true }, replace);
      if (answer !== replace) return;
    }
    for (let i = 0; i < targets.length; i++) await vscode.workspace.fs.writeFile(targets[i], Buffer.from(result.parts[i].text, 'utf8'));
    info('Wrote ' + plural(targets.length, 'file') + ' to ' + folderText(chosen[0]) + ' (' + baseName(targets[0]) + (targets.length > 1 ? ' to ' + baseName(targets[targets.length - 1]) : '') +
      '). Each one holds one message in its own envelope with a fresh control number. The open file was not changed.');
  });

  reg('ediLens.mergeMessages', async function (arg) {
    if (!(await h.requirePro('Merge Messages Into One Interchange'))) return;
    const mod = pro().envelope;
    if (!mod) { h.incomplete('envelope module'); return; }
    let uris;
    const mergeFolder = await folderArgument(arg);
    if (mergeFolder) {
      uris = (await listFolder(mergeFolder)).files;
      if (uris.length === 0) { info('No EDI files (by extension) were found in that folder. The files are matched by the setting ediLens.workspace.include.'); return; }
    } else {
      uris = await vscode.window.showOpenDialog({
        canSelectMany: true, openLabel: 'Merge',
        filters: { 'EDI messages': ['edi', 'edifact', 'edf', 'x12', 'x12edi', 'hl7', 'txt'], 'All files': ['*'] }
      });
      if (!uris || uris.length === 0) return;
      uris = uris.slice().sort(function (a, b) { return a.toString() < b.toString() ? -1 : 1; });
    }
    const texts = [];
    for (const uri of uris) {
      const read = await readMessageFile(uri);
      if (read.skipped) { warn('Nothing was merged: ' + labelOf(uri) + ' could not be used. ' + read.skipped); return; }
      texts.push(read.text);
    }
    const result = mod.merge(texts, { start: settings().envelope.startNumber });
    if (!result.ok) {
      // The message names the file by its position; put its name in front.
      const m = /^File (\d+)(: )?/.exec(result.message);
      const named = m && uris[Number(m[1]) - 1] ? labelOf(uris[Number(m[1]) - 1]) + ': ' + (m[2] ? result.message.slice(m[0].length) : result.message) : result.message;
      warn(named + ' (' + result.code + ')');
      return;
    }
    await openText(result.text, languageIdForFormat(result.format), false);
    info('Merged ' + plural(result.messages, 'message') + ' from ' + plural(uris.length, 'file') + ' into one ' + (result.format === 'hl7' ? 'batch' : 'interchange') + ' in a new editor. ' +
      (result.format === 'hl7' ? 'The batch header is built from the first message; the messages keep their own control ids.' : 'The envelope comes from the first file; message references were renumbered.') +
      ' The source files were not changed.');
  });

  reg('ediLens.renumberControlNumbers', async function () {
    if (!(await h.requirePro('Renumber Control Numbers'))) return;
    const editor = editorFor('renumbered');
    if (!editor) return;
    const mod = pro().envelope;
    if (!mod) { h.incomplete('envelope module'); return; }
    const start = await askStart('EDI Lens: Renumber Control Numbers');
    if (start === null) return;
    const keep = { label: 'Keep references', description: 'Numbers quoted by acknowledgement segments (AK1, AK2, TA1, UCI, UCF, UCM, MSA) stay as they are', keep: true };
    const follow = { label: 'Update references', description: 'References to a renumbered message in this file follow the new numbers', keep: false };
    const choice = await vscode.window.showQuickPick([keep, follow], { placeHolder: 'References to other messages' });
    if (!choice) return;
    const current = documentText(editor);
    const result = mod.renumber(current, { start: start, keepReferences: choice.keep });
    if (!result.ok) { warn(result.message + ' (' + result.code + ')'); return; }
    if (result.text === current) { info('The control numbers already start at ' + start + '; nothing was changed.'); return; }
    const whole = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(current.length));
    const versionBefore = editor.document.version;
    const applied = await editor.edit(function (builder) { builder.replace(whole, result.text); });
    if (!applied || editor.document.version === versionBefore) {
      warn('The file could not be changed, so nothing was modified. It is probably read-only: check the file permissions or the editor\'s read-only mode, then run the command again.');
      return;
    }
    info(plural(result.changed, 'control number') + ' changed, starting at ' + start + '. Headers and trailers agree; counts were not touched. Use Undo to go back.');
  });

  reg('ediLens.generateAcknowledgement', async function () {
    if (!(await h.requirePro('Generate Acknowledgement'))) return;
    const editor = editorFor('acknowledged');
    if (!editor) return;
    const mod = pro().envelope;
    if (!mod) { h.incomplete('envelope module'); return; }
    const e = settings().envelope;
    const result = mod.acknowledge(documentText(editor), { start: e.startNumber, x12Type: e.x12Acknowledgement });
    if (!result.ok) { warn(result.message + ' (' + result.code + ')'); return; }
    await openText(result.text, languageIdForFormat(result.format), true);
    const mark = result.format === 'x12' ? 'ISA15 is T' : result.format === 'edifact' ? 'the UNB test indicator is 1' : 'MSH-11 is T';
    info('TEST acknowledgement (' + result.kind + ') opened in a new editor: ' + plural(result.acknowledged, 'message') + ' acknowledged, ' + result.accepted + ' accepted, ' + result.rejected +
      ' rejected' + (result.envelopeFaults ? ', ' + plural(result.envelopeFaults, 'group or interchange') + ' with a wrong or missing trailer not accepted' : '') + '. It is marked as a test (' + mark + ') and only reflects the envelope checks of EDI Lens, not a business decision. Do not send it as a production acknowledgement.');
  });

  return disposables;
}

module.exports = { registerProTools: registerProTools, startNumberError: startNumberError, savedQueryList: savedQueryList, splitName: splitName };
