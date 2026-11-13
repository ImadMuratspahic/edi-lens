'use strict';

/*
 * Envelope tools (Pro): split an interchange into single messages, merge messages into one
 * interchange, renumber control numbers and write a test acknowledgement.
 *
 * All four read the text segment by segment and keep only the envelope segments and the
 * positions of the messages, so memory use does not grow with the number of body segments. The
 * body of every message is copied unchanged from the source text.
 *
 * Every function returns { ok: true, ... } or { ok: false, code, message }. Nothing here uses
 * the editor API.
 */

const shared = require('./shared.js');
const { parseStream, readElements } = require('../core/parse.js');
const { detectFormat } = require('../core/detect.js');
const { parse } = require('../core/parse.js');
const { validate } = require('../core/validate.js');

const CODES = Object.freeze({
  notEdi: 'ENV-NOT-EDI',
  noMessages: 'ENV-NO-MESSAGES',
  badEnvelope: 'ENV-BAD-ENVELOPE',
  mixedFormats: 'ENV-MIXED-FORMATS',
  delimiterMismatch: 'ENV-DELIMITER-MISMATCH',
  mixedGroups: 'ENV-MIXED-GROUPS',
  nothingToAcknowledge: 'ENV-NOTHING-TO-ACK',
  numberTooLarge: 'ENV-NUMBER-TOO-LARGE',
  badStart: 'ENV-BAD-START',
});

const MAX_START = 999999999;
const MAX_UNITS = 200000;

function fail(code, message) { return { ok: false, code: code, message: message }; }

function pad(n, width) { return String(n).padStart(width, '0'); }

/** Checks a start value; returns the integer or null. */
function startValue(value) {
  const n = value === undefined || value === null || value === '' ? 1 : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_START ? n : null;
}

/**
 * Writes the number n in the style of an existing control number: an all-digit original keeps
 * its width (zero padded); otherwise the digits at the end of the original are replaced and the
 * text before them is kept; an original without digits at the end becomes the plain number.
 * Returns null when a fixed width cannot hold the number.
 */
function numberLike(original, n, fixedWidth) {
  const text = String(original === undefined || original === null ? '' : original).trim();
  const digits = String(n);
  if (fixedWidth) return digits.length > fixedWidth ? null : pad(n, fixedWidth);
  if (/^\d+$/.test(text)) return digits.length >= text.length ? digits : pad(n, text.length);
  const m = /^(.*?)(\d+)$/.exec(text);
  if (m) return m[1] + (digits.length >= m[2].length ? digits : pad(n, m[2].length));
  return digits;
}

/** A light copy of a segment that survives the stream: text positions and element texts. */
function keep(text, segment) {
  const elements = readElements(segment).map(function (el) {
    return { index: el.index, offset: el.offset - segment.offset, end: el.end - segment.offset, raw: el.raw, first: el.repetitions[0].components.map(function (c) { return c.raw; }) };
  });
  const d = shared.segmentDelimiters(segment);
  return {
    id: segment.id, offset: segment.offset, end: segment.end, raw: segment.raw, occurrence: segment.occurrence,
    term: shared.terminatorIn(text, segment), elements: elements,
    element: d ? d.element : '', component: d ? d.component : '', release: d ? d.release : '',
  };
}

function value(seg, e, c) {
  if (!seg) return '';
  const el = seg.elements[e - 1];
  if (!el) return '';
  if (!c) return el.raw.trim();
  return (el.first[c - 1] || '').trim();
}

function rawElement(seg, e) {
  const el = seg && seg.elements[e - 1];
  return el ? el.raw : '';
}

/**
 * Returns the raw text of a kept segment with some elements replaced: changes is
 * { elementNumber: newText }. An element beyond the last one is appended with the separators
 * it needs.
 */
function withElements(seg, changes) {
  const numbers = Object.keys(changes).map(Number).sort(function (a, b) { return a - b; });
  let out = '';
  let last = 0;
  const extra = [];
  numbers.forEach(function (n) {
    const el = seg.elements[n - 1];
    if (el) {
      out += seg.raw.slice(last, el.offset) + changes[n];
      last = el.end;
    } else {
      extra.push(n);
    }
  });
  out += seg.raw.slice(last);
  let have = seg.elements.length;
  extra.forEach(function (n) {
    while (have < n - 1) { out += seg.element; have++; }
    out += seg.element + changes[n];
    have = n;
  });
  return out;
}

/**
 * Reads the envelope structure of a text. Returns { ok, format, eol, gap, interchanges, units,
 * problems }. An interchange is { una, header, trailer, groups: [{ header, trailer, units }],
 * units (those outside a group) }; for HL7 there is one pseudo interchange whose units are the
 * messages. A unit is { header, trailer, start, end, bodyStart, bodyEnd, segments, type, ref,
 * sound } where sound means the message is closed and its count and reference agree.
 */
