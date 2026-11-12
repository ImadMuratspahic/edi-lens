'use strict';

/*
 * Helpers shared by the Pro tools that read messages segment by segment: anonymise, partner
 * rules, query and the envelope tools.
 *
 * Selectors. A selector names a kind of segment and, optionally, a value inside it:
 *
 *   SEG                 every segment with that id                    NAD
 *   SEG[Q]              ... whose first element starts with Q         NAD[BY]   NM1[IL]   DTM[137]
 *   SEG[A|B]            ... one of several qualifiers                 NM1[IL|QC]
 *   SEG[n=Q]            ... whose element n equals Q                  OBX[3=GLU]  HL[3=22]
 *   SEG[n.m=Q]          ... whose element n, component m equals Q     OBX[3.1=2345-7]
 *   SEG#k               the k-th such segment of the message          LIN#2
 *   ...-e               element e                                     PID-5
 *   ...-e.c             component c of element e                      NAD[BY]-3.1
 *   ...-e.c.s           subcomponent s (HL7)                          PID-3.4.2
 *   ...-e(r)...         only repetition r of the element              PID-13(2).1
 *
 * A qualifier may contain * as a wildcard. Note the difference to the paths shown by hovers:
 * there the number in brackets counts occurrences (NAD[2] is the second NAD of the file); in a
 * selector the brackets always hold a qualifier value, and #k counts.
 *
 * Nothing here uses the editor API.
 */

const { parseStream, readElements, segmentDelimiters } = require('../core/parse.js');
const { detectFormat } = require('../core/detect.js');

