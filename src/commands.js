'use strict';
// All commands of the extension: free editing helpers, the licence commands and the Pro
// commands. The segment helpers at the top are pure and unit-tested; registerCommands() wires
// everything to the editor API provided by `app.vscode`.

const {
  formatForLanguageId,
  isSupportedLanguage,
  languageIdForFormat,
  formatLabel,
  formatMessage,
  describeFormatFailure,
  shorten,
  exceedsLimit,
  decodeUtf8,
  eolOf
} = require('./format');

const MAX_PICK_ITEMS = 20000;
const MAX_BATCH_FILES = 2000;
const MAX_BATCH_FILE_BYTES = 5 * 1024 * 1024;
const OPEN_SCHEMES = ['file', 'untitled', 'vscode-remote', 'vscode-vfs'];

// ---------------------------------------------------------------------------------------------
// Pure helpers.

// Envelope segments that open and close a block, per format.
const CLOSER_OF = Object.freeze({
  UNB: 'UNZ', UNG: 'UNE', UNH: 'UNT',
  ISA: 'IEA', GS: 'GE', ST: 'SE',
  FHS: 'FTS', BHS: 'BTS'
});
const OPENER_OF = Object.freeze(Object.keys(CLOSER_OF).reduce(function (acc, k) {
  acc[CLOSER_OF[k]] = k;
  return acc;
}, {}));

/**
 * Returns the index of the segment that belongs to the envelope segment at `index` (UNH to UNT,
 * ST to SE, ISA to IEA, GS to GE, UNB to UNZ, UNG to UNE, FHS to FTS, BHS to BTS and back).
 * Returns null when the segment is not an envelope segment and -1 when its partner is missing.
 */
function findMatchingSegment(segments, index) {
  const id = segments[index].id;
  let depth = 0;
  if (CLOSER_OF[id]) {
    for (let i = index + 1; i < segments.length; i++) {
      if (segments[i].id === id) depth++;
      else if (segments[i].id === CLOSER_OF[id]) {
        if (depth === 0) return i;
        depth--;
      }
    }
    return -1;
  }
  if (OPENER_OF[id]) {
    for (let i = index - 1; i >= 0; i--) {
      if (segments[i].id === id) depth++;
      else if (segments[i].id === OPENER_OF[id]) {
        if (depth === 0) return i;
        depth--;
      }
    }
    return -1;
  }
  return null;
}

/**
 * Returns the index of the segment that contains `offset`, or the last segment that starts
 * before it (an offset between two segments belongs to the earlier one). -1 when the offset is
 * before the first segment or there are no segments.
 */
function segmentIndexAt(segments, offset) {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].offset <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Builds the quick pick items of "Go to Segment" (at most `max`), one per segment. */
function segmentPickItems(message, max) {
  const limit = max || MAX_PICK_ITEMS;
  const items = [];
  const segments = message.segments;
  for (let i = 0; i < segments.length && i < limit; i++) {
    const s = segments[i];
    items.push({
      label: s.id + '[' + s.occurrence + ']',
      description: 'line ' + (s.line + 1),
      detail: shorten(s.raw, 100),
      index: i
    });
  }
  return items;
}

/** Describes the state of the licence in one or two sentences, for the status command. */
function licenceStatusText(st) {
  const env = st.mode === 'test' ? ' (licence server: test environment)' : '';
  if (st.pro && st.via === 'grace') {
    return 'EDI Lens Pro is active in offline mode: the licence server could not be reached. It stays active until ' +
      new Date(st.graceEndsAt).toLocaleDateString() + '. Connect to the internet before then.' + env;
  }
  if (st.pro) {
    return 'EDI Lens Pro is active on this machine (key ' + st.keyHint + '). Last verified ' +
      new Date(st.lastGoodAt).toLocaleString() + '.' + env;
  }
  if (st.hasKey && st.via === 'rejected') {
    return 'The licence server reports that the key ' + st.keyHint + ' is no longer valid, so Pro features are off. ' +
      'Enter a different key or remove this one.' + env;
  }
  if (st.hasKey) {
    return 'Pro is off: the licence could not be verified for more than 14 days. Connect to the internet and run this command again.' + env;
  }
  return 'EDI Lens Free. No licence key is stored on this machine.' + env;
}

