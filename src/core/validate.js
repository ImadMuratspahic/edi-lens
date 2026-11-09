'use strict';

/*
 * Structural validation of parsed EDI messages (UN/EDIFACT, ANSI X12, HL7 v2).
 *
 * The rules are deterministic and purely structural: envelope pairing, segment
 * counts, control numbers and required header fields. No code lists or
 * dictionaries are consulted. Every issue has a stable code (EDIFACT-, X12- or
 * HL7- prefix), a plain message and the exact character offsets of the text
 * that caused it. The module only reads the Message structure produced by the
 * parser and never throws.
 */

const DEFAULT_MAX_ISSUES = 500;

/* ------------------------------------------------------------------ */
/* Small helpers shared by the three formats                           */
/* ------------------------------------------------------------------ */

/**
 * Creates an issue collector bound to a text length. Added issues are clamped
 * so that 0 <= offset <= end <= text length, which keeps every range valid for
 * an editor even when the parser reported odd offsets.
 */
function createCollector(textLength) {
  const items = [];
  return {
    items: items,
    add: function (severity, code, message, range, segmentIndex) {
      let start = Number.isFinite(range[0]) ? Math.floor(range[0]) : 0;
      let end = Number.isFinite(range[1]) ? Math.floor(range[1]) : start;
      if (start < 0) start = 0;
      if (start > textLength) start = textLength;
      if (end < start) end = start;
      if (end > textLength) end = textLength;
      items.push({
        severity: severity,
        code: code,
        message: message,
        offset: start,
        end: end,
        segmentIndex: Number.isInteger(segmentIndex) ? segmentIndex : -1,
      });
    },
  };
}

/** Returns the usable segment objects of a message (never null, never throws). */
function segmentList(message) {
  if (!message || !Array.isArray(message.segments)) return [];
  return message.segments.filter(function (s) {
    return s && typeof s === 'object';
  });
}

/** Returns the segment id as a string ('' when absent). */
function sid(seg) {
  return typeof seg.id === 'string' ? seg.id : '';
}

/** Returns the numeric start offset of a segment (0 when absent). */
function segStart(seg) {
  return Number.isFinite(seg.offset) ? seg.offset : 0;
}

/** Returns the raw text of a segment without terminator ('' when absent). */
function segRaw(seg) {
  return typeof seg.raw === 'string' ? seg.raw : '';
}

/** Returns the issue segmentIndex for a segment (-1 when unknown). */
function segIdx(seg) {
  return seg && Number.isInteger(seg.index) ? seg.index : -1;
}

/** Range covering the whole segment text, or its terminator when the segment is empty. */
function segRange(seg) {
  const start = segStart(seg);
  const len = segRaw(seg).length;
  if (len > 0) return [start, start + len];
  const end = Number.isFinite(seg.end) ? seg.end : start;
  return [start, Math.max(end, start + 1)];
}

/** Range covering only the segment identifier (at least one character). */
function idRange(seg) {
  const start = segStart(seg);
  return [start, start + Math.max(1, sid(seg).length)];
}

/** Finds the element with the given 1-based index, or null. */
function element(seg, n) {
  const list = Array.isArray(seg.elements) ? seg.elements : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].index === n) return list[i];
  }
  return null;
}

/** Trimmed raw value of an element ('' when the element is absent). */
function elementValue(seg, n) {
  const e = element(seg, n);
  return e && typeof e.raw === 'string' ? e.raw.trim() : '';
}

/** Trimmed raw value of the first repetition's component k of element n. */
function componentValue(seg, n, k) {
  const e = element(seg, n);
  if (!e) return '';
  const reps = Array.isArray(e.repetitions) ? e.repetitions : [];
  const comps = reps.length > 0 && reps[0] && Array.isArray(reps[0].components) ? reps[0].components : [];
  for (let i = 0; i < comps.length; i++) {
    if (comps[i] && comps[i].index === k) {
      return typeof comps[i].raw === 'string' ? comps[i].raw.trim() : '';
    }
  }
  if (comps.length === 0 && k === 1 && typeof e.raw === 'string') return e.raw.trim();
  return '';
}

/** Range of an element (widened to one character when empty), or the segment range when absent. */
function elementSpan(seg, n) {
  const e = element(seg, n);
  if (!e || !Number.isFinite(e.offset)) return segRange(seg);
  const end = Number.isFinite(e.end) ? e.end : e.offset;
  return [e.offset, end > e.offset ? end : e.offset + 1];
}

