'use strict';
// All commands of the extension: free editing helpers, the first-run and support commands, the
// licence and trial commands and the Pro commands. The segment helpers at the top are pure and
// unit-tested; registerCommands() wires everything to the editor API provided by `app.vscode`.

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
const config = require('./licence/config');
const messages = require('./licence/messages');
const { sampleFor } = require('./samples');
const { diagnosticsBlock, reportProblemText } = require('./support');

const MAX_PICK_ITEMS = 20000;
const MAX_BATCH_FILES = 2000;
const MAX_BATCH_FILE_BYTES = 5 * 1024 * 1024;
const OPEN_SCHEMES = ['file', 'untitled', 'vscode-remote', 'vscode-vfs'];
const WALKTHROUGH_ID = 'SmallStepsStudio.edi-lens-viewer#ediLens.gettingStarted';

// Button labels, shared so that tests and documentation can refer to them.
const BUTTONS = Object.freeze({ buy: 'Buy Pro', enter: 'Enter Licence Key', lost: 'Lost your key?', remove: 'Remove Licence', problems: 'Show Problems', report: 'Report A Problem' });

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

const licenceStatusText = messages.licenceStatusText;
const activationFailureText = messages.activationFailureText;

// ---------------------------------------------------------------------------------------------
// Registration.

