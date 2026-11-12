'use strict';

/*
 * Message comparison (Pro).
 *
 * Pure functions, no dependency on the editor. They work on the Message data
 * structure (segments, elements, repetitions, components) and never modify
 * their input.
 */

/** Largest alignment table (cells) the exact algorithm may allocate. */
const MAX_ALIGN_CELLS = 16000000;
/** Most table rows written into the comparison view (keeps very large comparisons responsive). */
const MAX_HTML_ROWS = 3000;

/** How far the fallback aligner looks ahead for a matching segment id. */
const GREEDY_WINDOW = 64;

/**
 * Escapes a value for safe use in HTML text and attribute values. Every
 * character that has a meaning in HTML is replaced, and values that are not
 * strings are converted first. All text that reaches the report page passes
 * through this function.
 */
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Turns a glob-like pattern (only "*" is special and matches any run of
 * characters, including none) into a case-insensitive anchored RegExp.
 */
function globToRegExp(pattern) {
  const source = String(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\\-\/]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + source + '$', 'i');
}

/**
 * Reads the comparison options and fills in defaults. Unknown keys are
 * ignored. The result is an object with an ignore-segment set, compiled
 * ignore-path patterns and the two value switches.
 */
function normaliseOptions(opts) {
  const o = opts || {};
  const ignoreSegments = new Set();
  (Array.isArray(o.ignoreSegments) ? o.ignoreSegments : []).forEach((id) => {
    if (typeof id === 'string' && id.trim() !== '') {
      ignoreSegments.add(id.trim().toUpperCase());
    }
  });
  const ignorePatterns = [];
  (Array.isArray(o.ignorePaths) ? o.ignorePaths : []).forEach((p) => {
    if (typeof p === 'string' && p.trim() !== '') {
      ignorePatterns.push(globToRegExp(p.trim()));
    }
  });
  return {
    ignoreSegments,
    ignorePatterns,
    ignoreCase: o.ignoreCase === true,
    trimValues: o.trimValues === true,
  };
}

/**
 * Returns a value in the form used for equality tests: missing values count
 * as empty, and the two value options are applied. The original value is
 * never changed, only this comparison form.
 */
function comparable(value, o) {
  let v = value === undefined || value === null ? '' : String(value);
  if (o.trimValues) {
    v = v.trim();
  }
  if (o.ignoreCase) {
    v = v.toLowerCase();
  }
  return v;
}

/**
 * Builds a flat list of the segments to compare. Segments whose id is in
 * ignoreSegments are dropped here. Each item keeps the original segment and
 * the numbers needed for reporting (occurrence is counted over the whole
 * message, so ignored segments do not renumber the others).
 */
function prepare(message, o) {
  const out = [];
  const counts = new Map();
  const segments = message && Array.isArray(message.segments) ? message.segments : [];
  segments.forEach((seg, pos) => {
    const id = String(seg.id);
    const n = (counts.get(id) || 0) + 1;
    counts.set(id, n);
    if (o.ignoreSegments.has(id.toUpperCase())) {
      return;
    }
    out.push({
      seg,
      id,
      occ: typeof seg.occurrence === 'number' ? seg.occurrence : n,
      index: typeof seg.index === 'number' ? seg.index : pos,
      line: typeof seg.line === 'number' ? seg.line : 0,
      raw: typeof seg.raw === 'string' ? seg.raw : id,
    });
  });
  return out;
}

/** Signature used to detect segments that are identical in content. */
function signature(item, o) {
  return item.id + '\u0001' + comparable(item.raw, o);
}

/**
 * Aligns two segment lists with a longest-common-subsequence search over the
 * segment ids. Among alignments with the most matched segments, the one with
 * the most identical matched segments wins, so repeated ids pair up with the
 * right partner. Returns pairs [a, b]: both set for a match, a only for a
 * removal, b only for an addition. Segments that moved appear as one removal
 * and one addition.
 */