/** Shortens a value for use in a message. */
function show(value) {
  const s = String(value).replace(/[\r\n]+/g, ' ');
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
}

/** Display form of a segment id for messages. */
function showId(seg) {
  const id = sid(seg);
  return id === '' ? '(empty id)' : show(id);
}

/**
 * Checks element 1 of a trailer segment (UNT, UNE, UNZ, SE, GE, IEA) against
 * the actual count. `alsoAccepted` is a second count that is tolerated.
 */
function checkCount(c, seg, actual, code, noun, alsoAccepted) {
  const id = sid(seg);
  const raw = elementValue(seg, 1);
  const range = elementSpan(seg, 1);
  if (raw === '') {
    c.add('error', code, id + ' has an empty count; the file contains ' + actual + ' ' + noun + '.', range, segIdx(seg));
    return;
  }
  if (!/^[0-9]+$/.test(raw)) {
    c.add('error', code, id + ' count "' + show(raw) + '" is not a number; the file contains ' + actual + ' ' + noun + '.', range, segIdx(seg));
    return;
  }
  const declared = Number(raw);
  if (declared !== actual && declared !== alsoAccepted) {
    c.add('error', code, id + ' declares ' + declared + ' ' + noun + ' but the file contains ' + actual + '.', range, segIdx(seg));
  }
}

/** Checks element 2 of a trailer segment against the control reference of its opening segment. */
function checkRef(c, seg, expected, code, source) {
  const id = sid(seg);
  const raw = elementValue(seg, 2);
  if (raw === expected) return;
  const range = elementSpan(seg, 2);
  if (raw === '') {
    c.add('error', code, id + ' has no control reference; it must repeat "' + show(expected) + '" from ' + source + '.', range, segIdx(seg));
  } else {
    c.add('error', code, id + ' control reference "' + show(raw) + '" does not match ' + source + ' "' + show(expected) + '".', range, segIdx(seg));
  }
}

/* ------------------------------------------------------------------ */
/* UN/EDIFACT                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reports a segment whose last segment terminator (or end of input) is
 * escaped by an unmatched release character, so the segment never closes.
 */
function checkRelease(c, text, seg, release, terminator) {
  if (!release) return;
  const start = segStart(seg);
  const stop = Number.isFinite(seg.end) ? seg.end : start + segRaw(seg).length;
  // Trailing line breaks are removed with a loop: a regular expression anchored at
  // the end would take quadratic time on a segment full of line breaks.
  let trimmedEnd = stop;
  while (trimmedEnd > start) {
    const code = text.charCodeAt(trimmedEnd - 1);
    if (code !== 10 && code !== 13) break;
    trimmedEnd--;
  }
  let sliceEnd = trimmedEnd;
  if (terminator && sliceEnd > start && text.charAt(sliceEnd - 1) === terminator) {
    sliceEnd--;
  }
  let run = 0;
  while (run < sliceEnd - start && text.charAt(sliceEnd - 1 - run) === release) run++;
  if (run % 2 === 1) {
    c.add(
      'error',
      'EDIFACT-RELEASE-UNCLOSED',
      'Segment ' + showId(seg) + ' ends with an unmatched release character "' + release + '", so the segment terminator is escaped and the segment is never closed.',
      [start + (sliceEnd - start) - 1, trimmedEnd],
      segIdx(seg)
    );
  }
}

/**
 * Validates a UN/EDIFACT message: interchange (UNB/UNZ), functional group
 * (UNG/UNE) and message (UNH/UNT) envelopes, counts, control references,
 * empty messages, segment identifiers and unclosed release characters.
 */