const SELECTOR = /^([A-Za-z][A-Za-z0-9]{1,2})(?:#(\d{1,9}))?(?:\[([^\]]*)\])?(?:-(\d{1,4})(?:\((\d{1,4})\))?(?:\.(\d{1,4})(?:\.(\d{1,4}))?)?)?$/;
/** The same shape without anchors, for finding a selector inside a longer text. */
const SELECTOR_AT = /([A-Za-z][A-Za-z0-9]{1,2})(?:#\d{1,9})?(?:\[[^\]]*\])?(?:-\d{1,4}(?:\(\d{1,4}\))?(?:\.\d{1,4}(?:\.\d{1,4})?)?)?/y;

/** Ids of the segments that carry the HL7 delimiters in their first two fields. */
const HL7_HEADERS = ['MSH', 'FHS', 'BHS'];

/**
 * Matches text against a pattern in which * stands for any run of characters. Runs in time
 * proportional to text length times pattern length at worst; no regular expression is built.
 */
function globMatch(pattern, text) {
  if (pattern.indexOf('*') === -1) return pattern === text;
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Parses a selector. Returns { ok: true, text, id, occurrence, qualifier, element, repetition,
 * component, sub } (numbers are 1-based, 0 when not given; qualifier is null or { element,
 * component, values }) or { ok: false, error }.
 */
function parseSelector(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  const m = SELECTOR.exec(text);
  if (!m) {
    return { ok: false, error: 'not a selector (expected for example NAD, NAD[BY]-3.1 or PID-5)' };
  }
  let qualifier = null;
  if (m[3] !== undefined) {
    const q = /^(?:(\d{1,4})(?:\.(\d{1,4}))?=)?(.*)$/.exec(m[3]);
    const values = q[3].split('|').map(function (v) { return v.trim(); });
    if (values.some(function (v) { return v === ''; })) {
      return { ok: false, error: 'the qualifier in brackets is empty' };
    }
    qualifier = { element: q[1] ? Number(q[1]) : 1, component: q[2] ? Number(q[2]) : 1, values: values };
    if (qualifier.element < 1 || qualifier.component < 1) return { ok: false, error: 'element and component numbers start at 1' };
  }
  const sel = {
    ok: true,
    text: text,
    id: m[1],
    occurrence: m[2] ? Number(m[2]) : 0,
    qualifier: qualifier,
    element: m[4] ? Number(m[4]) : 0,
    repetition: m[5] ? Number(m[5]) : 0,
    component: m[6] ? Number(m[6]) : 0,
    sub: m[7] ? Number(m[7]) : 0,
  };
  if ((m[2] && sel.occurrence < 1) || (m[4] && sel.element < 1) || (m[5] && sel.repetition < 1) || (m[6] && sel.component < 1) || (m[7] && sel.sub < 1)) {
    return { ok: false, error: 'numbers in a selector start at 1' };
  }
  return sel;
}

/** Trimmed raw text of component c (first repetition) of element e, or '' when absent. */
function componentText(elements, e, c) {
  const el = elements[e - 1];
  if (!el) return '';
  const comp = el.repetitions[0].components[c - 1];
  return comp ? comp.raw.trim() : '';
}

/** True when the segment (with its element list) has the id and qualifier of the selector. */
function matchesSegment(sel, segment, elements) {
  if (segment.id !== sel.id) return false;
  const q = sel.qualifier;
  if (!q) return true;
  const value = componentText(elements, q.element, q.component);
  for (let i = 0; i < q.values.length; i++) {
    if (globMatch(q.values[i], value)) return true;
  }
  return false;
}

/**
 * Returns the pieces of a segment that a selector with an element part points at:
 * [{ offset, end, raw, element, repetition, component, sub }] (component and sub are 0 when the
 * piece is a whole element or repetition). Without a component the whole element is one piece
 * (or the one repetition named); with a component there is one piece per repetition.
 */
function targets(sel, elements) {
  const out = [];
  if (!sel.element) return out;
  const el = elements[sel.element - 1];
  if (!el) return out;
  if (!sel.component) {
    if (!sel.repetition) {
      out.push({ offset: el.offset, end: el.end, raw: el.raw, element: el.index, repetition: 0, component: 0, sub: 0 });
      return out;
    }
    const rep = el.repetitions[sel.repetition - 1];
    if (rep) {
      const first = rep.components[0];
      const last = rep.components[rep.components.length - 1];
      out.push({ offset: first.offset, end: last.end, raw: el.raw.slice(first.offset - el.offset, last.end - el.offset), element: el.index, repetition: sel.repetition, component: 0, sub: 0 });
    }
    return out;
  }
  for (let r = 0; r < el.repetitions.length; r++) {
    if (sel.repetition && sel.repetition !== r + 1) continue;
    const comp = el.repetitions[r].components[sel.component - 1];
    if (!comp) continue;
    const repNo = el.repetitions.length > 1 ? r + 1 : 0;
    if (!sel.sub) {
      out.push({ offset: comp.offset, end: comp.end, raw: comp.raw, element: el.index, repetition: repNo, component: comp.index, sub: 0 });
    } else {
      const sub = comp.subcomponents[sel.sub - 1];
      if (sub) out.push({ offset: sub.offset, end: sub.end, raw: sub.raw, element: el.index, repetition: repNo, component: comp.index, sub: sub.index });
    }
  }
  return out;
}

/**
 * Returns the smallest pieces (subcomponents) that a selector covers, in text order:
 * [{ offset, end, raw, element }]. Used where each value is rewritten on its own so that every
 * delimiter stays in place.
 */
function leaves(sel, elements) {
  const out = [];
  if (!sel.element) return out;
  const el = elements[sel.element - 1];
  if (!el) return out;
  for (let r = 0; r < el.repetitions.length; r++) {
    if (sel.repetition && sel.repetition !== r + 1) continue;
    const comps = el.repetitions[r].components;
    for (let c = 0; c < comps.length; c++) {
      if (sel.component && sel.component !== c + 1) continue;
      const subs = comps[c].subcomponents;
      for (let s = 0; s < subs.length; s++) {
        if (sel.sub && sel.sub !== s + 1) continue;
        out.push({ offset: subs[s].offset, end: subs[s].end, raw: subs[s].raw, element: el.index });
      }
    }
  }
  return out;
}

/** Writes the hover-style path of a piece: NAD[2]-3.1 (the bracket counts occurrences). */
function concretePath(segment, piece) {
  let path = segment.id + '[' + segment.occurrence + ']';
  if (!piece || !piece.element) return path;
  path += '-' + piece.element;
  if (piece.repetition) path += '(' + piece.repetition + ')';
  if (piece.component) path += '.' + piece.component;
  if (piece.sub) path += '.' + piece.sub;
  return path;
}

/**
 * Creates a converter from text offsets to 0-based { line, column }, with CR, LF and CRLF as
 * line breaks (as in the editor). It is fastest when the offsets do not decrease.
 */
function makePositioner(text) {
  let pos = 0;
  let line = 0;
  let lineStart = 0;
  return function at(offset) {
    const target = Math.max(0, Math.min(offset, text.length));
    if (target < pos) {
      pos = 0;
      line = 0;
      lineStart = 0;
    }
    while (pos < target) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        line++;
        lineStart = pos + 1;
      } else if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          // An offset between the two characters of a CRLF belongs to the end of the line.
          if (pos + 1 >= target) return { line: line, column: pos - lineStart };
          pos++;
        }
        line++;
        lineStart = pos + 1;
      }
      pos++;
    }
    return { line: line, column: Math.max(0, target - lineStart) };
  };
}

