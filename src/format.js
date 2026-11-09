'use strict';
// Shared helpers of the extension shell. Everything here is free of editor API calls so it can be
// unit-tested; the editor-facing formatting provider lives in registerFormatting() at the bottom
// and receives the editor API as an argument.

const LANGUAGES = Object.freeze([
  Object.freeze({ id: 'edifact', format: 'edifact', label: 'UN/EDIFACT' }),
  Object.freeze({ id: 'x12', format: 'x12', label: 'ANSI X12' }),
  Object.freeze({ id: 'hl7', format: 'hl7', label: 'HL7 v2' })
]);

/** Returns the language id registered for a message format, or null. */
function languageIdForFormat(format) {
  for (const l of LANGUAGES) if (l.format === format) return l.id;
  return null;
}

/** Returns the message format for one of our language ids, or null for any other language. */
function formatForLanguageId(id) {
  for (const l of LANGUAGES) if (l.id === id) return l.format;
  return null;
}

/** Returns true when the language id is one of the three languages this extension provides. */
function isSupportedLanguage(id) {
  return formatForLanguageId(id) !== null;
}

/** Returns the human readable name of a message format. */
function formatLabel(format) {
  for (const l of LANGUAGES) if (l.format === format) return l.label;
  return String(format || 'Unknown');
}

// ---------------------------------------------------------------------------------------------
// Lazy module access. Every module is required inside a function so that the extension still
// loads when one of the parts is missing; callers check for undefined functions.

const LOADERS = {
  detect: function () { return require('./core/detect'); },
  parse: function () { return require('./core/parse'); },
  serialize: function () { return require('./core/serialize'); },
  path: function () { return require('./core/path'); },
  validate: function () { return require('./core/validate'); },
  diff: function () { return require('./pro/diff'); },
  exporter: function () { return require('./pro/export'); },
  dictionary: function () { return require('./pro/dictionary'); },
  workspace: function () { return require('./pro/workspace'); }
};
const loaded = {};

/** Loads one module by short name ('parse', 'diff', ...). Returns null when it cannot be loaded. */
function loadModule(name) {
  if (loaded[name]) return loaded[name];
  try {
    loaded[name] = LOADERS[name]();
    return loaded[name];
  } catch (e) {
    return null;
  }
}

function pick(mod, fn) { return mod && typeof mod[fn] === 'function' ? mod[fn].bind(mod) : undefined; }

/** Returns the core functions (each undefined when its module is unavailable). */
function getCore() {
  const detect = loadModule('detect');
  const parse = loadModule('parse');
  const serialize = loadModule('serialize');
  const path = loadModule('path');
  const validate = loadModule('validate');
  return {
    detectFormat: pick(detect, 'detectFormat'),
    parse: pick(parse, 'parse'),
    pretty: pick(serialize, 'pretty'),
    minify: pick(serialize, 'minify'),
    toJSON: pick(serialize, 'toJSON'),
    formatPath: pick(path, 'formatPath'),
    resolvePath: pick(path, 'resolvePath'),
    locate: pick(path, 'locate'),
    validate: pick(validate, 'validate')
  };
}

/** Returns the Pro modules (each null when unavailable). */
function getPro() {
  return {
    diff: loadModule('diff'),
    exporter: loadModule('exporter'),
    dictionary: loadModule('dictionary'),
    workspace: loadModule('workspace')
  };
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers.

/**
 * Shortens a value for labels and tooltips: control characters become a middle dot and values
 * longer than `max` code points are cut with an ellipsis.
 */
function shorten(value, max) {
  const limit = max > 1 ? max : 40;
  const clean = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '·');
  const chars = Array.from(clean);
  if (chars.length <= limit) return clean;
  return chars.slice(0, limit - 1).join('') + '…';
}

/** Returns the number of Unicode code points in a string (not UTF-16 units). */
function codePointLength(value) {
  let n = 0;
  const s = String(value === undefined || value === null ? '' : value);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Returns true when a text of `length` characters is larger than the size limit in megabytes. */
function exceedsLimit(length, limitMB) {
  const mb = typeof limitMB === 'number' && limitMB > 0 ? limitMB : 10;
  return length > mb * 1024 * 1024;
}

/**
 * Decodes file bytes as strict UTF-8. Returns `{ text, bom }` (a leading byte order mark is
 * removed and reported) or null when the bytes are not valid UTF-8, so a file is never rewritten
 * from a lossy decoding.
 */
function decodeUtf8(bytes) {
  let start = 0;
  let bom = false;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
    bom = true;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray ? bytes.subarray(start) : bytes.slice(start));
    return { text: text, bom: bom };
  } catch (e) {
    return null;
  }
}

/** Returns the line break style used by `original`: CRLF, LF or CR (LF when it has no line break). */
function eolOf(original) {
  if (original.indexOf('\r\n') !== -1) return '\r\n';
  if (original.indexOf('\n') !== -1) return '\n';
  if (original.indexOf('\r') !== -1) return '\r';
  return '\n';
}

function severityRank(s) { return s === 'error' ? 0 : s === 'warning' ? 1 : 2; }

/**
 * Merges the syntax issues found while parsing with the structural validation issues. Duplicates
 * (same code and range) are dropped, the list is ordered by position and cut to `max` entries.
 */
