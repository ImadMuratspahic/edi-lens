'use strict';

/*
 * Synthetic sample messages and small helpers for the Pro tests. Every value
 * here is invented for testing.
 */

const EDIFACT_ORDER =
  "UNA:+.? '" +
  "UNB+UNOC:3+SENDER:ZZ+RECEIVER:ZZ+240101:1200+REF001'" +
  "UNH+1+ORDERS:D:96A:UN'" +
  "BGM+220+PO-100+9'" +
  "DTM+137:20240101:102'" +
  "NAD+BY+BUYER01::9'" +
  "NAD+SU+SELLER01::9'" +
  "LIN+1++ITEM-A:EN'" +
  "QTY+21:10'" +
  "LIN+2++ITEM-B:EN'" +
  "QTY+21:5'" +
  "UNT+10+1'" +
  "UNZ+1+REF001'";

const HL7_ADT =
  'MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20240101120000||ADT^A01|MSG0001|P|2.5\r' +
  'EVN|A01|20240101120000\r' +
  'PID|1||1001^^^HOSP~1002^^^ALT||Doe^Jane&Q^M||19800101|F\r' +
  'PV1|1|I|WARD^101^A\r';

/**
 * Builds a valid X12 interchange. The ISA segment is exactly 106 characters
 * including the terminator, as the format requires.
 */
function x12Interchange(body, controlNumber) {
  const pad = (value, width) => String(value).padEnd(width, ' ').slice(0, width);
  const control = String(controlNumber || 1).padStart(9, '0');
  const isa =
    'ISA*00*' + pad('', 10) + '*00*' + pad('', 10) + '*ZZ*' + pad('SENDERID', 15) +
    '*ZZ*' + pad('RECEIVERID', 15) + '*240101*1200*U*00401*' + control + '*0*P*>~';
  const segments = body.concat(['IEA*1*' + control]);
  return isa + segments.map((s) => s + '~').join('');
}

const X12_PO = x12Interchange([
  'GS*PO*SENDER*RECEIVER*20240101*1200*1*X*004010',
  'ST*850*0001',
  'BEG*00*SA*PO12345**20240101',
  'N1*BY*Buyer Co*92*B01',
  'PO1*1*10*EA*5.00**VP*ITEM-A',
  'SE*5*0001',
  'GE*1*1',
], 1);

/**
 * Builds a Message by hand from a compact description, following the data
 * message structure. segments is a list of [id, elements] where
 * elements is a list of elements; an element is a string (one component) or
 * a list of components, and a component is a string or a list of
 * subcomponents. An element may also be { reps: [element, ...] } for
 * repetitions.
 */
function buildMessage(format, segments) {
  const counts = new Map();
  let offset = 0;
  const toComponent = (value, index) => {
    const subs = Array.isArray(value) ? value : [value];
    return {
      index,
      offset: 0,
      end: 0,
      raw: subs.join('&'),
      subcomponents: subs.map((raw, i) => ({ index: i + 1, offset: 0, end: 0, raw })),
    };
  };
  const toRepetition = (value) => {
    const comps = Array.isArray(value) ? value : [value];
    return { components: comps.map((c, i) => toComponent(c, i + 1)) };
  };
  const out = {
    format,
    delimiters: {},
    text: '',
    segments: [],
    issues: [],
  };
  segments.forEach(([id, elements], index) => {
    const occurrence = (counts.get(id) || 0) + 1;
    counts.set(id, occurrence);
    const els = (elements || []).map((el, i) => {
      const reps = el && typeof el === 'object' && !Array.isArray(el) && el.reps ? el.reps : [el];
      return {
        index: i + 1,
        offset: 0,
        end: 0,
        raw: '',
        repetitions: reps.map(toRepetition),
      };
    });
    const raw = id + '|' + els.map((e) => e.repetitions.map((r) => r.components.map((c) => c.raw).join('^')).join('~')).join('|');
    out.segments.push({
      id,
      index,
      occurrence,
      offset,
      end: offset + raw.length + 1,
      line: index,
      raw,
      elements: els,
    });
    offset += raw.length + 1;
    out.text += raw + '\n';
  });
  return out;
}