function validateEdifact(message, c, text) {
  const segs = segmentList(message).filter(function (s) {
    return sid(s) !== 'UNA';
  });
  const d = message.delimiters && typeof message.delimiters === 'object' ? message.delimiters : {};
  // An empty release character means the UNA declared none (a blank in the advice).
  let release = typeof d.release === 'string' && d.release.length <= 1 ? d.release : '?';
  if (release === ' ') release = '';
  const terminator = typeof d.segment === 'string' && d.segment.length === 1 ? d.segment : "'";

  if (segs.length === 0) {
    c.add('error', 'EDIFACT-NO-SEGMENTS', 'No EDIFACT segments were found; an interchange must contain at least UNB and UNZ.', [0, 1], -1);
    return;
  }

  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const id = sid(s);
    if (id === '') {
      c.add('error', 'EDIFACT-SEGMENT-ID-EMPTY', 'Segment has no identifier (a stray segment terminator or a delimiter at the start of a segment).', segRange(s), segIdx(s));
    } else if (!/^[A-Z0-9]{3}$/.test(id)) {
      c.add('warning', 'EDIFACT-SEGMENT-ID-INVALID', 'Segment identifier "' + show(id) + '" is not three upper-case letters or digits.', idRange(s), segIdx(s));
    }
    checkRelease(c, text, s, release, terminator);
  }

  const firstSeg = segs[0];
  let ic = null; // open interchange
  let grp = null; // open functional group
  let msg = null; // open message
  let tail = 0; // 0: none, 1: just after UNZ, 2: already reported

  if (sid(firstSeg) !== 'UNB') {
    let laterUnb = false;
    for (let k = 1; k < segs.length; k++) {
      if (sid(segs[k]) === 'UNB') {
        laterUnb = true;
        break;
      }
    }
    if (laterUnb) {
      c.add('error', 'EDIFACT-UNB-NOT-FIRST', 'The interchange must start with UNB (after an optional UNA), but the first segment is ' + showId(firstSeg) + '; a UNB segment appears later in the file.', idRange(firstSeg), segIdx(firstSeg));
    } else {
      c.add('error', 'EDIFACT-UNB-MISSING', 'The interchange must start with UNB (after an optional UNA), but the first segment is ' + showId(firstSeg) + '.', idRange(firstSeg), segIdx(firstSeg));
    }
    ic = { unb: null, ref: '', messages: 0, groups: 0, implicit: true };
  }

  function flushMessage() {
    if (!msg) return;
    c.add('error', 'EDIFACT-UNT-MISSING', 'Message ' + (msg.ref === '' ? '(no reference)' : '"' + show(msg.ref) + '"') + ' opened by UNH is not closed by a UNT segment.', idRange(msg.unh), segIdx(msg.unh));
    msg = null;
  }
  function flushGroup() {
    flushMessage();
    if (!grp) return;
    c.add('error', 'EDIFACT-UNE-MISSING', 'Functional group ' + (grp.ref === '' ? '(no reference)' : '"' + show(grp.ref) + '"') + ' opened by UNG is not closed by a UNE segment.', idRange(grp.ung), segIdx(grp.ung));
    grp = null;
  }
  function flushInterchange() {
    flushGroup();
    if (!ic) return;
    if (ic.implicit) {
      const last = segs[segs.length - 1];
      if (sid(last) !== 'UNZ') {
        c.add('error', 'EDIFACT-UNZ-MISSING', 'The interchange does not end with a UNZ segment; the last segment is ' + showId(last) + '.', idRange(last), segIdx(last));
      }
    } else {
      c.add('error', 'EDIFACT-UNZ-MISSING', 'Interchange ' + (ic.ref === '' ? '(no reference)' : '"' + show(ic.ref) + '"') + ' opened by UNB is not closed by a UNZ segment.', idRange(ic.unb), segIdx(ic.unb));
    }
    ic = null;
  }

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const id = sid(s);

    if (tail === 1 && id !== 'UNB') {
      c.add('error', 'EDIFACT-UNZ-NOT-LAST', 'Segment ' + showId(s) + ' follows UNZ; UNZ must be the last segment of an interchange.', idRange(s), segIdx(s));
      tail = 2;
    }

    if (id === 'UNB') {
      flushInterchange();
      tail = 0;
      ic = { unb: s, ref: elementValue(s, 5), messages: 0, groups: 0, implicit: false };
      if (componentValue(s, 1, 1) === '') {
        c.add('error', 'EDIFACT-UNB-SYNTAX-ID-MISSING', 'UNB has no syntax identifier (element 1, for example UNOA or UNOC).', elementSpan(s, 1), segIdx(s));
      }
      if (ic.ref === '') {
        c.add('error', 'EDIFACT-UNB-REF-MISSING', 'UNB has no interchange control reference (element 5).', elementSpan(s, 5), segIdx(s));
      }
    } else if (id === 'UNG') {
      flushGroup();
      grp = { ung: s, ref: elementValue(s, 5), messages: 0 };
      if (ic) ic.groups++;
    } else if (id === 'UNE') {
      flushMessage();
      if (!grp) {
        c.add('error', 'EDIFACT-UNE-UNEXPECTED', 'UNE has no matching UNG segment.', idRange(s), segIdx(s));
      } else {
        checkCount(c, s, grp.messages, 'EDIFACT-UNE-COUNT', 'messages (UNH to UNT) in the group');
        checkRef(c, s, grp.ref, 'EDIFACT-UNE-REF', 'the UNG group reference');
        grp = null;
      }
    } else if (id === 'UNH') {
      flushMessage();
      msg = { unh: s, pos: i, ref: elementValue(s, 1), body: 0 };
      if (msg.ref === '') {
        c.add('error', 'EDIFACT-UNH-REF-MISSING', 'UNH has no message reference number (element 1).', elementSpan(s, 1), segIdx(s));
      }
      if (grp) grp.messages++;
      if (ic) ic.messages++;
    } else if (id === 'UNT') {
      if (!msg) {
        c.add('error', 'EDIFACT-UNT-UNEXPECTED', 'UNT has no matching UNH segment.', idRange(s), segIdx(s));
      } else {
        checkCount(c, s, i - msg.pos + 1, 'EDIFACT-UNT-COUNT', 'segments from UNH to UNT inclusive');
        checkRef(c, s, msg.ref, 'EDIFACT-UNT-REF', 'the UNH message reference');
        if (msg.body === 0) {
          c.add('warning', 'EDIFACT-MESSAGE-EMPTY', 'Message ' + (msg.ref === '' ? '(no reference)' : '"' + show(msg.ref) + '"') + ' has no body segments between UNH and UNT.', idRange(msg.unh), segIdx(msg.unh));
        }
        msg = null;
      }
    } else if (id === 'UNZ') {
      flushGroup();
      if (!ic) {
        c.add('error', 'EDIFACT-UNZ-UNEXPECTED', 'UNZ has no matching UNB segment.', idRange(s), segIdx(s));
      } else {
        if (ic.groups > 0) {
          checkCount(c, s, ic.groups, 'EDIFACT-UNZ-COUNT', 'functional groups (UNG to UNE) in the interchange', ic.messages);
        } else {
          checkCount(c, s, ic.messages, 'EDIFACT-UNZ-COUNT', 'messages (UNH to UNT) in the interchange');
        }
        if (!ic.implicit) checkRef(c, s, ic.ref, 'EDIFACT-UNZ-REF', 'the UNB interchange control reference');
        ic = null;
      }
      if (tail !== 2) tail = 1;
    } else if (msg) {
      msg.body++;
    }
  }

  flushInterchange();
}

