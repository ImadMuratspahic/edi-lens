'use strict';

/*
 * Parser for UN/EDIFACT, ANSI X12 and HL7 v2 messages.
 *
 * The parser reads the delimiters from the file itself (UNA, ISA or MSH),
 * splits the text into segments, elements, repetitions, components and
 * subcomponents, and records exact character offsets for every piece. It
 * never throws: any input produces a Message, possibly with issues and with
 * zero segments.
 *
 * Issue codes produced here (syntax level only; structural rules live in
 * validate.js):
 *   empty-input           the text is empty or only whitespace and no format was given
 *   unknown-format        the text does not start like any supported format
 *   bad-una               the UNA service string advice is incomplete or invalid
 *   bad-isa               the ISA header is missing, too short or has invalid delimiters
 *   bad-msh               the MSH/FHS/BHS header is missing or has no field separator
 *   short-encoding        the HL7 encoding characters have fewer than four characters
 *   empty-segment-id      a segment starts with a delimiter instead of an id
 *   unterminated-segment  the last segment has no segment terminator
 *   unclosed-release      the text ends with a release character that escapes nothing
 *   too-many-issues       more issues were found than the limit; the rest were dropped
 *   parse-failed          an unexpected internal error (should never happen)
 */

const { FORMATS, ISA_LENGTH, guessFormat, isAlphaNumericCode } = require('./detect');

const DEFAULT_MAX_ISSUES = 1000;

/** Splitting rules that keep a value as one single piece. */
const NO_SPLIT = makeSeps('', '', '', '');

/** Segment ids that carry the HL7 delimiter definition in their first two fields. */
const HL7_HEADER_IDS = ['MSH', 'FHS', 'BHS'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Returns a fresh copy of the default delimiters for the given format. */
function defaultDelimiters(format) {
  if (format === 'x12') {
    return { element: '*', component: ':', repetition: '', segment: '~' };
  }
  if (format === 'hl7') {
    return { field: '|', component: '^', repetition: '~', escape: '\\', subcomponent: '&', segment: '\r' };
  }
  return {
    component: ':',
    element: '+',
    decimal: '.',
    release: '?',
    repetition: '',
    segment: "'",
  };
}

/** Returns true for characters that may sit between segments (not part of the data). */
function isBlankCode(code) {
  return code <= 32 || code === 0xa0 || code === 0xfeff;
}

/** Returns the first index at or after pos that is not blank, or text.length. */
function skipBlank(text, pos) {
  const len = text.length;
  let i = pos;
  while (i < len && isBlankCode(text.charCodeAt(i))) {
    i++;
  }
  return i;
}

/** Moves the end of a range backwards over trailing blank characters. */
function trimBlankEnd(text, from, to) {
  let e = to;
  while (e > from && isBlankCode(text.charCodeAt(e - 1))) {
    e--;
  }
  return e;
}

/** Returns the index of the first occurrence of code in [from, to), or to when absent. */
function findCode(text, code, from, to) {
  let i = from;
  while (i < to) {
    if (text.charCodeAt(i) === code) {
      return i;
    }
    i++;
  }
  return to;
}

/**
 * Creates a function that converts a character offset into a 0-based line
 * number. Line breaks are CR, LF and CRLF, the same as in VS Code. The
 * function must be called with non-decreasing offsets.
 */
function makeLineCounter(text) {
  let pos = 0;
  let line = 0;
  return function lineAt(offset) {
    while (pos < offset) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) !== 10) {
        line++;
      }
      pos++;
    }
    return line;
  };
}

/**
 * Splits [start, end) at every occurrence of the separator that is not
 * escaped by the release character. Returns a flat array of start and end
 * offsets: [start0, end0, start1, end1, ...]. Always returns at least one
 * piece (an empty range gives one empty piece). An empty separator returns the
 * whole range as one piece.
 */
function splitPieces(text, start, end, sep, release) {
  const out = [];
  if (!sep) {
    out.push(start, end);
    return out;
  }
  const sepCode = sep.charCodeAt(0);
  const releaseCode = release ? release.charCodeAt(0) : -1;
  let pieceStart = start;
  let i = start;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === releaseCode) {
      i += 2;
      continue;
    }
    if (c === sepCode) {
      out.push(pieceStart, i);
      pieceStart = i + 1;
    }
    i++;
  }
  out.push(pieceStart, end);
  return out;
}

