'use strict';

/*
 * A deliberately small tokenizer used only by the validator tests when the
 * main parser is not available. It builds Message objects as described in the
 * specification (segments, elements, repetitions, components,
 * subcomponents) and never throws. It is not shipped with the extension.
 */

function splitTop(str, sep, release) {
  const out = [];
  let start = 0;
  let i = 0;
  while (i < str.length) {
    const ch = str.charAt(i);
    if (release && ch === release) {
      i += 2;
      continue;
    }
    if (sep && ch === sep) {
      out.push({ start: start, end: i });
      start = i + 1;
    }
    i++;
  }
  out.push({ start: start, end: Math.min(str.length, Math.max(start, str.length)) });
  return out;
}

function buildElement(raw, abs, index, seps) {
  const reps = seps.repetition ? splitTop(raw, seps.repetition, seps.release) : [{ start: 0, end: raw.length }];
  const repetitions = reps.map(function (r) {
    const repRaw = raw.slice(r.start, r.end);
    const comps = seps.component ? splitTop(repRaw, seps.component, seps.release) : [{ start: 0, end: repRaw.length }];
    return {
      components: comps.map(function (cp, ci) {
        const cRaw = repRaw.slice(cp.start, cp.end);
        const subs = seps.subcomponent ? splitTop(cRaw, seps.subcomponent, seps.release) : [{ start: 0, end: cRaw.length }];
        return {
          index: ci + 1,
          offset: abs + r.start + cp.start,
          end: abs + r.start + cp.end,
          raw: cRaw,
          subcomponents: subs.map(function (sp, si) {
            return {
              index: si + 1,
              offset: abs + r.start + cp.start + sp.start,
              end: abs + r.start + cp.start + sp.end,
              raw: cRaw.slice(sp.start, sp.end),
            };
          }),
        };
      }),
    };
  });
  return { index: index, offset: abs, end: abs + raw.length, raw: raw, repetitions: repetitions };
}

function makeSegment(text, raw, offset, end, state, seps, elementSep, mshStyle) {
  const pieces = splitTop(raw, elementSep, seps.release);
  const id = raw.slice(pieces[0].start, pieces[0].end);
  const elements = [];
  if (mshStyle && id === 'MSH' && pieces.length >= 1 && raw.length >= 4) {
    elements.push(buildElement(raw.charAt(3), offset + 3, 1, {}));
  }
  for (let k = 1; k < pieces.length; k++) {
    const pr = raw.slice(pieces[k].start, pieces[k].end);
    const idx = mshStyle && id === 'MSH' ? k + 1 : k;
    const sepsHere = mshStyle && id === 'MSH' && k === 1 ? {} : seps;
    elements.push(buildElement(pr, offset + pieces[k].start, idx, sepsHere));
  }
  state.occ[id] = (state.occ[id] || 0) + 1;
  let line = 0;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10 || (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) !== 10)) line++;
  return {
    id: id,
    index: state.segments.length,
    occurrence: state.occ[id],
    offset: offset,
    end: end,
    line: line,
    raw: raw,
    elements: elements,
  };
}

function skipLeading(text) {
  let pos = 0;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;
  while (pos < text.length && /\s/.test(text.charAt(pos))) pos++;
  return pos;
}

function parseEdifact(text) {
  let pos = skipLeading(text);
  const d = { component: ':', element: '+', decimal: '.', release: '?', repetition: '*', segment: "'" };
  const state = { segments: [], occ: {} };
  if (text.substr(pos, 3) === 'UNA' && text.length >= pos + 9) {
    d.component = text.charAt(pos + 3);
    d.element = text.charAt(pos + 4);
    d.decimal = text.charAt(pos + 5);
    d.release = text.charAt(pos + 6);
    d.repetition = text.charAt(pos + 7);
    d.segment = text.charAt(pos + 8);
    state.occ.UNA = 1;
    state.segments.push({
      id: 'UNA',
      index: 0,
      occurrence: 1,
      offset: pos,
      end: pos + 9,
      line: 0,
      raw: text.slice(pos, pos + 8),
      elements: [],
    });
    pos += 9;
  }
  const seps = { component: d.component, release: d.release === ' ' ? '' : d.release };
  while (pos < text.length) {
    while (pos < text.length && (text.charAt(pos) === '\r' || text.charAt(pos) === '\n')) pos++;
    if (pos >= text.length) break;
    let i = pos;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (seps.release && ch === seps.release) {
        i += 2;
        continue;
      }
      if (ch === d.segment) break;
      i++;
    }
    if (i > text.length) i = text.length;
    const terminated = i < text.length && text.charAt(i) === d.segment;
    const raw = text.slice(pos, i);
    const end = terminated ? i + 1 : text.length;
    state.segments.push(makeSegment(text, raw, pos, end, state, seps, d.element, false));
    pos = end;
  }
  return { format: 'edifact', delimiters: d, text: text, segments: state.segments, issues: [] };
}

