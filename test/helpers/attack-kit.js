'use strict';

/*
 * Shared helpers for the adversarial tests (test/attack.*.test.js): a seeded
 * random number source, writers that build messages from a known outline (so
 * the parsed result can be compared with what was written), a strict reader
 * for the exported XML and a reader for the exported CSV.
 */

/** Returns a deterministic random number function giving numbers in [0, 1). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks one entry of a list. */
function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

const REPLACEMENT = String.fromCharCode(0xfffd);
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);
const NUL = String.fromCharCode(0);

/** Characters used inside random values: accents, symbols, an astral character, NUL, tab, no-break space and every delimiter. */
const DATA_CHARS = [
  'A', 'b', '7', ' ', String.fromCharCode(0xe9), String.fromCharCode(0x20ac), String.fromCodePoint(0x1f600), 'x', '.', ',', '-', '/', '@', '"', '<', '&',
  NUL, '\t', NBSP, String.fromCharCode(0x65e5, 0x672c), "'", '*', ':', '+', '?', '~', '|', '^', '\\', '#', '!', '`', '$', ';',
];

/** Builds a value of 0 to 3 characters that contains none of the characters in avoid. */
function randomValue(rand, avoid) {
  const safe = DATA_CHARS.filter((ch) => !avoid.some((a) => ch.indexOf(a) !== -1));
  let out = '';
  const n = Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) out += pick(rand, safe);
  return out;
}

/**
 * Writes a random UN/EDIFACT text. Returns { text, plan, delimiters, hasUna }.
 * The plan is a list of { id, elements, plain }: an element is a list of
 * repetitions, a repetition a list of components. elements holds the text as
 * written (with release characters), plain the values without them.
 * Delimiters, line breaks and the presence of UNA come from the seed.
 */
function writeEdifact(rand) {
  const sets = [
    { c: ':', e: '+', d: '.', r: '?', rep: '', t: "'" },
    { c: ';', e: ',', d: '.', r: '\\', rep: '', t: '~' },
    { c: ':', e: '+', d: ',', r: '?', rep: '*', t: "'" },
    { c: '^', e: '|', d: '.', r: '!', rep: '', t: '#' },
    { c: ':', e: '+', d: '.', r: ' ', rep: ' ', t: "'" },
    { c: ':', e: '+', d: '.', r: '?', rep: '', t: '\n' },
  ];
  const D = pick(rand, sets);
  const hasUna = rand() < 0.7 || D !== sets[0];
  const release = D.r.trim();
  const repSep = D.rep.trim();
  const special = [D.c, D.e, D.t].concat(release ? [release] : [], repSep ? [repSep] : []);
  const escape = (value) => {
    if (!release) return value;
    let out = '';
    for (const ch of value) out += special.indexOf(ch) !== -1 ? release + ch : ch;
    return out;
  };
  const avoid = special.concat(['\n', '\r']);
  const plan = [];
  const count = 1 + Math.floor(rand() * 8);
  for (let s = 0; s < count; s++) {
    const id = s === 0 ? 'UNB' : pick(rand, ['UNB', 'UNH', 'NAD', 'LIN', 'QTY', 'UNT', 'UNZ']);
    const elements = [];
    const plain = [];
    const ne = Math.floor(rand() * 6);
    for (let e = 0; e < ne; e++) {
      const reps = repSep && rand() < 0.3 ? 2 : 1;
      const el = [];
      const pl = [];
      for (let r = 0; r < reps; r++) {
        const comps = [];
        const plainComps = [];
        const nc = 1 + Math.floor(rand() * 3);
        for (let c = 0; c < nc; c++) {
          // A value may contain a delimiter only when a release character can escape it.
          let v = randomValue(rand, avoid);
          if (release && rand() < 0.2) v += pick(rand, special);
          plainComps.push(v);
          comps.push(escape(v));
        }
        el.push(comps);
        pl.push(plainComps);
      }
      elements.push(el);
      plain.push(pl);
    }
    plan.push({ id, elements, plain });
  }
  const lineBreak = D.t === '\n' ? '' : pick(rand, ['', '', '\n', '\r\n', '\r']);
  let text = hasUna ? 'UNA' + D.c + D.e + D.d + D.r + (D.rep || ' ') + D.t : '';
  if (hasUna && D.t !== '\n') text += lineBreak;
  for (const seg of plan) {
    let line = seg.id;
    for (const el of seg.elements) {
      line += D.e + el.map((comps) => comps.join(D.c)).join(repSep);
    }
    text += line + D.t + lineBreak;
  }
  return { text, plan, delimiters: D, hasUna };
}