function align(listA, listB, o) {
  const ops = [];
  const sigA = listA.map((x) => signature(x, o));
  const sigB = listB.map((x) => signature(x, o));

  // Identical leading and trailing runs need no search.
  let start = 0;
  while (start < listA.length && start < listB.length && sigA[start] === sigB[start]) {
    ops.push([listA[start], listB[start]]);
    start += 1;
  }
  let endA = listA.length;
  let endB = listB.length;
  while (endA > start && endB > start && sigA[endA - 1] === sigB[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const tail = [];
  for (let k = 0; k < listA.length - endA; k += 1) {
    tail.push([listA[endA + k], listB[endB + k]]);
  }

  const midA = listA.slice(start, endA);
  const midB = listB.slice(start, endB);
  const midSigA = sigA.slice(start, endA);
  const midSigB = sigB.slice(start, endB);
  let approximate = false;
  if ((midA.length + 1) * (midB.length + 1) > MAX_ALIGN_CELLS) {
    approximate = true;
    alignGreedy(midA, midB, ops);
  } else {
    alignExact(midA, midB, midSigA, midSigB, ops);
  }
  return { ops: ops.concat(tail), approximate };
}

/** Exact weighted LCS alignment; appends its pairs to ops. */
function alignExact(A, B, sigA, sigB, ops) {
  const n = A.length;
  const m = B.length;
  if (n === 0 || m === 0) {
    A.forEach((a) => ops.push([a, null]));
    B.forEach((b) => ops.push([null, b]));
    return;
  }
  const width = m + 1;
  const big = Math.min(n, m) + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      let best = Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      if (A[i].id === B[j].id) {
        const bonus = sigA[i] === sigB[j] ? 1 : 0;
        const viaMatch = table[(i + 1) * width + j + 1] + big + bonus;
        if (viaMatch > best) {
          best = viaMatch;
        }
      }
      table[i * width + j] = best;
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const here = table[i * width + j];
    if (A[i].id === B[j].id) {
      const bonus = sigA[i] === sigB[j] ? 1 : 0;
      if (here === table[(i + 1) * width + j + 1] + big + bonus) {
        ops.push([A[i], B[j]]);
        i += 1;
        j += 1;
        continue;
      }
    }
    if (table[(i + 1) * width + j] === here) {
      ops.push([A[i], null]);
      i += 1;
    } else {
      ops.push([null, B[j]]);
      j += 1;
    }
  }
  while (i < n) {
    ops.push([A[i], null]);
    i += 1;
  }
  while (j < m) {
    ops.push([null, B[j]]);
    j += 1;
  }
}

/**
 * Fallback for very large inputs: walks both lists once and resynchronises
 * on the next equal id within a small window. Cheaper than the exact search,
 * and may report more additions and removals on heavily reordered files.
 */
function alignGreedy(A, B, ops) {
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i].id === B[j].id) {
      ops.push([A[i], B[j]]);
      i += 1;
      j += 1;
      continue;
    }
    let skipB = -1;
    let skipA = -1;
    for (let k = 1; k <= GREEDY_WINDOW; k += 1) {
      if (skipB < 0 && j + k < B.length && B[j + k].id === A[i].id) {
        skipB = k;
      }
      if (skipA < 0 && i + k < A.length && A[i + k].id === B[j].id) {
        skipA = k;
      }
      if (skipB >= 0 || skipA >= 0) {
        break;
      }
    }
    if (skipB >= 0 && (skipA < 0 || skipB <= skipA)) {
      for (let k = 0; k < skipB; k += 1) {
        ops.push([null, B[j]]);
        j += 1;
      }
    } else if (skipA >= 0) {
      for (let k = 0; k < skipA; k += 1) {
        ops.push([A[i], null]);
        i += 1;
      }
    } else {
      ops.push([A[i], null]);
      ops.push([null, B[j]]);
      i += 1;
      j += 1;
    }
  }
  while (i < A.length) {
    ops.push([A[i], null]);
    i += 1;
  }
  while (j < B.length) {
    ops.push([null, B[j]]);
    j += 1;
  }
}