/* ------------------------------------------------------------------ */
/* ANSI X12                                                            */
/* ------------------------------------------------------------------ */

/**
 * Validates an ANSI X12 message: fixed-width ISA, ISA..IEA / GS..GE / ST..SE
 * nesting, counts, control numbers, ISA16, duplicate control numbers, empty
 * transaction sets and segment identifiers.
 */
function validateX12(message, c) {
  const segs = segmentList(message);
  if (segs.length === 0) {
    c.add('error', 'X12-NO-SEGMENTS', 'No X12 segments were found; an interchange must contain at least ISA and IEA.', [0, 1], -1);
    return;
  }

  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const id = sid(s);
    if (id === '') {
      c.add('error', 'X12-SEGMENT-ID-EMPTY', 'Segment has no identifier (a stray segment terminator or a delimiter at the start of a segment).', segRange(s), segIdx(s));
    } else if (!/^[A-Z0-9]{2,3}$/.test(id)) {
      c.add('warning', 'X12-SEGMENT-ID-INVALID', 'Segment identifier "' + show(id) + '" is not two or three upper-case letters or digits.', idRange(s), segIdx(s));
    }
  }

  let isa = null;
  let gs = null;
  let st = null;
  const isaRefs = new Set();
  const firstSeg = segs[0];

  if (sid(firstSeg) !== 'ISA') {
    c.add('error', 'X12-ISA-MISSING', 'The interchange must start with ISA, but the first segment is ' + showId(firstSeg) + '.', idRange(firstSeg), segIdx(firstSeg));
    isa = { seg: null, ref: '', groups: 0, gsRefs: new Set(), implicit: true };
  }

  function flushSt() {
    if (!st) return;
    c.add('error', 'X12-SE-MISSING', 'Transaction set ' + (st.ref === '' ? '(no control number)' : '"' + show(st.ref) + '"') + ' opened by ST is not closed by an SE segment.', idRange(st.seg), segIdx(st.seg));
    st = null;
  }
  function flushGs() {
    flushSt();
    if (!gs) return;
    c.add('error', 'X12-GE-MISSING', 'Functional group ' + (gs.ref === '' ? '(no control number)' : '"' + show(gs.ref) + '"') + ' opened by GS is not closed by a GE segment.', idRange(gs.seg), segIdx(gs.seg));
    gs = null;
  }
  function flushIsa() {
    flushGs();
    if (!isa) return;
    if (isa.implicit) {
      const last = segs[segs.length - 1];
      if (sid(last) !== 'IEA') {
        c.add('error', 'X12-IEA-MISSING', 'The interchange does not end with an IEA segment; the last segment is ' + showId(last) + '.', idRange(last), segIdx(last));
      }
    } else {
      c.add('error', 'X12-IEA-MISSING', 'Interchange ' + (isa.ref === '' ? '(no control number)' : '"' + show(isa.ref) + '"') + ' opened by ISA is not closed by an IEA segment.', idRange(isa.seg), segIdx(isa.seg));
    }
    isa = null;
  }

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const id = sid(s);

    if (id === 'ISA') {
      flushIsa();
      isa = { seg: s, ref: elementValue(s, 13), groups: 0, gsRefs: new Set(), implicit: false };
      const len = segRaw(s).length;
      if (len !== 105) {
        c.add('error', 'X12-ISA-LENGTH', 'ISA is ' + len + ' characters long without its terminator; the fixed-width ISA must be 105 characters plus the terminator (106 in total).', segRange(s), segIdx(s));
      }
      const isa16 = element(s, 16);
      if (!isa16 || isa16.raw === '') {
        c.add('error', 'X12-ISA16-MISSING', 'ISA16 (the component element separator) is missing.', elementSpan(s, 16), segIdx(s));
      }
      if (isa.ref === '') {
        c.add('error', 'X12-ISA-CONTROL-MISSING', 'ISA13 (interchange control number) is missing.', elementSpan(s, 13), segIdx(s));
      } else if (isaRefs.has(isa.ref)) {
        c.add('warning', 'X12-DUPLICATE-CONTROL', 'ISA13 control number "' + show(isa.ref) + '" was already used by an earlier interchange in this file.', elementSpan(s, 13), segIdx(s));
      } else {
        isaRefs.add(isa.ref);
      }
    } else if (id === 'GS') {
      flushGs();
      gs = { seg: s, ref: elementValue(s, 6), sets: 0, stRefs: new Set() };
      if (!isa) {
        c.add('error', 'X12-GS-OUTSIDE-ISA', 'GS appears outside an ISA..IEA interchange.', idRange(s), segIdx(s));
      } else {
        isa.groups++;
      }
      if (gs.ref === '') {
        c.add('error', 'X12-GS-CONTROL-MISSING', 'GS06 (group control number) is missing.', elementSpan(s, 6), segIdx(s));
      } else if (isa && isa.gsRefs.has(gs.ref)) {
        c.add('warning', 'X12-DUPLICATE-CONTROL', 'GS06 control number "' + show(gs.ref) + '" was already used by an earlier group in this interchange.', elementSpan(s, 6), segIdx(s));
      } else if (isa) {
        isa.gsRefs.add(gs.ref);
      }
    } else if (id === 'ST') {
      flushSt();
      st = { seg: s, pos: i, ref: elementValue(s, 2), body: 0 };
      if (!gs) {
        c.add('error', 'X12-ST-OUTSIDE-GS', 'ST appears outside a GS..GE functional group.', idRange(s), segIdx(s));
      } else {
        gs.sets++;
      }
      if (st.ref === '') {
        c.add('error', 'X12-ST-CONTROL-MISSING', 'ST02 (transaction set control number) is missing.', elementSpan(s, 2), segIdx(s));
      } else if (gs && gs.stRefs.has(st.ref)) {
        c.add('warning', 'X12-DUPLICATE-CONTROL', 'ST02 control number "' + show(st.ref) + '" was already used by an earlier transaction set in this group.', elementSpan(s, 2), segIdx(s));
      } else if (gs) {
        gs.stRefs.add(st.ref);
      }
    } else if (id === 'SE') {
      if (!st) {
        c.add('error', 'X12-SE-UNEXPECTED', 'SE has no matching ST segment.', idRange(s), segIdx(s));
      } else {
        checkCount(c, s, i - st.pos + 1, 'X12-SE-COUNT', 'segments from ST to SE inclusive');
        checkRef(c, s, st.ref, 'X12-SE-CONTROL', 'the ST02 control number');
        if (st.body === 0) {
          c.add('warning', 'X12-TRANSACTION-EMPTY', 'Transaction set ' + (st.ref === '' ? '(no control number)' : '"' + show(st.ref) + '"') + ' has no segments between ST and SE.', idRange(st.seg), segIdx(st.seg));
        }
        st = null;
      }
    } else if (id === 'GE') {
      flushSt();
      if (!gs) {
        c.add('error', 'X12-GE-UNEXPECTED', 'GE has no matching GS segment.', idRange(s), segIdx(s));
      } else {
        checkCount(c, s, gs.sets, 'X12-GE-COUNT', 'transaction sets (ST to SE) in the group');
        checkRef(c, s, gs.ref, 'X12-GE-CONTROL', 'the GS06 control number');
        gs = null;
      }
    } else if (id === 'IEA') {
      flushGs();
      if (!isa) {
        c.add('error', 'X12-IEA-UNEXPECTED', 'IEA has no matching ISA segment.', idRange(s), segIdx(s));
      } else {
        checkCount(c, s, isa.groups, 'X12-IEA-COUNT', 'functional groups (GS to GE) in the interchange');
        if (!isa.implicit) checkRef(c, s, isa.ref, 'X12-IEA-CONTROL', 'the ISA13 control number');
        isa = null;
      }
    } else if (st) {
      st.body++;
    }
  }

  flushIsa();
}

