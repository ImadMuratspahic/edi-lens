'use strict';

/*
 * Anonymise (Pro): rewrites the identifying values of a message so that it can be shared, while
 * the message stays structurally the same.
 *
 * What is guaranteed:
 *   - Only values named by a rule are touched; every delimiter, segment and element stays where
 *     it was, so segment counts, envelope counts and nesting are unchanged.
 *   - Every action except `blank` writes a value of exactly the same length, built only from
 *     letters and digits in the places where the original had letters and digits. Escape
 *     sequences and punctuation are kept.
 *   - The envelope values that validation depends on (control numbers, counts, delimiters,
 *     message types, versions) are protected: a rule that points at one is skipped and counted.
 *   - The sender and receiver identifiers of the envelope (UNB, UNG, ISA, GS, MSH, BHS, FHS) are
 *     replaced like any identifier unless the caller asks to keep them, so that the first
 *     segment of a copy does not give away who the parties are. The same identifier in the body
 *     gets the same replacement.
 *   - The same original value always becomes the same replacement inside one run, and in every
 *     run that uses the same seed, so cross references stay consistent.
 *   - The report holds counts only, never a value. The table of originals and replacements
 *     exists only in memory, in the result of the call.
 *
 * Nothing here uses the editor API.
 */

const crypto = require('node:crypto');
const shared = require('./shared.js');
const { parseStream, readElements } = require('../core/parse.js');
const { detectFormat } = require('../core/detect.js');

const FORMATS = ['edifact', 'x12', 'hl7'];
const ACTIONS = ['mask', 'pseudonym', 'fake-name', 'fake-date', 'keep', 'blank'];
const MAX_RULES = 2000;
const MAX_MAP_ENTRIES = 100000;

const CODES = Object.freeze({
  rulesInvalid: 'ANON-RULES-INVALID',
  notEdi: 'ANON-NOT-EDI',
  nothingToDo: 'ANON-NO-RULES',
});

function rule(path, action) { return { path: path, action: action }; }
/** Street, other designation, city and postal code of an HL7 address; state and country stay. */
function address(field) { return [1, 2, 3, 5].map(function (c) { return rule(field + '.' + c, 'pseudonym'); }); }
/** Number, e-mail address and the split number parts of an HL7 telephone field; the use and type codes stay. */
function telephone(field) { return [1, 4, 6, 7, 12].map(function (c) { return rule(field + '.' + c, 'pseudonym'); }); }