function readStructure(text) {
  const detected = detectFormat(text);
  if (!detected) return fail(CODES.notEdi, 'The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message.');
  const format = detected.format;
  const out = { ok: true, format: format, eol: '', gap: null, interchanges: [], units: 0, problems: [], hadBatch: false };
  let ic = null;
  let grp = null;
  let unit = null;
  let una = null;
  let previousEnd = -1;
  let tooMany = false;

  const names = format === 'edifact'
    ? { ic: 'UNB', icEnd: 'UNZ', grp: 'UNG', grpEnd: 'UNE', unit: 'UNH', unitEnd: 'UNT' }
    : format === 'x12'
      ? { ic: 'ISA', icEnd: 'IEA', grp: 'GS', grpEnd: 'GE', unit: 'ST', unitEnd: 'SE' }
      : { ic: '', icEnd: '', grp: '', grpEnd: '', unit: 'MSH', unitEnd: '' };

  function problem(text_) { if (out.problems.length < 20) out.problems.push(text_); }
  function closeUnit(endOffset) {
    if (!unit) return;
    if (!unit.trailer && format !== 'hl7') {
      unit.sound = false;
      unit.fault = 'missing';
      problem('Message ' + (unit.ref || '(no reference)') + ' opened by ' + names.unit + ' is not closed by ' + names.unitEnd + '.');
    }
    if (format === 'hl7') { unit.end = endOffset; unit.bodyEnd = endOffset; }
    unit = null;
  }
  function closeGroup() {
    closeUnit(previousEnd);
    if (grp && !grp.trailer) grp.fault = 'missing';
    if (grp && !grp.trailer) problem('Group ' + (value(grp.header, format === 'x12' ? 6 : 5) || '(no reference)') + ' is not closed by ' + names.grpEnd + '.');
    grp = null;
  }
  function closeInterchange() {
    closeGroup();
    if (ic && !ic.trailer && format !== 'hl7') ic.fault = 'missing';
    if (ic && !ic.trailer && format !== 'hl7') problem('The interchange is not closed by ' + names.icEnd + '.');
    ic = null;
  }

  parseStream(text, { format: format }, function (segment) {
    if (tooMany) return;
    const id = segment.id;
    if (out.gap === null && previousEnd >= 0) out.gap = text.slice(previousEnd, segment.offset);
    if (format === 'hl7') {
      if (!out.eol) out.eol = shared.terminatorIn(text, segment);
      if (id === 'MSH') {
        closeUnit(segment.offset);
        if (!ic) { ic = { una: null, header: null, trailer: null, groups: [], units: [] }; out.interchanges.push(ic); }
        const k = keep(text, segment);
        unit = { header: k, trailer: null, start: segment.offset, end: segment.end, bodyStart: segment.end, bodyEnd: segment.end, segments: 1, type: '', ref: value(k, 10), sound: true };
        unit.type = value(k, 9, 1) + (value(k, 9, 2) ? '^' + value(k, 9, 2) : '');
        if (value(k, 9) === '' || unit.ref === '') unit.sound = false;
        ic.units.push(unit);
        out.units++;
      } else if (id === 'BHS' || id === 'FHS' || id === 'BTS' || id === 'FTS') {
        out.hadBatch = true;
        closeUnit(segment.offset);
      } else if (unit) {
        unit.segments++;
      }
      previousEnd = segment.end;
      if (out.units > MAX_UNITS) tooMany = true;
      return;
    }
    if (id === 'UNA') {
      una = keep(text, segment);
    } else if (id === names.ic) {
      closeInterchange();
      ic = { una: una, header: keep(text, segment), trailer: null, groups: [], units: [] };
      una = null;
      out.interchanges.push(ic);
    } else if (id === names.icEnd) {
      closeGroup();
      if (ic) {
        const k = keep(text, segment);
        ic.trailer = k;
        // The trailer counts groups (X12, and EDIFACT with groups) or messages, and repeats the reference.
        const counted = ic.groups.length > 0 || format === 'x12' ? ic.groups.length : ic.units.length;
        const all = ic.units.length + ic.groups.reduce(function (sum, g) { return sum + g.units.length; }, 0);
        if (!sameCount(value(k, 1), counted) && !(format === 'edifact' && sameCount(value(k, 1), all))) ic.fault = 'count';
        else if (value(k, 2) !== value(ic.header, format === 'x12' ? 13 : 5)) ic.fault = 'control';
      } else problem(names.icEnd + ' has no matching ' + names.ic + '.');
      ic = null;
    } else if (id === names.grp) {
      closeGroup();
      if (!ic) problem(names.grp + ' appears outside an interchange.');
      else { grp = { header: keep(text, segment), trailer: null, units: [] }; ic.groups.push(grp); }
    } else if (id === names.grpEnd) {
      closeUnit(previousEnd);
      if (grp) {
        const k = keep(text, segment);
        grp.trailer = k;
        if (!sameCount(value(k, 1), grp.units.length)) grp.fault = 'count';
        else if (value(k, 2) !== value(grp.header, format === 'x12' ? 6 : 5)) grp.fault = 'control';
      } else problem(names.grpEnd + ' has no matching ' + names.grp + '.');
      grp = null;
    } else if (id === names.unit) {
      closeUnit(previousEnd);
      const k = keep(text, segment);
      unit = { header: k, trailer: null, start: segment.offset, end: segment.end, bodyStart: segment.end, bodyEnd: segment.end, segments: 1, type: '', ref: '', sound: true };
      if (format === 'edifact') { unit.type = value(k, 2, 1); unit.ref = value(k, 1); } else { unit.type = value(k, 1); unit.ref = value(k, 2); }
      if (!ic) problem(names.unit + ' appears outside an interchange.');
      else if (format === 'x12' && !grp) problem('ST appears outside a GS group.');
      else (grp ? grp.units : ic.units).push(unit);
      out.units++;
    } else if (id === names.unitEnd) {
      if (!unit) problem(names.unitEnd + ' has no matching ' + names.unit + '.');
      else {
        const k = keep(text, segment);
        unit.trailer = k;
        unit.segments++;
        unit.bodyEnd = segment.offset;
        unit.end = segment.end;
        if (!sameCount(value(k, 1), unit.segments)) { unit.sound = false; unit.fault = 'count'; } else if (value(k, 2) !== unit.ref || unit.ref === '') { unit.sound = false; unit.fault = 'control'; }
        unit = null;
      }
    } else if (unit) {
      unit.segments++;
    }
    previousEnd = segment.end;
    if (out.units > MAX_UNITS) tooMany = true;
  });
  if (format === 'hl7') closeUnit(previousEnd >= 0 ? previousEnd : text.length);
  else closeInterchange();
  if (tooMany) return fail(CODES.badEnvelope, 'The file holds more than ' + MAX_UNITS + ' messages; split it into smaller files first.');
  if (out.gap === null || /\S/.test(out.gap)) out.gap = '';
  if (format === 'hl7' && !out.eol) out.eol = '\r';
  return out;
}

