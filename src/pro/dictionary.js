'use strict';

/*
 * User-supplied dictionaries (Pro).
 *
 * A dictionary is a JSON file written by the user that gives names to
 * segments, elements, components and code values. The extension ships no
 * dictionary of its own. Schema:
 *
 *   {
 *     "format": "edifact" | "x12" | "hl7",
 *     "name": "My dictionary",
 *     "segments": {
 *       "BGM": {
 *         "name": "Beginning of message",
 *         "elements": {
 *           "1": { "name": "Document name", "components": { "1": "Code" },
 *                  "values": { "220": "Order" } }
 *         }
 *       }
 *     }
 *   }
 */

const FORMATS = ['edifact', 'x12', 'hl7'];

/** Largest dictionary text accepted, in characters. */
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
/** Largest number of segment definitions. */
const MAX_SEGMENTS = 2000;
/** Largest number of elements, components and values together. */
const MAX_ENTRIES = 100000;
/** Longest accepted name or description. */
const MAX_NAME_LENGTH = 300;
/** Longest accepted code value key. */
const MAX_VALUE_KEY_LENGTH = 100;
/** Maximum number of error messages returned. */
const MAX_ERRORS = 50;

const SEGMENT_KEY = /^[A-Za-z][A-Za-z0-9]{1,2}$/;
const INDEX_KEY = /^[1-9][0-9]{0,3}$/;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Returns true for a plain JSON object (not null, not an array). */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks that a value is a string of acceptable length. Pushes an error
 * naming the location when it is not. Returns true when the value is fine.
 */
function checkString(value, where, errors, allowEmpty) {
  if (typeof value !== 'string') {
    errors.push(where + ' must be a text value.');
    return false;
  }
  if (!allowEmpty && value.trim() === '') {
    errors.push(where + ' must not be empty.');
    return false;
  }
  if (value.length > MAX_NAME_LENGTH) {
    errors.push(where + ' is longer than ' + MAX_NAME_LENGTH + ' characters.');
    return false;
  }
  return true;
}

/** Notes keys that are not part of the schema so typing mistakes are visible. */
function noteUnknownKeys(obj, allowed, where, warnings) {
  Object.keys(obj).forEach((key) => {
    if (allowed.indexOf(key) < 0) {
      warnings.push(where + ' has an unknown key "' + key + '" (ignored).');
    }
  });
}

/** Validates and copies the "components" object of one element. */
function readComponents(raw, where, errors, counter) {
  const out = {};
  if (!isObject(raw)) {
    errors.push(where + ' must be an object that maps component numbers to names.');
    return out;
  }
  Object.keys(raw).forEach((key) => {
    if (!INDEX_KEY.test(key)) {
      errors.push(where + ' has the key "' + key + '", which is not a component number (1, 2, 3 ...).');
      return;
    }
    if (checkString(raw[key], where + '["' + key + '"]', errors, false)) {
      counter.n += 1;
      out[key] = raw[key];
    }
  });
  return out;
}

/** Validates and copies the "values" object of one element. */
function readValues(raw, where, errors, counter) {
  const out = {};
  if (!isObject(raw)) {
    errors.push(where + ' must be an object that maps code values to names.');
    return out;
  }
  Object.keys(raw).forEach((key) => {
    if (key === '__proto__' || key === '' || key.length > MAX_VALUE_KEY_LENGTH) {
      errors.push(where + ' has an unusable code value key "' + key.slice(0, 20) + '".');
      return;
    }
    if (checkString(raw[key], where + '["' + key + '"]', errors, false)) {
      counter.n += 1;
      out[key] = raw[key];
    }
  });
  return out;
}

/** Validates and copies one element definition. */
function readElement(raw, where, errors, warnings, counter) {
  const out = {};
  if (!isObject(raw)) {
    errors.push(where + ' must be an object.');
    return out;
  }
  noteUnknownKeys(raw, ['name', 'components', 'values'], where, warnings);
  if (hasOwn(raw, 'name') && checkString(raw.name, where + '.name', errors, false)) {
    out.name = raw.name;
  }
  if (hasOwn(raw, 'components')) {
    out.components = readComponents(raw.components, where + '.components', errors, counter);
  }
  if (hasOwn(raw, 'values')) {
    out.values = readValues(raw.values, where + '.values', errors, counter);
  }
  return out;
}

/** Validates and copies one segment definition. */
function readSegment(raw, where, errors, warnings, counter) {
  const out = {};
  if (!isObject(raw)) {
    errors.push(where + ' must be an object.');
    return out;
  }
  noteUnknownKeys(raw, ['name', 'elements'], where, warnings);
  if (hasOwn(raw, 'name') && checkString(raw.name, where + '.name', errors, false)) {
    out.name = raw.name;
  }
  if (hasOwn(raw, 'elements')) {
    out.elements = {};
    if (!isObject(raw.elements)) {
      errors.push(where + '.elements must be an object that maps element numbers to definitions.');
    } else {
      Object.keys(raw.elements).forEach((key) => {
        if (!INDEX_KEY.test(key)) {
          errors.push(where + '.elements has the key "' + key.slice(0, 20) + '", which is not an element number (1, 2, 3 ...).');
          return;
        }
        counter.n += 1;
        out.elements[key] = readElement(raw.elements[key], where + '.elements["' + key + '"]', errors, warnings, counter);
      });
    }
  }
  return out;
}

