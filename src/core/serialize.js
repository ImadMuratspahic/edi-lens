'use strict';

/*
 * Serialisation of parsed messages: pretty printing, minifying and a plain
 * JSON representation.
 *
 * The text of every segment is taken from the original text, so no data
 * is ever changed; only the white space between segments differs.
 */

/** Returns the terminator that followed a segment in the original text ('' when it had none). */
function terminatorOf(message, segment) {
  return message.text.slice(segment.offset + segment.raw.length, segment.end);
}

/**
 * Formats a message with one segment per line. The UNA line stays first
 * because it is the first segment. Every segment keeps its own terminator
 * character (an unterminated last segment stays unterminated); HL7 segments
 * have no visible terminator, so they are simply separated by line breaks.
 * Lines are separated by opts.eol (default "\n"). The result has no final line
 * break. Formatting the result again gives the same text.
 */
function pretty(message, opts) {
  const eol = opts && typeof opts.eol === 'string' ? opts.eol : '\n';
  const isHl7 = message.format === 'hl7';
  const segments = message.segments;
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const term = isHl7 ? '' : terminatorOf(message, seg);
    out += seg.raw + term;
    if (i < segments.length - 1 && !term.endsWith('\n')) {
      out += eol;
    }
  }
  return out;
}

/**
 * Formats a message without any line breaks between segments. UN/EDIFACT and
 * X12 segments are joined by their own terminators only. HL7 segments are
 * each followed by a carriage return, which is the HL7 segment terminator.
 * Minifying the result again gives the same text.
 */
function minify(message) {
  const isHl7 = message.format === 'hl7';
  let out = '';
  for (const seg of message.segments) {
    out += seg.raw + (isHl7 ? '\r' : terminatorOf(message, seg));
  }
  return out;
}

/**
 * Removes the format's escaping from a raw value. UN/EDIFACT: a release
 * character followed by any character becomes that character. HL7 v2: the
 * sequences \F\ \S\ \T\ \R\ \E\ become the field, component, subcomponent,
 * repetition and escape characters; other escape sequences are left as they
 * are. X12 has no escaping, so the value is returned unchanged.
 */
function unescapeValue(message, value) {
  const d = message.delimiters;
  if (message.format === 'edifact') {
    const release = d.release;
    if (!release || value.indexOf(release) === -1) {
      return value;
    }
    let out = '';
    for (let i = 0; i < value.length; i++) {
      if (value[i] === release && i + 1 < value.length) {
        i++;
      }
      out += value[i];
    }
    return out;
  }
  if (message.format === 'hl7') {
    const esc = d.escape;
    if (!esc || value.indexOf(esc) === -1) {
      return value;
    }
    const map = {
      F: d.field,
      S: d.component,
      T: d.subcomponent,
      R: d.repetition,
      E: d.escape,
    };
    let out = '';
    let i = 0;
    while (i < value.length) {
      if (value[i] === esc) {
        const close = value.indexOf(esc, i + 1);
        if (close === -1) {
          out += value.slice(i);
          break;
        }
        const name = value.slice(i + 1, close);
        if (name.length === 1 && Object.prototype.hasOwnProperty.call(map, name)) {
          out += map[name];
        } else {
          out += value.slice(i, close + 1);
        }
        i = close + 1;
      } else {
        out += value[i];
        i++;
      }
    }
    return out;
  }
  return value;
}

/**
 * Converts a message to a plain object that can be passed to JSON.stringify.
 * Shape: { format, delimiters, segments: [{ id, elements: [...] }] }. Each
 * element is a string when it has one repetition with one component with one
 * subcomponent. Otherwise a repetition is an array of components, and a
 * component is a string or, when it has several subcomponents (HL7 only), an
 * array of strings. An element with several repetitions is written as
 * { repetitions: [repetition, repetition, ...] }. Values are the raw text from
 * the file unless opts.unescape is true, which removes release characters and
 * HL7 escape sequences.
 */
function toJSON(message, opts) {
  const unescape = Boolean(opts && opts.unescape);
  // The UNA service string advice lists the delimiters themselves, so it is never unescaped.
  const asIs = (raw) => raw;
  const unescaped = (raw) => unescapeValue(message, raw);
  let value = asIs;

  const componentValue = (component) => {
    if (component.subcomponents.length === 1) {
      return value(component.subcomponents[0].raw);
    }
    return component.subcomponents.map((sub) => value(sub.raw));
  };
  const repetitionValue = (repetition) => {
    const comps = repetition.components;
    if (comps.length === 1 && comps[0].subcomponents.length === 1) {
      return componentValue(comps[0]);
    }
    return comps.map(componentValue);
  };
  const elementValue = (element) => {
    if (element.repetitions.length === 1) {
      return repetitionValue(element.repetitions[0]);
    }
    return { repetitions: element.repetitions.map(repetitionValue) };
  };

  return {
    format: message.format,
    delimiters: Object.assign({}, message.delimiters),
    segments: message.segments.map((seg) => {
      const plainAdvice = message.format === 'edifact' && seg.id === 'UNA';
      value = unescape && !plainAdvice ? unescaped : asIs;
      return { id: seg.id, elements: seg.elements.map(elementValue) };
    }),
  };
}

module.exports = { pretty, minify, toJSON, unescapeValue };
