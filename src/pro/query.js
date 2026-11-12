'use strict';

/*
 * Query (Pro): finds the messages that satisfy a condition, in one text or in many files.
 *
 * The query language:
 *
 *   NAD[BY]-3.1 == "ACME*"            a value compared with a text (* is a wildcard)
 *   MOA[1.1=86]-1.2 > 1000            a value compared with a number
 *   count(LIN) > 50                   the number of matching segments (or of filled values)
 *   sum(QTY[1.1=21]-1.2) >= 100       the sum of the numeric values
 *   exists(CTA)                       a segment (or a filled value) is present
 *   A AND B, A OR B, NOT A, ( ... )   combinations; AND binds tighter than OR
 *
 * Comparison operators: ==  !=  <  <=  >  >=  (= and <> are accepted too). A path may match
 * several values in one message; a comparison is true when at least one of them satisfies it.
 * The left and right side may each be a path, count(...), sum(...), a text in quotes or a number.
 *
 * Text or number. A comparison with a text in quotes is always a comparison of text: "12345"
 * does not match 0012345. A comparison with a number, count(...) or sum(...) is a comparison of
 * numbers, and so is a comparison of two paths whose values are both numbers. Numbers are
 * compared exactly, digit by digit, however long they are: no value is ever rounded. Leading
 * zeros and zeros at the end of a fraction do not count (0012 is 12, 1.50 is 1.5).
 *
 * A query is checked once per message (UNH to UNT, ST to SE, or an MSH with its segments). The
 * text is read segment by segment and only the segments that the query names are examined, so
 * memory use does not grow with the size of the file. Nothing here uses the editor API.
 */

const shared = require('./shared.js');

const CODES = Object.freeze({ syntax: 'QUERY-SYNTAX', notEdi: 'QUERY-NOT-EDI', tooLong: 'QUERY-TOO-LONG' });
const MAX_QUERY_LENGTH = 1000;
const MAX_NODES = 100;
const MAX_HITS_PER_UNIT = 20;
const MAX_KEPT_VALUES = 5000;
const DEFAULT_MAX_RESULTS = 1000;
const HARD_MAX_RESULTS = 10000;
const OPERATORS = ['==', '!=', '<=', '>=', '<>', '=', '<', '>'];
const KEYWORDS = ['and', 'or', 'not'];
const FUNCTIONS = ['exists', 'count', 'sum'];

