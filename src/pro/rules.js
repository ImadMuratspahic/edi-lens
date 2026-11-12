'use strict';

/*
 * Partner rules (Pro): checks messages against a rule file that describes one partner's
 * implementation guide, and creates a starting rule file from a message.
 *
 * A rule file is JSON:
 *   {
 *     "name": "Harbor Supply purchase orders",
 *     "format": "edifact",
 *     "messageTypes": ["ORDERS"],
 *     "rules": [
 *       { "id": "R1", "type": "segment-required", "segment": "NAD[BY]", "message": "Buyer is missing" },
 *       { "id": "R2", "type": "value-in", "path": "BGM-1.1", "values": ["220", "221"] }
 *     ]
 *   }
 *
 * Rule types: segment-required, segment-forbidden, occurrences (min, max), element-required,
 * value-in (values), pattern (pattern), range (min, max), date (format), length (min, max),
 * condition (if, then) and equal (left, right). Every rule is checked once per message (UNH to
 * UNT, ST to SE, or an MSH with its segments). A rule with "within": "LIN" is checked once per
 * group instead: a group starts at each segment the selector names and ends before the next
 * segment with the same id (or an id listed in "until") or at the end of the message.
 *
 * The file is read segment by segment, so memory use does not grow with the size of a message.
 * Nothing here uses the editor API.
 */

const vm = require('node:vm');
const shared = require('./shared.js');
const { detectFormat } = require('../core/detect.js');

const FORMATS = ['edifact', 'x12', 'hl7'];
const SEVERITIES = ['error', 'warning', 'info'];
const MAX_RULES = 1000;
const MAX_PATTERN_LENGTH = 300;
const DIRECT_VALUE_LENGTH = 256;
const GUARDED_TIMEOUT_MS = 1000;
const SLOW_MS = 250;
/** All tests of one pattern rule together may take this long in one run. */
const PATTERN_BUDGET_MS = 2000;
const DEFAULT_MAX_ISSUES = 500;

const CODES = Object.freeze({
  fileInvalid: 'RULES-FILE-INVALID',
  notEdi: 'RULES-NOT-EDI',
  'segment-required': 'RULES-SEGMENT-REQUIRED',
  'segment-forbidden': 'RULES-SEGMENT-FORBIDDEN',
  occurrences: 'RULES-OCCURRENCES',
  'element-required': 'RULES-ELEMENT-REQUIRED',
  'value-in': 'RULES-VALUE-NOT-IN-LIST',
  pattern: 'RULES-PATTERN',
  range: 'RULES-RANGE',
  date: 'RULES-DATE',
  length: 'RULES-LENGTH',
  condition: 'RULES-CONDITION',
  equal: 'RULES-EQUAL',
  patternStopped: 'RULES-PATTERN-STOPPED',
});

const SIMPLE_TYPES = ['segment-required', 'segment-forbidden', 'occurrences', 'element-required', 'value-in', 'pattern', 'range', 'date', 'length'];
const ALL_TYPES = SIMPLE_TYPES.concat(['condition', 'equal']);

// ---------------------------------------------------------------------------------------------
// Patterns.

/**
 * Examines a regular expression before it is used. Refused: backreferences, lookarounds and a
 * repeated group that itself contains a repetition, an optional part or an alternative (the
 * shapes that can take exponential time, such as (a+)+, (a?a?)* and (a|aa)*). Returns { ok: true, guarded } where guarded means "run with a time limit"
 * (more than three open-ended repetitions), or { ok: false, error }.
 */
function checkPattern(source) {
  if (typeof source !== 'string' || source === '') return { ok: false, error: 'the pattern is empty' };
  if (source.length > MAX_PATTERN_LENGTH) return { ok: false, error: 'the pattern is longer than ' + MAX_PATTERN_LENGTH + ' characters' };
  try { new RegExp(source); } catch (e) { return { ok: false, error: 'the pattern is not a valid regular expression' }; }
  const stack = [];
  let top = { repeats: false, alternatives: false };
  let open = 0;
  let i = 0;
  // Reads a quantifier at position k: returns { length, many, openEnded } or null.
  function quantifierAt(k) {
    const ch = source[k];
    if (ch === '*' || ch === '+') return { length: source[k + 1] === '?' ? 2 : 1, many: true, openEnded: true };
    if (ch === '?') return { length: source[k + 1] === '?' ? 2 : 1, many: false, openEnded: false };
    if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}\??/.exec(source.slice(k, k + 24));
      if (!m) return null;
      const max = m[2] === undefined ? Number(m[1]) : (m[3] === '' ? Infinity : Number(m[3]));
      return { length: m[0].length, many: max > 1, openEnded: max === Infinity || max > 64 };
    }
    return null;
  }
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1] || '';
      if (/[1-9]/.test(next) || next === 'k') return { ok: false, error: 'backreferences are not allowed' };
      i += 2;
    } else if (ch === '[') {
      i++;
      if (source[i] === '^') i++;
      if (source[i] === ']') i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i++;
    } else if (ch === '(') {
      if (source[i + 1] === '?') {
        const kind = source.slice(i + 2, i + 4);
        if (kind[0] === '=' || kind[0] === '!' || kind === '<=' || kind === '<!') return { ok: false, error: 'lookarounds are not allowed' };
      }
      stack.push(top);
      top = { repeats: false, alternatives: false };
      i++;
      continue;
    } else if (ch === ')') {
      const inner = top;
      top = stack.pop() || { repeats: false, alternatives: false };
      i++;
      const q = quantifierAt(i);
      if (q && q.many && (inner.repeats || inner.alternatives)) {
        return { ok: false, error: 'a repeated group must not contain a repetition, an optional part or an alternative' };
      }
      if (inner.repeats) top.repeats = true;
      if (q) {
        top.repeats = true;
        if (q.openEnded) open++;
        i += q.length;
      }
      continue;
    } else if (ch === '|') {
      top.alternatives = true;
      i++;
    } else {
      i++;
    }
    const q = quantifierAt(i);
    if (q && source[i - 1] !== '(' && source[i - 1] !== '|') {
      top.repeats = true;
      if (q.openEnded) open++;
      i += q.length;
    }
  }
  return { ok: true, guarded: open > 3 };
}