/**
 * Reads CSV text (RFC 4180) into rows of fields. Written for the tests so
 * that exported CSV can be checked without trusting the exporter.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** True for a character that XML 1.0 does not allow in text. */
function isForbiddenChar(ch) {
  const code = ch.codePointAt(0);
  return (code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffe || code === 0xffff;
}

/**
 * A small XML checker. Returns { ok, error, root } where root is a tree of
 * { name, attrs, children, text }. It accepts the XML declaration, elements,
 * attributes in double quotes, text, and the five predefined entities plus
 * numeric character references. Anything else (a bare "&" or "<" in text, a
 * bad name, a mismatched tag, several roots, content after the root) is an
 * error.
 */
function checkXml(xml) {
  const nameRe = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;
  const decodeText = (text) => {
    let bad = null;
    const decoded = text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        const okCode = code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
        if (!okCode) {
          bad = 'invalid character reference ' + m;
        }
        return String.fromCodePoint(okCode ? code : 0xfffd);
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body];
    });
    if (bad) {
      throw new Error(bad);
    }
    const leftover = text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, '');
    if (leftover.indexOf('&') >= 0) {
      throw new Error('bare ampersand in text');
    }
    if (leftover.indexOf('<') >= 0) {
      throw new Error('bare "<" in text');
    }
    if (Array.from(decoded).some(isForbiddenChar)) {
      throw new Error('forbidden character in text');
    }
    return decoded;
  };
  try {
    let i = 0;
    const decl = /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*/.exec(xml);
    if (decl) {
      i = decl[0].length;
    }
    const stack = [];
    let root = null;
    while (i < xml.length) {
      if (xml[i] === '<') {
        if (xml[i + 1] === '/') {
          const end = xml.indexOf('>', i);
          const name = xml.slice(i + 2, end);
          const top = stack.pop();
          if (!top || top.name !== name) {
            throw new Error('mismatched end tag </' + name + '>');
          }
          i = end + 1;
        } else {
          const end = xml.indexOf('>', i);
          if (end < 0) {
            throw new Error('unterminated tag');
          }
          let inner = xml.slice(i + 1, end);
          const selfClose = inner.endsWith('/');
          if (selfClose) {
            inner = inner.slice(0, -1);
          }
          const m = /^([^\s]+)((?:\s+[^\s=]+="[^"<]*")*)\s*$/.exec(inner);
          if (!m || !nameRe.test(m[1])) {
            throw new Error('bad tag <' + inner + '>');
          }
          const attrs = {};
          const attrRe = /\s+([^\s=]+)="([^"<]*)"/g;
          let am;
          while ((am = attrRe.exec(m[2])) !== null) {
            if (!nameRe.test(am[1])) {
              throw new Error('bad attribute name ' + am[1]);
            }
            attrs[am[1]] = decodeText(am[2]);
          }
          const node = { name: m[1], attrs, children: [], text: '' };
          if (stack.length > 0) {
            stack[stack.length - 1].children.push(node);
          } else if (root) {
            throw new Error('more than one root element');
          } else {
            root = node;
          }
          if (!selfClose) {
            stack.push(node);
          }
          i = end + 1;
        }
      } else {
        const next = xml.indexOf('<', i);
        const stop = next < 0 ? xml.length : next;
        const chunk = xml.slice(i, stop);
        if (stack.length > 0) {
          stack[stack.length - 1].text += decodeText(chunk);
        } else if (chunk.trim() !== '') {
          throw new Error('text outside the root element');
        }
        i = stop;
      }
    }
    if (stack.length > 0) {
      throw new Error('unclosed element <' + stack[stack.length - 1].name + '>');
    }
    if (!root) {
      throw new Error('no root element');
    }
    return { ok: true, root };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  EDIFACT_ORDER,
  HL7_ADT,
  X12_PO,
  x12Interchange,
  buildMessage,
  parseCsv,
  checkXml,
};