function mergeIssues(first, second, max) {
  const seen = new Set();
  const out = [];
  const all = [].concat(first || [], second || []);
  for (const issue of all) {
    if (!issue || typeof issue.offset !== 'number') continue;
    const key = issue.code + '|' + issue.offset + '|' + issue.end;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  out.sort(function (a, b) { return a.offset - b.offset || severityRank(a.severity) - severityRank(b.severity); });
  const limit = typeof max === 'number' && max > 0 ? max : 500;
  return out.length > limit ? out.slice(0, limit) : out;
}

/** Counts issues by severity: `{ error, warning, info }`. */
function countIssues(issues) {
  const c = { error: 0, warning: 0, info: 0 };
  for (const i of issues || []) {
    if (i.severity === 'error') c.error++;
    else if (i.severity === 'warning') c.warning++;
    else c.info++;
  }
  return c;
}

/** Looks up dictionary names without ever throwing; returns an empty object when unavailable. */
function describeSafe(dictionary, segmentId, elementIndex, componentIndex, value) {
  const mod = loadModule('dictionary');
  if (!dictionary || !mod || typeof mod.describe !== 'function') return {};
  try {
    return mod.describe(dictionary, segmentId, elementIndex, componentIndex, value) || {};
  } catch (e) {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing with a per-document cache.

/**
 * Creates a cache that parses each document once per version. `parseFn` defaults to the core
 * parser. `get(key, version, getText)` returns the Message, or null when parsing is unavailable.
 */
function createMessageCache(parseFn) {
  const store = new WeakMap();
  return {
    get: function (key, version, getText) {
      const parse = parseFn || getCore().parse;
      if (!parse) return null;
      const hit = store.get(key);
      if (hit && hit.version === version) return hit.message;
      let message = null;
      try { message = parse(getText()); } catch (e) { message = null; }
      store.set(key, { version: version, message: message });
      return message;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Formatting.

/**
 * Re-serialises an already parsed message. `mode` is 'pretty' or 'minify'; `options` goes to the
 * pretty printer (`{ eol }`). Returns
 * `{ ok: true, text, format }` or `{ ok: false, reason }` with reason 'unavailable', 'empty'
 * (no segments found) or 'failed'.
 */
function formatMessage(message, mode, core, options) {
  const c = core || getCore();
  const serialise = mode === 'minify' ? c.minify : c.pretty;
  if (!serialise) return { ok: false, reason: 'unavailable' };
  if (!message || !Array.isArray(message.segments) || message.segments.length === 0) return { ok: false, reason: 'empty' };
  let out;
  try { out = mode === 'minify' ? serialise(message) : serialise(message, options); } catch (e) { return { ok: false, reason: 'failed' }; }
  if (typeof out !== 'string') return { ok: false, reason: 'failed' };
  return { ok: true, text: out, format: message.format };
}

/**
 * Parses `text` and re-serialises it as 'pretty' or 'minify'; see formatMessage for the result.
 * `options` is passed to the pretty printer (for example the line break to use).
 */
function formatText(text, mode, core, options) {
  const c = core || getCore();
  if (!c.parse) return { ok: false, reason: 'unavailable' };
  let message;
  try { message = c.parse(text); } catch (e) { return { ok: false, reason: 'failed' }; }
  return formatMessage(message, mode, c, options);
}

/** Explains a failed formatting result in one sentence for the user. */
function describeFormatFailure(reason) {
  if (reason === 'empty') return 'No segments were found, so there is nothing to format.';
  if (reason === 'unavailable') return 'This installation is incomplete: the formatting module could not be loaded.';
  return 'The file could not be formatted.';
}

/**
 * Registers the document formatting provider for the three languages. `vscode` is the editor API
 * and `getMessage(document)` returns the parsed message (or null). Returns the disposables.
 */
function registerFormatting(vscode, getMessage) {
  const provider = {
    provideDocumentFormattingEdits: function (document) {
      const message = getMessage(document);
      if (!message) return [];
      const result = formatMessage(message, 'pretty');
      if (!result.ok) return [];
      const text = result.text;
      const current = document.getText();
      if (text === current) return [];
      const whole = new vscode.Range(document.positionAt(0), document.positionAt(current.length));
      return [vscode.TextEdit.replace(whole, text)];
    }
  };
  return LANGUAGES.map(function (l) {
    return vscode.languages.registerDocumentFormattingEditProvider({ language: l.id }, provider);
  });
}

module.exports = {
  LANGUAGES: LANGUAGES,
  languageIdForFormat: languageIdForFormat,
  formatForLanguageId: formatForLanguageId,
  isSupportedLanguage: isSupportedLanguage,
  formatLabel: formatLabel,
  loadModule: loadModule,
  getCore: getCore,
  getPro: getPro,
  shorten: shorten,
  codePointLength: codePointLength,
  exceedsLimit: exceedsLimit,
  decodeUtf8: decodeUtf8,
  eolOf: eolOf,
  mergeIssues: mergeIssues,
  countIssues: countIssues,
  describeSafe: describeSafe,
  createMessageCache: createMessageCache,
  formatMessage: formatMessage,
  formatText: formatText,
  describeFormatFailure: describeFormatFailure,
  registerFormatting: registerFormatting
};
