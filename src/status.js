'use strict';
// Status bar item: format, segment count and issue count of the active EDI file. A click opens
// the Problems view.

const { formatLabel, formatForLanguageId } = require('./format');

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/**
 * Builds the status bar text and tooltip. `languageId` is the active document's language,
 * `summary` the last validation summary (or null). Returns `{ text, tooltip }`.
 */
function statusContent(languageId, summary) {
  const fallbackFormat = formatForLanguageId(languageId);
  if (summary && summary.skipped === 'size') {
    return {
      text: '$(circle-slash) EDI Lens: file over limit',
      tooltip: 'This file is larger than ' + summary.limitMB + ' MB (setting ediLens.maxFileSizeMB). Run "EDI Lens: Validate Current File" to check it on demand.'
    };
  }
  if (!summary || summary.skipped) {
    return { text: '$(file-code) ' + formatLabel(fallbackFormat), tooltip: 'EDI Lens: ' + formatLabel(fallbackFormat) + ' file. Click to open the Problems view.' };
  }
  const c = summary.counts;
  const total = c.error + c.warning + c.info;
  const icon = c.error > 0 ? '$(error)' : c.warning > 0 ? '$(warning)' : '$(check)';
  const label = formatLabel(summary.format || fallbackFormat);
  return {
    text: icon + ' ' + label + ' · ' + plural(summary.segments, 'segment') + ' · ' + plural(total, 'issue'),
    tooltip: [
      'EDI Lens: ' + label,
      plural(summary.segments, 'segment'),
      plural(c.error, 'error') + ', ' + plural(c.warning, 'warning') + ', ' + plural(c.info, 'note'),
      'Click to open the Problems view.'
    ].join('\n')
  };
}

/**
 * Creates the status bar item. `app` provides vscode and diagnostics (set after creation of the
 * diagnostics controller, so it is read lazily). Returns `{ update, dispose }`.
 */
function createStatus(app) {
  const vscode = app.vscode;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'EDI Lens';
  item.command = 'workbench.actions.view.problems';

  function update() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || formatForLanguageId(editor.document.languageId) === null) {
      item.hide();
      return;
    }
    const summary = app.diagnostics ? app.diagnostics.getSummary(editor.document) : null;
    const content = statusContent(editor.document.languageId, summary);
    item.text = content.text;
    item.tooltip = content.tooltip;
    item.show();
  }

  const subscriptions = [
    item,
    vscode.window.onDidChangeActiveTextEditor(update)
  ];
  update();

  return {
    update: update,
    dispose: function () {
      subscriptions.forEach(function (d) { try { d.dispose(); } catch (e) { /* already disposed */ } });
    }
  };
}

module.exports = { statusContent: statusContent, createStatus: createStatus };
