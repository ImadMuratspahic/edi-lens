'use strict';

/*
 * Export of a parsed message to JSON, CSV and XML (Pro).
 *
 * Pure functions that work on the parsed message structure (segments, elements, repetitions, components). They never
 * modify the message and never throw on odd input.
 */

const { toJSON } = require('../core/serialize.js');

const REPLACEMENT = String.fromCharCode(0xfffd);
const BOM = String.fromCharCode(0xfeff);

/** Returns true when the text holds a character that XML 1.0 does not allow (or a surrogate to check). */
function hasInvalidXml(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
      return true;
    }
  }
  return false;
}

/**
 * Replaces every character that XML 1.0 forbids (most control characters,
 * U+FFFE, U+FFFF and unpaired surrogates) with U+FFFD. Valid surrogate pairs
 * are kept.
 */
function stripInvalidXml(text) {
  if (!hasInvalidXml(text)) {
    return text;
  }
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
      } else {
        out += REPLACEMENT;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += REPLACEMENT;
    } else if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) {
      out += REPLACEMENT;
    } else if (code === 0xfffe || code === 0xffff) {
      out += REPLACEMENT;
    } else {
      out += text[i];
    }
  }
  return out;
}

/** Returns the segments array of a message, or an empty array. */
function segmentsOf(message) {
  return message && Array.isArray(message.segments) ? message.segments : [];
}

/** Returns the occurrence number of a segment, counting by id when it is missing. */
function occurrences(message) {
  const counts = new Map();
  return segmentsOf(message).map((seg) => {
    const n = (counts.get(seg.id) || 0) + 1;
    counts.set(seg.id, n);
    return typeof seg.occurrence === 'number' ? seg.occurrence : n;
  });
}

/** Returns the subcomponent raw values of a component, one entry when there is no split. */
function subRaws(component) {
  if (Array.isArray(component.subcomponents) && component.subcomponents.length > 1) {
    return component.subcomponents.map((s) => s.raw);
  }
  return null;
}

/**
 * Walks a message and calls visit for every value: { segment, occurrence,
 * element, repetition, component, subcomponent, path, value }. A segment
 * without elements yields one entry for the segment itself, an element
 * without components yields one entry for the element, and a component that
 * holds several subcomponents yields one entry per subcomponent. Numbers are
 * 1-based; fields that do not apply are undefined.
 */
function walk(message, visit) {
  const occ = occurrences(message);
  segmentsOf(message).forEach((seg, pos) => {
    const base = seg.id + '[' + occ[pos] + ']';
    const elements = Array.isArray(seg.elements) ? seg.elements : [];
    if (elements.length === 0) {
      visit({ segment: seg.id, occurrence: occ[pos], path: base, value: '' });
      return;
    }
    elements.forEach((el, ePos) => {
      const e = typeof el.index === 'number' ? el.index : ePos + 1;
      const reps = Array.isArray(el.repetitions) ? el.repetitions : [];
      const hasComponents = reps.some((r) => Array.isArray(r.components) && r.components.length > 0);
      if (!hasComponents) {
        visit({ segment: seg.id, occurrence: occ[pos], element: e, path: base + '-' + e, value: '' });
        return;
      }
      reps.forEach((rep, rPos) => {
        const r = rPos + 1;
        const repText = r > 1 ? '(' + r + ')' : '';
        (Array.isArray(rep.components) ? rep.components : []).forEach((comp, cPos) => {
          const c = typeof comp.index === 'number' ? comp.index : cPos + 1;
          const subs = subRaws(comp);
          if (subs) {
            subs.forEach((raw, sPos) => {
              visit({
                segment: seg.id, occurrence: occ[pos], element: e, repetition: r,
                component: c, subcomponent: sPos + 1,
                path: base + '-' + e + repText + '.' + c + '.' + (sPos + 1),
                value: raw,
              });
            });
          } else {
            visit({
              segment: seg.id, occurrence: occ[pos], element: e, repetition: r, component: c,
              path: base + '-' + e + repText + '.' + c,
              value: comp.raw,
            });
          }
        });
      });
    });
  });
}

/**
 * Returns the message as JSON text, using the same structure as the core
 * serializer: { format, delimiters, segments: [{ id, elements }] }, where an
 * element is a string, an array of components, or { repetitions: [...] } when
 * it repeats. With { pretty: true } the text is indented with two spaces;
 * otherwise it is on one line. With { unescape: true } release characters and
 * escape sequences are removed from the values. The text never ends with a
 * line break.
 */
function toJsonText(message, opts) {
  const o = opts || {};
  const safe = message && Array.isArray(message.segments)
    ? message
    : { format: message && message.format, delimiters: {}, segments: [] };
  return JSON.stringify(toJSON(safe, { unescape: o.unescape === true }), null, o.pretty ? 2 : 0);
}

