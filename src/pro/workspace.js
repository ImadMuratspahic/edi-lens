'use strict';

/*
 * Workspace scan (Pro).
 *
 * The scanning and reporting code is plain JavaScript that talks to the file
 * system through a small adapter object, so it can be tested without the
 * editor. The functions at the end of the file connect it to the VS Code API;
 * they are thin and are the only place that uses it.
 *
 * Adapter contract (all methods return promises):
 *   findFiles(glob, exclude, maxResults) -> string[]   ids of matching files
 *   stat(id)                             -> { size }   size in bytes
 *   readText(id)                         -> string     whole file as text
 *   readHead(id, maxChars)               -> string     start of the file (optional)
 *   label(id)                            -> string     name shown to the user (optional)
 */

const DEFAULT_GLOB = '**/*.{edi,edifact,edf,x12,x12edi,hl7}';
const DEFAULT_EXCLUDE = '**/{node_modules,.git,.hg,.svn}/**';
const SNIFF_GLOB = '**/*';

/** Hard limits. Options can lower them but never raise them. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 2000;
/** Most files without a known extension whose first bytes are examined. */
const MAX_SNIFF_CANDIDATES = 10000;
const SNIFF_CHARS = 512;
const DEFAULT_MAX_ISSUES_PER_FILE = 500;
/** Issues listed per file in the Markdown report. */
const REPORT_ISSUES_PER_FILE = 50;

/** File extensions that are never worth reading when looking for EDI content. */
const SKIP_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'pdf', 'zip', 'gz', 'tgz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'war', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'webm', 'psd', 'iso', 'db', 'sqlite', 'vsix', 'map',
]);

/** Returns the loaded core functions (detectFormat, parse, validate), loaded on first use. */
function loadCore() {
  return {
    detectFormat: require('../core/detect.js').detectFormat,
    parse: require('../core/parse.js').parse,
    validate: require('../core/validate.js').validate,
  };
}

/** Returns a positive integer from value, or fallback; the result never exceeds max. */
function limit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.floor(n), max);
}

/**
 * Fills in defaults and enforces the hard limits on scan options: glob,
 * exclude, maxFileBytes (at most 5 MB), maxFiles (at most 2,000),
 * sniffUnknownFiles (default true), maxSniffCandidates, maxIssuesPerFile and
 * core (optional replacement for the parse/validate/detect functions).
 */
function normaliseScanOptions(options) {
  const o = options || {};
  return {
    glob: typeof o.glob === 'string' && o.glob.trim() !== '' ? o.glob.trim() : DEFAULT_GLOB,
    exclude: typeof o.exclude === 'string' && o.exclude.trim() !== '' ? o.exclude.trim() : DEFAULT_EXCLUDE,
    maxFileBytes: limit(o.maxFileBytes, MAX_FILE_BYTES, MAX_FILE_BYTES),
    maxFiles: limit(o.maxFiles, MAX_FILES, MAX_FILES),
    sniffUnknownFiles: o.sniffUnknownFiles !== false,
    maxSniffCandidates: limit(o.maxSniffCandidates, MAX_SNIFF_CANDIDATES, MAX_SNIFF_CANDIDATES),
    maxIssuesPerFile: limit(o.maxIssuesPerFile, DEFAULT_MAX_ISSUES_PER_FILE, 5000),
    core: o.core || null,
  };
}

/** Removes a leading byte order mark. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Returns the offsets at which each line starts (CRLF, LF and lone CR all end a line). */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      starts.push(i + 1);
    } else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        i += 1;
      }
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Converts a text offset to a 0-based { line, character } using a lineStarts array. */
function positionAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low, character: offset - starts[low] };
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/**
 * Merges the syntax issues found while parsing with the structural issues
 * from validation, drops exact duplicates, and sorts by position. Each issue
 * gets the 1-based line and column, a 0-based range for the editor and the
 * label of its segment (such as "UNT[1]") when it has one.
 */