/** Returns the one-sentence message for a failed activation reason. */
function activationFailureText(result) {
  switch (result.reason) {
    case 'limit':
      return 'This key is already active on the maximum number of machines. Remove it from another machine first (EDI Lens: Remove Licence From This Machine) or contact support.';
    case 'invalid':
      return 'That key was not recognised or is no longer active. Check it for typing errors and try again.';
    case 'network':
      return 'The licence server could not be reached. Check your internet connection and try again; nothing was changed.';
    default:
      return 'The licence check failed' + (result.status ? ' (HTTP ' + result.status + ')' : '') + '. Please try again later.';
  }
}

// ---------------------------------------------------------------------------------------------
// Registration.

/**
 * Registers every command. `app` provides vscode, context, licence, state, diagnostics, tree,
 * getSettings(), getMessage(document, force), getCore(), getPro(), restoreDictionary(),
 * setDictionary(dictionary, path), dictionaryFor(message), workspaceCollection and
 * afterLicenceChange(). Returns the disposables.
 */
function registerCommands(app) {
  const vscode = app.vscode;
  const disposables = [];

  function reg(id, fn) {
    disposables.push(vscode.commands.registerCommand(id, async function () {
      try {
        return await fn.apply(null, arguments);
      } catch (err) {
        vscode.window.showErrorMessage('EDI Lens: ' + (err && err.message ? err.message : 'the command could not be completed.'));
        return undefined;
      }
    }));
  }

  // Shows an information message; extra arguments are button labels.
  function info() {
    return vscode.window.showInformationMessage.apply(vscode.window, Array.prototype.slice.call(arguments));
  }
  function warn(text) { return vscode.window.showWarningMessage(text); }

  // The active editor when it shows one of our languages; otherwise tells the user and returns null.
  function ediEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedLanguage(editor.document.languageId)) {
      warn('Open an EDIFACT, X12 or HL7 v2 file first. For other files, run "EDI Lens: Detect Format".');
      return null;
    }
    return editor;
  }

  // The parsed message of an editor, ignoring the size limit because the command was asked for.
  function messageOf(editor) {
    const message = app.getMessage(editor.document, true);
    if (!message) {
      warn('This installation is incomplete: the parser could not be loaded.');
      return null;
    }
    return message;
  }

  function revealOffsets(editor, start, end, select) {
    const doc = editor.document;
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    if (select) editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  function segmentEnd(segment) { return segment.offset + segment.raw.length; }

  // ---- Pro gate -------------------------------------------------------------------------
  async function requirePro(feature) {
    if (await app.licence.isPro()) return true;
    const buy = 'Buy Pro';
    const enter = 'Enter Licence Key';
    const pick = await info(feature + ' is an EDI Lens Pro feature. All free features keep working without a licence.', buy, enter);
    if (pick === buy) await vscode.commands.executeCommand('ediLens.buyPro');
    else if (pick === enter) await vscode.commands.executeCommand('ediLens.enterKey');
    return false;
  }

  // ---- Free commands --------------------------------------------------------------------
  reg('ediLens.detectFormat', async function () {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { warn('Open a file first.'); return; }
    const core = app.getCore();
    if (!core.detectFormat) { warn('This installation is incomplete: the format detector could not be loaded.'); return; }
    const detected = core.detectFormat(editor.document.getText());
    if (!detected) {
      warn('No UN/EDIFACT, ANSI X12 or HL7 v2 content was recognised at the start of this file.');
      return;
    }
    const target = languageIdForFormat(detected.format);
    if (editor.document.languageId === target) {
      info('This file is already set to ' + formatLabel(detected.format) + '.');
      return;
    }
    await vscode.languages.setTextDocumentLanguage(editor.document, target);
    info('Language set to ' + formatLabel(detected.format) + (detected.reason ? ' (' + detected.reason + ')' : '') + '.');
  });

  async function runFormat(mode) {
    const editor = ediEditor();
    if (!editor) return;
    const message = messageOf(editor);
    if (!message) return;
    const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const result = formatMessage(message, mode, app.getCore(), { eol: eol });
    if (!result.ok) { warn(describeFormatFailure(result.reason)); return; }
    const current = editor.document.getText();
    if (result.text === current) {
      vscode.window.setStatusBarMessage('EDI Lens: nothing to change', 3000);
      return;
    }
    const whole = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(current.length));
    // A read-only editor reports success without changing anything, so the document version is checked too.
    const versionBefore = editor.document.version;
    const applied = await editor.edit(function (builder) { builder.replace(whole, result.text); });
    if (!applied || editor.document.version === versionBefore) warn('The file could not be changed. It may be read-only; nothing was modified.');
  }
  reg('ediLens.prettyPrint', function () { return runFormat('pretty'); });
  reg('ediLens.minify', function () { return runFormat('minify'); });

  reg('ediLens.goToSegment', async function () {
    const editor = ediEditor();
    if (!editor) return;
    const message = messageOf(editor);
    if (!message) return;
    if (message.segments.length === 0) { warn('No segments were found in this file.'); return; }
    const savedSelection = editor.selection;
    const savedRanges = editor.visibleRanges.slice();
    const items = segmentPickItems(message);
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Segment id or occurrence, for example NAD or NAD[2]',
      matchOnDescription: true,
      matchOnDetail: true,
      onDidSelectItem: function (item) {
        if (item && item.index !== undefined) {
          const s = message.segments[item.index];
          revealOffsets(editor, s.offset, segmentEnd(s), false);
        }
      }
    });
    if (!pick) {
      editor.selection = savedSelection;
      if (savedRanges.length) editor.revealRange(savedRanges[0], vscode.TextEditorRevealType.AtTop);
      return;
    }
    const s = message.segments[pick.index];
    revealOffsets(editor, s.offset, segmentEnd(s), true);
  });

  reg('ediLens.copyPath', async function () {
    const editor = ediEditor();
    if (!editor) return;
    const message = messageOf(editor);
    if (!message) return;
    const core = app.getCore();
    const loc = core.locate ? core.locate(message, editor.document.offsetAt(editor.selection.active)) : null;
    if (!loc) { warn('The cursor is not inside a segment.'); return; }
    await vscode.env.clipboard.writeText(loc.path);
    vscode.window.setStatusBarMessage('EDI Lens: copied ' + loc.path, 4000);
  });

  reg('ediLens.copyTreePath', async function (node) {
    if (!node || !node.path) return;
    await vscode.env.clipboard.writeText(node.path);
    vscode.window.setStatusBarMessage('EDI Lens: copied ' + node.path, 4000);
  });

  reg('ediLens.refreshTree', function () { if (app.tree) app.tree.refresh(); });

  reg('ediLens.revealRange', async function (uri, start, end) {
    if (!uri || typeof start !== 'number') return;
    const key = uri.toString();
    const doc = vscode.workspace.textDocuments.find(function (d) { return d.uri.toString() === key; });
    if (!doc) return;
    const visible = vscode.window.visibleTextEditors.find(function (e) { return e.document === doc; });
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    await vscode.window.showTextDocument(doc, {
      viewColumn: visible ? visible.viewColumn : undefined,
      selection: range,
      preserveFocus: true
    });
  });

  reg('ediLens.jumpToTrailer', async function () {
    const editor = ediEditor();
    if (!editor) return;
    const message = messageOf(editor);
    if (!message) return;
    const at = segmentIndexAt(message.segments, editor.document.offsetAt(editor.selection.active));
    if (at < 0) { warn('The cursor is not inside a segment.'); return; }
    const seg = message.segments[at];
    const partner = findMatchingSegment(message.segments, at);
    if (partner === null) {
      info(seg.id + ' is not an envelope segment. Pairs: UNB/UNZ, UNG/UNE, UNH/UNT, ISA/IEA, GS/GE, ST/SE, FHS/FTS, BHS/BTS.');
      return;
    }
    if (partner === -1) {
      warn('No matching ' + (CLOSER_OF[seg.id] ? 'trailer' : 'header') + ' was found for ' + seg.id + '[' + seg.occurrence + '].');
      return;
    }
    const target = message.segments[partner];
    revealOffsets(editor, target.offset, segmentEnd(target), true);
  });

  reg('ediLens.validateFile', async function () {
    const editor = ediEditor();
    if (!editor) return;
    const summary = app.diagnostics.validateNow(editor.document);
    if (!summary || summary.skipped) { warn('This file could not be checked.'); return; }
    const c = summary.counts;
    const total = c.error + c.warning + c.info;
    if (total === 0) { info('No problems found in ' + summary.segments + ' segments.'); return; }
    const pick = await info(c.error + ' errors, ' + c.warning + ' warnings and ' + c.info + ' notes found.', 'Show Problems');
    if (pick === 'Show Problems') await vscode.commands.executeCommand('workbench.actions.view.problems');
  });

  reg('ediLens.unloadDictionary', async function () {
    await app.setDictionary(null, '');
    if (app.tree) app.tree.refresh();
    info('The dictionary was unloaded.');
  });

  reg('ediLens.clearWorkspaceResults', function () {
    app.workspaceCollection.clear();
    info('The workspace validation results were cleared from the Problems view.');
  });

  // ---- Licence commands -----------------------------------------------------------------
  reg('ediLens.buyPro', async function () {
    const url = app.licence.buyUrl();
    if (!url) { info('EDI Lens Pro is not on sale yet. Please check the extension page again soon.'); return; }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  reg('ediLens.enterKey', async function () {
    const raw = await vscode.window.showInputBox({
      title: 'EDI Lens Pro: paste the licence key from your purchase confirmation',
      placeHolder: 'Licence key',
      ignoreFocusOut: true,
      validateInput: function (v) { return /\s/.test((v || '').trim()) ? 'A licence key contains no spaces.' : null; }
    });
    const key = (raw || '').trim();
    if (!key) return;
    const result = await app.licence.activate(key);
    if (result.ok) {
      await app.afterLicenceChange();
      info('EDI Lens Pro is now active on this machine. Thank you.');
    } else {
      vscode.window.showErrorMessage('EDI Lens: ' + activationFailureText(result));
    }
  });

  reg('ediLens.licenceStatus', async function () {
    const st = await app.licence.status(true);
    const text = licenceStatusText(st);
    if (st.pro) { info(text); return; }
    const pick = st.hasKey
      ? await info(text, 'Enter Licence Key', 'Remove Licence')
      : await info(text, 'Buy Pro', 'Enter Licence Key');
    if (pick === 'Buy Pro') await vscode.commands.executeCommand('ediLens.buyPro');
    else if (pick === 'Enter Licence Key') await vscode.commands.executeCommand('ediLens.enterKey');
    else if (pick === 'Remove Licence') await vscode.commands.executeCommand('ediLens.removeLicence');
  });

  reg('ediLens.removeLicence', async function () {
    const st = await app.licence.status(false);
    if (!st.hasKey) { info('No licence key is stored on this machine.'); return; }
    const remove = 'Remove Licence';
    const pick = await vscode.window.showWarningMessage(
      'Remove the licence from this machine? This frees one activation so the key can be used elsewhere. Pro features turn off here.',
      { modal: true }, remove);
    if (pick !== remove) return;
    const result = await app.licence.remove();
    await app.afterLicenceChange();
    info(result.deactivated
      ? 'The licence was removed from this machine and the activation was freed.'
      : 'The licence was removed from this machine. The licence server could not be reached, so the activation may still count; contact support if you need it freed.');
  });

  // ---- Pro commands ---------------------------------------------------------------------
  async function readOtherMessage(uri, openDoc) {
    const core = app.getCore();
    const limit = app.getSettings().maxFileSizeMB;
    let text;
    if (openDoc) {
      text = openDoc.getText();
    } else {
      const decoded = decodeUtf8(await vscode.workspace.fs.readFile(uri));
      if (!decoded) throw new Error('The other file is not valid UTF-8 text.');
      text = decoded.text;
    }
    if (exceedsLimit(text.length, limit)) throw new Error('The other file is larger than the ' + limit + ' MB limit (setting ediLens.maxFileSizeMB).');
    const message = core.parse ? core.parse(text) : null;
    if (!message || message.segments.length === 0) throw new Error('No segments were found in the other file.');
    return message;
  }

  reg('ediLens.compare', async function () {
    if (!(await requirePro('Compare With Another File'))) return;
    const editor = ediEditor();
    if (!editor) return;
    const pro = app.getPro();
    if (!pro.diff) { warn('This installation is incomplete: the comparison module could not be loaded.'); return; }
    const a = messageOf(editor);
    if (!a) return;

    const here = editor.document.uri.toString();
    const items = vscode.workspace.textDocuments
      .filter(function (d) {
        return d.uri.toString() !== here && OPEN_SCHEMES.indexOf(d.uri.scheme) !== -1 && !d.isClosed &&
          (isSupportedLanguage(d.languageId) || (app.getCore().detectFormat && app.getCore().detectFormat(d.getText().slice(0, 4096))));
      })
      .map(function (d) { return { label: vscode.workspace.asRelativePath(d.uri, false), description: 'open file', doc: d }; });
    items.push({ label: '$(folder-opened) Choose a file...', description: '', browse: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Compare ' + vscode.workspace.asRelativePath(editor.document.uri, false) + ' with...' });
    if (!pick) return;

    let uri;
    let doc = null;
    if (pick.browse) {
      const chosen = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Compare',
        filters: { 'EDI messages': ['edi', 'edifact', 'edf', 'x12', 'x12edi', 'hl7', 'txt'], 'All files': ['*'] }
      });
      if (!chosen || chosen.length === 0) return;
      uri = chosen[0];
      doc = vscode.workspace.textDocuments.find(function (d) { return d.uri.toString() === uri.toString(); }) || null;
    } else {
      doc = pick.doc;
      uri = doc.uri;
    }
    const b = await readOtherMessage(uri, doc);
    if (a.format !== b.format) {
      warn('The two files are in different formats (' + formatLabel(a.format) + ' and ' + formatLabel(b.format) + '). Compare needs two messages in the same format.');
      return;
    }
    const s = app.getSettings().compare;
    const result = pro.diff.compare(a, b, {
      ignoreSegments: s.ignoreSegments,
      ignorePaths: s.ignorePaths,
      ignoreCase: s.ignoreCase,
      trimValues: s.trimValues
    });
    const labelA = vscode.workspace.asRelativePath(editor.document.uri, false);
    const labelB = vscode.workspace.asRelativePath(uri, false);
    const panel = vscode.window.createWebviewPanel('ediLensCompare', 'EDI Lens: ' + labelA + ' / ' + labelB, vscode.ViewColumn.Beside, { enableScripts: false });
    panel.webview.html = pro.diff.toHtml(result, { labelA: labelA, labelB: labelB, title: 'Comparison' });
  });

  async function exportAs(kind) {
    if (!(await requirePro('Export'))) return;
    const editor = ediEditor();
    if (!editor) return;
    const pro = app.getPro();
    if (!pro.exporter) { warn('This installation is incomplete: the export module could not be loaded.'); return; }
    const message = messageOf(editor);
    if (!message) return;
    let text;
    let language;
    if (kind === 'json') { text = pro.exporter.toJsonText(message, { pretty: true }); language = 'json'; }
    else if (kind === 'csv') { text = pro.exporter.toCsv(message, { neutraliseFormulas: app.getSettings().exportNeutraliseFormulas }); language = 'plaintext'; }
    else { text = pro.exporter.toXml(message); language = 'xml'; }
    const doc = await vscode.workspace.openTextDocument({ content: text, language: language });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const save = 'Save As...';
    info('Exported ' + message.segments.length + ' segments as ' + kind.toUpperCase() + '.', save).then(function (pick) {
      if (pick === save) vscode.commands.executeCommand('workbench.action.files.saveAs');
    });
  }
  reg('ediLens.exportJson', function () { return exportAs('json'); });
  reg('ediLens.exportCsv', function () { return exportAs('csv'); });
  reg('ediLens.exportXml', function () { return exportAs('xml'); });

  reg('ediLens.validateWorkspace', async function () {
    if (!(await requirePro('Validate Workspace'))) return;
    const pro = app.getPro();
    if (!pro.workspace) { warn('This installation is incomplete: the workspace module could not be loaded.'); return; }
    const s = app.getSettings();
    let summary;
    try {
      summary = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'EDI Lens: validating workspace',
        cancellable: true
      }, function (progress, token) {
        return pro.workspace.scanWorkspace({ glob: s.workspaceInclude, exclude: s.workspaceExclude, maxIssuesPerFile: s.maxIssues }, progress, token);
      });
    } catch (err) {
      warn(err && err.message ? err.message : 'The workspace could not be scanned.');
      return;
    }
    pro.workspace.applyDiagnostics(app.workspaceCollection, summary);
    const report = pro.workspace.toMarkdown(summary, { title: 'EDI Lens workspace report', reportDate: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' });
    const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    const t = summary.totals;
    info('Scanned ' + t.scanned + ' files: ' + t.errors + ' errors, ' + t.warnings + ' warnings' + (summary.cancelled ? ' (cancelled, partial result)' : '') + '.');
  });

  reg('ediLens.loadDictionary', async function () {
    if (!(await requirePro('Dictionary names'))) return;
    const pro = app.getPro();
    if (!pro.dictionary) { warn('This installation is incomplete: the dictionary module could not be loaded.'); return; }
    const chosen = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Load dictionary',
      filters: { 'JSON dictionary': ['json'] }
    });
    if (!chosen || chosen.length === 0) return;
    const decoded = decodeUtf8(await vscode.workspace.fs.readFile(chosen[0]));
    if (!decoded) { warn('The dictionary file is not valid UTF-8 text.'); return; }
    const loaded = pro.dictionary.loadDictionary(decoded.text);
    if (!loaded.ok) {
      vscode.window.showErrorMessage('EDI Lens: the dictionary could not be loaded. ' + loaded.errors.slice(0, 3).join(' '));
      return;
    }
    await app.setDictionary(loaded.dictionary, chosen[0].toString());
    if (app.tree) app.tree.refresh();
    const extra = loaded.warnings && loaded.warnings.length ? ' ' + loaded.warnings.length + ' entries were ignored.' : '';
    info('Dictionary "' + (loaded.dictionary.name || 'unnamed') + '" (' + formatLabel(loaded.dictionary.format) + ') loaded. It is used for hover and outline names in ' + formatLabel(loaded.dictionary.format) + ' files and is remembered for this workspace.' + extra);
  });

  reg('ediLens.batchPrettyPrint', async function (arg) {
    if (!(await requirePro('Batch Pretty Print Folder'))) return;
    const core = app.getCore();
    if (!core.parse || !core.pretty || !core.minify) { warn('This installation is incomplete: the formatter could not be loaded.'); return; }

    let folder = arg && arg.scheme ? arg : null;
    if (!folder) {
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.length === 0) { warn('Open a folder first, then run this command again.'); return; }
      if (folders.length === 1) {
        folder = folders[0].uri;
      } else {
        const chosen = await vscode.window.showQuickPick(folders.map(function (f) { return { label: f.name, description: f.uri.fsPath, uri: f.uri }; }), { placeHolder: 'Folder to format' });
        if (!chosen) return;
        folder = chosen.uri;
      }
    }
    const s = app.getSettings();
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, s.workspaceInclude), s.workspaceExclude, MAX_BATCH_FILES + 1);
    if (found.length === 0) { info('No EDI files (by extension) were found in that folder.'); return; }
    const files = found.slice(0, MAX_BATCH_FILES);
    const rewrite = 'Rewrite Files';
    const answer = await vscode.window.showWarningMessage(
      'Rewrite ' + files.length + ' file' + (files.length === 1 ? '' : 's') + (found.length > MAX_BATCH_FILES ? ' (the first ' + MAX_BATCH_FILES + ' of more)' : '') +
      ' in ' + (folder.scheme === 'file' ? folder.fsPath : folder.toString()) + '? Each file is parsed and saved with one segment per line; the data itself is not changed. ' +
      'Files that are not valid UTF-8, have no segments or are larger than 5 MB are skipped. Nothing is written unless you choose Rewrite Files.',
      { modal: true }, rewrite);
    if (answer !== rewrite) return;

    const counts = { rewritten: 0, unchanged: 0, skipped: 0 };
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'EDI Lens: formatting files',
      cancellable: true
    }, async function (progress, token) {
      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) break;
        progress.report({ message: vscode.workspace.asRelativePath(files[i], false), increment: 100 / files.length });
        const outcome = await formatOneFile(files[i]);
        counts[outcome]++;
      }
    });
    info('Formatting finished: ' + counts.rewritten + ' rewritten, ' + counts.unchanged + ' already formatted, ' + counts.skipped + ' skipped.');
  });

  // Formats one file on disk; returns 'rewritten', 'unchanged' or 'skipped'.
  async function formatOneFile(uri) {
    const core = app.getCore();
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size === 0 || st.size > MAX_BATCH_FILE_BYTES) return 'skipped';
      const decoded = decodeUtf8(await vscode.workspace.fs.readFile(uri));
      if (!decoded) return 'skipped';
      const message = core.parse(decoded.text);
      const result = formatMessage(message, 'pretty', core, { eol: eolOf(decoded.text) });
      if (!result.ok) return 'skipped';
      if (result.text === decoded.text) return 'unchanged';
      // Safety check: the data must be identical once both versions are minified.
      const again = core.parse(result.text);
      if (core.minify(again) !== core.minify(message)) return 'skipped';
      const out = (decoded.bom ? '﻿' : '') + result.text;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(out, 'utf8'));
      return 'rewritten';
    } catch (err) {
      return 'skipped';
    }
  }

  return disposables;
}