/**
 * Quotes one CSV field per RFC 4180: a field containing a comma, a double
 * quote, a carriage return or a line feed is wrapped in double quotes and
 * its quotes are doubled. With neutralise set, a value that a spreadsheet
 * could read as a formula gets a leading apostrophe.
 */
function csvField(value, neutralise) {
  let text = value === undefined || value === null ? '' : String(value);
  if (neutralise && /^[=+\-@\t\r]/.test(text)) {
    text = "'" + text;
  }
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

/**
 * Returns the message as CSV text: a header row (segment, occurrence, path,
 * value) and one row per element or component (one per subcomponent when a
 * component is split), lines ended by CRLF, fields quoted as RFC 4180
 * requires. Options: neutraliseFormulas (prefix values that start with =, +,
 * - or @ with an apostrophe, default false) and bom (start the text with a
 * UTF-8 byte order mark, default false). The text is meant to be written as
 * UTF-8.
 */
function toCsv(message, opts) {
  const o = opts || {};
  const rows = ['segment,occurrence,path,value'];
  walk(message, (v) => {
    rows.push([
      csvField(v.segment, false),
      String(v.occurrence),
      csvField(v.path, false),
      csvField(v.value, o.neutraliseFormulas === true),
    ].join(','));
  });
  return (o.bom === true ? BOM : '') + rows.join('\r\n') + '\r\n';
}

/**
 * Escapes text for XML. The five predefined entities are used for & < > "
 * and ', carriage returns and tabs become character references so they
 * survive parsing, and characters that XML 1.0 forbids are replaced with the
 * Unicode replacement character.
 */
function xmlEscape(value) {
  return stripInvalidXml(String(value === undefined || value === null ? '' : value))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;');
}

/** Escapes an attribute value; line breaks become character references too. */
function xmlAttr(value) {
  return xmlEscape(value).replace(/\n/g, '&#10;');
}

/** Turns a segment id into a valid XML name part (anything unusual becomes "_"). */
function nameSafe(id) {
  const cleaned = String(id).replace(/[^A-Za-z0-9_.\-]/g, '_');
  return cleaned === '' ? '_' : cleaned;
}

/** Zero-pads a position to at least two digits, as in e03 or c01. */
function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * Returns the message as generic, well-formed XML (UTF-8 declaration, two
 * space indentation, LF line ends). The root is <message format="...">; each
 * segment becomes <s_ID id="..." n="occurrence">, each element <e03> (one
 * tag per repetition, with rep="2" and so on from the second), each component
 * <c01> and each subcomponent <u01>. The original segment id is kept in the
 * id attribute because tag names allow fewer characters than EDI ids do.
 */
function toXml(message) {
  const occ = occurrences(message);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const format = message && message.format ? message.format : 'unknown';
  const segments = segmentsOf(message);
  if (segments.length === 0) {
    out.push('<message format="' + xmlAttr(format) + '"/>');
    return out.join('\n') + '\n';
  }
  out.push('<message format="' + xmlAttr(format) + '">');
  segments.forEach((seg, pos) => {
    const sName = 's_' + nameSafe(seg.id);
    const elements = Array.isArray(seg.elements) ? seg.elements : [];
    const open = '  <' + sName + ' id="' + xmlAttr(seg.id) + '" n="' + occ[pos] + '"';
    if (elements.length === 0) {
      out.push(open + '/>');
      return;
    }
    out.push(open + '>');
    elements.forEach((el, ePos) => {
      const e = typeof el.index === 'number' ? el.index : ePos + 1;
      const eName = 'e' + pad(e);
      const reps = Array.isArray(el.repetitions) ? el.repetitions : [];
      if (reps.length === 0) {
        out.push('    <' + eName + '/>');
        return;
      }
      reps.forEach((rep, rPos) => {
        const attr = rPos > 0 ? ' rep="' + (rPos + 1) + '"' : '';
        const comps = Array.isArray(rep.components) ? rep.components : [];
        if (comps.length === 0) {
          out.push('    <' + eName + attr + '/>');
          return;
        }
        out.push('    <' + eName + attr + '>');
        comps.forEach((comp, cPos) => {
          const c = typeof comp.index === 'number' ? comp.index : cPos + 1;
          const cName = 'c' + pad(c);
          const subs = subRaws(comp);
          if (subs) {
            out.push('      <' + cName + '>');
            subs.forEach((raw, sPos) => {
              out.push('        <u' + pad(sPos + 1) + '>' + xmlEscape(raw) + '</u' + pad(sPos + 1) + '>');
            });
            out.push('      </' + cName + '>');
          } else {
            out.push('      <' + cName + '>' + xmlEscape(comp.raw) + '</' + cName + '>');
          }
        });
        out.push('    </' + eName + '>');
      });
    });
    out.push('  </' + sName + '>');
  });
  out.push('</message>');
  return out.join('\n') + '\n';
}

module.exports = { toJsonText, toCsv, toXml, walk, csvField, xmlEscape };