/** Creates the tester of one pattern rule: test(value) returns true, false or 'stopped'. */
function createPatternTester(source, ignoreCase, guarded) {
  const re = new RegExp(source, ignoreCase ? 'i' : '');
  let stopped = false;
  let spent = 0;
  let calls = 0;
  let sandbox = null;
  let script = null;
  function guardedTest(value) {
    try {
      if (!sandbox) {
        sandbox = vm.createContext({ re: re, s: '', out: false });
        script = new vm.Script('out = re.test(s)');
      }
      sandbox.s = value;
      script.runInContext(sandbox, { timeout: GUARDED_TIMEOUT_MS });
      return sandbox.out === true;
    } catch (e) {
      stopped = true;
      return 'stopped';
    }
  }
  return function test(value) {
    if (stopped) return 'stopped';
    // The clock is read for long values and for every 64th short one, and the time is added up:
    // a pattern that is slow on every value is stopped after two seconds in total.
    calls++;
    const timed = guarded || value.length > 32 || (calls & 63) === 0;
    const started = timed ? process.hrtime.bigint() : 0n;
    const result = guarded || value.length > DIRECT_VALUE_LENGTH ? guardedTest(value) : re.test(value);
    if (timed) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      spent += ms;
      if (ms > SLOW_MS || spent > PATTERN_BUDGET_MS) {
        stopped = true;
        return 'stopped';
      }
    }
    return result;
  };
}

// ---------------------------------------------------------------------------------------------
// Dates.

const DATE_TOKENS = { CCYY: 4, YYYY: 4, YY: 2, MM: 2, DD: 2, hh: 2, mm: 2, ss: 2 };

/** Compiles a date format such as CCYYMMDD, YYMMDD or CCYYMMDDhhmm into a list of parts. */
function compileDateFormat(format) {
  if (typeof format !== 'string' || format === '' || format.length > 40) return null;
  const parts = [];
  let i = 0;
  while (i < format.length) {
    let hit = null;
    for (const token of Object.keys(DATE_TOKENS)) {
      if (format.startsWith(token, i)) { hit = token; break; }
    }
    if (hit) {
      parts.push({ token: hit, width: DATE_TOKENS[hit] });
      i += hit.length;
    } else if (/[A-Za-z0-9]/.test(format[i])) {
      return null;
    } else {
      parts.push({ literal: format[i] });
      i++;
    }
  }
  return parts.some(function (p) { return p.token; }) ? parts : null;
}