/**
 * Writes a random X12 text with an exact 106 character ISA and random
 * delimiters. Returns { text, plan, element, component, terminator,
 * repetition }.
 */
function writeX12(rand) {
  const element = pick(rand, ['*', '|', '>', '^']);
  const component = pick(rand, [':', '<', '\\', '$']);
  const term = pick(rand, ['~', '\n', '\r\n', '!', '\r', String.fromCharCode(0x1c), '`']);
  const terminator = term.charAt(0);
  const isaRep = pick(rand, ['U', '^', '`', '+', '|']);
  const real = [element, component, terminator];
  const repetition = isaRep !== 'U' && real.indexOf(isaRep) === -1 ? isaRep : '';
  const avoid = real.concat(repetition ? [repetition] : [], ['\n', '\r', String.fromCharCode(0x1c)]);
  const pad = (v, n) => String(v).padEnd(n);
  const isa = ['ISA', '00', pad('', 10), '00', pad('', 10), 'ZZ', pad('SENDER', 15), 'ZZ', pad('RECEIVER', 15), '210101', '1200', isaRep, '00501', '000000001', '0', 'P', component].join(element) + terminator;
  const plan = [];
  const n = Math.floor(rand() * 8);
  for (let i = 0; i < n; i++) {
    const elements = [];
    const ne = Math.floor(rand() * 6);
    for (let e = 0; e < ne; e++) {
      const reps = repetition && rand() < 0.3 ? 2 : 1;
      const el = [];
      for (let r = 0; r < reps; r++) {
        const comps = [];
        const nc = 1 + Math.floor(rand() * 3);
        for (let c = 0; c < nc; c++) comps.push(randomValue(rand, avoid));
        el.push(comps);
      }
      elements.push(el);
    }
    plan.push({ id: pick(rand, ['GS', 'ST', 'BEG', 'N1', 'REF', 'SE', 'GE', 'IEA', 'DTM']), elements });
  }
  const gap = term === '\n' || term === '\r\n' ? '' : pick(rand, ['', '', '\n', '\r\n', ' ']);
  let text = isa + gap;
  for (const seg of plan) {
    let line = seg.id;
    for (const el of seg.elements) line += element + el.map((comps) => comps.join(component)).join(repetition);
    text += line + term + gap;
  }
  return { text, plan, element, component, terminator, repetition };
}

/**
 * Writes a random HL7 v2 text with random encoding characters, escape
 * sequences in the values, repetitions, components and subcomponents, Z
 * segments, mixed line endings and sometimes a byte order mark. Returns
 * { text, plan, field, component, repetition, escape, subcomponent }.
 */
function writeHl7(rand) {
  const [field, component, repetition, escape, subcomponent] = pick(rand, [
    ['|', '^', '~', '\\', '&'],
    ['#', '*', '+', '!', '$'],
    ['|', '^', '~', '\\', '&'],
    [';', ',', '.', '/', ':'],
  ]);
  const specials = [field, component, repetition, escape, subcomponent];
  const avoid = specials.concat(['\n', '\r']);
  const value = () => {
    let v = '';
    const n = Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      if (rand() < 0.15) v += escape + pick(rand, ['F', 'S', 'T', 'R', 'E', 'X0D']) + escape;
      else v += Array.from(randomValue(rand, avoid))[0] || 'q';
    }
    return v;
  };
  const plan = [];
  const n = Math.floor(rand() * 8);
  for (let i = 0; i < n; i++) {
    const fields = [];
    const nf = Math.floor(rand() * 6);
    for (let f = 0; f < nf; f++) {
      const reps = rand() < 0.3 ? 2 : 1;
      const rl = [];
      for (let r = 0; r < reps; r++) {
        const cl = [];
        const nc = 1 + Math.floor(rand() * 3);
        for (let c = 0; c < nc; c++) {
          const sl = [];
          const ns = rand() < 0.3 ? 2 : 1;
          for (let s = 0; s < ns; s++) sl.push(value());
          cl.push(sl);
        }
        rl.push(cl);
      }
      fields.push(rl);
    }
    plan.push({ id: pick(rand, ['PID', 'OBX', 'ZPI', 'NK1', 'EVN', 'Z01', 'OBR']), fields });
  }
  const eols = ['\r', '\n', '\r\n'];
  const mixed = rand() < 0.3;
  const first = pick(rand, eols);
  const next = () => (mixed ? pick(rand, eols) : first);
  let text = 'MSH' + field + component + repetition + escape + subcomponent + field + 'APP' + field + 'FAC' + field + field + field + '20200101' + field + field + 'ADT' + component + 'A01' + field + 'C1' + field + 'P' + field + '2.5';
  for (const seg of plan) {
    text += next() + seg.id + seg.fields.map((rl) => field + rl.map((cl) => cl.map((sl) => sl.join(subcomponent)).join(component)).join(repetition)).join('');
  }
  if (rand() < 0.5) text += next();
  if (rand() < 0.3) text = BOM + text;
  return { text, plan, field, component, repetition, escape, subcomponent };
}