/** True when a trailer count written as text is the number counted. */
function sameCount(text, counted) { return /^\d{1,12}$/.test(text) && Number(text) === counted; }

function requireSound(structure, action) {
  if (structure.units === 0) return fail(CODES.noMessages, 'No message (UNH, ST or MSH) was found, so there is nothing to ' + action + '.');
  if (structure.problems.length) {
    return fail(CODES.badEnvelope, 'The envelope of the file is damaged, so it was not changed: ' + structure.problems[0] + ' Run "EDI Lens: Validate Current File" and repair the problems first.');
  }
  return null;
}

/** The text of a message of a kept unit, from its header to its trailer and terminator. */
function unitText(text, unit) { return text.slice(unit.start, unit.end); }

/** Makes sure a piece of HL7 text ends with a line break. */
function closeLine(piece, eol) { return /[\r\n]$/.test(piece) ? piece : piece + eol; }

// ---------------------------------------------------------------------------------------------
// Split.

/**
 * Splits a text into one text per message. Each EDIFACT or X12 message is wrapped in a copy of
 * its own interchange (and group) header with a fresh control number and correct counts; an HL7
 * message stands on its own. options: start (first control number, default 1). Returns
 * { ok: true, format, parts: [{ number, type, ref, text }] }.
 */
function split(text, options) {
  const start = startValue(options && options.start);
  if (start === null) return fail(CODES.badStart, 'The start value must be a whole number from 1 to ' + MAX_START + '.');
  const s = readStructure(text);
  if (!s.ok) return s;
  const bad = requireSound(s, 'split');
  if (bad) return bad;
  const parts = [];
  let n = start;
  const gap = s.gap;
  for (const ic of s.interchanges) {
    if (s.format === 'hl7') {
      for (const u of ic.units) parts.push({ number: parts.length + 1, type: u.type, ref: u.ref, text: closeLine(unitText(text, u), s.eol) });
      continue;
    }
    const lists = ic.groups.map(function (g) { return { group: g, units: g.units }; });
    if (ic.units.length) lists.push({ group: null, units: ic.units });
    for (const list of lists) {
      for (const u of list.units) {
        const h = ic.header;
        const refElement = s.format === 'x12' ? 13 : 5;
        const ref = numberLike(value(h, refElement), n, s.format === 'x12' ? 9 : 0);
        if (ref === null) return fail(CODES.numberTooLarge, 'The control number ' + n + ' does not fit into the nine digits of ISA13. Choose a smaller start value.');
        let out = '';
        if (ic.una) out += ic.una.raw + ic.una.term + gap;
        const change = {};
        change[refElement] = ref;
        out += withElements(h, change) + h.term + gap;
        let gref = '';
        if (list.group) {
          const g = list.group.header;
          const ge = s.format === 'x12' ? 6 : 5;
          gref = numberLike(value(g, ge), n, 0);
          const gc = {};
          gc[ge] = gref;
          out += withElements(g, gc) + g.term + gap;
        }
        out += unitText(text, u) + gap;
        const el = h.element;
        if (list.group) out += (s.format === 'x12' ? 'GE' : 'UNE') + el + '1' + el + gref + h.term + gap;
        out += (s.format === 'x12' ? 'IEA' : 'UNZ') + el + '1' + el + ref + h.term + gap;
        parts.push({ number: parts.length + 1, type: u.type, ref: u.ref, text: out });
        n++;
        if (n > MAX_START) return fail(CODES.numberTooLarge, 'The control numbers ran past ' + MAX_START + '. Choose a smaller start value.');
      }
    }
  }
  return { ok: true, format: s.format, parts: parts };
}