/** True when the value is written exactly in the compiled format and names a real date and time. */
function matchesDate(parts, value) {
  let pos = 0;
  const got = {};
  for (const p of parts) {
    if (p.literal) {
      if (value[pos] !== p.literal) return false;
      pos++;
      continue;
    }
    const piece = value.slice(pos, pos + p.width);
    if (piece.length !== p.width || !/^\d+$/.test(piece)) return false;
    got[p.token] = Number(piece);
    pos += p.width;
  }
  if (pos !== value.length) return false;
  if (got.MM !== undefined && (got.MM < 1 || got.MM > 12)) return false;
  if (got.DD !== undefined) {
    const year = got.CCYY !== undefined ? got.CCYY : got.YYYY !== undefined ? got.YYYY : got.YY !== undefined ? 2000 + got.YY : 2000;
    const month = got.MM !== undefined ? got.MM : 1;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (got.DD < 1 || got.DD > days) return false;
  }
  if (got.hh !== undefined && got.hh > 24) return false;
  if (got.mm !== undefined && got.mm > 59) return false;
  if (got.ss !== undefined && got.ss > 59) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Reading a rule file.

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** Parses "count(SEG)", "sum(PATH)", a number or a path into an operand, or returns an error text. */
function parseOperand(text) {
  if (typeof text === 'number' && isFinite(text)) return { kind: 'number', value: String(text) };
  if (typeof text !== 'string' || text.trim() === '') return 'must be a path, count(...), sum(...) or a number';
  const t = text.trim();
  const fn = /^(count|sum)\(\s*(.+?)\s*\)$/i.exec(t);
  if (fn) {
    const sel = shared.parseSelector(fn[2]);
    if (!sel.ok) return 'is ' + sel.error;
    if (fn[1].toLowerCase() === 'sum' && !sel.element) return 'sum(...) needs a path with an element';
    return { kind: fn[1].toLowerCase(), sel: sel };
  }
  // A number written as text keeps every digit (a number in JSON is only exact up to 15 digits).
  if (shared.parseDecimal(t)) return { kind: 'number', value: t };
  const sel = shared.parseSelector(t);
  if (!sel.ok) return 'is ' + sel.error;
  if (!sel.element) return 'must name an element, for example ' + sel.id + '-1';
  return { kind: 'value', sel: sel };
}

/**
 * Compiles one rule object. Returns the compiled rule or pushes an error and returns null.
 * `nested` is true for the "then" part of a condition (no id, no nested condition).
 */
function compileRule(raw, where, errors, nested) {
  const fail = function (text) { errors.push(where + text); return null; };
  if (!isObject(raw)) return fail('must be an object.');
  const type = raw.type;
  if ((nested ? SIMPLE_TYPES : ALL_TYPES).indexOf(type) === -1) {
    return fail('"type" must be one of ' + (nested ? SIMPLE_TYPES : ALL_TYPES).join(', ') + '.');
  }
  const rule = { type: type, id: '', severity: 'error', message: '', within: null, until: [], messageTypes: null };
  if (!nested) {
    if (raw.id !== undefined && (typeof raw.id !== 'string' || raw.id.length > 60 || /[\r\n]/.test(raw.id))) return fail('"id" must be a short text.');
    rule.id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (raw.severity !== undefined && SEVERITIES.indexOf(raw.severity) === -1) return fail('"severity" must be error, warning or info.');
    if (raw.severity) rule.severity = raw.severity;
    if (raw.message !== undefined && (typeof raw.message !== 'string' || raw.message.length > 500)) return fail('"message" must be a text of at most 500 characters.');
    rule.message = typeof raw.message === 'string' ? raw.message.replace(/[\r\n]+/g, ' ').trim() : '';
    if (raw.messageTypes !== undefined) {
      if (!Array.isArray(raw.messageTypes) || raw.messageTypes.some(function (t) { return typeof t !== 'string'; })) return fail('"messageTypes" must be a list of texts.');
      rule.messageTypes = raw.messageTypes.slice();
    }
    if (raw.within !== undefined) {
      const w = shared.parseSelector(raw.within);
      if (!w.ok || w.element) return fail('"within" must name a segment, for example LIN or HL[3=22].');
      rule.within = w;
      if (raw.until !== undefined) {
        if (!Array.isArray(raw.until) || raw.until.some(function (t) { return typeof t !== 'string' || !/^[A-Za-z][A-Za-z0-9]{1,2}$/.test(t); })) return fail('"until" must be a list of segment ids.');
        rule.until = raw.until.slice();
      }
    }
  }

  function segmentSelector(name) {
    const sel = shared.parseSelector(raw[name]);
    if (!sel.ok) return fail('"' + name + '" is ' + sel.error + '.');
    if (sel.element) return fail('"' + name + '" must name a segment only, for example NAD or NAD[BY].');
    return sel;
  }
  function pathSelector(name) {
    const sel = shared.parseSelector(raw[name]);
    if (!sel.ok) return fail('"' + name + '" is ' + sel.error + '.');
    if (!sel.element) return fail('"' + name + '" must name an element, for example ' + sel.id + '-1.');
    return sel;
  }
  function bound(name) {
    if (raw[name] === undefined) return undefined;
    if (typeof raw[name] !== 'number' || !isFinite(raw[name])) { fail('"' + name + '" must be a number.'); return null; }
    return raw[name];
  }

  if (type === 'segment-required' || type === 'segment-forbidden' || type === 'occurrences') {
    rule.sel = segmentSelector('segment');
    if (!rule.sel) return null;
    if (type === 'occurrences') {
      rule.min = bound('min');
      rule.max = bound('max');
      if (rule.min === null || rule.max === null) return null;
      if (rule.min === undefined && rule.max === undefined) return fail('needs "min", "max" or both.');
      if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) return fail('"min" is larger than "max".');
    }
    return rule;
  }
  if (type === 'condition') {
    if (!isObject(raw.if)) return fail('"if" must be an object such as { "path": "BGM-1.1", "equals": "220" } or { "segment": "FTX" }.');
    const cond = { sel: null, equals: null, values: null, negate: raw.if.not === true };
    if (raw.if.segment !== undefined) {
      const sel = shared.parseSelector(raw.if.segment);
      if (!sel.ok || sel.element) return fail('"if.segment" must name a segment.');
      cond.sel = sel;
    } else {
      const sel = shared.parseSelector(raw.if.path);
      if (!sel.ok || !sel.element) return fail('"if.path" must be a path with an element.');
      cond.sel = sel;
      if (raw.if.equals !== undefined) {
        if (typeof raw.if.equals !== 'string' && typeof raw.if.equals !== 'number') return fail('"if.equals" must be a text or a number.');
        cond.values = [String(raw.if.equals)];
      } else if (raw.if.in !== undefined) {
        if (!Array.isArray(raw.if.in) || raw.if.in.length === 0) return fail('"if.in" must be a list of values.');
        cond.values = raw.if.in.map(String);
      }
    }
    rule.cond = cond;
    rule.then = compileRule(raw.then, where + 'then: ', errors, true);
    if (!rule.then) return null;
    return rule;
  }
  if (type === 'equal') {
    const left = parseOperand(raw.left);
    if (typeof left === 'string') return fail('"left" ' + left + '.');
    const right = parseOperand(raw.right);
    if (typeof right === 'string') return fail('"right" ' + right + '.');
    rule.left = left;
    rule.right = right;
    rule.tolerance = 0;
    if (raw.tolerance !== undefined) {
      if (typeof raw.tolerance !== 'number' || !(raw.tolerance >= 0) || !shared.parseDecimal(raw.tolerance)) return fail('"tolerance" must be a plain number that is not negative, for example 0.01.');
      rule.tolerance = raw.tolerance;
    }
    rule.toleranceDecimal = shared.parseDecimal(rule.tolerance);
    return rule;
  }

  rule.sel = pathSelector('path');
  if (!rule.sel) return null;
  if (type === 'value-in') {
    if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.length > 5000) return fail('"values" must be a list of 1 to 5000 values.');
    rule.ignoreCase = raw.ignoreCase === true;
    rule.values = new Set(raw.values.map(function (v) { return rule.ignoreCase ? String(v).toLowerCase() : String(v); }));
    rule.sample = raw.values.slice(0, 8).map(String);
    rule.total = raw.values.length;
  } else if (type === 'pattern') {
    const checked = checkPattern(raw.pattern);
    if (!checked.ok) return fail('"pattern" was not accepted: ' + checked.error + '.');
    rule.pattern = raw.pattern;
    rule.ignoreCase = raw.ignoreCase === true;
    rule.guarded = checked.guarded;
  } else if (type === 'range' || type === 'length') {
    rule.min = bound('min');
    rule.max = bound('max');
    if (rule.min === null || rule.max === null) return null;
    if (rule.min === undefined && rule.max === undefined) return fail('needs "min", "max" or both.');
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) return fail('"min" is larger than "max".');
  } else if (type === 'date') {
    rule.parts = compileDateFormat(raw.format);
    if (!rule.parts) return fail('"format" must be built from CCYY, YY, MM, DD, hh, mm, ss and separators, for example CCYYMMDD.');
    rule.format = raw.format;
  }
  return rule;
}