/** Path of a value in the form SEG[occurrence]-element(repetition).component.subcomponent. */
function buildPath(item, element, repetition, component, subcomponent) {
  let p = item.id + '[' + item.occ + ']';
  if (element === undefined) {
    return p;
  }
  p += '-' + element;
  if (repetition > 1) {
    p += '(' + repetition + ')';
  }
  if (component !== undefined) {
    p += '.' + component;
    if (subcomponent !== undefined) {
      p += '.' + subcomponent;
    }
  }
  return p;
}

/**
 * Lists every spelling under which an ignore pattern may address a value:
 * the full path and each parent level, with and without the occurrence and
 * with and without an explicit first repetition.
 */
function pathCandidates(item, element, repetition, component, subcomponent) {
  const levels = [];
  if (subcomponent !== undefined) {
    levels.push([element, repetition, component, subcomponent]);
  }
  levels.push([element, repetition, component, undefined]);
  levels.push([element, repetition, undefined, undefined]);
  levels.push([element, undefined, undefined, undefined]);
  levels.push([undefined, undefined, undefined, undefined]);
  const out = [];
  levels.forEach(([e, r, c, s]) => {
    const withOcc = buildPath(item, e, r, c, s);
    out.push(withOcc);
    out.push(withOcc.replace(/^[^[]+\[\d+\]/, item.id));
    if (e !== undefined && r === 1) {
      const explicit = item.id + '[' + item.occ + ']-' + e + '(1)' +
        (c !== undefined ? '.' + c + (s !== undefined ? '.' + s : '') : '');
      out.push(explicit);
      out.push(explicit.replace(/^[^[]+\[\d+\]/, item.id));
    }
  });
  return out;
}

/** Returns the raw values of a component's subcomponents ([] if it is missing). */
function subValues(component) {
  if (!component) {
    return [];
  }
  if (Array.isArray(component.subcomponents) && component.subcomponents.length > 0) {
    return component.subcomponents.map((s) => s.raw);
  }
  return [component.raw];
}

/** Maps element index to element for one segment. */
function elementMap(seg) {
  const map = new Map();
  (Array.isArray(seg.elements) ? seg.elements : []).forEach((el, pos) => {
    map.set(typeof el.index === 'number' ? el.index : pos + 1, el);
  });
  return map;
}

/**
 * Lists the value differences between two matched segments, in file order.
 * A missing value counts as empty: a trailing empty element on one side only
 * is not a difference. Values that exist on both sides are "changed"; values
 * that exist only in B are "added"; values that exist only in A are "removed".
 */
function diffSegments(itemA, itemB, o) {
  const diffs = [];
  const mapA = elementMap(itemA.seg);
  const mapB = elementMap(itemB.seg);
  const indices = Array.from(new Set(Array.from(mapA.keys()).concat(Array.from(mapB.keys()))))
    .sort((x, y) => x - y);

  indices.forEach((e) => {
    const elA = mapA.get(e);
    const elB = mapB.get(e);
    const repsA = elA && Array.isArray(elA.repetitions) ? elA.repetitions : [];
    const repsB = elB && Array.isArray(elB.repetitions) ? elB.repetitions : [];
    const repCount = Math.max(repsA.length, repsB.length);
    for (let r = 0; r < repCount; r += 1) {
      const compsA = repsA[r] && Array.isArray(repsA[r].components) ? repsA[r].components : [];
      const compsB = repsB[r] && Array.isArray(repsB[r].components) ? repsB[r].components : [];
      const compCount = Math.max(compsA.length, compsB.length);
      for (let c = 0; c < compCount; c += 1) {
        const subsA = subValues(compsA[c]);
        const subsB = subValues(compsB[c]);
        const subCount = Math.max(subsA.length, subsB.length);
        if (subCount <= 1) {
          addDifference(diffs, itemA, itemB, [e, r + 1, c + 1, undefined], subsA[0], subsB[0], o);
        } else {
          for (let s = 0; s < subCount; s += 1) {
            addDifference(diffs, itemA, itemB, [e, r + 1, c + 1, s + 1], subsA[s], subsB[s], o);
          }
        }
      }
    }
  });
  return diffs;
}

/** Compares one pair of values and records a difference unless it is equal or ignored. */
function addDifference(diffs, itemA, itemB, where, valueA, valueB, o) {
  if (comparable(valueA, o) === comparable(valueB, o)) {
    return;
  }
  const [e, r, c, s] = where;
  if (o.ignorePatterns.length > 0) {
    const candidates = pathCandidates(itemA, e, r, c, s)
      .concat(pathCandidates(itemB, e, r, c, s));
    const ignored = o.ignorePatterns.some((re) => candidates.some((p) => re.test(p)));
    if (ignored) {
      return;
    }
  }
  let kind = 'changed';
  if (valueA === undefined) {
    kind = 'added';
  } else if (valueB === undefined) {
    kind = 'removed';
  }
  diffs.push({
    path: buildPath(itemA, e, r, c, s),
    pathB: buildPath(itemB, e, r, c, s),
    kind,
    a: valueA === undefined ? null : valueA,
    b: valueB === undefined ? null : valueB,
  });
}

/** Compact description of one side of an entry. */
function side(item) {
  return {
    index: item.index,
    occurrence: item.occ,
    line: item.line,
    path: item.id + '[' + item.occ + ']',
    raw: item.raw,
  };
}

/**
 * Compares two parsed messages. Segments are aligned by a longest common
 * subsequence over their ids (repeated ids pair up in order, preferring
 * identical partners), then each matched pair is compared element by element
 * down to components and subcomponents. Options: ignoreSegments (segment ids
 * to leave out), ignorePaths (paths to skip; "*" matches any characters and a
 * pattern also covers everything below the path it names), ignoreCase and
 * trimValues. Returns { identical, segments, summary }; each entry has a
 * status of unchanged, changed, added or removed, the sides a and b, the list
 * of differences, and a moved flag on a removed/added pair with equal content.
 * When the part that differs is very large (roughly more than 4,000 segments
 * on each side) a faster, less exact alignment is used and the result has
 * approximate set to true.
 */
function compare(msgA, msgB, opts) {
  const o = normaliseOptions(opts);
  const listA = prepare(msgA, o);
  const listB = prepare(msgB, o);
  const { ops, approximate } = align(listA, listB, o);

  const entries = [];
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  ops.forEach(([a, b]) => {
    if (a && b) {
      const differences = diffSegments(a, b, o);
      const status = differences.length > 0 ? 'changed' : 'unchanged';
      summary[status] += 1;
      entries.push({ status, id: a.id, a: side(a), b: side(b), differences, moved: false });
    } else if (a) {
      summary.removed += 1;
      entries.push({ status: 'removed', id: a.id, a: side(a), b: null, differences: [], moved: false, sig: signature(a, o) });
    } else {
      summary.added += 1;
      entries.push({ status: 'added', id: b.id, a: null, b: side(b), differences: [], moved: false, sig: signature(b, o) });
    }
  });

  // Mark a removed segment and an added segment with identical content as moved.
  const pendingAdds = new Map();
  entries.forEach((entry) => {
    if (entry.status === 'added') {
      if (!pendingAdds.has(entry.sig)) {
        pendingAdds.set(entry.sig, []);
      }
      pendingAdds.get(entry.sig).push(entry);
    }
  });
  entries.forEach((entry) => {
    if (entry.status === 'removed') {
      const queue = pendingAdds.get(entry.sig);
      if (queue && queue.length > 0) {
        const partner = queue.shift();
        entry.moved = true;
        partner.moved = true;
      }
    }
  });
  entries.forEach((entry) => {
    delete entry.sig;
  });

  const result = {
    identical: summary.added === 0 && summary.removed === 0 && summary.changed === 0,
    segments: entries,
    summary,
  };
  if (approximate) {
    result.approximate = true;
  }
  return result;
}

/** Formats a value for the text report; null means the value does not exist. */
function showValue(value) {
  return value === null ? '(none)' : JSON.stringify(value);
}

/** Describes where an entry sits in the two inputs, for the text report. */
function whereText(entry, labelA, labelB) {
  const parts = [];
  if (entry.a) {
    parts.push(labelA + ' line ' + (entry.a.line + 1));
  }
  if (entry.b) {
    parts.push(labelB + ' line ' + (entry.b.line + 1));
  }
  return parts.join(', ');
}

/**
 * Renders a comparison result as plain text: a summary line, then one block
 * per added, removed and changed segment with the differing values. Options:
 * labelA and labelB (names shown for the two inputs, default "A" and "B") and
 * showUnchanged (also list unchanged segments, default false).
 */
function toText(result, opts) {
  const o = opts || {};
  const labelA = o.labelA || 'A';
  const labelB = o.labelB || 'B';
  const s = result.summary;
  const lines = [];
  lines.push('Compared ' + labelA + ' with ' + labelB);
  lines.push('Summary: ' + s.added + ' added, ' + s.removed + ' removed, ' +
    s.changed + ' changed, ' + s.unchanged + ' unchanged');
  if (result.identical) {
    lines.push('The messages are identical.');
  }
  if (result.approximate) {
    lines.push('Note: the files are large, so the alignment is approximate.');
  }
  result.segments.forEach((entry) => {
    if (entry.status === 'unchanged' && !o.showUnchanged) {
      return;
    }
    lines.push('');
    const where = whereText(entry, labelA, labelB);
    if (entry.status === 'added') {
      lines.push('+ ' + entry.b.path + ' (' + where + ')' + (entry.moved ? ' [moved]' : ''));
      lines.push('    ' + entry.b.raw);
    } else if (entry.status === 'removed') {
      lines.push('- ' + entry.a.path + ' (' + where + ')' + (entry.moved ? ' [moved]' : ''));
      lines.push('    ' + entry.a.raw);
    } else if (entry.status === 'changed') {
      lines.push('~ ' + entry.a.path + ' (' + where + ')');
      entry.differences.forEach((d) => {
        const label = d.path === d.pathB ? d.path : d.path + ' / ' + d.pathB;
        lines.push('    ' + label + ': ' + showValue(d.a) + ' -> ' + showValue(d.b));
      });
    } else {
      lines.push('= ' + entry.a.path + ' (' + where + ')');
    }
  });
  return lines.join('\n') + '\n';
}

/** Short label for a status, used in the HTML report. */
const STATUS_LABEL = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  unchanged: 'Same',
};

/**
 * Renders a comparison result as a self-contained HTML document for a
 * webview: a summary, then a two-column table (A on the left, B on the right)
 * with one row per segment and the value differences listed under changed
 * rows. Every piece of text taken from the messages or the options is
 * escaped. The page contains no script and no external resource. Options:
 * labelA, labelB, title and showUnchanged (default true).
 */
function toHtml(result, opts) {
  const o = opts || {};
  const labelA = escapeHtml(o.labelA || 'A');
  const labelB = escapeHtml(o.labelB || 'B');
  const title = escapeHtml(o.title || 'EDI Lens comparison');
  const maxRows = o.maxRows > 0 ? o.maxRows : MAX_HTML_ROWS;
  let showUnchanged = o.showUnchanged !== false;
  let unchangedHidden = false;
  if (showUnchanged && result.segments.length > maxRows) {
    showUnchanged = false;
    unchangedHidden = true;
  }
  const s = result.summary;
  const out = [];
  out.push('<!DOCTYPE html>');
  out.push('<html lang="en"><head><meta charset="utf-8">');
  out.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\';">');
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push('<title>' + title + '</title>');
  out.push('<style>' + STYLE + '</style></head><body>');
  out.push('<h1>' + title + '</h1>');
  out.push('<p class="summary">' +
    '<span class="tag added">' + s.added + ' added</span> ' +
    '<span class="tag removed">' + s.removed + ' removed</span> ' +
    '<span class="tag changed">' + s.changed + ' changed</span> ' +
    '<span class="tag unchanged">' + s.unchanged + ' unchanged</span></p>');
  if (result.identical) {
    out.push('<p class="note">The messages are identical.</p>');
  }
  if (result.approximate) {
    out.push('<p class="note">The files are large, so the alignment is approximate.</p>');
  }
  out.push('<table><thead><tr><th class="status">Status</th><th>' + labelA +
    '</th><th>' + labelB + '</th></tr></thead><tbody>');
  if (unchangedHidden) {
    out.push('<p class="note">The files are large, so unchanged segments are not listed.</p>');
  }
  let rows = 0;
  let cut = 0;
  result.segments.forEach((entry) => {
    if (entry.status === 'unchanged' && !showUnchanged) {
      return;
    }
    if (rows >= maxRows) {
      cut += 1;
      return;
    }
    rows += 1;
    const status = escapeHtml(entry.status);
    const moved = entry.moved ? ' <span class="moved">moved</span>' : '';
    out.push('<tr class="' + status + '"><td class="status">' + escapeHtml(STATUS_LABEL[entry.status] || entry.status) + moved + '</td>');
    out.push('<td>' + cellHtml(entry.a) + '</td><td>' + cellHtml(entry.b) + '</td></tr>');
    if (entry.differences.length > 0) {
      out.push('<tr class="detail"><td></td><td colspan="2"><ul>');
      entry.differences.forEach((d) => {
        const label = d.path === d.pathB ? d.path : d.path + ' / ' + d.pathB;
        out.push('<li><code>' + escapeHtml(label) + '</code> ' +
          '<span class="from">' + valueHtml(d.a) + '</span> &rarr; ' +
          '<span class="to">' + valueHtml(d.b) + '</span></li>');
      });
      out.push('</ul></td></tr>');
    }
  });
  out.push('</tbody></table>');
  if (cut > 0) {
    out.push('<p class="note">The first ' + maxRows + ' rows are shown; ' + cut +
      ' more are left out. Use the ignore settings or compare smaller files to see them.</p>');
  }
  out.push('</body></html>');
  return out.join('\n');
}