/* ------------------------------------------------------------------ */
/* HL7 v2                                                              */
/* ------------------------------------------------------------------ */

/**
 * Finds runs of blank lines that sit before more content. Trailing blank
 * lines at the end of the input are not reported. Returns [start, end] pairs.
 */
function findBlankRuns(text) {
  const lines = [];
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    let e = pos;
    while (e < n) {
      const ch = text.charCodeAt(e);
      if (ch === 13 || ch === 10) break;
      e++;
    }
    let t = e;
    if (t < n) {
      t += text.charCodeAt(t) === 13 && text.charCodeAt(t + 1) === 10 ? 2 : 1;
    }
    let blank = true;
    for (let k = pos; k < e; k++) {
      const code = text.charCodeAt(k);
      if (code !== 32 && code !== 9 && code !== 0xfeff) {
        blank = false;
        break;
      }
    }
    lines.push({ start: pos, end: t, blank: blank });
    pos = t;
  }
  let lastContent = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lines[k].blank) {
      lastContent = k;
      break;
    }
  }
  const runs = [];
  let open = null;
  for (let k = 0; k < lastContent; k++) {
    if (lines[k].blank) {
      if (open) open[1] = lines[k].end;
      else open = [lines[k].start, lines[k].end];
    } else if (open) {
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);
  return runs;
}