/** The built-in profiles. Each one applies to a single format. */
const PROFILES = Object.freeze({
  'hl7-patient': {
    format: 'hl7',
    title: 'HL7 patient data (PID, NK1, IN1, GT1)',
    rules: [].concat(
      [rule('PID-2.1', 'pseudonym'), rule('PID-3.1', 'pseudonym'), rule('PID-3.4', 'pseudonym'), rule('PID-3.6', 'pseudonym'), rule('PID-4.1', 'pseudonym')],
      [rule('PID-5', 'fake-name'), rule('PID-6', 'fake-name'), rule('PID-7', 'fake-date'), rule('PID-9', 'fake-name')],
      address('PID-11'), telephone('PID-13'), telephone('PID-14'),
      [rule('PID-18.1', 'pseudonym'), rule('PID-19', 'pseudonym'), rule('PID-20.1', 'pseudonym'), rule('PID-21.1', 'pseudonym')],
      [rule('PID-23', 'pseudonym'), rule('PID-29', 'fake-date')],
      [rule('NK1-2', 'fake-name')], address('NK1-4'), telephone('NK1-5'), telephone('NK1-6'),
      [rule('NK1-16', 'fake-date'), rule('NK1-30', 'fake-name')], telephone('NK1-31'), address('NK1-32'),
      [rule('IN1-16', 'fake-name'), rule('IN1-18', 'fake-date')], address('IN1-19'), [rule('IN1-36', 'pseudonym'), rule('IN1-49.1', 'pseudonym')],
      [rule('GT1-3', 'fake-name'), rule('GT1-4', 'fake-name')], address('GT1-5'), telephone('GT1-6'), telephone('GT1-7'),
      [rule('GT1-8', 'fake-date'), rule('GT1-12', 'pseudonym'), rule('GT1-19.1', 'pseudonym')]
    ),
  },
  'x12-healthcare': {
    format: 'x12',
    title: 'X12 healthcare 837, 835, 270 and 271 identifying fields',
    rules: [
      rule('NM1[IL|QC|03|74]-3', 'fake-name'), rule('NM1[IL|QC|03|74]-4', 'fake-name'), rule('NM1[IL|QC|03|74]-5', 'fake-name'),
      rule('NM1[IL|QC|03|74]-9', 'pseudonym'),
      rule('N3-1', 'pseudonym'), rule('N3-2', 'pseudonym'), rule('N4-1', 'pseudonym'), rule('N4-3', 'pseudonym'),
      rule('DMG-2', 'fake-date'),
      rule('REF[SY|1W|EJ|0F|1L|IG|EA]-2', 'pseudonym'),
      rule('CLM-1', 'pseudonym'), rule('CLP-1', 'pseudonym'),
      rule('PER-2', 'fake-name'), rule('PER-4', 'pseudonym'), rule('PER-6', 'pseudonym'), rule('PER-8', 'pseudonym'),
    ],
  },
  'x12-party': {
    format: 'x12',
    title: 'X12 party data (N1, N2, N3, N4, PER)',
    rules: [
      rule('N1-2', 'fake-name'), rule('N1-4', 'pseudonym'), rule('N2-1', 'fake-name'), rule('N2-2', 'fake-name'),
      rule('N3-1', 'pseudonym'), rule('N3-2', 'pseudonym'), rule('N4-1', 'pseudonym'), rule('N4-3', 'pseudonym'),
      rule('PER-2', 'fake-name'), rule('PER-4', 'pseudonym'), rule('PER-6', 'pseudonym'), rule('PER-8', 'pseudonym'),
    ],
  },
  'edifact-party': {
    format: 'edifact',
    title: 'EDIFACT party data (NAD, CTA, COM, FII)',
    rules: [
      rule('NAD-2.1', 'pseudonym'), rule('NAD-3', 'pseudonym'), rule('NAD-4', 'fake-name'), rule('NAD-5', 'pseudonym'),
      rule('NAD-6', 'pseudonym'), rule('NAD-8', 'pseudonym'),
      rule('CTA-2.1', 'pseudonym'), rule('CTA-2.2', 'fake-name'),
      rule('COM-1.1', 'pseudonym'),
      rule('FII-2.1', 'pseudonym'), rule('FII-2.2', 'fake-name'), rule('FII-2.3', 'fake-name'), rule('FII-3.1', 'pseudonym'),
    ],
  },
});

/**
 * The sender and receiver identifiers of the envelope, per format. They are replaced as
 * pseudonyms (so that the same identifier in the body matches) unless envelope ids are kept.
 */
const ENVELOPE_IDS = Object.freeze({
  edifact: ['UNB-2.1', 'UNB-2.3', 'UNB-3.1', 'UNB-3.3', 'UNG-2.1', 'UNG-3.1'],
  x12: ['ISA-6', 'ISA-8', 'GS-2', 'GS-3'],
  hl7: ['MSH-3', 'MSH-4', 'MSH-5', 'MSH-6', 'BHS-3', 'BHS-4', 'BHS-5', 'BHS-6', 'FHS-3', 'FHS-4', 'FHS-5', 'FHS-6'],
});

/**
 * Elements that are never rewritten, per segment id: true protects the whole segment, a list
 * protects those element numbers.
 */
const PROTECTED = Object.freeze({
  edifact: { UNA: true, UNB: [1, 5], UNG: [1, 5], UNH: true, UNT: true, UNE: true, UNZ: true },
  x12: { ISA: [1, 3, 5, 7, 9, 10, 11, 12, 13, 14, 15, 16], GS: [1, 6, 7, 8], ST: true, SE: true, GE: true, IEA: true },
  hl7: { MSH: [1, 2, 9, 10, 11, 12], BHS: [1, 2], FHS: [1, 2], BTS: true, FTS: true },
});

function isProtected(format, id, element) {
  const p = PROTECTED[format][id];
  if (!p) return false;
  return p === true || p.indexOf(element) !== -1;
}

// ---------------------------------------------------------------------------------------------
// Rule files.

/**
 * Reads a rule file (JSON text). Layout:
 *   { "profiles": ["hl7-patient"], "rules": [{ "format": "hl7", "path": "PID-5", "action": "fake-name" }] }
 * Both parts are optional. Returns { ok: true, config: { profiles, rules } } or
 * { ok: false, code, errors: [text] }.
 */