/**
 * Builds an Element for the range [s, e) using the given splitting rules
 * (seps.rep, seps.comp, seps.sub, seps.release). Each level that has an empty
 * separator is kept whole. For formats without subcomponents the component
 * carries exactly one subcomponent equal to itself.
 */
function buildElement(text, index, s, e, seps) {
  // Fast path: most elements contain none of the inner separators.
  const repCode = seps.repCode;
  const compCode = seps.compCode;
  const subCode = seps.subCode;
  const releaseCode = seps.releaseCode;
  let plain = true;
  for (let i = s; i < e; i++) {
    const c = text.charCodeAt(i);
    if (c === repCode || c === compCode || c === subCode || c === releaseCode) {
      plain = false;
      break;
    }
  }
  if (plain) {
    const raw = text.slice(s, e);
    return {
      index,
      offset: s,
      end: e,
      raw,
      repetitions: [
        {
          components: [
            {
              index: 1,
              offset: s,
              end: e,
              raw,
              subcomponents: [{ index: 1, offset: s, end: e, raw }],
            },
          ],
        },
      ],
    };
  }

  const repPieces = splitPieces(text, s, e, seps.rep, seps.release);
  const repetitions = [];
  for (let r = 0; r < repPieces.length; r += 2) {
    const compPieces = splitPieces(text, repPieces[r], repPieces[r + 1], seps.comp, seps.release);
    const components = [];
    for (let c = 0; c < compPieces.length; c += 2) {
      const cs = compPieces[c];
      const ce = compPieces[c + 1];
      const craw = text.slice(cs, ce);
      let subcomponents;
      if (seps.sub) {
        const subPieces = splitPieces(text, cs, ce, seps.sub, seps.release);
        subcomponents = [];
        for (let k = 0; k < subPieces.length; k += 2) {
          subcomponents.push({
            index: k / 2 + 1,
            offset: subPieces[k],
            end: subPieces[k + 1],
            raw: text.slice(subPieces[k], subPieces[k + 1]),
          });
        }
      } else {
        subcomponents = [{ index: 1, offset: cs, end: ce, raw: craw }];
      }
      components.push({ index: c / 2 + 1, offset: cs, end: ce, raw: craw, subcomponents });
    }
    repetitions.push({ components });
  }
  return { index, offset: s, end: e, raw: text.slice(s, e), repetitions };
}

/**
 * Splits the part of a segment after its id into elements and appends them to
 * the list. firstIndex is the 1-based index of the first element produced.
 */
function appendElements(elements, text, from, to, elementSep, release, seps, firstIndex) {
  const sepCode = elementSep.charCodeAt(0);
  const releaseCode = release ? release.charCodeAt(0) : -1;
  let index = firstIndex;
  let pieceStart = from;
  let i = from;
  while (i < to) {
    const c = text.charCodeAt(i);
    if (c === releaseCode) {
      i += 2;
      continue;
    }
    if (c === sepCode) {
      elements.push(buildElement(text, index, pieceStart, i, seps));
      index++;
      pieceStart = i + 1;
    }
    i++;
  }
  elements.push(buildElement(text, index, pieceStart, to, seps));
}

/**
 * Describes how an element is split: the repetition, component and
 * subcomponent separators and the release character (empty string = not used),
 * together with their character codes (-1 = not used) for fast scanning.
 */
function makeSeps(rep, comp, sub, release) {
  return {
    rep,
    comp,
    sub,
    release,
    repCode: rep ? rep.charCodeAt(0) : -1,
    compCode: comp ? comp.charCodeAt(0) : -1,
    subCode: sub ? sub.charCodeAt(0) : -1,
    releaseCode: release ? release.charCodeAt(0) : -1,
  };
}

/** Creates the parse context shared by the three format readers. */
function createContext(text, format, maxIssues) {
  return {
    text,
    format,
    maxIssues,
    dropped: 0,
    issues: [],
    segments: [],
    counts: new Map(),
    delimiters: defaultDelimiters(format),
    lineAt: makeLineCounter(text),
  };
}

/** Records an issue unless the issue limit has been reached. */
function addIssue(ctx, severity, code, message, offset, end, segmentIndex) {
  if (ctx.issues.length >= ctx.maxIssues) {
    ctx.dropped++;
    return;
  }
  ctx.issues.push({ severity, code, message, offset, end, segmentIndex });
}