/** Splits the raw text of an MSH segment on the field separator, returning start/end positions. */
function splitFields(raw, fs) {
  const out = [];
  let pos = 0;
  for (;;) {
    const k = raw.indexOf(fs, pos);
    if (k < 0) {
      out.push({ start: pos, end: raw.length });
      return out;
    }
    out.push({ start: pos, end: k });
    pos = k + 1;
  }
}

/** True when a field value holds nothing but whitespace and the given separator characters. */
function isBlankField(value, separators) {
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch.trim() !== '' && separators.indexOf(ch) < 0) return false;
  }
  return true;
}

/** Validates the delimiters and required header fields of one MSH segment. */
function checkMsh(c, seg) {
  const raw = segRaw(seg);
  const start = segStart(seg);
  const fs = raw.charAt(3);
  if (raw.length < 4 || fs === '' || /[A-Za-z0-9\s]/.test(fs)) {
    c.add('error', 'HL7-MSH-FIELD-SEPARATOR', 'MSH must be followed by a field separator character (usually "|"); found ' + (raw.length < 4 ? 'nothing' : '"' + show(fs) + '"') + '.', [start, start + Math.min(raw.length, 4)], segIdx(seg));
    return;
  }
  const fields = splitFields(raw, fs);
  const encField = fields.length > 1 ? fields[1] : { start: 4, end: 4 };
  const enc = raw.slice(encField.start, encField.end);
  const encRange = [start + encField.start, start + Math.max(encField.end, encField.start + 1)];
  let encOk = enc.length === 4 || enc.length === 5;
  if (!encOk) {
    c.add('error', 'HL7-MSH-ENCODING', 'MSH-2 must hold the four encoding characters (component, repetition, escape, subcomponent); found ' + enc.length + ' character' + (enc.length === 1 ? '' : 's') + '.', encRange, segIdx(seg));
  } else {
    const seen = new Set([fs]);
    let problem = '';
    for (let i = 0; i < enc.length; i++) {
      const ch = enc.charAt(i);
      if (/[A-Za-z0-9\s]/.test(ch)) problem = 'letters, digits and white space cannot be delimiters';
      else if (seen.has(ch)) problem = 'the field separator and the encoding characters must all be different';
      seen.add(ch);
    }
    if (problem !== '') {
      encOk = false;
      c.add('error', 'HL7-MSH-ENCODING', 'MSH-2 "' + show(enc) + '" is not valid: ' + problem + '.', encRange, segIdx(seg));
    }
  }
  const separators = fs + (encOk ? enc : '^~\\&');

  function fieldCheck(n, code, severity, label) {
    const f = fields[n - 1];
    const value = f ? raw.slice(f.start, f.end) : '';
    if (!f || isBlankField(value, separators)) {
      const range = f ? [start + f.start, start + Math.max(f.end, f.start + 1)] : segRange(seg);
      c.add(severity, code, label + ' is missing.', range, segIdx(seg));
    }
  }
  fieldCheck(9, 'HL7-MSH-TYPE-MISSING', 'error', 'MSH-9 (message type)');
  fieldCheck(10, 'HL7-MSH-CONTROL-ID-MISSING', 'error', 'MSH-10 (message control id)');
  fieldCheck(12, 'HL7-MSH-VERSION-MISSING', 'warning', 'MSH-12 (version id)');
}