/**
 * Reads a rule file (JSON text). Returns { ok: true, guide } or { ok: false, code, errors }.
 * guide: { name, format, messageTypes, rules } with compiled rules.
 */
function loadRules(text) {
  let data;
  const source = String(text);
  try {
    data = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  } catch (e) {
    return { ok: false, code: CODES.fileInvalid, errors: ['The file is not valid JSON: ' + shared.show(e && e.message, 120)] };
  }
  const errors = [];
  if (!isObject(data)) return { ok: false, code: CODES.fileInvalid, errors: ['The file must hold one JSON object with "format" and "rules".'] };
  if (FORMATS.indexOf(data.format) === -1) errors.push('"format" must be "edifact", "x12" or "hl7".');
  if (data.name !== undefined && typeof data.name !== 'string') errors.push('"name" must be a text.');
  let messageTypes = null;
  if (data.messageTypes !== undefined) {
    if (!Array.isArray(data.messageTypes) || data.messageTypes.some(function (t) { return typeof t !== 'string'; })) errors.push('"messageTypes" must be a list of texts.');
    else messageTypes = data.messageTypes.slice();
  }
  const rules = [];
  if (!Array.isArray(data.rules)) errors.push('"rules" must be a list.');
  else if (data.rules.length > MAX_RULES) errors.push('"rules" holds more than ' + MAX_RULES + ' entries.');
  else {
    const ids = new Set();
    data.rules.forEach(function (raw, i) {
      if (errors.length >= 20) return;
      const rule = compileRule(raw, 'rules[' + i + ']: ', errors, false);
      if (!rule) return;
      if (!rule.id) rule.id = 'rule ' + (i + 1);
      if (ids.has(rule.id)) { errors.push('rules[' + i + ']: the id "' + shared.show(rule.id, 40) + '" is used twice.'); return; }
      ids.add(rule.id);
      rules.push(rule);
    });
  }
  if (errors.length) return { ok: false, code: CODES.fileInvalid, errors: errors.slice(0, 20) };
  return { ok: true, guide: { name: typeof data.name === 'string' ? data.name : '', format: data.format, messageTypes: messageTypes, rules: rules } };
}

// ---------------------------------------------------------------------------------------------
// Checking a text.

function typeMatches(list, type) {
  if (!list || list.length === 0) return true;
  const base = type.split('^')[0];
  for (const t of list) {
    if (t === '*' || t === type || t === base || shared.globMatch(t, type)) return true;
  }
  return false;
}

function describeBounds(min, max) {
  if (min !== undefined && max !== undefined) return min === max ? 'exactly ' + min : 'between ' + min + ' and ' + max;
  return min !== undefined ? 'at least ' + min : 'at most ' + max;
}

/** The default sentence of a violation when the rule file gives no message. */
function defaultMessage(rule, detail) {
  const d = detail || {};
  switch (rule.type) {
    case 'segment-required': return 'Segment ' + rule.sel.text + ' is required' + (d.scope ? ' in every ' + d.scope + ' group' : '') + ' but is missing.';
    case 'segment-forbidden': return 'Segment ' + rule.sel.text + ' must not be used.';
    case 'occurrences': return 'Segment ' + rule.sel.text + ' must occur ' + describeBounds(rule.min, rule.max) + ' times; found ' + d.count + '.';
    case 'element-required': return rule.sel.text + ' is required but is empty or missing.';
    case 'value-in': return rule.sel.text + ' has the value "' + shared.show(d.value, 40) + '", which is not in the list of allowed values (' + rule.sample.join(', ') + (rule.total > rule.sample.length ? ', ...' : '') + ').';
    case 'pattern': return rule.sel.text + ' has the value "' + shared.show(d.value, 40) + '", which does not match the pattern ' + rule.pattern + '.';
    case 'range': return rule.sel.text + ' has the value "' + shared.show(d.value, 40) + '"; a number ' + describeBounds(rule.min, rule.max) + ' is expected.';
    case 'date': return rule.sel.text + ' has the value "' + shared.show(d.value, 40) + '", which is not a date in the format ' + rule.format + '.';
    case 'length': return rule.sel.text + ' is ' + d.length + ' characters long; a length ' + describeBounds(rule.min, rule.max) + ' is expected.';
    case 'equal':
      if (rule.right.kind === 'number') return d.leftText + ' is "' + shared.show(d.left, 30) + '"; ' + d.right + ' is expected.';
      if (rule.left.kind === 'number') return d.rightText + ' is "' + shared.show(d.right, 30) + '"; ' + d.left + ' is expected.';
      return 'The values must be equal: ' + d.leftText + ' is "' + shared.show(d.left, 30) + '" but ' + d.rightText + ' is "' + shared.show(d.right, 30) + '".';
    default: return 'The rule is not met.';
  }
}

