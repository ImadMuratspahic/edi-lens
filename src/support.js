'use strict';
// Support helpers: the diagnostics block that "Report A Problem" copies to the clipboard. Pure
// functions; the editor-facing command lives in commands.js.
//
// The block holds only what support needs to reproduce an environment: version numbers, the
// platform, the format of the active file with its segment and problem counts, the settings and
// the licence or trial state. It never contains file contents, file names, paths, the licence
// key, the key hint, user or computer names. Settings that may hold folder names (the two file
// patterns, the ignored paths of Compare) are printed as "default", "customised" or a count.

const config = require('./licence/config');
const { formatLabel } = require('./format');

const SETTING_KEYS = [
  'validateOnType', 'maxFileSizeMB', 'maxIssues', 'hoverEnabled', 'autoDetectLanguage',
  'exportNeutraliseFormulas'
];

// Settings whose values may hold folder or file names: only whether they were changed is printed.
const PATTERN_DEFAULTS = {
  workspaceInclude: '**/*.{edi,edifact,edf,x12,x12edi,hl7}',
  workspaceExclude: '**/{node_modules,.git,.hg,.svn}/**'
};

/** Describes the licence and trial state in one line, without the key or its hint. */
function licenceLine(st) {
  if (!st) return 'unknown';
  const trial = st.trial || { state: 'unused' };
  let text;
  if (st.pro && st.via === 'grace') text = 'Pro (licence, offline grace period)';
  else if (st.pro) text = 'Pro (licence, verified)';
  else if (st.hasKey && st.via === 'rejected') text = 'Free (stored key rejected by the server)';
  else if (st.hasKey && st.via === 'product') text = 'Free (stored key of another product)';
  else if (st.hasKey && st.via === 'stale') text = 'stored key, last check older than a day (not asked again for this report)';
  else if (st.hasKey) text = 'Free (stored key, grace period over)';
  else if (trial.state === 'active') text = 'Trial (' + trial.daysLeft + ' day' + (trial.daysLeft === 1 ? '' : 's') + ' left)';
  else if (trial.state === 'expired') text = 'Free (trial ended)';
  else text = 'Free (trial not started)';
  if (trial.state === 'active' && !st.pro && st.hasKey) text += ', trial running (' + trial.daysLeft + ' day' + (trial.daysLeft === 1 ? '' : 's') + ' left)';
  return text + (st.mode && st.mode !== 'live' ? ', licence server: ' + st.mode : '');
}

/** Formats one settings value for the block (arrays and strings are quoted as JSON). */
function settingValue(v) {
  if (v === undefined) return 'default';
  if (typeof v === 'object') return JSON.stringify(v);
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/**
 * Builds the diagnostics block. `info` holds: extensionVersion, editorName, editorVersion,
 * platform, osRelease, arch, nodeVersion, settings (the resolved settings object or null),
 * licence (the status object or null), active (`{ languageId, format, segments, counts,
 * skipped, size }` of the active file or null). Returns plain text, one item per line.
 */
function diagnosticsBlock(info) {
  const i = info || {};
  const lines = [];
  lines.push('EDI Lens ' + (i.extensionVersion || 'unknown version'));
  lines.push('Editor: ' + (i.editorName || 'unknown') + ' ' + (i.editorVersion || ''));
  lines.push('Platform: ' + (i.platform || 'unknown') + ' ' + (i.osRelease || '') + ' ' + (i.arch || '') + (i.nodeVersion ? ', Node ' + i.nodeVersion : ''));
  const a = i.active;
  if (!a) {
    lines.push('Active file: none');
  } else {
    const format = a.format ? formatLabel(a.format) : (a.languageId || 'unknown language');
    let detail = '';
    if (a.skipped === 'size') detail = ', not parsed (over the size limit)';
    else if (a.skipped) detail = ', not parsed';
    else if (typeof a.segments === 'number') {
      const c = a.counts || { error: 0, warning: 0, info: 0 };
      detail = ', ' + a.segments + ' segments, ' + c.error + ' errors, ' + c.warning + ' warnings, ' + c.info + ' notes';
    }
    lines.push('Active file: ' + format + (typeof a.size === 'number' ? ', ' + a.size + ' characters' : '') + detail);
  }
  lines.push('Settings:');
  const s = i.settings || {};
  for (const key of SETTING_KEYS) lines.push('  ' + key + ' = ' + settingValue(s[key]));
  for (const key of Object.keys(PATTERN_DEFAULTS)) lines.push('  ' + key + ' = ' + (s[key] === undefined || s[key] === PATTERN_DEFAULTS[key] ? 'default' : 'customised'));
  if (s.compare) {
    lines.push('  compare.ignoreSegments = ' + settingValue(s.compare.ignoreSegments));
    lines.push('  compare.ignorePaths = ' + (Array.isArray(s.compare.ignorePaths) ? s.compare.ignorePaths.length + ' entries' : 'default'));
    lines.push('  compare.ignoreCase = ' + settingValue(s.compare.ignoreCase));
    lines.push('  compare.trimValues = ' + settingValue(s.compare.trimValues));
  }
  lines.push('Licence: ' + licenceLine(i.licence));
  lines.push('Issues page: ' + config.issuesUrl);
  return lines.join('\n') + '\n';
}

/** The message shown after the block was copied. */
function reportProblemText(opened) {
  return 'A diagnostics block (version numbers, platform, settings, licence state; no file contents or names) was copied to the clipboard. ' +
    (opened ? 'Paste it into the issue that opens in your browser, add what you did and what you expected, and attach an example without real business or patient data.'
      : 'Open ' + config.issuesUrl + ', create a new issue, paste the block and describe what you did and what you expected.');
}

module.exports = { diagnosticsBlock: diagnosticsBlock, licenceLine: licenceLine, reportProblemText: reportProblemText, SETTING_KEYS: SETTING_KEYS };