/**
 * Parses and validates dictionary text. Returns { ok: true, dictionary,
 * warnings } when the text is valid (the dictionary is a cleaned copy with
 * upper-case segment ids; warnings list keys that were ignored), or
 * { ok: false, errors } with plain-English messages that say where the
 * problem is. Limits: 2 MB of text, 2,000 segments and 100,000 entries in
 * total. Nothing is ever executed; the text is only parsed as JSON.
 */
function loadDictionary(text) {
  const errors = [];
  const warnings = [];
  if (typeof text !== 'string') {
    return { ok: false, errors: ['The dictionary must be given as text.'] };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, errors: ['The dictionary file is larger than ' + (MAX_TEXT_LENGTH / 1024 / 1024) + ' MB.'] };
  }
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, errors: ['The file is not valid JSON: ' + (err && err.message ? err.message : 'parse error') + '.'] };
  }
  if (!isObject(data)) {
    return { ok: false, errors: ['The top level of the dictionary must be an object.'] };
  }
  noteUnknownKeys(data, ['format', 'name', 'segments'], 'The dictionary', warnings);

  const dictionary = { format: '', name: '', segments: {} };
  if (typeof data.format !== 'string' || FORMATS.indexOf(data.format) < 0) {
    errors.push('"format" must be one of: ' + FORMATS.join(', ') + '.');
  } else {
    dictionary.format = data.format;
  }
  if (checkString(data.name, '"name"', errors, false)) {
    dictionary.name = data.name;
  }
  if (!isObject(data.segments)) {
    errors.push('"segments" must be an object that maps segment ids to definitions.');
  } else {
    const ids = Object.keys(data.segments);
    if (ids.length > MAX_SEGMENTS) {
      errors.push('The dictionary defines ' + ids.length + ' segments; the limit is ' + MAX_SEGMENTS + '.');
    } else {
      const counter = { n: 0 };
      ids.forEach((id) => {
        if (!SEGMENT_KEY.test(id)) {
          errors.push('Segment id "' + id.slice(0, 20) + '" is not valid: use 2 or 3 letters or digits, starting with a letter.');
          return;
        }
        const upper = id.toUpperCase();
        if (hasOwn(dictionary.segments, upper)) {
          errors.push('Segment "' + upper + '" is defined more than once (ids are not case sensitive).');
          return;
        }
        counter.n += 1;
        dictionary.segments[upper] = readSegment(data.segments[id], 'Segment ' + upper, errors, warnings, counter);
      });
      if (counter.n > MAX_ENTRIES) {
        errors.push('The dictionary has ' + counter.n + ' entries; the limit is ' + MAX_ENTRIES + '.');
      }
    }
  }
  if (errors.length > 0) {
    if (errors.length > MAX_ERRORS) {
      const more = errors.length - MAX_ERRORS;
      errors.length = MAX_ERRORS;
      errors.push('... and ' + more + ' more problems.');
    }
    return { ok: false, errors };
  }
  return { ok: true, dictionary, warnings };
}

/** Normalises a 1-based index given as a number or digit string; returns '' if it is not usable. */
function indexKey(value) {
  if (value === undefined || value === null) {
    return '';
  }
  const text = String(value);
  return INDEX_KEY.test(text) ? text : '';
}

/**
 * Looks up the names for a position. Gives back { segmentName, elementName,
 * componentName, valueName }; a field is present only when the dictionary
 * knows it. The segment id is not case sensitive. elementIndex and
 * componentIndex are 1-based. value is the text found at that position; it is
 * matched against the element's "values" table exactly, then with spaces
 * trimmed. Returns an empty object for a missing dictionary or an unknown
 * segment.
 */
function describe(dictionary, segId, elementIndex, componentIndex, value) {
  const out = {};
  if (!dictionary || !isObject(dictionary.segments) || typeof segId !== 'string') {
    return out;
  }
  const key = segId.toUpperCase();
  if (!hasOwn(dictionary.segments, key)) {
    return out;
  }
  const seg = dictionary.segments[key];
  if (seg.name) {
    out.segmentName = seg.name;
  }
  const e = indexKey(elementIndex);
  if (e === '' || !seg.elements || !hasOwn(seg.elements, e)) {
    return out;
  }
  const el = seg.elements[e];
  if (el.name) {
    out.elementName = el.name;
  }
  const c = indexKey(componentIndex);
  if (c !== '' && el.components && hasOwn(el.components, c)) {
    out.componentName = el.components[c];
  }
  if (value !== undefined && value !== null && el.values) {
    const text = String(value);
    if (hasOwn(el.values, text)) {
      out.valueName = el.values[text];
    } else if (hasOwn(el.values, text.trim())) {
      out.valueName = el.values[text.trim()];
    }
  }
  return out;
}

module.exports = {
  loadDictionary,
  describe,
  limits: {
    maxTextLength: MAX_TEXT_LENGTH,
    maxSegments: MAX_SEGMENTS,
    maxEntries: MAX_ENTRIES,
    maxNameLength: MAX_NAME_LENGTH,
  },
};