function collectIssues(message, validated, text, maxIssues) {
  const seen = new Set();
  const merged = [];
  (Array.isArray(message.issues) ? message.issues : []).concat(validated || []).forEach((issue) => {
    const key = [issue.code, issue.offset, issue.end, issue.message].join('\u0001');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(issue);
    }
  });
  merged.sort((a, b) => (a.offset - b.offset) || ((SEVERITY_ORDER[a.severity] || 0) - (SEVERITY_ORDER[b.severity] || 0)));
  const starts = merged.length > 0 ? lineStarts(text) : [0];
  const segments = Array.isArray(message.segments) ? message.segments : [];
  const counts = { error: 0, warning: 0, info: 0 };
  const listed = [];
  merged.forEach((issue) => {
    const severity = issue.severity === 'error' || issue.severity === 'warning' ? issue.severity : 'info';
    counts[severity] += 1;
    if (listed.length >= maxIssues) {
      return;
    }
    const startOffset = Math.max(0, Math.min(issue.offset || 0, text.length));
    const endOffset = Math.max(startOffset, Math.min(typeof issue.end === 'number' ? issue.end : startOffset, text.length));
    const from = positionAt(starts, startOffset);
    const to = positionAt(starts, endOffset);
    const seg = issue.segmentIndex >= 0 ? segments[issue.segmentIndex] : null;
    listed.push({
      severity,
      code: issue.code,
      message: issue.message,
      offset: startOffset,
      end: endOffset,
      segmentIndex: typeof issue.segmentIndex === 'number' ? issue.segmentIndex : -1,
      segment: seg ? seg.id + '[' + seg.occurrence + ']' : '',
      line: from.line + 1,
      column: from.character + 1,
      range: { startLine: from.line, startCharacter: from.character, endLine: to.line, endCharacter: to.character },
    });
  });
  return { listed, counts, total: merged.length };
}

/** Formats a byte count for messages, such as "5.2 MB". */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  if (bytes >= 1024) {
    return Math.round(bytes / 1024) + ' KB';
  }
  return bytes + ' bytes';
}