/**
 * Compares the segments of a parsed message with the plan used to write it.
 * Returns a list of problems (empty when everything matches). skip is the
 * number of leading parsed segments that are not in the plan; kind is 'hl7'
 * for the plan of writeHl7 (fields with subcomponents) and anything else for
 * the plans of writeEdifact and writeX12.
 */
function compareToPlan(message, plan, skip, kind) {
  const problems = [];
  const segs = message.segments.slice(skip);
  if (segs.length !== plan.length) {
    problems.push('segment count ' + segs.length + ' instead of ' + plan.length);
    return problems;
  }
  plan.forEach((m, i) => {
    const seg = segs[i];
    if (seg.id !== m.id) problems.push('segment ' + i + ' id ' + seg.id + ' instead of ' + m.id);
    const list = kind === 'hl7' ? m.fields : m.elements;
    if (seg.elements.length !== list.length) {
      problems.push('segment ' + i + ' has ' + seg.elements.length + ' elements instead of ' + list.length);
      return;
    }
    list.forEach((reps, k) => {
      const el = seg.elements[k];
      if (el.repetitions.length !== reps.length) {
        problems.push('segment ' + i + ' element ' + k + ' repetitions');
        return;
      }
      reps.forEach((comps, r) => {
        const rep = el.repetitions[r];
        if (rep.components.length !== comps.length) {
          problems.push('segment ' + i + ' element ' + k + ' component count');
          return;
        }
        comps.forEach((expected, j) => {
          const comp = rep.components[j];
          if (kind === 'hl7') {
            const same = comp.subcomponents.length === expected.length && comp.subcomponents.every((sub, q) => sub.raw === expected[q]);
            if (!same) problems.push('segment ' + i + ' element ' + k + ' subcomponents ' + JSON.stringify(comp.raw));
          } else if (comp.raw !== expected) {
            problems.push('segment ' + i + ' element ' + k + ' component ' + j + ' ' + JSON.stringify(comp.raw) + ' instead of ' + JSON.stringify(expected));
          }
        });
      });
    });
  });
  return problems;
}

/** Replaces the characters XML 1.0 forbids with U+FFFD, the same rule the exporter applies. */
function xmlSafe(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += REPLACEMENT;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += REPLACEMENT;
    } else if ((code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffe || code === 0xffff) {
      out += REPLACEMENT;
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * A strict reader for the XML the exporter writes. Throws an Error when the
 * text is not well formed (bad names, unclosed tags, a bare & or <, an
 * undefined entity, a forbidden character, text outside the root). Returns
 * the root as { name, attrs, children, text } where text is the decoded
 * character data of an element.
 */
function readXml(xml) {
  let pos = 0;
  const fail = (why) => {
    throw new Error('XML not well formed at ' + pos + ': ' + why);
  };
  for (let i = 0; i < xml.length; i++) {
    const code = xml.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = xml.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('lone surrogate');
      i++;
    } else if ((code >= 0xdc00 && code <= 0xdfff) || (code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffe || code === 0xffff) {
      pos = i;
      fail('forbidden character U+' + code.toString(16));
    }
  }
  const decode = (raw) => {
    if (raw.indexOf('<') !== -1) fail('< in text');
    return raw.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z]+);|&/g, (all, name) => {
      if (!name) fail('bare &');
      if (name === 'amp') return '&';
      if (name === 'lt') return '<';
      if (name === 'gt') return '>';
      if (name === 'quot') return '"';
      if (name === 'apos') return "'";
      if (name[0] === '#') {
        const cp = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        const allowed = cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
        if (!allowed) fail('bad character reference');
        return String.fromCodePoint(cp);
      }
      return fail('undefined entity &' + name + ';');
    });
  };
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) fail('missing declaration');
  pos = xml.indexOf('?>') + 2;
  const stack = [];
  let root = null;
  const tag = /<(\/?)([A-Za-z_][A-Za-z0-9_.-]*)((?:\s+[A-Za-z_][A-Za-z0-9_.-]*="[^"<]*")*)\s*(\/?)>/y;
  while (pos < xml.length) {
    if (xml[pos] !== '<') {
      const end = xml.indexOf('<', pos);
      const raw = xml.slice(pos, end === -1 ? xml.length : end);
      if (stack.length === 0) {
        if (raw.trim() !== '') fail('text outside the root');
      } else {
        stack[stack.length - 1].text += decode(raw);
      }
      pos = end === -1 ? xml.length : end;
      continue;
    }
    tag.lastIndex = pos;
    const m = tag.exec(xml);
    if (!m) fail('bad tag');
    const attrs = {};
    const attrRe = /([A-Za-z_][A-Za-z0-9_.-]*)="([^"<]*)"/g;
    let a;
    while ((a = attrRe.exec(m[3]))) {
      if (Object.prototype.hasOwnProperty.call(attrs, a[1])) fail('duplicate attribute');
      attrs[a[1]] = decode(a[2]);
    }
    if (m[1] === '/') {
      const open = stack.pop();
      if (!open || open.name !== m[2]) fail('mismatched closing tag ' + m[2]);
    } else {
      const node = { name: m[2], attrs, children: [], text: '' };
      if (stack.length > 0) stack[stack.length - 1].children.push(node);
      else if (root) fail('second root');
      else root = node;
      if (m[4] !== '/') stack.push(node);
    }
    pos = tag.lastIndex;
  }
  if (stack.length > 0) fail('unclosed tag ' + stack[stack.length - 1].name);
  if (!root) fail('no root');
  return root;
}