/** Appends a segment built from the range [offset, rawEnd) and returns it. */
function addSegment(ctx, id, offset, rawEnd, end, elements) {
  const occurrence = (ctx.counts.get(id) || 0) + 1;
  ctx.counts.set(id, occurrence);
  const segment = {
    id,
    index: ctx.segments.length,
    occurrence,
    offset,
    end,
    line: ctx.lineAt(offset),
    raw: ctx.text.slice(offset, rawEnd),
    elements,
  };
  ctx.segments.push(segment);
  return segment;
}

/**
 * Makes the delimiters found in a header the active ones. The first header in
 * the file defines Message.delimiters; later headers (a second interchange
 * with different delimiters) only affect the segments that follow them.
 */
function adoptDelimiters(ctx, current, derived) {
  if (ctx.segments.length === 0) {
    Object.assign(ctx.delimiters, derived);
    return ctx.delimiters;
  }
  return Object.assign({}, current, derived);
}

// ---------------------------------------------------------------------------
// UN/EDIFACT
// ---------------------------------------------------------------------------

/**
 * Reads a UNA service string advice at pos. Returns the delimiters it defines
 * or null when the advice is incomplete or invalid (letters or digits used as
 * delimiters, or the component, element and terminator characters not
 * distinct).
 */
function readUna(text, pos) {
  if (pos + 9 > text.length) {
    return null;
  }
  const component = text[pos + 3];
  const element = text[pos + 4];
  const decimal = text[pos + 5];
  const release = text[pos + 6];
  const repetition = text[pos + 7];
  const segment = text[pos + 8];
  const mandatory = [component, element, segment];
  for (const ch of mandatory) {
    if (isAlphaNumericCode(ch.charCodeAt(0))) {
      return null;
    }
  }
  if (component === element || component === segment || element === segment) {
    return null;
  }
  if (component.charCodeAt(0) <= 32 || element.charCodeAt(0) <= 32) {
    return null;
  }
  // The optional release and repetition characters (a blank means "not used") must
  // not be letters or digits and must differ from the three mandatory delimiters.
  const used = [component, element, segment];
  for (const optional of [release, repetition]) {
    if (optional !== ' ' && (isAlphaNumericCode(optional.charCodeAt(0)) || used.indexOf(optional) !== -1)) {
      return null;
    }
  }
  if (release !== ' ' && release === repetition) {
    return null;
  }
  return {
    component,
    element,
    decimal,
    release: release === ' ' ? '' : release,
    repetition: repetition === ' ' ? '' : repetition,
    segment,
  };
}

/** Reads all segments of an EDIFACT text starting at offset start. */
function parseEdifact(ctx, start) {
  const text = ctx.text;
  const len = text.length;
  let cur = ctx.delimiters;
  let seps = makeSeps(cur.repetition, cur.component, '', cur.release);
  let pos = start;

  while (pos < len) {
    pos = skipBlank(text, pos);
    if (pos >= len) {
      break;
    }

    if (text.startsWith('UNA', pos)) {
      const una = readUna(text, pos);
      if (una) {
        cur = adoptDelimiters(ctx, cur, una);
        seps = makeSeps(cur.repetition, cur.component, '', cur.release);
        const advice = buildElement(text, 1, pos + 3, pos + 8, NO_SPLIT);
        addSegment(ctx, 'UNA', pos, pos + 8, pos + 9, [advice]);
        pos += 9;
        continue;
      }
      addIssue(
        ctx,
        'error',
        'bad-una',
        'The UNA service string advice is incomplete or invalid; default delimiters are used.',
        pos,
        Math.min(len, pos + 9),
        ctx.segments.length
      );
    }

    const releaseCode = cur.release ? cur.release.charCodeAt(0) : -1;
    const termCode = cur.segment.charCodeAt(0);
    let i = pos;
    let terminated = false;
    let danglingRelease = false;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === releaseCode) {
        if (i + 1 >= len) {
          danglingRelease = true;
          i = len;
          break;
        }
        i += 2;
        continue;
      }
      if (c === termCode) {
        terminated = true;
        break;
      }
      i++;
    }

    let rawEnd = i;
    let segEnd;
    if (terminated) {
      segEnd = i + 1;
    } else {
      rawEnd = trimBlankEnd(text, pos, Math.min(i, len));
      segEnd = rawEnd;
      addIssue(
        ctx,
        'error',
        'unterminated-segment',
        'The last segment has no segment terminator (' + describeChar(cur.segment) + ').',
        pos,
        rawEnd,
        ctx.segments.length
      );
      if (danglingRelease) {
        addIssue(
          ctx,
          'warning',
          'unclosed-release',
          'The text ends with a release character that does not escape anything.',
          len - 1,
          len,
          ctx.segments.length
        );
      }
    }

    const idEnd = findCode(text, cur.element.charCodeAt(0), pos, rawEnd);
    if (idEnd === pos) {
      addIssue(
        ctx,
        'error',
        'empty-segment-id',
        'The segment has no id; it starts with a delimiter or is empty.',
        pos,
        Math.min(rawEnd + 1, len),
        ctx.segments.length
      );
    }
    const elements = [];
    if (idEnd < rawEnd) {
      appendElements(elements, text, idEnd + 1, rawEnd, cur.element, cur.release, seps, 1);
    }
    addSegment(ctx, text.slice(pos, idEnd), pos, rawEnd, segEnd, elements);
    pos = terminated ? segEnd : len;
  }
}