/** Returns the lower-case extension of a file name, without the dot. */
function extensionOf(id) {
  const name = String(id).split(/[\\/]/).pop();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Reads, detects, parses and validates one file. Never throws: problems with
 * the file itself become a result with status "skipped" (not an EDI file, too
 * large, empty) or "failed" (could not be read).
 */
async function scanOne(adapter, core, o, id, label) {
  const entry = { path: id, label, status: 'ok', size: 0, issues: [], counts: { error: 0, warning: 0, info: 0 } };
  try {
    const st = await adapter.stat(id);
    entry.size = st && typeof st.size === 'number' ? st.size : 0;
    if (entry.size > o.maxFileBytes) {
      entry.status = 'skipped';
      entry.reason = 'Larger than ' + formatBytes(o.maxFileBytes) + ' (' + formatBytes(entry.size) + ').';
      return entry;
    }
    const text = stripBom(await adapter.readText(id));
    if (text.length > o.maxFileBytes) {
      entry.status = 'skipped';
      entry.reason = 'Larger than ' + formatBytes(o.maxFileBytes) + '.';
      return entry;
    }
    if (text.trim() === '') {
      entry.status = 'skipped';
      entry.reason = 'The file is empty.';
      return entry;
    }
    const detected = core.detectFormat(text);
    if (!detected) {
      entry.status = 'skipped';
      entry.reason = 'The start of the file is not a recognised UN/EDIFACT, X12 or HL7 v2 header.';
      return entry;
    }
    const message = core.parse(text);
    const validated = core.validate(message, { maxIssues: o.maxIssuesPerFile });
    const collected = collectIssues(message, validated, text, o.maxIssuesPerFile);
    entry.format = message.format || detected.format;
    entry.segmentCount = Array.isArray(message.segments) ? message.segments.length : 0;
    entry.issues = collected.listed;
    entry.counts = collected.counts;
    if (collected.total > collected.listed.length) {
      entry.issuesTruncated = collected.total - collected.listed.length;
    }
    return entry;
  } catch (err) {
    entry.status = 'failed';
    entry.reason = 'The file could not be read or analysed' + (err && err.message ? ': ' + err.message : '.');
    return entry;
  }
}

/** Sorts and removes duplicates from a list of ids. */
function sortedUnique(list) {
  return Array.from(new Set(list)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Scans files through the adapter and returns a summary object.
 *
 * Steps: find files by glob (at most maxFiles), optionally look at the first
 * bytes of other files and add those that start like a known format, then
 * parse and validate each file in turn. Files over maxFileBytes are skipped
 * and listed as such. hooks.onProgress({ phase, done, total, label }) is
 * called as work advances; hooks.isCancelled() is checked before every file,
 * and when it returns true the scan stops and the summary has cancelled set.
 *
 * Summary: { options, files, totals, byFormat, truncated, sniffTruncated,
 * cancelled }. Each entry of files has path, label, status (ok, skipped or
 * failed), reason, format, size, segmentCount, counts and issues.
 */
async function scanFiles(adapter, options, hooks) {
  const o = normaliseScanOptions(options);
  const h = hooks || {};
  const core = o.core || loadCore();
  const report = (info) => {
    if (typeof h.onProgress === 'function') {
      h.onProgress(info);
    }
  };
  const cancelled = () => typeof h.isCancelled === 'function' && h.isCancelled() === true;
  const labelOf = (id) => (typeof adapter.label === 'function' ? adapter.label(id) : id);

  const summary = {
    options: { glob: o.glob, maxFileBytes: o.maxFileBytes, maxFiles: o.maxFiles },
    files: [],
    totals: {
      found: 0, scanned: 0, skipped: 0, failed: 0,
      filesWithErrors: 0, filesWithWarnings: 0, errors: 0, warnings: 0, infos: 0,
    },
    byFormat: { edifact: 0, x12: 0, hl7: 0 },
    truncated: false,
    sniffTruncated: false,
    cancelled: false,
  };

  const matched = sortedUnique(await adapter.findFiles(o.glob, o.exclude, o.maxFiles + 1));
  let candidates = matched.slice(0, o.maxFiles);
  if (matched.length > o.maxFiles) {
    summary.truncated = true;
  }

  if (o.sniffUnknownFiles && typeof adapter.readHead === 'function' && candidates.length < o.maxFiles) {
    const everything = await adapter.findFiles(SNIFF_GLOB, o.exclude, o.maxSniffCandidates + 1);
    if (everything.length > o.maxSniffCandidates) {
      summary.sniffTruncated = true;
    }
    const known = new Set(matched);
    const others = sortedUnique(everything.slice(0, o.maxSniffCandidates))
      .filter((id) => !known.has(id) && !SKIP_EXTENSIONS.has(extensionOf(id)));
    for (let i = 0; i < others.length; i += 1) {
      if (cancelled()) {
        summary.cancelled = true;
        break;
      }
      if (i % 50 === 0) {
        report({ phase: 'looking', done: i, total: others.length, label: '' });
      }
      try {
        const st = await adapter.stat(others[i]);
        if (!st || st.size === 0 || st.size > o.maxFileBytes) {
          continue;
        }
        const head = await adapter.readHead(others[i], SNIFF_CHARS);
        if (core.detectFormat(stripBom(head))) {
          if (candidates.length >= o.maxFiles) {
            summary.truncated = true;
            break;
          }
          candidates.push(others[i]);
        }
      } catch (err) {
        // A file that cannot be examined is simply not a candidate.
      }
    }
    candidates = sortedUnique(candidates);
  }

  summary.totals.found = candidates.length;
  for (let i = 0; i < candidates.length; i += 1) {
    if (summary.cancelled || cancelled()) {
      summary.cancelled = true;
      break;
    }
    const id = candidates[i];
    const label = labelOf(id);
    report({ phase: 'scanning', done: i, total: candidates.length, label });
    const entry = await scanOne(adapter, core, o, id, label);
    summary.files.push(entry);
    addToTotals(summary, entry);
  }
  report({ phase: 'done', done: summary.files.length, total: candidates.length, label: '' });
  return summary;
}

/** Adds one file result to the totals of a summary. */
function addToTotals(summary, entry) {
  const t = summary.totals;
  if (entry.status === 'skipped') {
    t.skipped += 1;
  } else if (entry.status === 'failed') {
    t.failed += 1;
  } else {
    t.scanned += 1;
    if (entry.format && hasOwn(summary.byFormat, entry.format)) {
      summary.byFormat[entry.format] += 1;
    }
    t.errors += entry.counts.error;
    t.warnings += entry.counts.warning;
    t.infos += entry.counts.info;
    if (entry.counts.error > 0) {
      t.filesWithErrors += 1;
    } else if (entry.counts.warning > 0) {
      t.filesWithWarnings += 1;
    }
  }
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Escapes text for Markdown so that file names and messages taken from files
 * cannot create links, HTML or table breaks. Line breaks become spaces.
 */
function escapeMarkdown(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[\\`*_[\]<>|&~#]/g, '\\$&');
}

const FORMAT_NAMES = { edifact: 'UN/EDIFACT', x12: 'ANSI X12', hl7: 'HL7 v2' };

/** Returns "1 error" / "2 errors" style text. */
function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/**
 * Renders a scan summary as a Markdown report: totals, a table per file that
 * has problems (at most 50 issues each), the clean files, and the files that
 * were skipped or could not be read. Options: title and reportDate (text
 * shown under the title; omitted when not given, so the report is the same
 * every time for the same input).
 */
function toMarkdown(summary, opts) {
  const o = opts || {};
  const t = summary.totals;
  const lines = [];
  lines.push('# ' + escapeMarkdown(o.title || 'EDI Lens workspace report'));
  lines.push('');
  if (o.reportDate) {
    lines.push('Report date: ' + escapeMarkdown(o.reportDate));
    lines.push('');
  }
  if (summary.cancelled) {
    lines.push('> The scan was cancelled before it finished. The results below are partial.');
    lines.push('');
  }
  if (summary.truncated) {
    lines.push('> More than ' + summary.options.maxFiles + ' files matched. Only the first ' +
      summary.options.maxFiles + ' were scanned.');
    lines.push('');
  }
  if (summary.sniffTruncated) {
    lines.push('> The workspace has a very large number of other files. Only some of them were checked for EDI content.');
    lines.push('');
  }
  lines.push('## Summary');
  lines.push('');
  lines.push('| Item | Count |');
  lines.push('| --- | ---: |');
  lines.push('| Files scanned | ' + t.scanned + ' |');
  lines.push('| Files with errors | ' + t.filesWithErrors + ' |');
  lines.push('| Files with warnings only | ' + t.filesWithWarnings + ' |');
  lines.push('| Files skipped | ' + t.skipped + ' |');
  lines.push('| Files that could not be read | ' + t.failed + ' |');
  lines.push('| Errors | ' + t.errors + ' |');
  lines.push('| Warnings | ' + t.warnings + ' |');
  lines.push('| Information notes | ' + t.infos + ' |');
  lines.push('');
  lines.push('By format: ' + Object.keys(FORMAT_NAMES).map((k) => FORMAT_NAMES[k] + ' ' + summary.byFormat[k]).join(', ') + '.');
  lines.push('');

  const scanned = summary.files.filter((f) => f.status === 'ok');
  const withIssues = scanned.filter((f) => f.issues.length > 0 || f.counts.error + f.counts.warning + f.counts.info > 0);
  const clean = scanned.filter((f) => withIssues.indexOf(f) < 0);
  const others = summary.files.filter((f) => f.status !== 'ok');

  if (withIssues.length > 0) {
    lines.push('## Files with problems');
    lines.push('');
    withIssues.forEach((f) => {
      lines.push('### ' + escapeMarkdown(f.label));
      lines.push('');
      lines.push((FORMAT_NAMES[f.format] || f.format) + ', ' + plural(f.segmentCount, 'segment') + ': ' +
        plural(f.counts.error, 'error') + ', ' + plural(f.counts.warning, 'warning') + ', ' +
        plural(f.counts.info, 'note') + '.');
      lines.push('');
      lines.push('| Line | Segment | Severity | Code | Message |');
      lines.push('| ---: | --- | --- | --- | --- |');
      f.issues.slice(0, REPORT_ISSUES_PER_FILE).forEach((issue) => {
        lines.push('| ' + issue.line + ' | ' + escapeMarkdown(issue.segment) + ' | ' + escapeMarkdown(issue.severity) +
          ' | ' + escapeMarkdown(issue.code) + ' | ' + escapeMarkdown(issue.message) + ' |');
      });
      const unlisted = f.counts.error + f.counts.warning + f.counts.info - Math.min(f.issues.length, REPORT_ISSUES_PER_FILE);
      if (unlisted > 0) {
        lines.push('');
        lines.push('... and ' + plural(unlisted, 'more issue') + ' not listed here.');
      }
      lines.push('');
    });
  }
  if (clean.length > 0) {
    lines.push('## Files without problems');
    lines.push('');
    clean.forEach((f) => {
      lines.push('- ' + escapeMarkdown(f.label) + ' (' + (FORMAT_NAMES[f.format] || f.format) + ', ' +
        plural(f.segmentCount, 'segment') + ')');
    });
    lines.push('');
  }
  if (others.length > 0) {
    lines.push('## Skipped or unreadable files');
    lines.push('');
    others.forEach((f) => {
      lines.push('- ' + escapeMarkdown(f.label) + ': ' + escapeMarkdown(f.reason));
    });
    lines.push('');
  }
  if (summary.files.length === 0) {
    lines.push('No EDI files were found.');
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Connection to the editor (thin glue; needs the vscode module)       */
/* ------------------------------------------------------------------ */

/**
 * Builds a file-system adapter on top of the VS Code workspace API for the
 * given folder URIs. File ids are URI strings. Files on the local disk have
 * their first bytes read directly; other schemes read the whole file.
 */
function createVscodeAdapter(vscode, folders) {
  const uris = new Map();
  const decoder = new TextDecoder('utf-8');
  const uriOf = (id) => uris.get(id) || vscode.Uri.parse(id);
  return {
    async findFiles(glob, exclude, maxResults) {
      const found = [];
      for (const folder of folders) {
        const pattern = new vscode.RelativePattern(folder, glob);
        const list = await vscode.workspace.findFiles(pattern, exclude, maxResults - found.length);
        list.forEach((uri) => {
          const id = uri.toString();
          uris.set(id, uri);
          found.push(id);
        });
        if (found.length >= maxResults) {
          break;
        }
      }
      return found;
    },
    async stat(id) {
      const st = await vscode.workspace.fs.stat(uriOf(id));
      return { size: st.size };
    },
    async readText(id) {
      return decoder.decode(await vscode.workspace.fs.readFile(uriOf(id)));
    },
    async readHead(id, maxChars) {
      const uri = uriOf(id);
      if (uri.scheme === 'file') {
        const fsp = require('fs').promises;
        const handle = await fsp.open(uri.fsPath, 'r');
        try {
          const buffer = Buffer.alloc(maxChars * 2);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return buffer.toString('utf8', 0, bytesRead).slice(0, maxChars);
        } finally {
          await handle.close();
        }
      }
      return decoder.decode(await vscode.workspace.fs.readFile(uri)).slice(0, maxChars);
    },
    label(id) {
      return vscode.workspace.asRelativePath(uriOf(id), folders.length > 1);
    },
  };
}

/**
 * Scans every folder of the open workspace. options are the scan options
 * described above (the settings of the extension are passed in by the
 * caller). progress is a vscode.Progress object (optional) and token a
 * CancellationToken (optional). Throws an Error with a plain message when no
 * folder is open.
 */
async function scanWorkspace(options, progress, token) {
  const vscode = require('vscode');
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri);
  if (folders.length === 0) {
    throw new Error('Open a folder first: the workspace scan needs a folder to look in.');
  }
  const adapter = createVscodeAdapter(vscode, folders);
  let lastPercent = 0;
  return scanFiles(adapter, options, {
    isCancelled: () => !!(token && token.isCancellationRequested),
    onProgress: (info) => {
      if (!progress || info.total === 0) {
        return;
      }
      const percent = Math.floor((info.done / info.total) * 100);
      const message = info.phase === 'looking' ? 'Looking for EDI files' : info.label;
      progress.report({ message, increment: Math.max(0, percent - lastPercent) });
      lastPercent = Math.max(lastPercent, percent);
    },
  });
}

/**
 * Replaces the contents of a DiagnosticCollection with the issues of a scan
 * summary, one entry per issue at the position the scan computed. The
 * collection is cleared first.
 */
function applyDiagnostics(collection, summary) {
  const vscode = require('vscode');
  const severities = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
  };
  collection.clear();
  summary.files.forEach((file) => {
    if (file.status !== 'ok' || file.issues.length === 0) {
      return;
    }
    const diagnostics = file.issues.map((issue) => {
      const r = issue.range;
      const range = new vscode.Range(r.startLine, r.startCharacter, r.endLine, r.endCharacter);
      const d = new vscode.Diagnostic(range, issue.message, severities[issue.severity]);
      d.code = issue.code;
      d.source = 'EDI Lens';
      return d;
    });
    collection.set(vscode.Uri.parse(file.path), diagnostics);
  });
}

module.exports = {
  DEFAULT_GLOB,
  DEFAULT_EXCLUDE,
  limits: {
    maxFileBytes: MAX_FILE_BYTES,
    maxFiles: MAX_FILES,
    maxSniffCandidates: MAX_SNIFF_CANDIDATES,
  },
  normaliseScanOptions,
  scanFiles,
  toMarkdown,
  escapeMarkdown,
  lineStarts,
  positionAt,
  createVscodeAdapter,
  scanWorkspace,
  applyDiagnostics,
};