function loadRules(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text));
  } catch (e) {
    return { ok: false, code: CODES.rulesInvalid, errors: ['The file is not valid JSON: ' + shared.show(e && e.message, 120)] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: CODES.rulesInvalid, errors: ['The file must hold one JSON object with "profiles" and/or "rules".'] };
  }
  const config = { profiles: null, rules: [] };
  if (data.profiles !== undefined) {
    if (!Array.isArray(data.profiles)) errors.push('"profiles" must be a list of profile names.');
    else {
      config.profiles = [];
      data.profiles.forEach(function (name) {
        if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PROFILES, name)) {
          errors.push('Unknown profile ' + JSON.stringify(shared.show(name, 40)) + '. Known profiles: ' + Object.keys(PROFILES).join(', ') + '.');
        } else if (config.profiles.indexOf(name) === -1) config.profiles.push(name);
      });
    }
  }
  if (data.rules !== undefined) {
    if (!Array.isArray(data.rules)) errors.push('"rules" must be a list.');
    else if (data.rules.length > MAX_RULES) errors.push('"rules" holds more than ' + MAX_RULES + ' entries.');
    else {
      data.rules.forEach(function (r, i) {
        const where = 'rules[' + i + ']: ';
        if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(where + 'must be an object.'); return; }
        if (FORMATS.indexOf(r.format) === -1) { errors.push(where + '"format" must be "edifact", "x12" or "hl7".'); return; }
        if (ACTIONS.indexOf(r.action) === -1) { errors.push(where + '"action" must be one of ' + ACTIONS.join(', ') + '.'); return; }
        const sel = shared.parseSelector(r.path);
        if (!sel.ok) { errors.push(where + '"path" is ' + sel.error + '.'); return; }
        if (!sel.element) { errors.push(where + '"path" must name an element, for example ' + sel.id + '-2.'); return; }
        if (sel.occurrence) { errors.push(where + '"path" must not use #n; rules apply to every matching segment.'); return; }
        config.rules.push({ format: r.format, path: sel.text, action: r.action });
      });
    }
  }
  if (errors.length) return { ok: false, code: CODES.rulesInvalid, errors: errors.slice(0, 20) };
  return { ok: true, config: config };
}

/**
 * Builds the working rule set. `config` is the result of loadRules (or null); `profileNames` are
 * the profiles chosen in the settings, used when the rule file names none. Rules of the file come
 * first and win over profile rules. options.envelopeIds is 'pseudonymise' (the default: the
 * sender and receiver identifiers of the envelope are replaced too) or 'keep'. Returns
 * { byFormat: { format: Map(id -> [rule]) }, list }.
 */
function compile(config, profileNames, options) {
  const list = [];
  const keepEnvelope = !!options && options.envelopeIds === 'keep';
  const add = function (format, path, action, source, envelope) {
    const sel = shared.parseSelector(path);
    if (!sel.ok || !sel.element || FORMATS.indexOf(format) === -1 || ACTIONS.indexOf(action) === -1) return;
    list.push({ format: format, path: sel.text, action: action, source: source, sel: sel, count: 0, envelope: envelope === true });
  };
  ((config && config.rules) || []).forEach(function (r) { add(r.format, r.path, r.action, 'rule file'); });
  // After the rules of the file, so that "keep" there switches a single envelope id off.
  if (!keepEnvelope) {
    FORMATS.forEach(function (format) {
      ENVELOPE_IDS[format].forEach(function (path) { add(format, path, 'pseudonym', 'envelope ids', true); });
    });
  }
  const names = config && Array.isArray(config.profiles) ? config.profiles : (Array.isArray(profileNames) ? profileNames : []);
  names.forEach(function (name) {
    if (!Object.prototype.hasOwnProperty.call(PROFILES, name)) return;
    const p = PROFILES[name];
    p.rules.forEach(function (r) { add(p.format, r.path, r.action, 'profile ' + name); });
  });
  const byFormat = { edifact: new Map(), x12: new Map(), hl7: new Map() };
  list.forEach(function (r) {
    const map = byFormat[r.format];
    if (!map.has(r.sel.id)) map.set(r.sel.id, []);
    map.get(r.sel.id).push(r);
  });
  return { byFormat: byFormat, list: list };
}