/**
 * Switches files of our languages to the language that matches their content when the file
 * extension was ambiguous (for example an X12 file named .edi). Each document is considered once
 * per session, so a language chosen by hand is never overridden. Controlled by the setting
 * ediLens.autoDetectLanguage. Returns the disposables.
 */
function registerAutoDetect(app) {
  const vscode = app.vscode;
  const handled = new Set();

  function consider(document) {
    if (!app.getSettings().autoDetectLanguage) return;
    if (!isSupportedLanguage(document.languageId)) return;
    if (OPEN_SCHEMES.indexOf(document.uri.scheme) === -1) return;
    const key = document.uri.toString();
    if (handled.has(key)) return;
    handled.add(key);
    const core = app.getCore();
    if (!core.detectFormat) return;
    const detected = core.detectFormat(document.getText().slice(0, 4096));
    if (!detected) return;
    const target = languageIdForFormat(detected.format);
    if (target && target !== document.languageId && formatForLanguageId(target)) {
      vscode.languages.setTextDocumentLanguage(document, target).then(undefined, function () { /* the document was closed meanwhile */ });
    }
  }

  const subscription = vscode.workspace.onDidOpenTextDocument(consider);
  vscode.workspace.textDocuments.forEach(consider);
  return [subscription];
}

module.exports = {
  registerCommands: registerCommands,
  registerAutoDetect: registerAutoDetect,
  findMatchingSegment: findMatchingSegment,
  segmentIndexAt: segmentIndexAt,
  segmentPickItems: segmentPickItems,
  licenceStatusText: licenceStatusText,
  activationFailureText: activationFailureText,
  CLOSER_OF: CLOSER_OF,
  OPENER_OF: OPENER_OF
};
