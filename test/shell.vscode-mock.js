'use strict';
// A small stand-in for the editor API, just large enough to load and exercise the extension shell
// in unit tests. It records what the extension registers and shows.

const Module = require('node:module');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
    else { this.start = a; this.end = b; }
  }
}
class Selection extends Range {
  constructor(a, b) { super(a, b); this.anchor = a; this.active = b; }
}
class EventEmitter {
  constructor() { this.listeners = []; this.event = (cb) => { this.listeners.push(cb); return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== cb); } }; }; }
  fire(value) { this.listeners.slice().forEach((l) => l(value)); }
  dispose() { this.listeners = []; }
}
class TreeItem {
  constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
}
class ThemeIcon { constructor(id) { this.id = id; } }
class MarkdownString {
  constructor() { this.value = ''; this.isTrusted = false; this.supportHtml = false; }
  appendMarkdown(s) { this.value += s; return this; }
  appendText(s) { this.value += String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&'); return this; }
}
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
class Diagnostic {
  constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; }
}
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
class TextEdit {
  static replace(range, newText) { const e = new TextEdit(); e.range = range; e.newText = newText; return e; }
}
class Uri {
  constructor(scheme, path) { this.scheme = scheme; this.path = path; this.fsPath = path; }
  toString() { return this.scheme + '://' + this.path; }
  with(change) { return new Uri(change.scheme || this.scheme, change.path !== undefined ? change.path : this.path); }
  static parse(text) { const m = /^([a-z-]+):\/\/(.*)$/.exec(text); return m ? new Uri(m[1], m[2]) : new Uri('file', text); }
  static file(p) { return new Uri('file', p); }
}

/** Creates a fake text document with position/offset conversion. */
function makeDocument(text, languageId, name, options) {
  const o = options || {};
  const doc = {
    uri: new Uri(o.scheme || 'file', '/work/' + (name || 'sample.txt')),
    languageId: languageId,
    version: 1,
    isClosed: false,
    eol: o.eol || 1,
    _text: text,
    getText: () => doc._text,
    offsetAt: (pos) => {
      const re = /\r\n|\r|\n/g;
      const starts = [0];
      let m;
      while ((m = re.exec(doc._text)) !== null) starts.push(m.index + m[0].length);
      const offset = (starts[pos.line] || 0) + pos.character;
      return Math.min(offset, doc._text.length);
    },
    positionAt: (offset) => {
      const re = /\r\n|\r|\n/g;
      let line = 0;
      let lineStart = 0;
      let m;
      while ((m = re.exec(doc._text)) !== null && m.index + m[0].length <= offset) {
        line++;
        lineStart = m.index + m[0].length;
      }
      return new Position(line, offset - lineStart);
    }
  };
  return doc;
}

/** Creates a fake editor on a document; `edit` applies the first replace to the document text. */
function makeEditor(doc) {
  const origin = new Position(0, 0);
  const editor = {
    document: doc,
    viewColumn: 1,
    selection: new Selection(origin, origin),
    visibleRanges: [new Range(0, 0, 0, 0)],
    revealed: [],
    revealRange: (range) => { editor.revealed.push(range); },
    edit: async (callback) => {
      const edits = [];
      callback({ replace: (range, text) => edits.push({ range, text }) });
      editor.edits = edits;
      if (edits.length) { doc._text = edits[0].text; doc.version++; }
      return true;
    },
    setCursor: (offset) => { const p = doc.positionAt(offset); editor.selection = new Selection(p, p); }
  };
  return editor;
}