// ---------------------------------------------------------------------------------------------
// Value transformations.

const CONSONANTS = 'bdfghklmnprstvz';
const VOWELS = 'aeiou';

function isUpper(ch) { return ch !== ch.toLowerCase() && ch === ch.toUpperCase(); }

/** 'L' for a letter, 'D' for a digit, '' for anything else (one UTF-16 unit). */
function classOf(ch, code) {
  if (code < 128) {
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return 'L';
    if (code >= 48 && code <= 57) return 'D';
    return '';
  }
  if (code >= 0xd800 && code <= 0xdfff) return 'L';
  if (/\p{L}/u.test(ch)) return 'L';
  if (/\p{Nd}/u.test(ch)) return 'D';
  return '';
}

/**
 * Marks the characters of a value that belong to the syntax and must stay: an EDIFACT release
 * character with the character it escapes, and HL7 escape sequences from one escape character
 * to the next. Returns null when nothing is marked.
 */
function fixedPositions(value, format, release, escape) {
  let fixed = null;
  if (format === 'edifact' && release && value.indexOf(release) !== -1) {
    fixed = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      if (value[i] === release) {
        fixed[i] = 1;
        if (i + 1 < value.length) fixed[++i] = 1;
      }
    }
  } else if (format === 'hl7' && escape && value.indexOf(escape) !== -1) {
    fixed = new Uint8Array(value.length);
    let i = 0;
    while (i < value.length) {
      if (value[i] === escape) {
        const close = value.indexOf(escape, i + 1);
        if (close === -1) break;
        for (let k = i; k <= close; k++) fixed[k] = 1;
        i = close + 1;
      } else {
        i++;
      }
    }
  }
  return fixed;
}

/** A source of bytes that depends only on the seed, the kind and the value. */
function byteStream(seed, kind, value) {
  let block = null;
  let used = 0;
  let counter = 0;
  return function next() {
    if (!block || used >= block.length) {
      block = crypto.createHmac('sha256', seed).update(kind + '\u0000' + counter + '\u0000' + value).digest();
      counter++;
      used = 0;
    }
    return block[used++];
  };
}

function maskValue(value, fixed) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const cls = fixed && fixed[i] ? '' : classOf(value[i], value.charCodeAt(i));
    out += cls === 'L' ? 'X' : cls === 'D' ? '9' : value[i];
  }
  return out;
}

function scramble(value, fixed, next, nameLike) {
  let out = '';
  let run = 0;
  let vowel = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const cls = fixed && fixed[i] ? '' : classOf(ch, value.charCodeAt(i));
    if (cls === 'L') {
      let letter;
      if (nameLike) {
        if (run === 0) vowel = (next() & 7) === 0;
        const set = vowel ? VOWELS : CONSONANTS;
        letter = set[next() % set.length];
        vowel = !vowel;
        run++;
      } else {
        letter = String.fromCharCode(97 + (next() % 26));
      }
      out += isUpper(ch) ? letter.toUpperCase() : letter;
    } else {
      run = 0;
      out += cls === 'D' ? String.fromCharCode(48 + (next() % 10)) : ch;
    }
  }
  return out;
}

function hasReplaceable(value, fixed) {
  for (let i = 0; i < value.length; i++) {
    if (!(fixed && fixed[i]) && classOf(value[i], value.charCodeAt(i))) return true;
  }
  return false;
}

function pad(n, width) { return String(n).padStart(width, '0'); }

/**
 * Moves the date at the start of a value by `days`. Understands CCYYMMDD followed by anything
 * (a time, a zone) and a value of exactly six digits as YYMMDD. Returns null when the value does
 * not start with a real calendar date.
 */
function shiftDate(value, days) {
  let y;
  let m;
  let d;
  let width;
  if (/^\d{8}/.test(value)) {
    y = Number(value.slice(0, 4)); m = Number(value.slice(4, 6)); d = Number(value.slice(6, 8)); width = 8;
  } else if (/^\d{6}$/.test(value)) {
    y = 2000 + Number(value.slice(0, 2)); m = Number(value.slice(2, 4)); d = Number(value.slice(4, 6)); width = 6;
  } else {
    return null;
  }
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  date.setUTCDate(date.getUTCDate() + days);
  const ny = date.getUTCFullYear();
  if (ny < 1000 || ny > 9999) return null;
  const head = width === 8
    ? pad(ny, 4) + pad(date.getUTCMonth() + 1, 2) + pad(date.getUTCDate(), 2)
    : pad(ny % 100, 2) + pad(date.getUTCMonth() + 1, 2) + pad(date.getUTCDate(), 2);
  // A range of two dates (CCYYMMDD-CCYYMMDD): the second date moves by the same number of days.
  const rest = value.slice(width);
  if (width === 8 && /^-\d{8}$/.test(rest)) {
    const second = shiftDate(rest.slice(1), days);
    return second === null ? null : head + '-' + second;
  }
  return head + rest;
}

