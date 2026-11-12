'use strict';

/*
 * Path language for addressing pieces of a parsed message:
 *
 *   SEG[occurrence]-element(repetition).component.subcomponent
 *
 * Everything after SEG[occurrence] is optional and the repetition defaults to
 * 1. Examples: NAD[2]-3.1, PID[1]-5(2).1, MSH[1]-9.2. Element, component
 * and subcomponent numbers are 1-based, as in the standards.
 */

const PATH_PATTERN = /^([A-Za-z0-9]+)(?:\[(\d+)\])?(?:-(\d+)(?:\((\d+)\))?(?:\.(\d+)(?:\.(\d+))?)?)?$/;

/**
 * Formats a path. The first argument is a segment (or a plain segment id,
 * which means occurrence 1). The element, component, subcomponent and
 * repetition numbers are optional; the repetition is written only when it is
 * given. A subcomponent without a component refers to component 1. Numbers
 * given without the level above them are ignored.
 */
function formatPath(segment, elementIndex, componentIndex, subIndex, repetitionIndex) {
  const id = typeof segment === 'string' ? segment : segment.id;
  const occurrence = typeof segment === 'string' ? 1 : segment.occurrence;
  let path = id + '[' + occurrence + ']';
  if (elementIndex === undefined || elementIndex === null) {
    return path;
  }
  path += '-' + elementIndex;
  if (repetitionIndex !== undefined && repetitionIndex !== null) {
    path += '(' + repetitionIndex + ')';
  }
  const hasSub = subIndex !== undefined && subIndex !== null;
  if (componentIndex !== undefined && componentIndex !== null) {
    path += '.' + componentIndex;
  } else if (hasSub) {
    path += '.1';
  }
  if (hasSub) {
    path += '.' + subIndex;
  }
  return path;
}

const indexCache = new WeakMap();

/** Returns a map from segment id to the list of segments with that id (cached per message). */
function segmentsById(message) {
  const cached = indexCache.get(message);
  if (cached && cached.list === message.segments && cached.length === message.segments.length) {
    return cached.byId;
  }
  const byId = new Map();
  for (const segment of message.segments) {
    const list = byId.get(segment.id);
    if (list) {
      list.push(segment);
    } else {
      byId.set(segment.id, [segment]);
    }
  }
  indexCache.set(message, { list: message.segments, length: message.segments.length, byId });
  return byId;
}

/** Builds the result object for a resolved piece of text. */
function makeResult(message, parts, offset, end) {
  return Object.assign({}, parts, {
    offset,
    end,
    value: message.text.slice(offset, end),
  });
}

/**
 * Finds the piece of text a path points to. Returns
 * { segment, element?, repetition?, component?, subcomponent?, offset, end, value }
 * where offset/end delimit the deepest piece named by the path and value is
 * its raw text, or null when the path is malformed or does not exist in the
 * message. When an element is addressed, repetition is always set (default 1);
 * a path without an explicit repetition covers the whole element, a path with
 * one covers that repetition only.
 */
function resolvePath(message, pathString) {
  if (!message || typeof pathString !== 'string') {
    return null;
  }
  const match = PATH_PATTERN.exec(pathString.trim());
  if (!match) {
    return null;
  }
  const id = match[1];
  const occurrence = match[2] === undefined ? 1 : Number(match[2]);
  const list = segmentsById(message).get(id);
  if (!list || occurrence < 1 || occurrence > list.length) {
    return null;
  }
  const segment = list[occurrence - 1];
  if (match[3] === undefined) {
    return makeResult(message, { segment }, segment.offset, segment.offset + segment.raw.length);
  }

  const elementNo = Number(match[3]);
  const explicitRep = match[4] !== undefined;
  const repNo = explicitRep ? Number(match[4]) : 1;
  const element = segment.elements[elementNo - 1];
  if (!element || repNo < 1 || repNo > element.repetitions.length) {
    return null;
  }
  const repetition = element.repetitions[repNo - 1];
  if (match[5] === undefined) {
    if (!explicitRep) {
      return makeResult(message, { segment, element, repetition }, element.offset, element.end);
    }
    const first = repetition.components[0];
    const last = repetition.components[repetition.components.length - 1];
    return makeResult(message, { segment, element, repetition }, first.offset, last.end);
  }

  const component = repetition.components[Number(match[5]) - 1];
  if (!component) {
    return null;
  }
  if (match[6] === undefined) {
    return makeResult(message, { segment, element, repetition, component }, component.offset, component.end);
  }
  const subcomponent = component.subcomponents[Number(match[6]) - 1];
  if (!subcomponent) {
    return null;
  }
  return makeResult(
    message,
    { segment, element, repetition, component, subcomponent },
    subcomponent.offset,
    subcomponent.end
  );
}