// ---------------------------------------------------------------------------------------------
// Merge.

function sameDelimiters(a, b) {
  return a.element === b.element && a.component === b.component && a.release === b.release && a.term.charAt(0) === b.term.charAt(0);
}

/**
 * Merges the messages of several texts into one interchange. The interchange header is taken
 * from the first text; all texts must be in the same format and use the same delimiters. X12 and
 * grouped EDIFACT sources keep their groups. Message references are renumbered so that they are
 * unique; the interchange and group control numbers start at options.start (default 1). HL7
 * messages are wrapped in a batch (BHS ... BTS). Returns { ok: true, format, text, messages }.
 */
function merge(texts, options) {
  const start = startValue(options && options.start);
  if (start === null) return fail(CODES.badStart, 'The start value must be a whole number from 1 to ' + MAX_START + '.');
  if (!Array.isArray(texts) || texts.length === 0) return fail(CODES.noMessages, 'No files were given, so there is nothing to merge.');
  const structures = [];
  for (let i = 0; i < texts.length; i++) {
    const s = readStructure(texts[i]);
    if (!s.ok) return fail(s.code, 'File ' + (i + 1) + ': ' + s.message);
    const bad = requireSound(s, 'merge');
    if (bad) return fail(bad.code, 'File ' + (i + 1) + ': ' + bad.message);
    if (structures.length && s.format !== structures[0].format) {
      return fail(CODES.mixedFormats, 'File ' + (i + 1) + ' is in another format than file 1. Only messages of one format can be merged into one interchange.');
    }
    structures.push(s);
  }
  const format = structures[0].format;
  if (format === 'hl7') {
    const first = structures[0].interchanges[0].units[0].header;
    const eol = structures[0].eol;
    const f = first.raw.charAt(3);
    let out = 'BHS' + f + rawElement(first, 2);
    for (let e = 3; e <= 7; e++) out += f + rawElement(first, e);
    out += eol;
    let count = 0;
    structures.forEach(function (s, i) {
      s.interchanges.forEach(function (ic) {
        // The batch gets one line-end style, that of the first file.
        ic.units.forEach(function (u) { out += closeLine(unitText(texts[i], u), eol).replace(/\r\n|\r|\n/g, eol); count++; });
      });
    });
    out += 'BTS' + f + count + eol;
    return { ok: true, format: format, text: out, messages: count };
  }

  const base = structures[0].interchanges[0];
  const h = base.header;
  const gap = structures[0].gap;
  const grouped = format === 'x12' || base.groups.length > 0;
  const refElement = format === 'x12' ? 13 : 5;
  const ref = numberLike(value(h, refElement), start, format === 'x12' ? 9 : 0);
  if (ref === null) return fail(CODES.numberTooLarge, 'The control number ' + start + ' does not fit into the nine digits of ISA13. Choose a smaller start value.');
  const pieces = [];
  if (base.una) pieces.push(base.una.raw + base.una.term + gap);
  const change = {};
  change[refElement] = ref;
  pieces.push(withElements(h, change) + h.term + gap);
  const el = h.element;
  let messages = 0;
  let groups = 0;
  let unitNo = 0;

  function addUnit(source, u) {
    unitNo++;
    messages++;
    const he = format === 'x12' ? 2 : 1;
    const newRef = numberLike(u.ref, unitNo, 0);
    const hc = {};
    hc[he] = newRef;
    pieces.push(withElements(u.header, hc) + u.header.term + source.slice(u.bodyStart, u.bodyEnd) + withElements(u.trailer, { 2: newRef }) + u.trailer.term + gap);
  }

  for (let i = 0; i < structures.length; i++) {
    for (const ic of structures[i].interchanges) {
      if (!sameDelimiters(ic.header, h)) {
        return fail(CODES.delimiterMismatch, 'File ' + (i + 1) + ' uses other delimiters than file 1. Messages can only be merged when the element separator, the component separator, the release character and the segment terminator are the same.');
      }
      if (format === 'edifact' && ((ic.groups.length > 0) !== grouped || (grouped && ic.units.length > 0))) {
        return fail(CODES.mixedGroups, 'File ' + (i + 1) + ' mixes messages inside functional groups (UNG) with messages outside groups, compared with file 1. One interchange must use groups for all messages or for none.');
      }
      for (const g of ic.groups) {
        groups++;
        if (format === 'x12') unitNo = 0;
        const ge = format === 'x12' ? 6 : 5;
        const gref = numberLike(value(g.header, ge), start + groups - 1, 0);
        const gc = {};
        gc[ge] = gref;
        pieces.push(withElements(g.header, gc) + g.header.term + gap);
        for (const u of g.units) addUnit(texts[i], u);
        pieces.push((format === 'x12' ? 'GE' : 'UNE') + el + g.units.length + el + gref + h.term + gap);
      }
      for (const u of ic.units) addUnit(texts[i], u);
    }
  }
  pieces.push((format === 'x12' ? 'IEA' : 'UNZ') + el + (grouped ? groups : messages) + el + ref + h.term + gap);
  return { ok: true, format: format, text: pieces.join(''), messages: messages };
}