/**
 * Creates the value rewriter of one run. `seed` is the user's seed; without one a random seed is
 * drawn that exists only for this run. The rewriter keeps the table of originals and replacements
 * in memory (at most 100,000 entries; values beyond that are still rewritten the same way).
 */
function createRewriter(seed) {
  const key = typeof seed === 'string' && seed !== '' ? seed : crypto.randomBytes(32).toString('hex');
  const map = new Map();
  let overflow = false;
  const offsetBytes = crypto.createHmac('sha256', key).update('date-offset').digest();
  const dateShift = -(1 + (offsetBytes.readUInt32BE(0) % 365));

  function remember(kind, original, replacement) {
    if (original === replacement) return;
    const id = kind + '\u0000' + original;
    if (map.has(id)) return;
    if (map.size >= MAX_MAP_ENTRIES) { overflow = true; return; }
    map.set(id, { action: kind, original: original, replacement: replacement });
  }

  /**
   * Returns { value, note } where note is '' or 'not-a-date'. Spaces around a value (the padding
   * of a fixed-width field) are kept and are not part of the value: "ABC   " in an ISA and "ABC"
   * in a GS get the same replacement.
   */
  function rewrite(action, padded, ctx) {
    if (action === 'keep' || padded === '') return { value: padded, note: '' };
    if (action === 'blank') return { value: ctx.fixedWidth ? ' '.repeat(padded.length) : '', note: '' };
    const lead = /^ */.exec(padded)[0];
    const trail = lead.length === padded.length ? '' : / *$/.exec(padded)[0];
    if (lead.length + trail.length > 0) {
      const inner = padded.slice(lead.length, padded.length - trail.length);
      if (inner === '') return { value: padded, note: '' };
      const done = rewriteCore(action, inner, ctx);
      return { value: lead + done.value + trail, note: done.note };
    }
    return rewriteCore(action, padded, ctx);
  }

  function rewriteCore(action, value, ctx) {
    const fixed = fixedPositions(value, ctx.format, ctx.release, ctx.escape);
    if (action === 'mask') return { value: maskValue(value, fixed), note: '' };
    let kind = action;
    let note = '';
    if (action === 'fake-date') {
      const shifted = shiftDate(value, dateShift);
      if (shifted !== null) {
        remember('fake-date', value, shifted);
        return { value: shifted, note: '' };
      }
      kind = 'pseudonym';
      note = 'not-a-date';
    }
    const id = kind + '\u0000' + value;
    const known = map.get(id);
    if (known) return { value: known.replacement, note: note };
    let out = value;
    if (hasReplaceable(value, fixed)) {
      for (let attempt = 0; attempt < 4; attempt++) {
        out = scramble(value, fixed, byteStream(key, kind + ':' + attempt, value), kind === 'fake-name');
        if (out !== value) break;
      }
    }
    remember(kind, value, out);
    return { value: out, note: note };
  }

  return {
    rewrite: rewrite,
    dateShiftDays: dateShift,
    entries: function () { return Array.from(map.values()); },
    size: function () { return map.size; },
    overflowed: function () { return overflow; },
  };
}

// ---------------------------------------------------------------------------------------------
// Anonymising a text.

/**
 * Anonymises one text. `compiled` comes from compile(); options: seed (string, optional) or
 * rewriter (an existing one from createRewriter, to share replacements across several files).
 * Returns { ok: true, text, format, report, rewriter } or { ok: false, code, message }.
 * report: { format, segments, changed, changedBody, changedEnvelope, unchanged, protectedSkipped,
 * datesNotRecognised, rules: [{ format, path, action, source, count }] } with counts only.
 * changedBody counts the values replaced by profile and file rules; when it is 0 no rule matched
 * anything in the body and the text must not be passed on as anonymised.
 */