function parseX12(text, over) {
  let pos = skipLeading(text);
  const d = { element: '*', component: ':', repetition: '^', segment: '~' };
  if (text.substr(pos, 3) === 'ISA' && text.length >= pos + 106) {
    const e = text.charAt(pos + 3);
    const cmp = text.charAt(pos + 104);
    const t = text.charAt(pos + 105);
    if (!/[A-Za-z0-9\s]/.test(e)) d.element = e;
    if (!/[A-Za-z0-9\s]/.test(cmp)) d.component = cmp;
    if (!/[A-Za-z0-9]/.test(t)) d.segment = t;
  }
  if (over) Object.assign(d, over);
  const state = { segments: [], occ: {} };
  const seps = { component: d.component, release: '' };
  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text.charAt(pos))) pos++;
    if (pos >= text.length) break;
    const i = text.indexOf(d.segment, pos);
    const raw = i < 0 ? text.slice(pos) : text.slice(pos, i);
    const end = i < 0 ? text.length : i + 1;
    state.segments.push(makeSegment(text, raw, pos, end, state, seps, d.element, false));
    pos = end;
  }
  return { format: 'x12', delimiters: d, text: text, segments: state.segments, issues: [] };
}

function parseHl7(text) {
  let pos = skipLeading(text);
  const d = { field: '|', component: '^', repetition: '~', escape: '\\', subcomponent: '&', segment: '\r' };
  const head = text.substr(pos, 3);
  if ((head === 'MSH' || head === 'FHS' || head === 'BHS') && text.length > pos + 3) {
    d.field = text.charAt(pos + 3);
    const enc = text.slice(pos + 4, pos + 8);
    if (enc.length === 4) {
      d.component = enc.charAt(0);
      d.repetition = enc.charAt(1);
      d.escape = enc.charAt(2);
      d.subcomponent = enc.charAt(3);
    }
  }
  const state = { segments: [], occ: {} };
  const seps = { component: d.component, repetition: d.repetition, subcomponent: d.subcomponent, release: '' };
  pos = 0;
  while (pos < text.length) {
    let e = pos;
    while (e < text.length && text.charAt(e) !== '\r' && text.charAt(e) !== '\n') e++;
    let t = e;
    if (t < text.length) t += text.charAt(t) === '\r' && text.charAt(t + 1) === '\n' ? 2 : 1;
    let raw = text.slice(pos, e);
    let start = pos;
    if (start === 0 && raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
      start = 1;
    }
    if (raw.trim() !== '') {
      state.segments.push(makeSegment(text, raw, start, t, state, seps, d.field, true));
    }
    pos = t;
  }
  return { format: 'hl7', delimiters: d, text: text, segments: state.segments, issues: [] };
}

/**
 * Parses text into a Message. The format is taken from opts.format when given,
 * otherwise from the first characters (UN* edifact, ISA x12, MSH/FHS/BHS hl7).
 */
function parse(text, opts) {
  const forced = opts && opts.format;
  const pos = skipLeading(text);
  const head = text.substr(pos, 3);
  let format = forced;
  if (!format) {
    if (head === 'ISA') format = 'x12';
    else if (head === 'MSH' || head === 'FHS' || head === 'BHS') format = 'hl7';
    else format = 'edifact';
  }
  if (format === 'x12') return parseX12(text, opts && opts.delimiters);
  if (format === 'hl7') return parseHl7(text);
  return parseEdifact(text);
}

module.exports = { parse: parse };
