'use strict';
// Structural validation as editor problems. Files are checked when opened, when saved and
// (debounced, setting ediLens.validateOnType) while typing. Files above the size limit are only
// checked on demand through "EDI Lens: Validate Current File".

const { isSupportedLanguage, exceedsLimit, mergeIssues, countIssues } = require('./format');

const TYPE_DELAY_MS = 400;
// While typing, files above this size wait for the next save instead of being re-checked.
const ON_TYPE_MAX_CHARS = 2 * 1024 * 1024;
const CHECKED_SCHEMES = ['file', 'untitled', 'vscode-remote', 'vscode-vfs'];

/**
 * Converts an issue range to start/end offsets inside a text of `textLength` characters. Empty
 * ranges are widened by one character (when possible) so the problem is visible.
 */
function issueSpan(issue, textLength) {
  const start = Math.max(0, Math.min(issue.offset, textLength));
  let end = Math.max(issue.end === undefined ? start : issue.end, start);
  if (end <= start) end = start + 1;
  return { start: start, end: Math.min(end, textLength) };
}

/**
 * Creates the diagnostics controller. `app` provides: vscode, getSettings(), getMessage(doc,
 * force) and getCore(). Returns `{ collection, validateNow, getSummary, onDidUpdate, runAll,
 * dispose }`.
 */
function createDiagnostics(app) {
  const vscode = app.vscode;
  const collection = vscode.languages.createDiagnosticCollection('ediLens');
  const summaries = new Map();
  const timers = new Map();
  const listeners = [];
  const severities = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information
  };

  function emit(document) {
    for (const cb of listeners) {
      try { cb(document); } catch (e) { /* a listener must not break validation */ }
    }
  }

  function toDiagnostic(document, issue, textLength) {
    const span = issueSpan(issue, textLength);
    const range = new vscode.Range(document.positionAt(span.start), document.positionAt(span.end));
    const d = new vscode.Diagnostic(range, issue.message, severities[issue.severity] !== undefined ? severities[issue.severity] : severities.info);
    d.code = issue.code;
    d.source = 'EDI Lens';
    return d;
  }

  // Runs parse + validation for one document and publishes the problems. `force` ignores the
  // size limit (used by the on-demand command).
  function run(document, force) {
    if (!isSupportedLanguage(document.languageId)) return null;
    if (CHECKED_SCHEMES.indexOf(document.uri.scheme) === -1) return null;
    const key = document.uri.toString();
    const settings = app.getSettings();
    const text = document.getText();
    let summary;
    if (!force && exceedsLimit(text.length, settings.maxFileSizeMB)) {
      collection.delete(document.uri);
      summary = { skipped: 'size', limitMB: settings.maxFileSizeMB, segments: 0, counts: { error: 0, warning: 0, info: 0 } };
    } else {
      const message = app.getMessage(document, true);
      if (!message) {
        collection.delete(document.uri);
        summary = { skipped: 'unavailable', segments: 0, counts: { error: 0, warning: 0, info: 0 } };
      } else {
        const core = app.getCore();
        let found = [];
        if (core.validate) {
          try { found = core.validate(message, { maxIssues: settings.maxIssues }) || []; } catch (e) { found = []; }
        }
        const issues = mergeIssues(message.issues, found, settings.maxIssues);
        collection.set(document.uri, issues.map(function (i) { return toDiagnostic(document, i, text.length); }));
        summary = { skipped: null, format: message.format, segments: message.segments.length, counts: countIssues(issues) };
      }
    }
    summaries.set(key, summary);
    emit(document);
    return summary;
  }

  function schedule(document) {
    const key = document.uri.toString();
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(function () {
      timers.delete(key);
      run(document, false);
    }, TYPE_DELAY_MS));
  }

  function runAll() {
    for (const document of vscode.workspace.textDocuments) run(document, false);
  }

  const subscriptions = [
    collection,
    vscode.workspace.onDidOpenTextDocument(function (d) { run(d, false); }),
    vscode.workspace.onDidSaveTextDocument(function (d) { run(d, false); }),
    vscode.workspace.onDidChangeTextDocument(function (event) {
      const d = event.document;
      if (!isSupportedLanguage(d.languageId)) return;
      if (!app.getSettings().validateOnType) return;
      if (event.contentChanges && event.contentChanges.length === 0) return;
      if (d.getText().length > ON_TYPE_MAX_CHARS) return;
      schedule(d);
    }),
    vscode.workspace.onDidCloseTextDocument(function (d) {
      const key = d.uri.toString();
      if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); }
      collection.delete(d.uri);
      summaries.delete(key);
    }),
    vscode.workspace.onDidChangeConfiguration(function (event) {
      if (event.affectsConfiguration('ediLens')) runAll();
    })
  ];

  runAll();

  return {
    collection: collection,
    /** Validates a document immediately, ignoring the size limit. Returns the summary. */
    validateNow: function (document) { return run(document, true); },
    /** Returns the last summary `{ skipped, format, segments, counts }` of a document, or null. */
    getSummary: function (document) { return summaries.get(document.uri.toString()) || null; },
    /** Registers a callback invoked with the document after each validation run. */
    onDidUpdate: function (cb) { listeners.push(cb); },
    runAll: runAll,
    dispose: function () {
      timers.forEach(function (t) { clearTimeout(t); });
      timers.clear();
      subscriptions.forEach(function (d) { try { d.dispose(); } catch (e) { /* already disposed */ } });
    }
  };
}

module.exports = { createDiagnostics: createDiagnostics, issueSpan: issueSpan };