/** Reads RFC 4180 CSV text (CRLF rows, quoted fields) into a list of rows. Throws when malformed. */
function readCsv(csv) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  const n = csv.length;
  while (i < n) {
    const ch = csv[i];
    if (ch === '"') {
      if (field !== '') throw new Error('quote in the middle of an unquoted field at ' + i);
      i++;
      for (;;) {
        if (i >= n) throw new Error('unterminated quoted field');
        if (csv[i] === '"') {
          if (csv[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += csv[i++];
      }
      if (i < n && csv[i] !== ',' && csv[i] !== '\r') throw new Error('text after closing quote at ' + i);
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r') {
      if (csv[i + 1] !== '\n') throw new Error('bare CR at ' + i);
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
    } else if (ch === '\n') {
      throw new Error('bare LF at ' + i);
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length > 0) throw new Error('last row has no CRLF');
  return rows;
}

/**
 * Lists the rows the CSV export must contain, worked out independently of
 * the exporter: [segment, occurrence, path, value] per element, component or
 * subcomponent (one row for a segment without elements).
 */
function expectedCsvRows(message) {
  const rows = [];
  const counts = new Map();
  message.segments.forEach((seg) => {
    const n = (counts.get(seg.id) || 0) + 1;
    counts.set(seg.id, n);
    const base = seg.id + '[' + n + ']';
    if (seg.elements.length === 0) {
      rows.push([seg.id, String(n), base, '']);
      return;
    }
    seg.elements.forEach((el) => {
      el.repetitions.forEach((rep, r) => {
        const repText = r > 0 ? '(' + (r + 1) + ')' : '';
        rep.components.forEach((comp) => {
          if (comp.subcomponents.length > 1) {
            comp.subcomponents.forEach((sub) => {
              rows.push([seg.id, String(n), base + '-' + el.index + repText + '.' + comp.index + '.' + sub.index, sub.raw]);
            });
          } else {
            rows.push([seg.id, String(n), base + '-' + el.index + repText + '.' + comp.index, comp.raw]);
          }
        });
      });
    });
  });
  return rows;
}

/** Builds a UN/EDIFACT interchange with one message holding bodyPairs LIN and QTY segment pairs. */
function bigEdifact(bodyPairs) {
  const parts = ["UNB+UNOA:1+SENDER+RECEIVER+200101:1200+1'", "UNH+1+ORDERS:D:96A'"];
  for (let i = 1; i <= bodyPairs; i++) {
    parts.push('LIN+' + i + '++4012345' + String(i).padStart(6, '0') + ":EN'QTY+21:" + (i % 100) + ":PCE'");
  }
  parts.push('UNT+' + (bodyPairs * 2 + 2) + "+1'UNZ+1+1'");
  return parts.join('');
}

module.exports = {
  rng,
  pick,
  randomValue,
  writeEdifact,
  writeX12,
  writeHl7,
  compareToPlan,
  xmlSafe,
  readXml,
  readCsv,
  expectedCsvRows,
  bigEdifact,
  BOM,
  NBSP,
  NUL,
  REPLACEMENT,
};
