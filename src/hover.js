'use strict';
// Hover information: path, raw value, position inside the segment and, with a loaded dictionary
// (Pro), the names of the segment, element, component and code value.

const { LANGUAGES, shorten, codePointLength, describeSafe } = require('./format');

const VALUE_PREVIEW = 200;

/** Wraps a value in a markdown code span whose fence is longer than any backtick run inside. */
function inlineCode(value) {
  const text = String(value).replace(/[\r\n]+/g, ' ');
  let longest = 0;
  const runs = text.match(/`+/g) || [];
  for (const r of runs) if (r.length > longest) longest = r.length;
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return fence + pad + text + pad + fence;
}

/**
 * Describes what a hover should show for a located position as a list of lines; every line is a
 * list of parts `{ t: 'md' | 'text' | 'code', v }`. `names` holds optional dictionary names
 * (`segmentName`, `elementName`, `componentName`, `valueName`). Pure and unit-tested.
 */
function hoverLines(loc, names) {
  const n = names || {};
  const lines = [];
  const seg = loc.segment;
  const element = loc.element;
  const sub = loc.subcomponent;
  const comp = loc.component;
  const value = sub ? sub.raw : comp ? comp.raw : element ? element.raw : seg.raw;

  lines.push([{ t: 'md', v: '**' }, { t: 'code', v: loc.path }, { t: 'md', v: '**' }]);

  const named = [];
  if (n.segmentName) named.push('Segment: ' + n.segmentName);
  if (n.elementName) named.push('Element: ' + n.elementName);
  if (n.componentName) named.push('Component: ' + n.componentName);
  if (n.valueName) named.push('Value: ' + n.valueName);
  for (const text of named) lines.push([{ t: 'text', v: text }]);

  lines.push([{ t: 'text', v: 'Value: ' }, { t: 'code', v: shorten(value, VALUE_PREVIEW) }]);

  const where = [];
  if (element) where.push('element ' + element.index);
  if (element && loc.repetition) {
    const reps = element.repetitions || [];
    const at = reps.indexOf(loc.repetition) + 1;
    if (at > 0) where.push('repetition ' + at + ' of ' + reps.length);
  }
  if (comp) where.push('component ' + comp.index);
  if (sub && comp && (comp.subcomponents || []).length > 1) where.push('subcomponent ' + sub.index);
  if (!element) where.push('segment ' + seg.id + ', occurrence ' + seg.occurrence + ', position ' + (seg.index + 1));
  lines.push([{ t: 'text', v: 'Position: ' + where.join(', ') }]);
  lines.push([{ t: 'text', v: 'Length: ' + codePointLength(value) + ' code points' }]);
  return lines;
}

// The most specific item at the location, used as the hover range.
function rangeOf(loc) {
  const item = loc.subcomponent || loc.component || loc.element || loc.segment;
  const start = item.offset;
  const end = item.end !== undefined ? item.end : start + (item.raw || '').length;
  return { start: start, end: loc.element || loc.component ? end : start + loc.segment.id.length };
}

/** Registers the hover provider for the three languages and returns its disposables. */
function registerHover(app) {
  const vscode = app.vscode;
  const provider = {
    provideHover: async function (document, position) {
      if (!app.getSettings().hoverEnabled) return null;
      const message = app.getMessage(document);
      const core = app.getCore();
      if (!message || !core.locate) return null;
      let loc = null;
      try { loc = core.locate(message, document.offsetAt(position)); } catch (e) { loc = null; }
      if (!loc || !loc.segment) return null;

      let names = {};
      const dictionary = await app.dictionaryFor(message);
      if (dictionary) {
        const element = loc.element;
        const comp = loc.component;
        const sub = loc.subcomponent;
        const value = sub ? sub.raw : comp ? comp.raw : element ? element.raw : '';
        names = describeSafe(dictionary, loc.segment.id, element ? element.index : undefined, comp ? comp.index : undefined, value);
      }

      const md = new vscode.MarkdownString();
      md.isTrusted = false;
      md.supportHtml = false;
      for (const line of hoverLines(loc, names)) {
        for (const part of line) {
          if (part.t === 'md') md.appendMarkdown(part.v);
          else if (part.t === 'code') md.appendMarkdown(inlineCode(part.v));
          else md.appendText(part.v);
        }
        md.appendMarkdown('\n\n');
      }
      const r = rangeOf(loc);
      return new vscode.Hover(md, new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)));
    }
  };
  return LANGUAGES.map(function (l) {
    return vscode.languages.registerHoverProvider({ language: l.id }, provider);
  });
}

module.exports = { hoverLines: hoverLines, inlineCode: inlineCode, registerHover: registerHover };