function anonymiseText(text, compiled, options) {
  const o = options || {};
  const source = typeof text === 'string' ? text : '';
  const rewriter = o.rewriter || createRewriter(o.seed);
  const counts = new Map();
  const report = { format: null, segments: 0, changed: 0, changedBody: 0, changedEnvelope: 0, unchanged: 0, protectedSkipped: 0, datesNotRecognised: 0, rules: [] };
  const parts = [];
  let chunks = [];
  let last = 0;
  let format = null;
  let rulesFor = null;
  // The HL7 escape character; every header segment (MSH, FHS, BHS) may define a new one.
  let escape = '\\';

  const detected = detectFormat(source);
  if (!detected) {
    return { ok: false, code: CODES.notEdi, message: 'The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message, so nothing was anonymised.' };
  }
  format = detected.format;
  rulesFor = compiled.byFormat[format];
  report.format = format;
  // The envelope ids alone are no reason to call a copy anonymised: a rule for the body is needed.
  const hasBodyRule = compiled.list.some(function (r) { return r.format === format && !r.envelope; });
  if (!rulesFor || rulesFor.size === 0 || !hasBodyRule) {
    return { ok: false, code: CODES.nothingToDo, message: 'No anonymise rule applies to ' + format + ' messages. Choose a built-in profile in the settings or add rules to the rule file.' };
  }

  const result = parseStream(source, { format: format }, function (segment) {
    report.segments++;
    if (format === 'hl7' && shared.HL7_HEADERS.indexOf(segment.id) !== -1 && segment.raw.length > 4) {
      const fieldEnd = segment.raw.indexOf(segment.raw[3], 4);
      const enc = segment.raw.slice(4, fieldEnd === -1 ? segment.raw.length : fieldEnd);
      escape = enc.charAt(2) || '\\';
    }
    const rules = rulesFor.get(segment.id);
    if (!rules) return;
    const delims = shared.segmentDelimiters(segment);
    const elements = readElements(segment);
    const isHeader = format === 'hl7' && shared.HL7_HEADERS.indexOf(segment.id) !== -1;
    // Collect the leaves of every matching rule; the first rule that covers a leaf wins.
    const taken = new Map();
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!shared.matchesSegment(r.sel, segment, elements)) continue;
      const found = shared.leaves(r.sel, elements);
      for (let k = 0; k < found.length; k++) {
        if (!taken.has(found[k].offset + ':' + found[k].end)) taken.set(found[k].offset + ':' + found[k].end, { leaf: found[k], rule: r });
      }
    }
    if (taken.size === 0) return;
    const ordered = Array.from(taken.values()).sort(function (a, b) { return a.leaf.offset - b.leaf.offset; });
    const ctx = {
      format: format,
      release: delims ? delims.release : '',
      escape: escape,
      fixedWidth: format === 'x12' && segment.id === 'ISA',
    };
    for (let i = 0; i < ordered.length; i++) {
      const leaf = ordered[i].leaf;
      const r = ordered[i].rule;
      if (leaf.raw === '' || r.action === 'keep') continue;
      if (leaf.offset < last) continue;
      if (isProtected(format, segment.id, leaf.element) || (isHeader && leaf.element <= 2)) {
        report.protectedSkipped++;
        continue;
      }
      const done = rewriter.rewrite(r.action, leaf.raw, ctx);
      if (done.note === 'not-a-date') report.datesNotRecognised++;
      if (done.value === leaf.raw) { report.unchanged++; continue; }
      chunks.push(source.slice(last, leaf.offset), done.value);
      last = leaf.end;
      report.changed++;
      if (r.envelope) report.changedEnvelope++;
      else report.changedBody++;
      counts.set(r, (counts.get(r) || 0) + 1);
      if (chunks.length > 40000) { parts.push(chunks.join('')); chunks = []; }
    }
  });
  chunks.push(source.slice(last));
  parts.push(chunks.join(''));
  compiled.list.forEach(function (r) {
    if (r.format === format) report.rules.push({ format: r.format, path: r.path, action: r.action, source: r.source, count: counts.get(r) || 0 });
  });
  report.syntaxIssues = result.issues.length;
  return { ok: true, text: parts.join(''), format: format, report: report, rewriter: rewriter };
}