// ---------------------------------------------------------------------------
// ANSI X12
// ---------------------------------------------------------------------------

/**
 * Reads the fixed-width ISA header at pos and returns the delimiters it
 * defines, or null when the header is shorter than 106 characters or uses
 * letters, digits or blanks as separators.
 */
function readIsa(text, pos) {
  if (pos + ISA_LENGTH > text.length) {
    return null;
  }
  const element = text[pos + 3];
  const component = text[pos + 104];
  const segment = text[pos + 105];
  if (isAlphaNumericCode(element.charCodeAt(0)) || element.charCodeAt(0) <= 32) {
    return null;
  }
  if (isAlphaNumericCode(component.charCodeAt(0)) || component.charCodeAt(0) <= 32) {
    return null;
  }
  if (isAlphaNumericCode(segment.charCodeAt(0))) {
    return null;
  }
  if (element === component || element === segment || component === segment) {
    return null;
  }
  let repetition = text[pos + 82];
  if (
    repetition === 'U' ||
    isAlphaNumericCode(repetition.charCodeAt(0)) ||
    repetition.charCodeAt(0) <= 32 ||
    repetition === element ||
    repetition === component ||
    repetition === segment
  ) {
    repetition = '';
  }
  return { element, component, repetition, segment };
}

/** Returns true when the text at pos is an ISA segment tag followed by a separator. */
function isIsaAt(text, pos) {
  if (!text.startsWith('ISA', pos)) {
    return false;
  }
  return pos + 3 >= text.length || !isAlphaNumericCode(text.charCodeAt(pos + 3));
}

/** Reads all segments of an X12 text starting at offset start. */
function parseX12(ctx, start) {
  const text = ctx.text;
  const len = text.length;
  let cur = ctx.delimiters;
  let seps = makeSeps(cur.repetition, cur.component, '', '');
  let pos = start;

  while (pos < len) {
    pos = skipBlank(text, pos);
    if (pos >= len) {
      break;
    }

    let isIsa = false;
    let isaValid = false;
    if (isIsaAt(text, pos)) {
      isIsa = true;
      const isa = readIsa(text, pos);
      if (isa) {
        isaValid = true;
        cur = adoptDelimiters(ctx, cur, isa);
        seps = makeSeps(cur.repetition, cur.component, '', '');
      } else {
        addIssue(
          ctx,
          'error',
          'bad-isa',
          'The ISA header is shorter than 106 characters or has invalid separators; default delimiters are used.',
          pos,
          Math.min(len, pos + ISA_LENGTH),
          ctx.segments.length
        );
        // A short header still shows its element separator in the fourth character.
        if (ctx.segments.length === 0 && pos + 3 < len) {
          const guess = text[pos + 3];
          if (!isAlphaNumericCode(guess.charCodeAt(0)) && guess.charCodeAt(0) > 32) {
            cur.element = guess;
          }
        }
      }
    } else if (ctx.segments.length === 0) {
      addIssue(
        ctx,
        'error',
        'bad-isa',
        'The text does not start with an ISA header; default delimiters are used.',
        pos,
        Math.min(len, pos + 3),
        0
      );
    }

    // A valid ISA is fixed width: it always ends at character 106, even when the
    // same character also appears earlier inside the header (for example as ISA11).
    let rawEnd = isaValid ? pos + ISA_LENGTH - 1 : text.indexOf(cur.segment, pos);
    let segEnd;
    const terminated = rawEnd !== -1;
    if (terminated) {
      segEnd = rawEnd + 1;
    } else {
      rawEnd = trimBlankEnd(text, pos, len);
      segEnd = rawEnd;
      addIssue(
        ctx,
        'error',
        'unterminated-segment',
        'The last segment has no segment terminator (' + describeChar(cur.segment) + ').',
        pos,
        rawEnd,
        ctx.segments.length
      );
    }

    const idEnd = findCode(text, cur.element.charCodeAt(0), pos, rawEnd);
    if (idEnd === pos) {
      addIssue(
        ctx,
        'error',
        'empty-segment-id',
        'The segment has no id; it starts with a delimiter or is empty.',
        pos,
        Math.min(rawEnd + 1, len),
        ctx.segments.length
      );
    }
    const elements = [];
    if (idEnd < rawEnd) {
      // ISA elements 11 and 16 are delimiter characters, so ISA is never split further.
      appendElements(elements, text, idEnd + 1, rawEnd, cur.element, '', isIsa ? NO_SPLIT : seps, 1);
    }
    addSegment(ctx, text.slice(pos, idEnd), pos, rawEnd, segEnd, elements);
    pos = terminated ? segEnd : len;
  }
}