// ---------------------------------------------------------------------------------------------
// Renumber.

/** Segments that quote the control number of another message, with the level they refer to. */
const REFERENCES = {
  x12: { TA1: { element: 1, level: 'interchange' }, AK1: { element: 2, level: 'group' }, AK2: { element: 2, level: 'unit' } },
  edifact: { UCI: { element: 1, level: 'interchange' }, UCF: { element: 1, level: 'group' }, UCM: { element: 1, level: 'unit' } },
  hl7: { MSA: { element: 2, level: 'unit' } },
};

/**
 * Renumbers the control numbers of a text: interchanges and groups count up from options.start
 * (default 1) through the file; messages count up from the start value inside each group (X12)
 * or interchange (EDIFACT), HL7 control ids through the file. Each trailer gets the number of
 * its header; an ISA13 keeps its width. With keepReferences false, the references that acknowledgement segments in the
 * same file make to an old number (AK1, AK2, TA1, UCI, UCF, UCM, MSA) follow the new numbers;
 * by default they are left as they are. Returns { ok: true, format, text, changed }.
 */
function renumber(text, options) {
  const o = options || {};
  const start = startValue(o.start);
  if (start === null) return fail(CODES.badStart, 'The start value must be a whole number from 1 to ' + MAX_START + '.');
  const detected = detectFormat(text);
  if (!detected) return fail(CODES.notEdi, 'The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message.');
  const format = detected.format;
  const edits = [];
  const refSites = [];
  const maps = { interchange: new Map(), group: new Map(), unit: new Map() };
  const open = { interchange: null, group: null, unit: null };
  let icNo = start - 1;
  let grpNo = start - 1;
  let unitNo = start - 1;
  let overflow = false;
  let headers = 0;

  const layout = format === 'edifact'
    ? { UNB: ['interchange', 5, 0], UNG: ['group', 5, 0], UNH: ['unit', 1, 0], UNZ: ['interchange', 2], UNE: ['group', 2], UNT: ['unit', 2] }
    : format === 'x12'
      ? { ISA: ['interchange', 13, 9], GS: ['group', 6, 0], ST: ['unit', 2, 0], IEA: ['interchange', 2], GE: ['group', 2], SE: ['unit', 2] }
      : { MSH: ['unit', 10, 0] };
  const refs = REFERENCES[format];

  parseStream(text, { format: format }, function (segment) {
    const spec = layout[segment.id];
    const refSpec = refs[segment.id];
    if (!spec && !refSpec) return;
    const elements = readElements(segment);
    if (refSpec) {
      const el = elements[refSpec.element - 1];
      if (el && el.raw.trim() !== '') refSites.push({ offset: el.offset, end: el.end, old: el.raw.trim(), level: refSpec.level });
      return;
    }
    const level = spec[0];
    const el = elements[spec[1] - 1];
    if (spec.length === 3) {
      // A header: draw the next number of its level.
      let n;
      if (level === 'interchange') { n = ++icNo; if (format !== 'hl7') unitNo = start - 1; } else if (level === 'group') { n = ++grpNo; if (format === 'x12') unitNo = start - 1; } else n = ++unitNo;
      if (!el) { open[level] = null; return; }
      headers++;
      // ISA13 sits in a fixed-width header: the new number takes exactly the room of the old one,
      // and an empty ISA13 is left for validation to report.
      if (spec[2] && el.raw === '') { open[level] = null; return; }
      const fresh = numberLike(el.raw, n, spec[2] ? el.raw.length : 0);
      if (fresh === null || n > MAX_START) { overflow = true; return; }
      const old = el.raw.trim();
      if (old !== '' && !maps[level].has(old)) maps[level].set(old, fresh);
      open[level] = fresh;
      if (fresh !== el.raw) edits.push({ offset: el.offset, end: el.end, value: fresh });
    } else {
      // A trailer: repeat the number of the header that is open at its level.
      const fresh = open[level];
      open[level] = null;
      if (fresh === null || !el) return;
      if (fresh !== el.raw) edits.push({ offset: el.offset, end: el.end, value: fresh });
    }
  });
  if (overflow) {
    return fail(CODES.numberTooLarge, format === 'x12'
      ? 'A control number became too large for its field (ISA13 holds nine digits). Choose a smaller start value.'
      : 'The control numbers ran past ' + MAX_START + '. Choose a smaller start value.');
  }
  if (headers === 0) return fail(CODES.noMessages, 'No envelope segment with a control number was found, so nothing was renumbered.');
  if (o.keepReferences === false) {
    refSites.forEach(function (site) {
      const fresh = maps[site.level].get(site.old);
      if (fresh !== undefined && fresh !== site.old) edits.push({ offset: site.offset, end: site.end, value: fresh });
    });
  }
  edits.sort(function (a, b) { return a.offset - b.offset; });
  const parts = [];
  let chunks = [];
  let last = 0;
  for (const e of edits) {
    if (e.offset < last) continue;
    chunks.push(text.slice(last, e.offset), e.value);
    last = e.end;
    if (chunks.length > 40000) { parts.push(chunks.join('')); chunks = []; }
  }
  chunks.push(text.slice(last));
  parts.push(chunks.join(''));
  return { ok: true, format: format, text: parts.join(''), changed: edits.length };
}