/**
 * Returns true when the offset lies inside [start, end). With inclusive set,
 * the position right after the range (offset equal to end) counts as well,
 * which is what a text cursor placed at the end of a value expects.
 */
function within(offset, start, end, inclusive) {
  return offset >= start && (offset < end || (inclusive && offset === end));
}

/** Finds the segment that contains the offset using a binary search, or null. */
function findSegmentAt(message, offset, inclusive) {
  const segments = message.segments;
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].offset <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) {
    return null;
  }
  const seg = segments[found];
  if (offset < seg.end || (inclusive && offset <= seg.offset + seg.raw.length)) {
    return seg;
  }
  return null;
}

/**
 * Tells what is at a text offset, for hovers and "copy path". Returns
 * { segment, element?, repetition?, component?, subcomponent?, path } with the
 * deepest piece that contains the offset, or null when the offset is not
 * inside any segment. An offset on a delimiter belongs to the enclosing piece
 * (a separator between elements gives the segment). The path is the shortest
 * one that names the piece: the repetition is written only for elements with
 * several repetitions, the component only when the repetition has several
 * components, the subcomponent only when the component has several. When
 * opts.inclusiveEnd is true, an offset right after a value counts as inside it.
 */
function locate(message, offset, opts) {
  if (!message || typeof offset !== 'number' || offset < 0) {
    return null;
  }
  const inclusive = Boolean(opts && opts.inclusiveEnd);
  const segment = findSegmentAt(message, offset, inclusive);
  if (!segment) {
    return null;
  }

  let element = null;
  for (const candidate of segment.elements) {
    if (within(offset, candidate.offset, candidate.end, inclusive)) {
      element = candidate;
      break;
    }
  }
  if (!element) {
    return { segment, path: formatPath(segment) };
  }

  let repetition = null;
  let component = null;
  for (const rep of element.repetitions) {
    for (const comp of rep.components) {
      if (within(offset, comp.offset, comp.end, inclusive)) {
        repetition = rep;
        component = comp;
        break;
      }
    }
    if (component) {
      break;
    }
  }
  if (!component) {
    return { segment, element, path: formatPath(segment, element.index) };
  }

  // A component with a single subcomponent is its own subcomponent. With several, the offset
  // must lie inside one of them; on the separator between two subcomponents the enclosing
  // component is reported instead.
  let subcomponent = component.subcomponents.length === 1 ? component.subcomponents[0] : null;
  for (const sub of component.subcomponents) {
    if (within(offset, sub.offset, sub.end, inclusive)) {
      subcomponent = sub;
      break;
    }
  }

  const repNo = element.repetitions.indexOf(repetition) + 1;
  const repArg = element.repetitions.length > 1 ? repNo : undefined;
  const subArg = subcomponent && component.subcomponents.length > 1 ? subcomponent.index : undefined;
  const compArg = repetition.components.length > 1 || subArg !== undefined ? component.index : undefined;
  return {
    segment,
    element,
    repetition,
    component,
    subcomponent,
    path: formatPath(segment, element.index, compArg, subArg, repArg),
  };
}

module.exports = { formatPath, resolvePath, locate };