// ---------------------------------------------------------------------------------------------
// Reading a query.

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const fail = function (message, at) { const e = new Error(message); e.position = at; throw e; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ t: ch, at: i }); i++; continue; }
    if (ch === '"' || ch === "'") {
      let value = '';
      let k = i + 1;
      let closed = false;
      while (k < text.length) {
        if (text[k] === '\\' && k + 1 < text.length && (text[k + 1] === ch || text[k + 1] === '\\')) { value += text[k + 1]; k += 2; continue; }
        if (text[k] === ch) { closed = true; break; }
        value += text[k];
        k++;
      }
      if (!closed) fail('the text that starts here has no closing quote', i);
      tokens.push({ t: 'str', v: value, at: i });
      i = k + 1;
      continue;
    }
    if (text.startsWith('&&', i)) { tokens.push({ t: 'and', at: i }); i += 2; continue; }
    if (text.startsWith('||', i)) { tokens.push({ t: 'or', at: i }); i += 2; continue; }
    let op = null;
    for (const candidate of OPERATORS) {
      if (text.startsWith(candidate, i)) { op = candidate; break; }
    }
    if (op) {
      tokens.push({ t: 'op', v: op === '=' ? '==' : op === '<>' ? '!=' : op, at: i });
      i += op.length;
      continue;
    }
    if (ch === '!') { tokens.push({ t: 'not', at: i }); i++; continue; }
    const number = /^-?\d+(?:[.,]\d+)?(?![A-Za-z0-9[#])/.exec(text.slice(i, i + 420));
    if (number) {
      tokens.push({ t: 'num', v: shared.parseDecimal(number[0]), at: i });
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z][A-Za-z0-9]*/.exec(text.slice(i, i + 40));
    if (word) {
      const lower = word[0].toLowerCase();
      const after = text[i + word[0].length];
      // Inside count(...), sum(...) and exists(...) a word is always a segment id, also AND, OR and NOT.
      const inFunction = tokens.length >= 2 && tokens[tokens.length - 1].t === '(' && tokens[tokens.length - 2].t === 'fn';
      if (!inFunction && KEYWORDS.indexOf(lower) !== -1 && after !== '[' && after !== '-' && after !== '#') {
        tokens.push({ t: lower, at: i });
        i += word[0].length;
        continue;
      }
      if (!inFunction && FUNCTIONS.indexOf(lower) !== -1 && /^\s*\(/.test(text.slice(i + word[0].length))) {
        tokens.push({ t: 'fn', v: lower, at: i });
        i += word[0].length;
        continue;
      }
      shared.SELECTOR_AT.lastIndex = i;
      const m = shared.SELECTOR_AT.exec(text);
      if (m && m.index === i) {
        const sel = shared.parseSelector(m[0]);
        const next = text[i + m[0].length];
        if (sel.ok && !(next && /[A-Za-z0-9[\].#]/.test(next))) {
          tokens.push({ t: 'sel', v: sel, at: i });
          i += m[0].length;
          continue;
        }
      }
      fail('"' + shared.show(text.slice(i, i + 20), 20) + '" is not a path, a function or a keyword', i);
    }
    fail('unexpected character "' + ch + '"', i);
  }
  tokens.push({ t: 'end', at: text.length });
  return tokens;
}

/**
 * Compiles a query. options: ignoreCase. Returns { ok: true, text, ast, ids (the segment ids the
 * query reads) } or { ok: false, code, message, position }.
 */
function compile(input, options) {
  const text = typeof input === 'string' ? input.trim() : '';
  const ignoreCase = !!(options && options.ignoreCase);
  if (text === '') return { ok: false, code: CODES.syntax, message: 'The query is empty.', position: 0 };
  if (text.length > MAX_QUERY_LENGTH) return { ok: false, code: CODES.tooLong, message: 'The query is longer than ' + MAX_QUERY_LENGTH + ' characters.', position: MAX_QUERY_LENGTH };
  let tokens;
  let pos = 0;
  let nodes = 0;
  const leafs = [];
  const fail = function (message, at) { const e = new Error(message); e.position = at; throw e; };
  const peek = function () { return tokens[pos]; };
  const take = function () { return tokens[pos++]; };
  const count = function () { if (++nodes > MAX_NODES) fail('the query has too many parts', peek().at); };

  function operand() {
    const tok = take();
    if (tok.t === 'str') return { k: 'str', v: tok.v };
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === 'sel') {
      if (!tok.v.element) fail('a path in a comparison needs an element, for example ' + tok.v.text + '-1 (or use exists(' + tok.v.text + ') or count(' + tok.v.text + '))', tok.at);
      return { k: 'sel', sel: tok.v };
    }
    if (tok.t === 'fn' && tok.v !== 'exists') {
      if (take().t !== '(') fail('"(" expected after ' + tok.v, tok.at);
      const inner = take();
      if (inner.t !== 'sel') fail('a path is expected inside ' + tok.v + '(...)', inner.at);
      if (tok.v === 'sum' && !inner.v.element) fail('sum(...) needs a path with an element', inner.at);
      if (take().t !== ')') fail('")" expected', tokens[pos - 1].at);
      return { k: tok.v, sel: inner.v };
    }
    return fail('a path, count(...), sum(...), a text in quotes or a number is expected here', tok.at);
  }

  function primary() {
    count();
    const tok = peek();
    if (tok.t === '(') {
      take();
      const inner = or();
      if (take().t !== ')') fail('")" expected', tokens[pos - 1].at);
      return inner;
    }
    if (tok.t === 'fn' && tok.v === 'exists') {
      take();
      if (take().t !== '(') fail('"(" expected after exists', tok.at);
      const inner = take();
      if (inner.t !== 'sel') fail('a segment or a path is expected inside exists(...)', inner.at);
      if (take().t !== ')') fail('")" expected', tokens[pos - 1].at);
      const node = { t: 'exists', sel: inner.v, slot: leafs.length };
      leafs.push(node);
      return node;
    }
    const left = operand();
    const op = take();
    if (op.t !== 'op') fail('a comparison operator (==, !=, <, <=, >, >=) is expected here', op.at);
    const right = operand();
    if ((left.k === 'str' || left.k === 'num') && (right.k === 'str' || right.k === 'num')) fail('at least one side of a comparison must be a path, count(...) or sum(...)', op.at);
    const node = { t: 'cmp', op: op.v, left: left, right: right, slot: leafs.length };
    leafs.push(node);
    return node;
  }
  function not() {
    if (peek().t === 'not') {
      take();
      count();
      const first = leafs.length;
      const node = { t: 'not', a: not() };
      // Every part below a NOT changes side; a part under two NOTs is back on the plain side.
      for (let i = first; i < leafs.length; i++) leafs[i].negated = !leafs[i].negated;
      return node;
    }
    return primary();
  }
  function and() {
    let node = not();
    while (peek().t === 'and') { take(); count(); node = { t: 'and', a: node, b: not() }; }
    return node;
  }
  function or() {
    let node = and();
    while (peek().t === 'or') { take(); count(); node = { t: 'or', a: node, b: and() }; }
    return node;
  }

  try {
    tokens = tokenize(text);
    const ast = or();
    if (peek().t !== 'end') fail('AND, OR or the end of the query is expected here', peek().at);
    const ids = new Set();
    leafs.forEach(function (leaf) {
      if (leaf.t === 'exists') ids.add(leaf.sel.id);
      else [leaf.left, leaf.right].forEach(function (side) { if (side.sel) ids.add(side.sel.id); });
    });
    return { ok: true, text: text, ast: ast, leafs: leafs, ids: ids, ignoreCase: ignoreCase };
  } catch (e) {
    const position = typeof e.position === 'number' ? e.position : 0;
    return { ok: false, code: CODES.syntax, message: 'The query is not valid at position ' + (position + 1) + ': ' + e.message + '.', position: position };
  }
}

// ---------------------------------------------------------------------------------------------
// Checking one message.

/**
 * Compares two values. `asText` forces a comparison of text (one side is a text in quotes);
 * otherwise two decimals are compared exactly as numbers and anything else as text. `pattern`
 * says that b is a quoted text in which * is a wildcard.
 */
function compareValues(op, a, b, ignoreCase, asText, pattern) {
  const order = asText ? null : shared.compareDecimal(typeof a === 'object' ? a : String(a), typeof b === 'object' ? b : String(b));
  if (order !== null) {
    switch (op) {
      case '==': return order === 0;
      case '!=': return order !== 0;
      case '<': return order < 0;
      case '<=': return order <= 0;
      case '>': return order > 0;
      default: return order >= 0;
    }
  }
  let x = typeof a === 'object' ? shared.formatDecimal(a) : String(a);
  let y = typeof b === 'object' ? shared.formatDecimal(b) : String(b);
  if (ignoreCase) { x = x.toLowerCase(); y = y.toLowerCase(); }
  if (op === '==' || op === '!=') {
    const equal = pattern && y.indexOf('*') !== -1 ? shared.globMatch(y, x) : x === y;
    return op === '==' ? equal : !equal;
  }
  switch (op) {
    case '<': return x < y;
    case '<=': return x <= y;
    case '>': return x > y;
    default: return x >= y;
  }
}

const FLIP = { '==': '==', '!=': '!=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

/** Creates the per-message state of one operand that reads segments (a path, count or sum). */
function operandState(side) {
  return { side: side, seen: 0, n: 0, sum: { n: 0n, scale: 0 }, summed: 0, values: [], dropped: false };
}

function feedOperand(st, segment, getElements, onValue) {
  const sel = st.side.sel;
  if (segment.id !== sel.id) return;
  const elements = getElements();
  if (!shared.matchesSegment(sel, segment, elements)) return;
  st.seen++;
  if (sel.occurrence && sel.occurrence !== st.seen) return;
  if (!sel.element) { st.n++; return; }
  const pieces = shared.targets(sel, elements);
  for (let i = 0; i < pieces.length; i++) {
    const value = pieces[i].raw.trim();
    if (value === '') continue;
    st.n++;
    if (st.side.k === 'sum') {
      const num = shared.parseDecimal(value);
      if (num) { st.sum = shared.addDecimal(st.sum, num); st.summed++; }
    } else if (st.side.k === 'sel') {
      onValue(value, segment, pieces[i]);
    }
  }
}

/** Creates the state of one leaf (a comparison or exists) for one message. */
function leafState(leaf, ignoreCase, positionOf) {
  const st = { truth: false, hits: [] };
  const hit = function (value, segment, piece) {
    st.truth = true;
    // A part that stands under NOT is true when nothing was found, so it has nothing to show.
    if (!leaf.negated && st.hits.length < MAX_HITS_PER_UNIT) {
      const p = positionOf(piece ? piece.offset : segment.offset);
      st.hits.push({
        path: shared.concretePath(segment, piece), value: shared.show(value, 200), line: p.line, column: p.column,
        length: piece ? piece.end - piece.offset : segment.raw.length,
      });
    }
  };
  if (leaf.t === 'exists') {
    const os = operandState({ k: 'sel', sel: leaf.sel });
    st.feed = function (segment, getElements) {
      const before = os.n;
      feedOperand(os, segment, getElements, function (value, seg, piece) { hit(value, seg, piece); });
      if (!leaf.sel.element && os.n > before) hit(shared.show(segment.raw, 200), segment, null);
    };
    st.finish = function () { return st.truth; };
    return st;
  }
  const literalRight = leaf.right.k === 'str' || leaf.right.k === 'num';
  const literalLeft = leaf.left.k === 'str' || leaf.left.k === 'num';
  if (leaf.left.k === 'sel' && literalRight) {
    const os = operandState(leaf.left);
    st.feed = function (segment, getElements) {
      feedOperand(os, segment, getElements, function (value, seg, piece) {
        if (compareValues(leaf.op, value, leaf.right.v, ignoreCase, leaf.right.k === 'str', leaf.right.k === 'str')) hit(value, seg, piece);
      });
    };
    st.finish = function () { return st.truth; };
    return st;
  }
  if (leaf.right.k === 'sel' && literalLeft) {
    const os = operandState(leaf.right);
    st.feed = function (segment, getElements) {
      feedOperand(os, segment, getElements, function (value, seg, piece) {
        if (compareValues(FLIP[leaf.op], value, leaf.left.v, ignoreCase, leaf.left.k === 'str', leaf.left.k === 'str')) hit(value, seg, piece);
      });
    };
    st.finish = function () { return st.truth; };
    return st;
  }
  // General case: both sides are collected and compared at the end of the message.
  const sides = [leaf.left, leaf.right].map(function (side) {
    if (side.k === 'str' || side.k === 'num') return { literal: side.v };
    const os = operandState(side);
    os.kept = [];
    return os;
  });
  st.feed = function (segment, getElements) {
    sides.forEach(function (os) {
      if (os.literal !== undefined) return;
      feedOperand(os, segment, getElements, function (value, seg, piece) {
        if (os.kept.length < MAX_KEPT_VALUES) os.kept.push({ value: value, segment: seg, piece: piece });
      });
    });
  };
  st.finish = function () {
    const lists = sides.map(function (os) {
      if (os.literal !== undefined) return [{ value: os.literal }];
      if (os.side.k === 'count') return [{ value: os.n }];
      if (os.side.k === 'sum') return os.summed > 0 ? [{ value: os.sum }] : [];
      return os.kept;
    });
    // A text in quotes on either side makes it a comparison of text.
    const asText = leaf.left.k === 'str' || leaf.right.k === 'str';
    let work = 0;
    for (let i = 0; i < lists[0].length && !st.truth; i++) {
      for (let k = 0; k < lists[1].length; k++) {
        if (++work > 200000) return st.truth;
        if (compareValues(leaf.op, lists[0][i].value, lists[1][k].value, ignoreCase, asText, leaf.right.k === 'str')) {
          const shown = lists[0][i].segment ? lists[0][i] : lists[1][k];
          if (shown.segment) hit(shown.value, shown.segment, shown.piece);
          st.truth = true;
          break;
        }
      }
    }
    return st.truth;
  };
  return st;
}

function evaluate(node, truths) {
  switch (node.t) {
    case 'and': return evaluate(node.a, truths) && evaluate(node.b, truths);
    case 'or': return evaluate(node.a, truths) || evaluate(node.b, truths);
    case 'not': return !evaluate(node.a, truths);
    default: return truths[node.slot];
  }
}

/**
 * Runs a compiled query over one text. options: maxResults (default 1000, at most 10,000),
 * isCancelled (function). Returns { ok: true, format, units, matches, truncated, cancelled } or
 * { ok: false, code, message }. A match is { unit, type, ref, line, column, hits } where hits are
 * the values that satisfied a comparison: [{ path, value, line, column, length }] (0-based lines;
 * path counts occurrences like the hover does).
 */
function scanText(text, compiled, options) {
  const o = options || {};
  const maxResults = Math.max(1, Math.min(HARD_MAX_RESULTS, Number(o.maxResults) > 0 ? Math.floor(Number(o.maxResults)) : DEFAULT_MAX_RESULTS));
  const source = typeof text === 'string' ? text : '';
  const out = { ok: true, format: null, units: 0, matches: [], truncated: false, cancelled: false };
  const at = shared.makePositioner(source);
  // Positions are asked for in text order within a message; the converter copes with a step back.
  const positionOf = function (offset) { return at(offset); };
  let states = null;
  let seen = 0;
  const walked = shared.walkUnits(source, {
    onUnitStart: function () {
      states = compiled.leafs.map(function (leaf) { return leafState(leaf, compiled.ignoreCase, positionOf); });
    },
    onSegment: function (unit, segment, getElements) {
      if ((++seen & 4095) === 0 && typeof o.isCancelled === 'function' && o.isCancelled()) {
        out.cancelled = true;
        return false;
      }
      if (!compiled.ids.has(segment.id)) return undefined;
      for (let i = 0; i < states.length; i++) states[i].feed(segment, getElements);
      return undefined;
    },
    onUnitEnd: function (unit) {
      if (!states || out.cancelled) return;
      const truths = states.map(function (s) { return s.finish(); });
      if (evaluate(compiled.ast, truths)) {
        if (out.matches.length >= maxResults) { out.truncated = true; states = null; return; }
        const hits = [];
        const seenHits = new Set();
        states.forEach(function (s, i) {
          if (!truths[i]) return;
          s.hits.forEach(function (h) {
            const key = h.path + '@' + h.line + ':' + h.column;
            if (hits.length < MAX_HITS_PER_UNIT && !seenHits.has(key)) { seenHits.add(key); hits.push(h); }
          });
        });
        hits.sort(function (a, b) { return a.line - b.line || a.column - b.column; });
        out.matches.push({ unit: unit.index, type: unit.type, ref: unit.ref, line: unit.line, column: unit.column, hits: hits });
      }
      states = null;
    },
  });
  if (!walked.ok) return { ok: false, code: CODES.notEdi, message: 'The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message, so it was not searched.' };
  out.format = walked.format;
  out.units = walked.units;
  return out;
}

/**
 * Writes query results as CSV. files: [{ label, result }] with result from scanText. One row per
 * matched value; a message that matched without a value gets one row with empty value columns.
 */
function toCsv(files, neutralise) {
  const f = function (v) { return shared.csvField(v, neutralise); };
  const rows = ['file,message_number,message_type,reference,line,column,path,value'];
  files.forEach(function (file) {
    if (!file.result || !file.result.matches) return;
    file.result.matches.forEach(function (m) {
      if (m.hits.length === 0) {
        rows.push([f(file.label), m.unit, f(m.type), f(m.ref), m.line + 1, m.column + 1, '', ''].join(','));
      }
      m.hits.forEach(function (h) {
        rows.push([f(file.label), m.unit, f(m.type), f(m.ref), h.line + 1, h.column + 1, f(h.path), f(h.value)].join(','));
      });
    });
  });
  return rows.join('\r\n') + '\r\n';
}

module.exports = { CODES, compile, scanText, toCsv, limits: { maxResults: HARD_MAX_RESULTS, defaultMaxResults: DEFAULT_MAX_RESULTS, maxQueryLength: MAX_QUERY_LENGTH } };