// ---------------------------------------------------------------------------------------------
// Acknowledgement.

function stamp(now) {
  const d = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  const yyyy = pad(d.getFullYear(), 4);
  const rest = pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2);
  return { ccyymmdd: yyyy + rest, yymmdd: yyyy.slice(2) + rest, hhmm: pad(d.getHours(), 2) + pad(d.getMinutes(), 2), ss: pad(d.getSeconds(), 2) };
}

/**
 * Writes a basic test acknowledgement for a text: an X12 997 (or 999 with options.x12Type
 * '999'), an EDIFACT CONTRL or HL7 ACK messages. Sender and receiver are swapped, the control
 * numbers of the source are quoted, and a message is reported as accepted when it is closed and
 * its count and reference agree, otherwise as rejected (with the code of what was wrong). A
 * group or interchange whose own trailer is missing or wrong is never reported as accepted. The
 * result is marked as a test: ISA15 is
 * T, the UNB test indicator is 1, MSH-11 is T. options: start (control number, default 1), now
 * (a Date), x12Type. Returns { ok: true, format, kind, text, acknowledged, accepted, rejected }.
 */
function acknowledge(text, options) {
  const o = options || {};
  const start = startValue(o.start);
  if (start === null) return fail(CODES.badStart, 'The start value must be a whole number from 1 to ' + MAX_START + '.');
  const s = readStructure(text);
  if (!s.ok) return s;
  if (s.units === 0) return fail(CODES.noMessages, 'No message (UNH, ST or MSH) was found, so there is nothing to acknowledge.');
  if (s.format !== 'hl7' && s.interchanges.length === 0) {
    return fail(CODES.badEnvelope, 'The file has no interchange header (' + (s.format === 'x12' ? 'ISA' : 'UNB') + '), so there is nothing an acknowledgement could refer to. ' + (s.problems[0] || ''));
  }
  const result = buildAcknowledgement(text, s, start, o);
  if (!result.ok) return result;
  // The acknowledgement is built from the header of the source. When that header is damaged the
  // result would carry the damage, so it is checked before it is handed out.
  const broken = validate(parse(result.text), { includeParseIssues: true, maxIssues: 5 }).filter(function (i) { return i.severity === 'error' || i.severity === 'warning'; });
  if (broken.length) {
    return fail(CODES.badEnvelope, 'The header of the source (' + (s.format === 'x12' ? 'ISA' : s.format === 'edifact' ? 'UNB' : 'MSH') + ') is damaged, so no valid acknowledgement can be written for it. Run "EDI Lens: Validate Current File" and repair the header first.');
  }
  return result;
}

/** What MSH-12 of an acknowledgement may hold: a version number such as 2.5 or 2.5.1. */
const HL7_VERSION = /^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/;

/** The codes a 997 or 999 gives for a faulty transaction set (AK5/IK5) and group (AK9). */
const SET_FAULT = { missing: '2', control: '3', count: '4' };
const GROUP_FAULT = { missing: '3', control: '4', count: '5' };