/** Parses a decimal number written with a point or a comma; returns NaN for anything else. */
function toNumber(value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(s)) return NaN;
  return Number(s.replace(',', '.'));
}

/*
 * Exact decimals. Identifiers in EDI are often long digit strings (an 18-digit container code,
 * a 13-digit location number), and amounts must add up to the cent. Binary floating point
 * cannot hold either, so numbers are kept as an integer with a scale and compared digit by
 * digit. 0012 equals 12 and 1.50 equals 1.5; nothing is ever rounded.
 */

const DECIMAL = /^([+-]?)(\d*)(?:[.,](\d*))?$/;

/**
 * Reads a decimal number written with a point or a comma (at most 400 digits). Returns
 * { n, scale } with the value n / 10^scale, or null for anything that is not a plain decimal.
 * Numbers (not strings) are accepted when they are finite and need no exponent.
 */
function parseDecimal(value) {
  if (value && typeof value === 'object' && typeof value.n === 'bigint') return value;
  let text = typeof value === 'number' ? (isFinite(value) ? String(value) : '') : String(value === undefined || value === null ? '' : value).trim();
  if (text === '' || text.length > 400) return null;
  const m = DECIMAL.exec(text);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return null;
  const fraction = (m[3] || '').replace(/0+$/, '');
  let n = BigInt((m[2] || '0') + fraction);
  if (m[1] === '-') n = -n;
  return { n: n, scale: fraction.length };
}

function scaled(d, scale) { return d.scale === scale ? d.n : d.n * (10n ** BigInt(scale - d.scale)); }

/** Compares two decimals exactly: -1, 0 or 1. Returns null when one side is no decimal. */
function compareDecimal(a, b) {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (!x || !y) return null;
  const scale = Math.max(x.scale, y.scale);
  const p = scaled(x, scale);
  const q = scaled(y, scale);
  return p < q ? -1 : p > q ? 1 : 0;
}

/** Adds two decimals exactly. */
function addDecimal(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return { n: scaled(a, scale) + scaled(b, scale), scale: scale };
}

/** True when the two decimals differ by at most the (non-negative) decimal tolerance. */
function withinDecimal(a, b, tolerance) {
  const scale = Math.max(a.scale, b.scale, tolerance.scale);
  let diff = scaled(a, scale) - scaled(b, scale);
  if (diff < 0n) diff = -diff;
  return diff <= scaled(tolerance, scale);
}

/** Writes a decimal without needless zeros: 4094.4, 12, -0.5. */
function formatDecimal(d) {
  const negative = d.n < 0n;
  let digits = (negative ? -d.n : d.n).toString();
  if (d.scale > 0) {
    digits = digits.padStart(d.scale + 1, '0');
    digits = digits.slice(0, digits.length - d.scale) + '.' + digits.slice(digits.length - d.scale);
    digits = digits.replace(/0+$/, '').replace(/\.$/, '');
  }
  return (negative && digits !== '0' ? '-' : '') + digits;
}

/** The message type of a header segment: ORDERS (UNH), 850 (ST), ADT^A01 (MSH). */
function unitType(format, elements) {
  if (format === 'edifact') return componentText(elements, 2, 1);
  if (format === 'x12') return componentText(elements, 1, 1);
  const a = componentText(elements, 9, 1);
  const b = componentText(elements, 9, 2);
  return b ? a + '^' + b : a;
}