const FORMAT_NAMES = { edifact: 'UN/EDIFACT', x12: 'ANSI X12', hl7: 'HL7 v2' };

function md(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\r\n|\r|\n/g, ' ').replace(/[\\`*_[\]<>|&~#]/g, '\\$&');
}

/**
 * Writes the report of one or more anonymised files as Markdown. `entries` is a list of
 * { label, report } (and, for files that were left out, { label, skipped: reason }). The report
 * lists counts per rule and never a value from a file. options: title, seeded (true when the
 * user gave a seed), mapSize.
 */
function toReport(entries, options) {
  const o = options || {};
  const lines = ['# ' + md(o.title || 'EDI Lens anonymise report'), ''];
  lines.push(o.seeded
    ? 'A seed was given: the same seed produces the same replacements in a later run.'
    : 'No seed was given: a random seed was used for this run only, so the replacements cannot be reproduced.');
  lines.push('This report lists counts only. It contains no value from the files.');
  lines.push('');
  const done = entries.filter(function (e) { return e.report && !e.unchanged; });
  const untouched = entries.filter(function (e) { return e.report && e.unchanged; });
  const skipped = entries.filter(function (e) { return !e.report; });
  const total = { changed: 0, protectedSkipped: 0, datesNotRecognised: 0 };
  done.forEach(function (e) {
    total.changed += e.report.changed;
    total.protectedSkipped += e.report.protectedSkipped;
    total.datesNotRecognised += e.report.datesNotRecognised;
  });
  lines.push('| Item | Count |', '| --- | ---: |');
  lines.push('| Files anonymised | ' + done.length + ' |');
  lines.push('| Files unchanged: no rule matched | ' + untouched.length + ' |');
  lines.push('| Files left out | ' + skipped.length + ' |');
  lines.push('| Values replaced | ' + total.changed + ' |');
  lines.push('| Protected envelope values left as they are | ' + total.protectedSkipped + ' |');
  lines.push('| Dates that were not recognised and were replaced like an identifier | ' + total.datesNotRecognised + ' |');
  if (typeof o.mapSize === 'number') lines.push('| Distinct original values in the replacement table (memory only) | ' + o.mapSize + ' |');
  lines.push('');
  done.forEach(function (e) {
    lines.push('## ' + md(e.label), '');
    lines.push((FORMAT_NAMES[e.report.format] || e.report.format) + ', ' + e.report.segments + ' segments, ' + e.report.changed + ' values replaced.', '');
    const used = e.report.rules.filter(function (r) { return r.count > 0; });
    if (used.length === 0) {
      lines.push('No rule matched a value in this file.', '');
      return;
    }
    lines.push('| Rule | Action | From | Values replaced |', '| --- | --- | --- | ---: |');
    used.forEach(function (r) { lines.push('| ' + md(r.path) + ' | ' + md(r.action) + ' | ' + md(r.source) + ' | ' + r.count + ' |'); });
    lines.push('');
  });
  if (untouched.length) {
    lines.push('## Unchanged: no rule matched', '');
    lines.push('No rule matched a value in the body of these files. They are NOT anonymised.', '');
    untouched.forEach(function (e) {
      lines.push('- ' + md(e.label) + ' (' + (FORMAT_NAMES[e.report.format] || e.report.format) + '): ' + (e.copied ? 'copied unchanged because the setting ediLens.anonymise.copyUnchanged is on' : 'nothing was written'));
    });
    lines.push('');
  }
  if (skipped.length) {
    lines.push('## Files left out', '');
    skipped.forEach(function (e) { lines.push('- ' + md(e.label) + ': ' + md(e.skipped)); });
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Writes the replacement table as CSV (action, original, replacement). This is the only function
 * that puts original values into text; it is called only for the explicit export.
 */
function mapToCsv(rewriter, neutralise) {
  const rows = ['action,original,replacement'];
  rewriter.entries().forEach(function (e) {
    rows.push([shared.csvField(e.action, neutralise), shared.csvField(e.original, neutralise), shared.csvField(e.replacement, neutralise)].join(','));
  });
  return rows.join('\r\n') + '\r\n';
}

module.exports = {
  CODES,
  ACTIONS,
  PROFILES,
  PROTECTED,
  ENVELOPE_IDS,
  loadRules,
  compile,
  createRewriter,
  anonymiseText,
  toReport,
  mapToCsv,
  shiftDate,
};