/**
 * Registers every command. `app` provides vscode, context, licence, state, diagnostics, tree,
 * getSettings(), getMessage(document, force), getCore(), getPro() (with the modules of the Pro tools), restoreDictionary(),
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
        const why = err && err.message ? err.message : 'the command could not be completed.';
        vscode.window.showErrorMessage('EDI Lens: ' + why + ' If this keeps happening, run "EDI Lens: Report A Problem".');
        return undefined;
      }
    }));
  }

  // Shows an information message; extra arguments are button labels.
  function info() {
    return vscode.window.showInformationMessage.apply(vscode.window, Array.prototype.slice.call(arguments));
  }
  function warn(text) { return vscode.window.showWarningMessage(text); }

  async function openExternal(url) {
    try {
      return await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (e) {
      // Some editors refuse to open links; the address is still shown so it can be copied.
      warn('The link could not be opened by the editor. Open it in your browser: ' + url);
      return false;
    }
  }

  // Runs a handler on the chosen button of a licence message.
  async function handleLicenceButton(pick) {
    if (pick === BUTTONS.buy) await vscode.commands.executeCommand('ediLens.buyPro');
    else if (pick === BUTTONS.enter) await vscode.commands.executeCommand('ediLens.enterKey');
    else if (pick === BUTTONS.remove) await vscode.commands.executeCommand('ediLens.removeLicence');
    else if (pick === BUTTONS.lost) await showLostKey();
  }

  async function showLostKey() {
    const pick = await info(messages.lostKeyText(), BUTTONS.enter, BUTTONS.report);
    if (pick === BUTTONS.enter) await vscode.commands.executeCommand('ediLens.enterKey');
    else if (pick === BUTTONS.report) await vscode.commands.executeCommand('ediLens.reportProblem');
  }

  // The active editor when it shows one of our languages; otherwise tells the user and returns null.
  function ediEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedLanguage(editor.document.languageId)) {
      warn('This command needs a UN/EDIFACT, ANSI X12 or HL7 v2 file in the active editor. Open one (or run "EDI Lens: Open Sample EDIFACT" to try one); for a file in another language run "EDI Lens: Detect Format" first.');
      return null;
    }
    return editor;
  }

  function incomplete(part) {
    warn('This installation is incomplete: the ' + part + ' could not be loaded. Reinstall EDI Lens from the Extensions view; if that does not help, run "EDI Lens: Report A Problem".');
  }

  // The parsed message of an editor, ignoring the size limit because the command was asked for.
  function messageOf(editor) {
    const message = app.getMessage(editor.document, true);
    if (!message) {
      incomplete('parser');
      return null;
    }
    return message;
  }

  // Compare and the exports read every value of the message, which for a file far above the size
  // limit would exhaust the memory of the editor; unlike the on-demand check they keep to the limit.
  function tooLargeForPro(editor, verb) {
    if (!app.isTooLarge(editor.document)) return false;
    warn('This file is larger than the ' + app.getSettings().maxFileSizeMB + ' MB limit, so it is not ' + verb + '. Raise the setting ediLens.maxFileSizeMB if your computer has enough memory, or split the file.');
    return true;
  }

  function revealOffsets(editor, start, end, select) {
    const doc = editor.document;
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    if (select) editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  function segmentEnd(segment) { return segment.offset + segment.raw.length; }

  // ---- Pro gate: licence first, then the free trial ---------------------------------------
  async function requirePro(feature) {
    if (await app.licence.isPro()) return true;
    let trial = app.licence.trialStatus();
    if (trial.state === 'unused') {
      trial = await app.licence.startTrial();
      if (trial.state === 'active') {
        await app.licence.noteTrialReminder();
        await app.afterLicenceChange();
        info(messages.trialStartedText(trial), BUTTONS.buy, BUTTONS.enter).then(handleLicenceButton).then(undefined, function () { /* the message was closed with the window */ });
        return true;
      }
    }
    if (trial.state === 'active') {
      await app.licence.touchTrial();
      if (await app.licence.noteTrialReminder()) {
        info(messages.trialReminderText(trial), BUTTONS.buy, BUTTONS.enter).then(handleLicenceButton).then(undefined, function () { /* the message was closed with the window */ });
      }
      return true;
    }
    const pick = await info(messages.proNoticeText(feature, trial), BUTTONS.buy, BUTTONS.enter);
    await handleLicenceButton(pick);
    return false;
  }

  // ---- Free commands --------------------------------------------------------------------
  reg('ediLens.detectFormat', async function () {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { warn('Open a file first, then run "EDI Lens: Detect Format" again.'); return; }
    const core = app.getCore();
    if (!core.detectFormat) { incomplete('format detector'); return; }
    const detected = core.detectFormat(editor.document.getText());
    if (!detected) {
      warn('No UN/EDIFACT, ANSI X12 or HL7 v2 content was recognised at the start of this file. The first segment must be UNA, UNB or UNH (EDIFACT), a 106-character ISA (X12), or MSH, FHS or BHS (HL7 v2). Leading blank lines are fine.');
      return;
    }
    const target = languageIdForFormat(detected.format);
    if (editor.document.languageId === target) {
      info('This file is already set to ' + formatLabel(detected.format) + '.');
      return;
    }
    await vscode.languages.setTextDocumentLanguage(editor.document, target);
    info('Language set to ' + formatLabel(detected.format) + (detected.reason ? ' (' + detected.reason.charAt(0).toLowerCase() + detected.reason.slice(1) + ')' : '') + '.');
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
    if (!applied || editor.document.version === versionBefore) warn('The file could not be changed, so nothing was modified. It is probably read-only: check the file permissions or the editor\'s read-only mode, then run the command again.');
  }
  reg('ediLens.prettyPrint', function () { return runFormat('pretty'); });
  reg('ediLens.minify', function () { return runFormat('minify'); });

  reg('ediLens.goToSegment', async function () {
    const editor = ediEditor();
    if (!editor) return;
    const message = messageOf(editor);
    if (!message) return;
    if (message.segments.length === 0) { warn('No segments were found in this file, so there is nothing to list. Check that the file starts with a valid header segment (UNB, ISA or MSH).'); return; }
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
    if (!loc) { warn('The cursor is not inside a segment, so there is no path to copy. Place it on a segment and run the command again.'); return; }
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
    if (at < 0) { warn('The cursor is not inside a segment. Place it on an envelope segment (UNH, ST, BHS and their trailers) and run the command again.'); return; }
    const seg = message.segments[at];
    const partner = findMatchingSegment(message.segments, at);
    if (partner === null) {
      info(seg.id + ' is not an envelope segment. Pairs: UNB/UNZ, UNG/UNE, UNH/UNT, ISA/IEA, GS/GE, ST/SE, FHS/FTS, BHS/BTS.');
      return;
    }
    if (partner === -1) {
      warn('No matching ' + (CLOSER_OF[seg.id] ? 'trailer' : 'header') + ' was found for ' + seg.id + '[' + seg.occurrence + ']. The envelope is incomplete; see the Problems view for the exact position.');
      return;
    }
    const target = message.segments[partner];
    revealOffsets(editor, target.offset, segmentEnd(target), true);
  });

  reg('ediLens.validateFile', async function () {
    const editor = ediEditor();
    if (!editor) return;
    const summary = app.diagnostics ? app.diagnostics.validateNow(editor.document) : null;
    if (!summary || summary.skipped) {
      warn('This file could not be checked' + (summary && summary.skipped === 'unavailable' ? ' because the parser could not be loaded; reinstall EDI Lens' : '; make sure it is open from a file, an untitled editor or a remote workspace') + '. If the problem persists, run "EDI Lens: Report A Problem".');
      return;
    }
    const c = summary.counts;
    const total = c.error + c.warning + c.info;
    if (total === 0) { info('No problems found in ' + summary.segments + ' segments.'); return; }
    const pick = await info(c.error + ' errors, ' + c.warning + ' warnings and ' + c.info + ' notes found.', BUTTONS.problems);
    if (pick === BUTTONS.problems) await vscode.commands.executeCommand('workbench.actions.view.problems');
  });

  reg('ediLens.unloadDictionary', async function () {
    await app.setDictionary(null, '');
    if (app.tree) app.tree.refresh();
    info('The dictionary was unloaded. Hovers and the outline show paths and values only.');
  });

  reg('ediLens.clearWorkspaceResults', function () {
    app.workspaceCollection.clear();
    info('The workspace validation results were cleared from the Problems view.');
  });

  // ---- First-run and support commands ---------------------------------------------------
  async function openSample(format) {
    const sample = sampleFor(format);
    if (!sample) { incomplete('sample library'); return; }
    const doc = await vscode.workspace.openTextDocument({ content: sample.text, language: sample.languageId });
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.setStatusBarMessage('EDI Lens: opened the ' + sample.title + ' sample (invented data)', 5000);
  }
  reg('ediLens.openSampleEdifact', function () { return openSample('edifact'); });
  reg('ediLens.openSampleX12', function () { return openSample('x12'); });
  reg('ediLens.openSampleHl7', function () { return openSample('hl7'); });

  reg('ediLens.openWalkthrough', async function () {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
  });

  reg('ediLens.showDocumentation', async function () {
    await openExternal(config.docsUrl);
  });

  reg('ediLens.reportProblem', async function () {
    const editor = vscode.window.activeTextEditor;
    let active = null;
    if (editor) {
      const summary = app.diagnostics ? app.diagnostics.getSummary(editor.document) : null;
      active = {
        languageId: editor.document.languageId,
        format: summary && summary.format ? summary.format : formatForLanguageId(editor.document.languageId),
        size: editor.document.getText().length,
        segments: summary ? summary.segments : undefined,
        counts: summary ? summary.counts : undefined,
        skipped: summary ? summary.skipped : (isSupportedLanguage(editor.document.languageId) ? null : 'unsupported')
      };
    }
    const extension = app.context && app.context.extension;
    const block = diagnosticsBlock({
      extensionVersion: extension && extension.packageJSON ? extension.packageJSON.version : app.extensionVersion,
      editorName: vscode.env && vscode.env.appName,
      editorVersion: vscode.version,
      platform: process.platform,
      osRelease: app.osRelease ? app.osRelease() : '',
      arch: process.arch,
      nodeVersion: process.versions && process.versions.node,
      settings: app.getSettings(),
      // Read from what is stored: preparing a report never contacts the licence server.
      licence: await app.licence.peek(),
      active: active
    });
    await vscode.env.clipboard.writeText(block);
    const opened = await openExternal(config.issuesUrl);
    info(reportProblemText(opened !== false));
  });

  // ---- Licence commands -----------------------------------------------------------------
  reg('ediLens.buyPro', async function () {
    const choice = await vscode.window.showQuickPick(messages.buyChoices(), { placeHolder: 'Which licence? Both unlock the same Pro features.', matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    let users = 1;
    if (choice.tier === 'business') {
      const answer = await vscode.window.showInputBox({
        title: 'EDI Lens Pro Business: ' + messages.businessUsersQuestion(),
        value: '1',
        ignoreFocusOut: true,
        validateInput: messages.businessUsersError
      });
      if (answer === undefined) return;
      if (messages.businessUsersError(answer)) { warn(messages.businessUsersError(answer) + ' The checkout page was not opened.'); return; }
      users = Number(String(answer).trim());
    }
    const url = app.licence.buyUrl(choice.tier, users);
    if (!url) { info(choice.label + ' is not on sale yet. Please check the extension page again soon.'); return; }
    await openExternal(url);
  });

  reg('ediLens.enterKey', async function () {
    const raw = await vscode.window.showInputBox({
      title: 'EDI Lens Pro: paste the licence key from your purchase e-mail',
      placeHolder: 'Licence key',
      ignoreFocusOut: true,
      validateInput: function (v) { return /\s/.test((v || '').trim()) ? 'A licence key contains no spaces.' : null; }
    });
    const key = (raw || '').trim();
    if (!key) return;
    const result = await app.licence.activate(key);
    if (result.ok) {
      await app.afterLicenceChange();
      info(messages.activatedText(result.licenceType, result));
    } else {
      // At the limit, a licence stored here can be removed right from the message.
      const pick = result.reason === 'limit' && result.hasStored
        ? await vscode.window.showErrorMessage('EDI Lens: ' + activationFailureText(result), BUTTONS.remove, BUTTONS.lost)
        : await vscode.window.showErrorMessage('EDI Lens: ' + activationFailureText(result), BUTTONS.lost);
      if (pick === BUTTONS.lost) await showLostKey();
      else if (pick === BUTTONS.remove) await vscode.commands.executeCommand('ediLens.removeLicence');
    }
  });

  reg('ediLens.licenceStatus', async function () {
    const st = await app.licence.status(true);
    const text = licenceStatusText(st);
    let pick;
    if (st.pro) pick = await info(text, BUTTONS.remove);
    else if (st.hasKey) pick = await info(text, BUTTONS.enter, BUTTONS.remove, BUTTONS.lost);
    else pick = await info(text, BUTTONS.buy, BUTTONS.enter, BUTTONS.lost);
    await handleLicenceButton(pick);
  });

  reg('ediLens.removeLicence', async function () {
    // Only what is stored is looked at: no request is made before the user has confirmed.
    const st = await app.licence.peek();
    if (!st.hasKey) { info('No licence key is stored on this computer, so there is nothing to remove.'); return; }
    const pick = await vscode.window.showWarningMessage(messages.removeConfirmText(), { modal: true }, BUTTONS.remove);
    if (pick !== BUTTONS.remove) return;
    const result = await app.licence.remove();
    await app.afterLicenceChange();
    info(result.deactivated
      ? 'The licence was removed from this computer and the activation was freed. You can enter the key on another computer now.'
      : 'The licence was removed from this computer. The licence server could not be reached, so the activation may still count against the limit of ' + config.activationLimit + '; if a later activation is refused, contact ' + config.supportContact() + '.');
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
      if (!decoded) throw new Error('The other file is not valid UTF-8 text, so it cannot be compared. Convert it to UTF-8 (for example with the editor\'s "Save with Encoding") and try again.');
      text = decoded.text;
    }
    if (exceedsLimit(text.length, limit)) throw new Error('The other file is larger than the ' + limit + ' MB limit (setting ediLens.maxFileSizeMB), so it is not compared.');
    const message = core.parse ? core.parse(text) : null;
    if (!message || message.segments.length === 0) throw new Error('No segments were found in the other file, so there is nothing to compare. Check that it starts with a valid header segment.');
    return message;
  }

  reg('ediLens.compare', async function () {
    if (!(await requirePro('Compare With Another File'))) return;
    const editor = ediEditor();
    if (!editor) return;
    const pro = app.getPro();
    if (!pro.diff) { incomplete('comparison module'); return; }
    if (tooLargeForPro(editor, 'compared')) return;
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
      warn('The two files are in different formats (' + formatLabel(a.format) + ' and ' + formatLabel(b.format) + '). Compare needs two messages in the same format; choose another file.');
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
    if (!pro.exporter) { incomplete('export module'); return; }
    if (tooLargeForPro(editor, 'exported')) return;
    const message = messageOf(editor);
    if (!message) return;
    let text;
    let language;
    let note = '';
    if (kind === 'json') { text = pro.exporter.toJsonText(message, { pretty: true }); language = 'json'; }
    else if (kind === 'csv') {
      const neutralise = app.getSettings().exportNeutraliseFormulas;
      text = pro.exporter.toCsv(message, { neutraliseFormulas: neutralise }); language = 'plaintext';
      note = neutralise ? ' Values that start with =, +, -, @, a tab or a carriage return got a leading apostrophe so spreadsheets do not run them as formulas (setting ediLens.export.neutraliseFormulas).' : '';
    } else { text = pro.exporter.toXml(message); language = 'xml'; }
    const doc = await vscode.workspace.openTextDocument({ content: text, language: language });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const save = 'Save As...';
    info('Exported ' + message.segments.length + ' segments as ' + kind.toUpperCase() + '.' + note, save).then(function (pick) {
      if (pick === save) vscode.commands.executeCommand('workbench.action.files.saveAs');
    });
  }
  reg('ediLens.exportJson', function () { return exportAs('json'); });
  reg('ediLens.exportCsv', function () { return exportAs('csv'); });
  reg('ediLens.exportXml', function () { return exportAs('xml'); });

  reg('ediLens.validateWorkspace', async function () {
    if (!(await requirePro('Validate Workspace'))) return;
    const pro = app.getPro();
    if (!pro.workspace) { incomplete('workspace module'); return; }
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
      warn(err && err.message ? err.message : 'The workspace could not be scanned. Open a folder and try again.');
      return;
    }
    pro.workspace.applyDiagnostics(app.workspaceCollection, summary);
    const report = pro.workspace.toMarkdown(summary, { title: 'EDI Lens workspace report', reportDate: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' });
    const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    const t = summary.totals;
    info('Scanned ' + t.scanned + ' files: ' + t.errors + ' errors, ' + t.warnings + ' warnings' + (summary.cancelled ? ' (cancelled, partial result)' : '') + '. The report is open in the editor; the problems are also listed in the Problems view.');
  });

  reg('ediLens.loadDictionary', async function () {
    if (!(await requirePro('Dictionary names'))) return;
    const pro = app.getPro();
    if (!pro.dictionary) { incomplete('dictionary module'); return; }
    const chosen = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Load dictionary',
      filters: { 'JSON dictionary': ['json'] }
    });
    if (!chosen || chosen.length === 0) return;
    const decoded = decodeUtf8(await vscode.workspace.fs.readFile(chosen[0]));
    if (!decoded) { warn('The dictionary file is not valid UTF-8 text, so it was not loaded. Save it as UTF-8 and try again.'); return; }
    const loaded = pro.dictionary.loadDictionary(decoded.text);
    if (!loaded.ok) {
      vscode.window.showErrorMessage('EDI Lens: the dictionary could not be loaded. ' + loaded.errors.slice(0, 3).join(' ') + ' The expected layout is described in the README under "Load Dictionary".');
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
    if (!core.parse || !core.pretty || !core.minify) { incomplete('formatter'); return; }

    let folder = arg && arg.scheme ? arg : null;
    if (!folder) {
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.length === 0) { warn('Open a folder first (File > Open Folder), then run this command again or right-click a folder in the Explorer.'); return; }
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
    if (found.length === 0) { info('No EDI files (by extension) were found in that folder. The files are matched by the setting ediLens.workspace.include.'); return; }
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

  // The Pro tools added in 0.2.0 live in their own file (protools.js) and register their commands
  // through these helpers; a failure to load that file leaves the commands above untouched.
  app.proHelpers = { reg: reg, requirePro: requirePro, ediEditor: ediEditor, info: info, warn: warn, incomplete: incomplete, tooLargeForPro: tooLargeForPro, BUTTONS: BUTTONS };

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
  BUTTONS: BUTTONS,
  WALKTHROUGH_ID: WALKTHROUGH_ID,
  CLOSER_OF: CLOSER_OF,
  OPENER_OF: OPENER_OF
};