/** The control reference of a header segment: UNH-1, ST02, MSH-10. */
function unitRef(format, elements) {
  if (format === 'edifact') return componentText(elements, 1, 1);
  if (format === 'x12') return componentText(elements, 2, 1);
  const el = elements[9];
  return el ? el.raw.trim() : '';
}

const UNIT_RULES = {
  edifact: { open: 'UNH', close: 'UNT', stop: ['UNE', 'UNZ', 'UNB', 'UNG', 'UNA'] },
  x12: { open: 'ST', close: 'SE', stop: ['GE', 'IEA', 'ISA', 'GS'] },
  hl7: { open: 'MSH', close: '', stop: ['BHS', 'BTS', 'FHS', 'FTS'] },
};

/**
 * Reads a text segment by segment and reports the messages in it: UNH to UNT, ST to SE, or an
 * MSH with the segments that follow it. handlers: onUnitStart(unit, segment, elements),
 * onSegment(unit, segment, getElements) for every segment inside a message (the header and the
 * trailer included), onOutside(segment, getElements) for envelope segments, onUnitEnd(unit).
 * unit is { index (from 1), type, ref, offset, line, column, header }. getElements() builds the
 * elements of that one segment without keeping them. Returns { ok, format, delimiters, issues,
 * count, units } or { ok: false } when the text is not one of the three formats.
 */
function walkUnits(text, handlers) {
  const detected = detectFormat(text);
  if (!detected) return { ok: false, format: null, units: 0, count: 0 };
  const format = detected.format;
  const rule = UNIT_RULES[format];
  const h = handlers || {};
  const at = makePositioner(text);
  let unit = null;
  let units = 0;
  let stopped = false;

  function end() {
    if (unit && h.onUnitEnd) h.onUnitEnd(unit);
    unit = null;
  }

  const result = parseStream(text, { format: format }, function (segment) {
    if (stopped) return;
    let cached = null;
    const getElements = function () {
      if (!cached) cached = readElements(segment);
      return cached;
    };
    const id = segment.id;
    if (id === rule.open) {
      end();
      units++;
      const p = at(segment.offset);
      const elements = getElements();
      unit = { index: units, type: unitType(format, elements), ref: unitRef(format, elements), offset: segment.offset, line: p.line, column: p.column, header: segment };
      if (h.onUnitStart && h.onUnitStart(unit, segment, elements) === false) stopped = true;
    } else if (unit && rule.stop.indexOf(id) !== -1) {
      end();
    }
    if (stopped) return;
    if (unit) {
      if (h.onSegment && h.onSegment(unit, segment, getElements) === false) stopped = true;
      if (rule.close && id === rule.close) end();
    } else if (h.onOutside) {
      if (h.onOutside(segment, getElements) === false) stopped = true;
    }
  });
  if (!stopped) end();
  return { ok: true, format: format, delimiters: result.delimiters, issues: result.issues, count: result.count, units: units, stopped: stopped };
}

/** The terminator text that followed a segment in its source text. */
function terminatorIn(text, segment) {
  return text.slice(segment.offset + segment.raw.length, segment.end);
}

/** Escapes text for use inside HTML. */
function htmlEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Quotes one CSV field. A value that a spreadsheet could read as a formula (it starts with =, +,
 * -, @, a tab or a carriage return) gets a leading apostrophe unless neutralise is false.
 */
function csvField(value, neutralise) {
  let text = value === undefined || value === null ? '' : String(value);
  if (neutralise !== false && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

/** Shortens a value for a message or a list; control characters become a middle dot. */
function show(value, max) {
  const limit = max || 60;
  let s = String(value === undefined || value === null ? '' : value);
  if (s.length > limit * 2) s = s.slice(0, limit * 2);
  s = s.replace(/[\u0000-\u001f\u007f]/g, '·');
  return s.length > limit ? s.slice(0, limit - 3) + '...' : s;
}

module.exports = {
  SELECTOR_AT,
  HL7_HEADERS,
  globMatch,
  parseSelector,
  matchesSegment,
  targets,
  leaves,
  concretePath,
  componentText,
  makePositioner,
  toNumber,
  parseDecimal,
  compareDecimal,
  addDecimal,
  withinDecimal,
  formatDecimal,
  unitType,
  unitRef,
  walkUnits,
  terminatorIn,
  segmentDelimiters,
  readElements,
  htmlEscape,
  csvField,
  show,
};