function codePoints(value) {
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) i++;
    n++;
  }
  return n;
}

/**
 * Creates the working state of one simple rule inside one scope (a message or a group). It
 * receives the segments of the scope and collects findings: [{ offset, end, detail }]; a
 * finding without an offset belongs to the start of the scope.
 */
function createSimpleState(rule, env) {
  const findings = [];
  let count = 0;
  const add = function (offset, end, detail) {
    if (findings.length < env.maxIssues) findings.push({ offset: offset, end: end, detail: detail });
    else env.overflow = true;
  };
  return {
    findings: findings,
    feed: function (segment, getElements) {
      if (segment.id !== rule.sel.id) return;
      const elements = getElements();
      if (!shared.matchesSegment(rule.sel, segment, elements)) return;
      count++;
      if (rule.sel.occurrence && rule.sel.occurrence !== count) return;
      const segEnd = segment.offset + segment.raw.length;
      if (rule.type === 'segment-forbidden') { add(segment.offset, segEnd, {}); return; }
      if (rule.type === 'segment-required' || rule.type === 'occurrences') return;
      const pieces = shared.targets(rule.sel, elements);
      if (rule.type === 'element-required') {
        if (!pieces.some(function (p) { return p.raw.trim() !== ''; })) {
          const el = elements[rule.sel.element - 1];
          if (el) add(el.offset, Math.max(el.end, el.offset + 1), {});
          else add(segment.offset, segEnd, {});
        }
        return;
      }
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        const value = p.raw.trim();
        if (value === '') continue;
        let bad = false;
        const detail = { value: value };
        if (rule.type === 'value-in') {
          bad = !rule.values.has(rule.ignoreCase ? value.toLowerCase() : value);
        } else if (rule.type === 'pattern') {
          const tester = env.tester(rule);
          const r = tester(value);
          if (r === 'stopped') { env.patternStopped(rule); return; }
          bad = !r;
        } else if (rule.type === 'range') {
          const n = shared.toNumber(value);
          bad = isNaN(n) || (rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max);
        } else if (rule.type === 'date') {
          bad = !matchesDate(rule.parts, value);
        } else if (rule.type === 'length') {
          detail.length = codePoints(value);
          bad = (rule.min !== undefined && detail.length < rule.min) || (rule.max !== undefined && detail.length > rule.max);
        }
        if (bad) add(p.offset, Math.max(p.end, p.offset + 1), detail);
      }
    },
    finish: function (scopeName) {
      if (rule.type === 'segment-required' && count === 0) add(-1, -1, { scope: scopeName });
      if (rule.type === 'occurrences' && ((rule.min !== undefined && count < rule.min) || (rule.max !== undefined && count > rule.max))) add(-1, -1, { count: count });
      return findings;
    },
  };
}

/** Working state of one operand of an "equal" rule inside one scope. */
function createOperandState(operand) {
  const st = { kind: operand.kind, value: undefined, offset: -1, end: -1, n: 0, sum: { n: 0n, scale: 0 }, seen: 0 };
  if (operand.kind === 'number') st.value = operand.value;
  st.feed = function (segment, getElements) {
    if (operand.kind === 'number' || segment.id !== operand.sel.id) return;
    const elements = getElements();
    if (!shared.matchesSegment(operand.sel, segment, elements)) return;
    st.seen++;
    if (operand.sel.occurrence && operand.sel.occurrence !== st.seen) return;
    if (operand.kind === 'count' && !operand.sel.element) { st.n++; return; }
    const pieces = shared.targets(operand.sel, elements);
    for (const p of pieces) {
      const value = p.raw.trim();
      if (value === '') continue;
      if (operand.kind === 'count') st.n++;
      else if (operand.kind === 'sum') {
        const n = shared.parseDecimal(value);
        if (n) { st.sum = shared.addDecimal(st.sum, n); st.n++; }
      } else if (st.value === undefined) {
        st.value = value;
        st.offset = p.offset;
        st.end = p.end;
      }
    }
  };
  st.result = function () {
    if (operand.kind === 'count') return st.n;
    if (operand.kind === 'sum') return st.n > 0 ? shared.formatDecimal(st.sum) : undefined;
    return st.value;
  };
  return st;
}

function operandText(operand) {
  if (operand.kind === 'number') return String(operand.value);
  if (operand.kind === 'value') return operand.sel.text;
  return operand.kind + '(' + operand.sel.text + ')';
}