function createMock() {
  const state = {
    commands: new Map(),
    hoverProviders: [],
    formattingProviders: [],
    diagnosticCollections: [],
    treeViews: [],
    statusItems: [],
    infoMessages: [],
    warnMessages: [],
    errorMessages: [],
    statusMessages: [],
    outputChannels: [],
    openedDocuments: [],
    clipboard: '',
    config: {},
    textDocuments: [],
    files: new Map(),
    written: [],
    findResult: [],
    activeTextEditor: undefined,
    quickPickAnswer: undefined,
    quickPicks: [],
    inputBoxes: [],
    progressTitles: [],
    cancelAfter: undefined,
    saveDialogAnswer: undefined,
    infoAnswer: undefined,
    inputAnswer: undefined,
    emitters: {
      activeEditor: new EventEmitter(),
      open: new EventEmitter(),
      save: new EventEmitter(),
      change: new EventEmitter(),
      close: new EventEmitter(),
      config: new EventEmitter()
    }
  };

  function collection(name) {
    const map = new Map();
    const c = {
      name,
      map,
      set: (uri, diags) => { map.set(uri.toString(), diags); },
      delete: (uri) => { map.delete(uri.toString()); },
      has: (uri) => map.has(uri.toString()),
      clear: () => { map.clear(); },
      dispose: () => {}
    };
    state.diagnosticCollections.push(c);
    return c;
  }

  const vscode = {
    Position, Range, Selection, EventEmitter, TreeItem, ThemeIcon, MarkdownString, Hover, Diagnostic, RelativePattern, TextEdit, Uri,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    EndOfLine: { LF: 1, CRLF: 2 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    ProgressLocation: { Notification: 15 },
    FileType: { Unknown: 0, File: 1, Directory: 2 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    commands: {
      registerCommand: (id, fn) => { state.commands.set(id, fn); return { dispose: () => state.commands.delete(id) }; },
      executeCommand: async (id, ...args) => {
        const fn = state.commands.get(id);
        if (fn) return fn(...args);
        return undefined;
      }
    },
    window: {
      get activeTextEditor() { return state.activeTextEditor; },
      get visibleTextEditors() { return state.activeTextEditor ? [state.activeTextEditor] : []; },
      onDidChangeActiveTextEditor: state.emitters.activeEditor.event,
      createOutputChannel: (name) => { const ch = { name, lines: [], appendLine: (l) => ch.lines.push(l), dispose() {} }; state.outputChannels.push(ch); return ch; },
      createTreeView: (id, options) => {
        const view = { id, options, message: undefined, dispose() {} };
        state.treeViews.push(view);
        return view;
      },
      createStatusBarItem: (alignment, priority) => {
        const item = { alignment, priority, text: '', tooltip: '', command: undefined, visible: false, show() { item.visible = true; }, hide() { item.visible = false; }, dispose() {} };
        state.statusItems.push(item);
        return item;
      },
      showInformationMessage: async (text, ...buttons) => {
        state.infoMessages.push({ text, buttons });
        return typeof state.infoAnswer === 'function' ? state.infoAnswer(text, buttons) : state.infoAnswer;
      },
      showWarningMessage: async (text, ...rest) => {
        state.warnMessages.push({ text, rest });
        return typeof state.warnAnswer === 'function' ? state.warnAnswer(text, rest) : state.warnAnswer;
      },
      showErrorMessage: async (text) => { state.errorMessages.push(text); return undefined; },
      showQuickPick: async (items, options) => {
        state.quickPicks.push({ items, options });
        return typeof state.quickPickAnswer === 'function' ? state.quickPickAnswer(items, options) : state.quickPickAnswer;
      },
      showInputBox: async (options) => {
        state.inputBoxes.push(options || {});
        return typeof state.inputAnswer === 'function' ? state.inputAnswer(options || {}) : state.inputAnswer;
      },
      showOpenDialog: async (options) => (typeof state.openDialogAnswer === 'function' ? state.openDialogAnswer(options || {}) : state.openDialogAnswer),
      showSaveDialog: async (options) => (typeof state.saveDialogAnswer === 'function' ? state.saveDialogAnswer(options || {}) : state.saveDialogAnswer),
      showTextDocument: async (doc, options) => { state.shown = doc; state.shownOptions = options; return { document: doc }; },
      setStatusBarMessage: (text) => { state.statusMessages.push(text); return { dispose() {} }; },
      withProgress: async (options, task) => {
        state.progressTitles.push(options && options.title);
        let reports = 0;
        const token = { get isCancellationRequested() { return state.cancelAfter !== undefined && reports > state.cancelAfter; } };
        return task({ report() { reports++; } }, token);
      },
      createWebviewPanel: (type, title, column, options) => { const panel = { type, title, options, webview: { html: '' } }; state.panel = panel; return panel; }
    },
    workspace: {
      get textDocuments() { return state.textDocuments; },
      workspaceFolders: undefined,
      getWorkspaceFolder: (uri) => (vscode.workspace.workspaceFolders || []).find((f) => String(uri.path).startsWith(f.uri.path.replace(/\/+$/, '') + '/')),
      getConfiguration: () => ({ get: (key, fallback) => (Object.prototype.hasOwnProperty.call(state.config, key) ? state.config[key] : fallback) }),
      onDidOpenTextDocument: state.emitters.open.event,
      onDidSaveTextDocument: state.emitters.save.event,
      onDidChangeTextDocument: state.emitters.change.event,
      onDidCloseTextDocument: state.emitters.close.event,
      onDidChangeConfiguration: state.emitters.config.event,
      asRelativePath: (uri) => (uri.path || String(uri)).replace(/^\/work\//, ''),
      openTextDocument: async (options) => {
        if (options instanceof Uri) {
          const known = state.textDocuments.find((d) => d.uri.toString() === options.toString());
          if (known) return known;
          const bytes = state.files.get(options.toString());
          if (!bytes) throw new Error('file not found: ' + options.toString());
          const opened = makeDocument(Buffer.from(bytes).toString('utf8'), 'plaintext', options.path.replace(/^\/work\//, ''));
          opened.uri = options;
          state.textDocuments.push(opened);
          return opened;
        }
        const doc = makeDocument(options.content, options.language, 'untitled-' + (state.openedDocuments.length + 1), { scheme: 'untitled' });
        state.openedDocuments.push(doc);
        return doc;
      },
      findFiles: async () => state.findResult.slice(),
      fs: {
        readFile: async (uri) => {
          const bytes = state.files.get(uri.toString());
          if (!bytes) throw new Error('file not found: ' + uri.toString());
          return bytes;
        },
        writeFile: async (uri, bytes) => { state.files.set(uri.toString(), bytes); state.written.push(uri.toString()); },
        stat: async (uri) => {
          const bytes = state.files.get(uri.toString());
          if (!bytes) throw new Error('file not found: ' + uri.toString());
          return { size: bytes.length, type: 1 };
        }
      }
    },
    languages: {
      createDiagnosticCollection: collection,
      registerHoverProvider: (selector, provider) => { state.hoverProviders.push({ selector, provider }); return { dispose() {} }; },
      registerDocumentFormattingEditProvider: (selector, provider) => { state.formattingProviders.push({ selector, provider }); return { dispose() {} }; },
      setTextDocumentLanguage: async (doc, language) => { doc.languageId = language; return doc; }
    },
    env: {
      clipboard: { writeText: async (t) => { state.clipboard = t; } },
      openExternal: async (uri) => { state.opened = uri; return true; }
    }
  };
  return { vscode, state };
}

/** Makes `require('vscode')` return the given mock for as long as the returned function is not called. */
function install(mock) {
  const original = Module._load;
  Module._load = function (request) {
    if (request === 'vscode') return mock;
    return original.apply(this, arguments);
  };
  return function uninstall() { Module._load = original; };
}

function makeContext(extensionMode) {
  const secrets = new Map();
  const global = new Map();
  const workspace = new Map();
  return {
    extensionMode: extensionMode === undefined ? 1 : extensionMode,
    subscriptions: [],
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    globalState: { get: (k) => global.get(k), update: async (k, v) => { if (v === undefined) global.delete(k); else global.set(k, v); } },
    workspaceState: { get: (k) => workspace.get(k), update: async (k, v) => { if (v === undefined) workspace.delete(k); else workspace.set(k, v); } }
  };
}

module.exports = { createMock, install, makeDocument, makeEditor, makeContext, Uri, Range, Position };