/** One side of an entry as a table cell body. */
function cellHtml(info) {
  if (!info) {
    return '<span class="none">&mdash;</span>';
  }
  return '<div class="path">' + escapeHtml(info.path) + ' <span class="line">line ' +
    escapeHtml(info.line + 1) + '</span></div><code>' + escapeHtml(info.raw) + '</code>';
}

/** A value for the HTML report; null means the value does not exist. */
function valueHtml(value) {
  if (value === null) {
    return '<span class="none">(none)</span>';
  }
  return '<code>' + escapeHtml(value === '' ? '(empty)' : value) + '</code>';
}

const STYLE = [
  'body{font-family:var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#222);background:var(--vscode-editor-background,#fff);margin:16px;}',
  'h1{font-size:1.3em;margin:0 0 8px;}',
  'table{border-collapse:collapse;width:100%;min-width:620px;table-layout:fixed;}',
  'th,td{border:1px solid var(--vscode-panel-border,#ccc);padding:4px 8px;vertical-align:top;text-align:left;overflow-wrap:anywhere;}',
  'th.status,td.status{width:90px;}',
  'code{font-family:var(--vscode-editor-font-family,monospace);white-space:pre-wrap;}',
  '.path{font-weight:bold;margin-bottom:2px;}',
  '.line,.none{opacity:.6;font-weight:normal;}',
  '.tag{padding:2px 8px;border-radius:3px;margin-right:6px;}',
  '.added,.tag.added{background:rgba(60,160,60,.22);}',
  '.removed,.tag.removed{background:rgba(200,60,60,.22);}',
  '.changed,.tag.changed{background:rgba(210,160,40,.25);}',
  'tr.unchanged{opacity:.75;}',
  'tr.detail{background:transparent;}',
  'ul{margin:0;padding-left:18px;}',
  '.moved{font-size:.8em;opacity:.7;}',
  '.note{opacity:.8;}',
].join('');

module.exports = { compare, toText, toHtml, escapeHtml };