/** Creates the state of any rule inside one scope: feed(segment, getElements) and finish(). */
function createRuleState(rule, env) {
  if (rule.type === 'condition') {
    const inner = createSimpleState(rule.then, env);
    let holds = false;
    let seen = 0;
    return {
      feed: function (segment, getElements) {
        inner.feed(segment, getElements);
        const c = rule.cond;
        if (holds || segment.id !== c.sel.id) return;
        const elements = getElements();
        if (!shared.matchesSegment(c.sel, segment, elements)) return;
        seen++;
        if (c.sel.occurrence && c.sel.occurrence !== seen) return;
        if (!c.sel.element) { holds = true; return; }
        for (const p of shared.targets(c.sel, elements)) {
          const value = p.raw.trim();
          if (value === '') continue;
          if (!c.values || c.values.indexOf(value) !== -1) { holds = true; return; }
        }
      },
      finish: function (scopeName) {
        const applies = rule.cond.negate ? !holds : holds;
        if (!applies) return [];
        return inner.finish(scopeName).map(function (f) {
          return { offset: f.offset, end: f.end, detail: f.detail, text: 'When ' + conditionText(rule.cond) + ': ' + defaultMessage(rule.then, f.detail) };
        });
      },
    };
  }
  if (rule.type === 'equal') {
    const left = createOperandState(rule.left);
    const right = createOperandState(rule.right);
    return {
      feed: function (segment, getElements) { left.feed(segment, getElements); right.feed(segment, getElements); },
      finish: function () {
        const a = left.result();
        const b = right.result();
        if (a === undefined || b === undefined) return [];
        // Two numbers are compared exactly, digit by digit (an 18-digit identifier is never
        // rounded); a tolerance is applied exactly as well. Anything else is compared as text.
        const na = shared.parseDecimal(a);
        const nb = shared.parseDecimal(b);
        const same = na && nb ? shared.withinDecimal(na, nb, rule.toleranceDecimal) : String(a) === String(b);
        if (same) return [];
        const at = left.offset >= 0 ? left : right;
        return [{ offset: at.offset, end: at.end, detail: { left: a, right: b, leftText: operandText(rule.left), rightText: operandText(rule.right) } }];
      },
    };
  }
  return createSimpleState(rule, env);
}

function conditionText(cond) {
  const base = cond.sel.text + (cond.values ? (cond.values.length === 1 ? ' is "' + cond.values[0] + '"' : ' is one of ' + cond.values.join(', ')) : ' is present');
  return cond.negate ? 'not (' + base + ')' : base;
}

/**
 * Checks a text against a guide. options: maxIssues (default 500). Returns
 * { ok: true, format, applicable, units, unitsChecked, rulesApplied, violations, truncated,
 * stoppedPatterns } or { ok: false, code, message }. A violation is { ruleId, code, severity,
 * message, offset, end, line, column, endLine, endColumn, unit, unitType } with 0-based lines.
 * applicable is false when the guide is for another format or no message has one of its types.
 */
