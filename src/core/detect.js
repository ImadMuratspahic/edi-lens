'use strict';

/*
 * Format detection for segment-based business messages.
 *
 * Two entry points:
 *  - detectFormat(text): strict check used by the "Detect Format" command.
 *  - guessFormat(text):  lenient check used by the parser so that truncated
 *                        files (for example a cut-off ISA header) still open
 *                        in the right format and report useful issues.
 */

const FORMATS = ['edifact', 'x12', 'hl7'];

/** Minimum length of a complete X12 ISA segment including its terminator. */
const ISA_LENGTH = 106;

/**
 * Returns true when the character code is a letter or a digit. Delimiters can
 * never be letters or digits, which is how a segment id is told apart from a
 * longer word that merely starts with the same letters.
 */
function isAlphaNumericCode(code) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

/**
 * Returns the index of the first character that is neither a byte order mark
 * nor whitespace. Returns text.length when the text has no such character.
 */
function firstContentIndex(text) {
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c <= 32 || c === 0xfeff || c === 0xa0) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Returns true when the text at position pos starts with the three-letter
 * tag and the tag is not just the beginning of a longer word. The character
 * after the tag is the element or field separator, which is never a letter or
 * a digit. A tag at the very end of the text counts as well (truncated file).
 */
function hasTagAt(text, pos, tag) {
  if (!text.startsWith(tag, pos)) {
    return false;
  }
  const next = pos + tag.length;
  if (next >= text.length) {
    return true;
  }
  return !isAlphaNumericCode(text.charCodeAt(next));
}

/**
 * Strict detection. Looks at the first non-blank characters of the text and
 * returns { format, reason } when the text starts like a UN/EDIFACT
 * interchange (UNA, UNB or UNH), an X12 interchange (ISA with at least 106
 * characters) or an HL7 v2 message or batch (MSH, FHS or BHS). Returns null
 * when no known format matches. A leading byte order mark and leading
 * whitespace are ignored.
 */
function detectFormat(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const start = firstContentIndex(text);
  if (start >= text.length) {
    return null;
  }
  if (text.startsWith('UNA', start)) {
    return { format: 'edifact', reason: 'Starts with a UNA service string advice' };
  }
  if (hasTagAt(text, start, 'UNB')) {
    return { format: 'edifact', reason: 'Starts with a UNB interchange header' };
  }
  if (hasTagAt(text, start, 'UNH')) {
    return { format: 'edifact', reason: 'Starts with a UNH message header' };
  }
  if (hasTagAt(text, start, 'ISA') && text.length - start >= ISA_LENGTH) {
    return { format: 'x12', reason: 'Starts with an ISA interchange header' };
  }
  if (hasTagAt(text, start, 'MSH')) {
    return { format: 'hl7', reason: 'Starts with an MSH message header' };
  }
  if (hasTagAt(text, start, 'FHS') || hasTagAt(text, start, 'BHS')) {
    return { format: 'hl7', reason: 'Starts with a batch or file header segment' };
  }
  return null;
}

/**
 * Lenient detection used by the parser. Same rules as detectFormat, except
 * that an ISA header shorter than 106 characters is still reported as X12 so
 * that a truncated file is parsed in the right format. Returns
 * { format, reason } or null.
 */
function guessFormat(text) {
  const strict = detectFormat(text);
  if (strict) {
    return strict;
  }
  if (typeof text !== 'string') {
    return null;
  }
  const start = firstContentIndex(text);
  if (start < text.length && hasTagAt(text, start, 'ISA')) {
    return { format: 'x12', reason: 'Starts with a truncated ISA interchange header' };
  }
  return null;
}

module.exports = {
  FORMATS,
  ISA_LENGTH,
  detectFormat,
  guessFormat,
  isAlphaNumericCode,
  firstContentIndex,
};