function buildAcknowledgement(text, s, start, o) {
  const t = stamp(o.now);
  const gap = s.gap;
  let accepted = 0;
  let rejected = 0;
  const tally = function (ok) { if (ok) accepted++; else rejected++; return ok; };
  const out = [];

  if (s.format === 'hl7') {
    let n = start;
    for (const u of s.interchanges[0].units) {
      if (u.type.split('^')[0] === 'ACK') continue;
      const h = u.header;
      const f = h.raw.charAt(3);
      const enc = rawElement(h, 2);
      const c = enc.charAt(0) || '^';
      const trigger = value(h, 9, 2);
      const type = trigger ? 'ACK' + c + trigger + c + 'ACK' : 'ACK';
      // The version is quoted from MSH-12 of the source. An empty field gets the default; a field
      // that holds something else than a version number (a damaged header, for example one that
      // ran into the next line) cannot be quoted in a valid acknowledgement.
      let version = '2.5';
      if (rawElement(h, 12).trim() !== '') {
        version = value(h, 12, 1);
        if (!HL7_VERSION.test(version)) {
          return fail(CODES.badEnvelope, 'MSH-12 (version id) of the source does not hold a version number such as 2.5, so no valid acknowledgement can be written for it. Run "EDI Lens: Validate Current File" and repair the header first.');
        }
      }
      const ok = tally(u.sound);
      out.push(['MSH', enc, rawElement(h, 5), rawElement(h, 6), rawElement(h, 3), rawElement(h, 4), t.ccyymmdd + t.hhmm + t.ss, '', type, 'ACK' + pad(n, 9), 'T', version].join(f) + s.eol);
      out.push(['MSA', ok ? 'AA' : 'AE', u.ref, 'TEST ACKNOWLEDGEMENT'].join(f) + s.eol);
      n++;
    }
    if (out.length === 0) return fail(CODES.nothingToAcknowledge, 'The file holds only acknowledgements (ACK), which are not acknowledged again.');
    return { ok: true, format: 'hl7', kind: 'ACK', text: out.join(''), acknowledged: accepted + rejected, accepted: accepted, rejected: rejected };
  }

  if (s.format === 'x12') {
    const use999 = String(o.x12Type) === '999';
    let groupFaults = 0;
    let n = start;
    for (const ic of s.interchanges) {
      const groups = ic.groups.filter(function (g) { return value(g.header, 1) !== 'FA'; });
      if (groups.length === 0) continue;
      // A 997 or 999 reports on groups and transaction sets; it has no place for a fault of the
      // interchange itself, so such a file is not acknowledged at all.
      if (ic.fault) {
        return fail(CODES.badEnvelope, 'The interchange ' + (value(ic.header, 13) || '(no control number)') + ' is not closed correctly: IEA is ' +
          (ic.fault === 'missing' ? 'missing' : ic.fault === 'count' ? 'there, but its group count is wrong' : 'there, but its control number differs from ISA13') +
          '. An acknowledgement of groups and transaction sets cannot report that, so none was written. Repair the interchange first.');
      }
      const h = ic.header;
      const el = h.element;
      const term = h.term;
      const isa13 = numberLike('', n, 9);
      if (isa13 === null) return fail(CODES.numberTooLarge, 'The control number ' + n + ' does not fit into the nine digits of ISA13. Choose a smaller start value.');
      out.push(withElements(h, { 5: rawElement(h, 7), 6: rawElement(h, 8), 7: rawElement(h, 5), 8: rawElement(h, 6), 9: t.yymmdd, 10: t.hhmm, 13: isa13, 14: '0', 15: 'T' }) + term + gap);
      const g0 = groups[0].header;
      const version = use999 ? '005010X231A1' : (value(g0, 8).slice(0, 6) || '004010');
      const date = value(g0, 4).length === 6 ? t.yymmdd : t.ccyymmdd;
      out.push(['GS', 'FA', rawElement(g0, 3), rawElement(g0, 2), date, t.hhmm, String(n), value(g0, 7) || 'X', version].join(el) + term + gap);
      let sets = 0;
      for (const g of groups) {
        sets++;
        const st = pad(sets, 4);
        const lines = [];
        lines.push(use999 ? ['ST', '999', st, '005010X231A1'] : ['ST', '997', st]);
        lines.push(use999 ? ['AK1', value(g.header, 1), value(g.header, 6), value(g.header, 8)] : ['AK1', value(g.header, 1), value(g.header, 6)]);
        let ok = 0;
        for (const u of g.units) {
          const good = tally(u.sound);
          if (good) ok++;
          const st3 = value(u.header, 3);
          lines.push(use999 && st3 ? ['AK2', u.type, u.ref, st3] : ['AK2', u.type, u.ref]);
          lines.push(good ? [use999 ? 'IK5' : 'AK5', 'A'] : [use999 ? 'IK5' : 'AK5', 'R', SET_FAULT[u.fault] || '5']);
        }
        const declared = g.trailer && /^\d+$/.test(value(g.trailer, 1)) ? value(g.trailer, 1) : String(g.units.length);
        // A group whose own trailer is wrong is never plainly accepted: E (accepted, errors noted)
        // when transaction sets were accepted, R otherwise, with the code of the fault.
        if (g.fault) lines.push(['AK9', ok === 0 ? 'R' : 'E', declared, String(g.units.length), String(ok), GROUP_FAULT[g.fault]]);
        else lines.push(['AK9', ok === g.units.length ? 'A' : ok === 0 ? 'R' : 'P', declared, String(g.units.length), String(ok)]);
        if (g.fault) groupFaults++;
        lines.push(['SE', String(lines.length + 1), st]);
        lines.forEach(function (line) { out.push(line.join(el) + term + gap); });
      }
      out.push(['GE', String(sets), String(n)].join(el) + term + gap);
      out.push(['IEA', '1', isa13].join(el) + term + gap);
      n++;
    }
    if (out.length === 0) return fail(CODES.nothingToAcknowledge, 'The file holds only functional acknowledgements (group FA), which are not acknowledged again.');
    return { ok: true, format: 'x12', kind: use999 ? '999' : '997', text: out.join(''), acknowledged: accepted + rejected, accepted: accepted, rejected: rejected, envelopeFaults: groupFaults };
  }

  let n = start;
  let envelopeFaults = 0;
  for (const ic of s.interchanges) {
    const isControl = function (u) { return u.type === 'CONTRL'; };
    const all = ic.units.concat.apply(ic.units, ic.groups.map(function (g) { return g.units; }));
    if (all.length === 0 || all.every(isControl)) continue;
    const h = ic.header;
    // An acknowledgement names the sender, the recipient and the control reference of the source.
    if (value(h, 2) === '' || value(h, 3) === '' || value(h, 5) === '') {
      return fail(CODES.badEnvelope, 'The interchange header (UNB) has no ' + (value(h, 5) === '' ? 'control reference' : value(h, 2) === '' ? 'sender' : 'recipient') + ', so there is nothing an acknowledgement could refer to. Repair the header first.');
    }
    const el = h.element;
    const c = h.component || ':';
    const term = h.term;
    const ref = numberLike(value(h, 5), n, 0);
    // An interchange whose trailer is missing or disagrees with the header is rejected as a whole.
    const closed = !ic.fault;
    if (ic.fault) envelopeFaults++;
    // The date has the width the source uses: eight digits from syntax version 4 on, six before.
    const date = /^\d{8}$/.test(value(h, 4, 1)) ? t.ccyymmdd : t.yymmdd;
    if (ic.una) out.push(ic.una.raw + ic.una.term + gap);
    out.push(['UNB', rawElement(h, 1), rawElement(h, 3), rawElement(h, 2), date + c + t.hhmm, ref, '', '', '', '', '', '1'].join(el) + term + gap);
    const lines = [];
    lines.push(['UNH', '1', ['CONTRL', 'D', '3', 'UN'].join(c)]);
    lines.push(['UCI', rawElement(h, 5), rawElement(h, 2), rawElement(h, 3), closed ? '7' : '4']);
    const addUnits = function (units) {
      units.forEach(function (u) {
        if (isControl(u)) return;
        lines.push(['UCM', rawElement(u.header, 1), rawElement(u.header, 2), tally(u.sound) ? '7' : '4']);
      });
    };
    if (closed) {
      addUnits(ic.units);
      ic.groups.forEach(function (g) {
        if (g.units.every(isControl)) return;
        // A group whose trailer is wrong is rejected with everything in it.
        if (g.fault) {
          envelopeFaults++;
          lines.push(['UCF', rawElement(g.header, 5), rawElement(g.header, 2), rawElement(g.header, 3), '4']);
          g.units.forEach(function (u) { if (!isControl(u)) tally(false); });
          return;
        }
        lines.push(['UCF', rawElement(g.header, 5), rawElement(g.header, 2), rawElement(g.header, 3), '7']);
        addUnits(g.units);
      });
    } else {
      all.forEach(function (u) { if (!isControl(u)) tally(false); });
    }
    lines.push(['UNT', String(lines.length + 1), '1']);
    lines.forEach(function (line) { out.push(line.join(el) + term + gap); });
    out.push(['UNZ', '1', ref].join(el) + term + gap);
    n++;
  }
  if (out.length === 0) return fail(CODES.nothingToAcknowledge, 'The file holds only CONTRL messages, which are not acknowledged again.');
  return { ok: true, format: 'edifact', kind: 'CONTRL', text: out.join(''), acknowledged: accepted + rejected, accepted: accepted, rejected: rejected, envelopeFaults: envelopeFaults };
}

module.exports = { CODES, split, merge, renumber, acknowledge, readStructure, numberLike };