/**
 * Returns the segment id used for HL7 rules. A segment that starts with MSH
 * followed directly by a letter or digit has no usable field separator (the
 * parser then reads the whole first field as the id), so it is treated as an
 * MSH segment and reported by the MSH field separator rule.
 */
function hl7Id(seg) {
  const id = sid(seg);
  const raw = segRaw(seg);
  if (id !== 'MSH' && raw.indexOf('MSH') === 0 && raw.length > 3 && /[A-Za-z0-9]/.test(raw.charAt(3))) return 'MSH';
  return id;
}

/**
 * Validates an HL7 v2 message: first segment, MSH delimiters and required
 * fields, segment identifiers, blank lines and FHS/FTS and BHS/BTS batch
 * trailers with their counts.
 */
function validateHl7(message, c, text) {
  const all = segmentList(message);
  const segs = all.filter(function (s) {
    return segRaw(s).trim() !== '';
  });

  const runs = findBlankRuns(text);
  for (let r = 0; r < runs.length; r++) {
    c.add('info', 'HL7-BLANK-LINE', 'Blank line between segments. HL7 segments are separated by a single line break.', runs[r], -1);
  }

  if (segs.length === 0) {
    c.add('error', 'HL7-MSH-MISSING', 'No HL7 segments were found; a message must start with an MSH segment.', [0, 1], -1);
    return;
  }

  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const id = hl7Id(s);
    if (!/^[A-Z][A-Z0-9]{2}$/.test(id)) {
      c.add('error', 'HL7-SEGMENT-ID-INVALID', id === '' ? 'Segment has no identifier.' : 'Segment identifier "' + show(id) + '" must be three characters (A-Z, 0-9) starting with a letter.', idRange(s), segIdx(s));
    }
  }

  const firstSeg = segs[0];
  const firstId = hl7Id(firstSeg);
  if (firstId !== 'MSH' && firstId !== 'FHS' && firstId !== 'BHS') {
    c.add('error', 'HL7-MSH-MISSING', 'The first segment must be MSH (or a FHS/BHS batch header), but it is ' + showId(firstSeg) + '.', idRange(firstSeg), segIdx(firstSeg));
  }

  let file = null; // open FHS
  let batch = null; // open BHS
  let looseMessages = 0;

  function flushBatch() {
    if (!batch) return;
    c.add('error', 'HL7-BTS-MISSING', 'Batch opened by BHS is not closed by a BTS segment.', idRange(batch.seg), segIdx(batch.seg));
    batch = null;
  }

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const id = hl7Id(s);
    if (id === 'MSH') {
      checkMsh(c, s);
      if (batch) batch.messages++;
      else looseMessages++;
    } else if (id === 'FHS') {
      flushBatch();
      if (file) {
        c.add('error', 'HL7-FTS-MISSING', 'File opened by FHS is not closed by an FTS segment.', idRange(file.seg), segIdx(file.seg));
      }
      file = { seg: s, batches: 0 };
      looseMessages = 0;
    } else if (id === 'BHS') {
      flushBatch();
      batch = { seg: s, messages: 0 };
      if (file) file.batches++;
    } else if (id === 'BTS') {
      if (!batch) {
        c.add('error', 'HL7-BTS-UNEXPECTED', 'BTS has no matching BHS segment.', idRange(s), segIdx(s));
      } else {
        if (elementValue(s, 1) !== '') {
          checkCount(c, s, batch.messages, 'HL7-BTS-COUNT', 'messages (MSH) in the batch');
        }
        batch = null;
      }
    } else if (id === 'FTS') {
      flushBatch();
      if (!file) {
        c.add('error', 'HL7-FTS-UNEXPECTED', 'FTS has no matching FHS segment.', idRange(s), segIdx(s));
      } else {
        if (elementValue(s, 1) !== '') {
          if (file.batches > 0) {
            checkCount(c, s, file.batches, 'HL7-FTS-COUNT', 'batches (BHS to BTS) in the file');
          } else {
            checkCount(c, s, looseMessages, 'HL7-FTS-COUNT', 'messages (MSH) in the file');
          }
        }
        file = null;
      }
    }
  }

  flushBatch();
  if (file) {
    c.add('error', 'HL7-FTS-MISSING', 'File opened by FHS is not closed by an FTS segment.', idRange(file.seg), segIdx(file.seg));
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Normalises opts.maxIssues to a non-negative integer (default 500). */
function resolveMax(opts) {
  const v = opts && opts.maxIssues;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return DEFAULT_MAX_ISSUES;
}

/**
 * Validates a parsed message and returns a list of issues sorted by position.
 * The format is taken from message.format ('edifact', 'x12' or 'hl7'); any
 * other value yields an empty list. Options: maxIssues (default 500) caps the
 * returned list; includeParseIssues (default false) prepends the syntax issues
 * that the parser stored in message.issues. The function never throws: if the
 * message object is damaged beyond reading, the issues found so far are
 * returned together with one internal-error issue.
 */
function validate(message, opts) {
  const max = resolveMax(opts);
  if (!message || typeof message !== 'object' || max === 0) return [];
  const text = typeof message.text === 'string' ? message.text : '';
  const c = createCollector(text.length);

  if (opts && opts.includeParseIssues === true && Array.isArray(message.issues)) {
    for (let i = 0; i < message.issues.length; i++) {
      const p = message.issues[i];
      if (p && typeof p === 'object') {
        c.add(
          p.severity === 'warning' || p.severity === 'info' ? p.severity : 'error',
          typeof p.code === 'string' ? p.code : 'SYNTAX',
          typeof p.message === 'string' ? p.message : 'Syntax problem.',
          [p.offset, p.end],
          p.segmentIndex
        );
      }
    }
  }

  const format = message.format;
  const prefix = format === 'edifact' ? 'EDIFACT' : format === 'x12' ? 'X12' : format === 'hl7' ? 'HL7' : '';
  try {
    if (format === 'edifact') validateEdifact(message, c, text);
    else if (format === 'x12') validateX12(message, c);
    else if (format === 'hl7') validateHl7(message, c, text);
  } catch (err) {
    c.add('error', prefix + '-INTERNAL', 'Validation stopped early because the message structure could not be read.', [0, 0], -1);
  }

  const decorated = c.items.map(function (issue, n) {
    return { issue: issue, n: n };
  });
  decorated.sort(function (a, b) {
    return a.issue.offset - b.issue.offset || a.n - b.n;
  });
  const result = [];
  for (let i = 0; i < decorated.length && i < max; i++) result.push(decorated[i].issue);
  return result;
}

module.exports = { validate: validate };