function validateText(text, guide, options) {
  const o = options || {};
  const maxIssues = typeof o.maxIssues === 'number' && o.maxIssues > 0 ? Math.floor(o.maxIssues) : DEFAULT_MAX_ISSUES;
  const source = typeof text === 'string' ? text : '';
  const out = { ok: true, format: null, applicable: false, units: 0, unitsChecked: 0, rulesApplied: 0, violations: [], truncated: false, stoppedPatterns: [] };
  const testers = new Map();
  const stopped = new Set();
  const pending = [];
  const env = {
    maxIssues: maxIssues,
    overflow: false,
    tester: function (rule) {
      if (!testers.has(rule)) testers.set(rule, createPatternTester(rule.pattern, rule.ignoreCase, rule.guarded));
      return testers.get(rule);
    },
    patternStopped: function (rule) { stopped.add(rule); },
  };

  function record(rule, unit, scopeStart, finding) {
    if (pending.length >= maxIssues) { out.truncated = true; return; }
    const top = rule;
    const offset = finding.offset >= 0 ? finding.offset : scopeStart.offset;
    const end = finding.offset >= 0 ? finding.end : scopeStart.end;
    const sentence = top.message || finding.text || defaultMessage(top, finding.detail);
    pending.push({
      ruleId: top.id, code: CODES[top.type], severity: top.severity, message: '[' + top.id + '] ' + sentence,
      offset: offset, end: end, unit: unit.index, unitType: unit.type,
    });
  }

  const detected = detectFormat(source);
  const guideApplies = !!detected && detected.format === guide.format;
  let active = null; // rules of the current message: [{ rule, state, scopeStart, open }]

  function openScope(entry, segment) {
    entry.state = createRuleState(entry.rule, env);
    entry.scopeStart = { offset: segment.offset, end: segment.offset + Math.max(1, segment.id.length) };
    entry.open = true;
  }
  function closeScope(entry, unit) {
    if (!entry.open) return;
    const findings = entry.state.finish(entry.rule.within ? entry.rule.within.text : '');
    for (const f of findings) record(entry.rule, unit, entry.scopeStart, f);
    entry.open = false;
    entry.state = null;
  }

  const walked = shared.walkUnits(source, {
    onUnitStart: function (unit, segment) {
      active = null;
      if (guideApplies && typeMatches(guide.messageTypes, unit.type)) {
        active = [];
        for (const rule of guide.rules) {
          if (stopped.has(rule) || !typeMatches(rule.messageTypes, unit.type)) continue;
          const entry = { rule: rule, state: null, scopeStart: null, open: false };
          if (!rule.within) openScope(entry, segment);
          active.push(entry);
        }
        out.unitsChecked++;
        out.rulesApplied = Math.max(out.rulesApplied, active.length);
      }
    },
    onSegment: function (unit, segment, getElements) {
      if (!active) return undefined;
      for (const entry of active) {
        const rule = entry.rule;
        if (stopped.has(rule)) continue;
        if (rule.within) {
          if (segment.id === rule.within.id || rule.until.indexOf(segment.id) !== -1) {
            closeScope(entry, unit);
            if (segment.id === rule.within.id && shared.matchesSegment(rule.within, segment, getElements())) openScope(entry, segment);
            else continue;
          }
          if (!entry.open) continue;
        }
        entry.state.feed(segment, getElements);
      }
      if (pending.length >= maxIssues) {
        out.truncated = true;
        return false;
      }
      return undefined;
    },
    onUnitEnd: function (unit) {
      if (!active) return;
      for (const entry of active) closeScope(entry, unit);
      active = null;
    },
  });
  if (!walked.ok) {
    return { ok: false, code: CODES.notEdi, message: 'The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message, so it was not checked.' };
  }
  out.format = walked.format;
  out.units = walked.units;
  out.applicable = out.unitsChecked > 0;
  if (env.overflow) out.truncated = true;

  stopped.forEach(function (rule) {
    out.stoppedPatterns.push(rule.id);
    pending.push({
      ruleId: rule.id, code: CODES.patternStopped, severity: 'warning',
      message: '[' + rule.id + '] The pattern ' + rule.pattern + ' took too long on a value and was not applied to the rest of the file. Simplify the pattern.',
      offset: 0, end: 0, unit: 0, unitType: '',
    });
  });

  pending.sort(function (a, b) { return a.offset - b.offset; });
  const at = shared.makePositioner(source);
  for (const v of pending) {
    const p = at(v.offset);
    v.line = p.line;
    v.column = p.column;
  }
  pending.slice().sort(function (a, b) { return a.end - b.end; }).forEach(function (v) {
    const p = at(v.end);
    v.endLine = p.line;
    v.endColumn = p.column;
  });
  out.violations = pending;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Creating a starting rule file from a message.

const ENVELOPE_IDS = { edifact: ['UNH', 'UNT'], x12: ['ST', 'SE'], hl7: [] };
/** MSH fields that differ in every message (delimiters, time, control id) and are not turned into rules. */
const HL7_SKIP = { MSH: [1, 2, 7, 10] };
const MAX_CODE_VALUES = 10;

/**
 * Reads a text and writes a starting rule file for it: a segment-required rule for every segment
 * id that occurs in every message, an element-required rule for every element that is filled in
 * all segments of an id, and a value-in rule for every position that only holds a few short
 * codes. The text itself always passes the rules. Returns { ok: true, guide (a plain object
 * ready for JSON.stringify), units } or { ok: false, code, message }.
 */
function inferRules(text, options) {
  const o = options || {};
  const source = typeof text === 'string' ? text : '';
  // id -> { segments, unitsWith, lastUnit, filled: Map(element -> count), codes: Map('e.c' -> Set or null) }
  const stats = new Map();
  const order = [];
  const types = [];
  const detected = detectFormat(source);
  const format = detected ? detected.format : null;
  const skipIds = format ? ENVELOPE_IDS[format] : [];
  const walked = shared.walkUnits(source, {
    onUnitStart: function (unit) {
      if (unit.type && types.indexOf(unit.type) === -1 && types.length < 20) types.push(unit.type);
    },
    onSegment: function (unit, segment, getElements) {
      if (skipIds.indexOf(segment.id) !== -1 || !/^[A-Za-z][A-Za-z0-9]{1,2}$/.test(segment.id)) return;
      let st = stats.get(segment.id);
      if (!st) {
        if (stats.size >= 300) return;
        st = { segments: 0, unitsWith: 0, lastUnit: 0, filled: new Map(), codes: new Map() };
        stats.set(segment.id, st);
        order.push(segment.id);
      }
      st.segments++;
      if (st.lastUnit !== unit.index) { st.unitsWith++; st.lastUnit = unit.index; }
      const elements = getElements();
      const skip = format === 'hl7' && HL7_SKIP[segment.id] ? HL7_SKIP[segment.id] : [];
      for (let e = 0; e < elements.length && e < 60; e++) {
        const el = elements[e];
        if (skip.indexOf(el.index) !== -1) continue;
        if (el.raw.trim() !== '') st.filled.set(el.index, (st.filled.get(el.index) || 0) + 1);
        if (el.repetitions.length > 1) {
          for (let c = 1; c <= 12; c++) st.codes.set(el.index + '.' + c, null);
          continue;
        }
        const comps = el.repetitions[0].components;
        for (let c = 0; c < comps.length && c < 12; c++) {
          const value = comps[c].raw.trim();
          if (value === '') continue;
          const key = el.index + '.' + (c + 1);
          let set = st.codes.get(key);
          if (set === null) continue;
          if (set === undefined) { set = new Set(); st.codes.set(key, set); }
          const numeric = /^[0-9]+$/.test(value);
          const codeLike = /^[A-Z0-9]{1,3}$/.test(value) && (!numeric || (el.index === 1 && c === 0 && value.length >= 2));
          if (!codeLike || comps[c].subcomponents.length > 1) { st.codes.set(key, null); continue; }
          set.add(value);
          if (set.size > MAX_CODE_VALUES) st.codes.set(key, null);
        }
      }
    },
  });
  if (!walked.ok) return { ok: false, code: CODES.notEdi, message: 'The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message, so no rules were created.' };
  if (walked.units === 0) return { ok: false, code: CODES.notEdi, message: 'No message (UNH, ST or MSH) was found in the text, so no rules were created.' };
  const rules = [];
  let n = 0;
  const next = function () { n++; return 'R' + String(n).padStart(3, '0'); };
  for (const id of order) {
    const st = stats.get(id);
    if (st.unitsWith === walked.units) rules.push({ id: next(), type: 'segment-required', segment: id, message: id + ' is required in every message.' });
    Array.from(st.filled.keys()).sort(function (a, b) { return a - b; }).forEach(function (e) {
      if (st.filled.get(e) === st.segments) rules.push({ id: next(), type: 'element-required', path: id + '-' + e, message: id + '-' + e + ' must be filled.' });
    });
    Array.from(st.codes.keys()).forEach(function (key) {
      const set = st.codes.get(key);
      if (!set || set.size === 0) return;
      const values = Array.from(set).sort();
      // Numeric codes only when they all have the same length, so that counters are left out.
      if (values.every(function (v) { return /^[0-9]+$/.test(v); }) && new Set(values.map(function (v) { return v.length; })).size > 1) return;
      rules.push({ id: next(), type: 'value-in', path: id + '-' + key, values: values, message: id + '-' + key + ' must be one of: ' + values.join(', ') + '.' });
    });
    if (rules.length >= MAX_RULES - 5) break;
  }
  const guide = {
    name: 'Rules created from ' + (o.label || 'a message'),
    format: walked.format,
    messageTypes: types,
    rules: rules.slice(0, MAX_RULES),
  };
  return { ok: true, guide: guide, units: walked.units };
}

// ---------------------------------------------------------------------------------------------
// Reports of a folder run.

/**
 * Writes the violations of several files as CSV. files: [{ label, result }] with result from
 * validateText (or { label, skipped }). neutralise false switches the formula protection off.
 */
function toCsv(files, neutralise) {
  const f = function (v) { return shared.csvField(v, neutralise); };
  const rows = ['file,line,column,severity,code,rule,message_number,message_type,message'];
  files.forEach(function (file) {
    if (!file.result) return;
    file.result.violations.forEach(function (v) {
      rows.push([f(file.label), v.line + 1, v.column + 1, f(v.severity), f(v.code), f(v.ruleId), v.unit || '', f(v.unitType), f(v.message)].join(','));
    });
  });
  return rows.join('\r\n') + '\r\n';
}

/** Writes the violations of several files as a self-contained HTML page (no scripts). */
function toHtml(files, options) {
  const o = options || {};
  const e = shared.htmlEscape;
  const checked = files.filter(function (x) { return x.result && x.result.applicable; });
  const other = files.filter(function (x) { return !(x.result && x.result.applicable); });
  let total = 0;
  checked.forEach(function (x) { total += x.result.violations.length; });
  const title = e(o.title || 'EDI Lens partner rules report');
  const out = [];
  out.push('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">');
  out.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">');
  out.push('<title>' + title + '</title>');
  out.push('<style>body{font-family:system-ui,sans-serif;margin:1.5rem;line-height:1.4}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border:1px solid #8884;padding:.25rem .5rem;text-align:left;vertical-align:top;font-size:.9rem}th{background:#8882}.error{font-weight:600}.num{text-align:right}h2{font-size:1.05rem;margin-top:1.5rem}</style>');
  out.push('</head><body>');
  out.push('<h1>' + title + '</h1>');
  out.push('<p>Rule file: ' + e(o.guideName || '(unnamed)') + '. ' + (o.reportDate ? 'Report date: ' + e(o.reportDate) + '. ' : '') + checked.length + ' files checked, ' + total + ' rule violations, ' + other.length + ' files not checked.' + (o.cancelled ? ' The run was cancelled; the result is partial.' : '') + '</p>');
  checked.forEach(function (file) {
    const r = file.result;
    out.push('<h2>' + e(file.label) + '</h2>');
    out.push('<p>' + r.unitsChecked + ' of ' + r.units + ' messages checked, ' + r.violations.length + ' violations' + (r.truncated ? ' (list cut at the limit)' : '') + '.</p>');
    if (r.violations.length === 0) return;
    out.push('<table><thead><tr><th class="num">Line</th><th>Severity</th><th>Code</th><th class="num">Message no.</th><th>Violation</th></tr></thead><tbody>');
    r.violations.forEach(function (v) {
      out.push('<tr><td class="num">' + (v.line + 1) + '</td><td class="' + e(v.severity) + '">' + e(v.severity) + '</td><td>' + e(v.code) + '</td><td class="num">' + (v.unit || '') + '</td><td>' + e(v.message) + '</td></tr>');
    });
    out.push('</tbody></table>');
  });
  if (other.length) {
    out.push('<h2>Files not checked</h2><ul>');
    other.forEach(function (file) {
      out.push('<li>' + e(file.label) + ': ' + e(file.skipped || 'the rule file is for another format or message type') + '</li>');
    });
    out.push('</ul>');
  }
  out.push('</body></html>');
  return out.join('\n');
}

module.exports = { CODES, loadRules, validateText, inferRules, toCsv, toHtml, checkPattern, compileDateFormat, matchesDate, defaultMessage, typeMatches };