// ---------------------------------------------------------------------------
// HL7 v2
// ---------------------------------------------------------------------------

/**
 * Reads the delimiter definition of an MSH, FHS or BHS segment starting at
 * pos on a line that ends at lineEnd. Returns null when the segment is not a
 * header or has no field separator.
 */
function readHl7Header(text, pos, lineEnd) {
  let isHeader = false;
  for (const id of HL7_HEADER_IDS) {
    if (text.startsWith(id, pos)) {
      isHeader = true;
      break;
    }
  }
  if (!isHeader || pos + 3 >= lineEnd) {
    return null;
  }
  const field = text[pos + 3];
  const fieldCode = field.charCodeAt(0);
  if (isAlphaNumericCode(fieldCode) || fieldCode <= 32) {
    return null;
  }
  let e = pos + 4;
  while (e < lineEnd && text.charCodeAt(e) !== fieldCode) {
    e++;
  }
  const enc = text.slice(pos + 4, e);
  return {
    field,
    component: enc.charAt(0) || '^',
    repetition: enc.charAt(1) || '~',
    escape: enc.charAt(2) || '\\',
    subcomponent: enc.charAt(3) || '&',
    short: enc.length < 4,
  };
}

/** Reads all segments of an HL7 v2 text starting at offset start. */
function parseHl7(ctx, start) {
  const text = ctx.text;
  const len = text.length;
  let cur = ctx.delimiters;
  let seps = makeSeps(cur.repetition, cur.component, cur.subcomponent, '');
  let segmentSet = false;
  let pos = start;

  while (pos < len) {
    // Find the end of the line (CR, LF or CRLF).
    let le = pos;
    while (le < len) {
      const c = text.charCodeAt(le);
      if (c === 13 || c === 10) {
        break;
      }
      le++;
    }
    let termLen = 0;
    if (le < len) {
      termLen = text.charCodeAt(le) === 13 && text.charCodeAt(le + 1) === 10 ? 2 : 1;
      if (!segmentSet) {
        ctx.delimiters.segment = text.slice(le, le + termLen);
        segmentSet = true;
      }
    }
    const lineEnd = le + termLen;

    // Skip indentation and transport framing characters (blank, tab, VT, FS).
    let s = pos;
    while (s < le) {
      const c = text.charCodeAt(s);
      if (c === 32 || c === 9 || c === 0x0b || c === 0x1c || c === 0xfeff || c === 0xa0) {
        s++;
      } else {
        break;
      }
    }
    if (s >= le) {
      pos = lineEnd;
      continue;
    }

    const header = readHl7Header(text, s, le);
    if (header) {
      const derived = {
        field: header.field,
        component: header.component,
        repetition: header.repetition,
        escape: header.escape,
        subcomponent: header.subcomponent,
      };
      cur = adoptDelimiters(ctx, cur, derived);
      seps = makeSeps(cur.repetition, cur.component, cur.subcomponent, '');
      if (header.short) {
        addIssue(
          ctx,
          'warning',
          'short-encoding',
          'The encoding characters have fewer than four characters; defaults are used for the missing ones.',
          s + 4,
          Math.min(le, s + 4 + 4),
          ctx.segments.length
        );
      }
    } else if (ctx.segments.length === 0) {
      addIssue(
        ctx,
        'error',
        'bad-msh',
        'The text does not start with an MSH header that defines the delimiters; defaults are used.',
        s,
        Math.min(le, s + 3),
        0
      );
    }

    const fieldCode = cur.field.charCodeAt(0);
    const idEnd = findCode(text, fieldCode, s, le);
    if (idEnd === s) {
      addIssue(
        ctx,
        'error',
        'empty-segment-id',
        'The segment has no id; it starts with a delimiter.',
        s,
        Math.min(le + 1, len),
        ctx.segments.length
      );
    }
    const id = text.slice(s, idEnd);
    const elements = [];
    if (idEnd < le) {
      if (HL7_HEADER_IDS.indexOf(id) !== -1) {
        // Field 1 is the field separator itself, field 2 the encoding characters.
        elements.push(buildElement(text, 1, idEnd, idEnd + 1, NO_SPLIT));
        const encEnd = findCode(text, fieldCode, idEnd + 1, le);
        elements.push(buildElement(text, 2, idEnd + 1, encEnd, NO_SPLIT));
        if (encEnd < le) {
          appendElements(elements, text, encEnd + 1, le, cur.field, '', seps, 3);
        }
      } else {
        appendElements(elements, text, idEnd + 1, le, cur.field, '', seps, 1);
      }
    }
    addSegment(ctx, id, s, le, lineEnd, elements);
    pos = lineEnd;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Describes a delimiter character for use in a message (names control characters). */
function describeChar(ch) {
  if (ch === '\r') {
    return 'carriage return';
  }
  if (ch === '\n') {
    return 'line feed';
  }
  if (ch === ' ') {
    return 'space';
  }
  return "'" + ch + "'";
}

/**
 * Parses text into a Message: its segments, and within them elements,
 * repetitions, components and subcomponents, each with exact character
 * offsets. The format is detected from the first characters of the text unless opts.format
 * ('edifact', 'x12' or 'hl7') forces it. opts.maxIssues (default 1000) limits
 * the number of syntax issues that are recorded. This function never throws:
 * unusable input produces a Message with issues and possibly zero segments.
 */
function parse(text, opts) {
  const options = opts || {};
  const source = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  const maxIssues =
    typeof options.maxIssues === 'number' && options.maxIssues > 0 ? options.maxIssues : DEFAULT_MAX_ISSUES;

  let format = FORMATS.indexOf(options.format) !== -1 ? options.format : null;
  let unknown = false;
  if (!format) {
    const guess = guessFormat(source);
    if (guess) {
      format = guess.format;
    } else {
      format = 'edifact';
      unknown = true;
    }
  }

  const ctx = createContext(source, format, maxIssues);
  try {
    if (unknown) {
      if (skipBlank(source, 0) >= source.length) {
        addIssue(ctx, 'warning', 'empty-input', 'The text is empty.', 0, source.length, -1);
      } else {
        const first = skipBlank(source, 0);
        addIssue(
          ctx,
          'error',
          'unknown-format',
          'The text does not start like a UN/EDIFACT, X12 or HL7 v2 message.',
          first,
          Math.min(source.length, first + 3),
          -1
        );
      }
    } else {
      const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
      if (format === 'x12') {
        parseX12(ctx, start);
      } else if (format === 'hl7') {
        parseHl7(ctx, start);
      } else {
        parseEdifact(ctx, start);
      }
    }
  } catch (err) {
    ctx.issues.push({
      severity: 'error',
      code: 'parse-failed',
      message: 'The text could not be parsed completely.',
      offset: 0,
      end: source.length,
      segmentIndex: -1,
    });
  }
  if (ctx.dropped > 0) {
    ctx.issues.push({
      severity: 'info',
      code: 'too-many-issues',
      message: ctx.dropped + ' more syntax issues were not recorded.',
      offset: 0,
      end: 0,
      segmentIndex: -1,
    });
  }

  return {
    format,
    delimiters: ctx.delimiters,
    text: source,
    segments: ctx.segments,
    issues: ctx.issues,
  };
}

module.exports = { parse, defaultDelimiters, DEFAULT_MAX_ISSUES };
