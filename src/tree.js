'use strict';
// The "EDI Lens" outline view: Segment > Element > (Repetition) > Component > Subcomponent for
// the active editor. The node description logic is pure (plain descriptors, no editor API) and
// is turned into tree items by createTree().

const { shorten, isSupportedLanguage, describeSafe } = require('./format');

const MAX_ROOT_NODES = 20000;
const PREVIEW_LENGTH = 40;
const REFRESH_DELAY_MS = 300;

function fallbackPath(segment, elementIndex, componentIndex, subIndex, repetitionIndex) {
  let p = segment.id + '[' + segment.occurrence + ']';
  if (elementIndex === undefined) return p;
  p += '-' + elementIndex;
  if (repetitionIndex !== undefined && repetitionIndex > 1) p += '(' + repetitionIndex + ')';
  if (componentIndex !== undefined) p += '.' + componentIndex;
  if (subIndex !== undefined) p += '.' + subIndex;
  return p;
}

function nonEmpty(item) { return item && item.raw !== ''; }

// Does the element have anything to expand below it?
function elementHasChildren(element) {
  const reps = element.repetitions || [];
  if (reps.length > 1) return true;
  const comps = reps.length ? reps[0].components || [] : [];
  if (comps.length > 1) return true;
  return comps.length === 1 && (comps[0].subcomponents || []).length > 1;
}

function componentHasChildren(component) {
  return (component.subcomponents || []).length > 1;
}

function joinDescription(name, preview, valueName) {
  const shown = valueName ? preview + ' (' + valueName + ')' : preview;
  return name ? name + ' · ' + shown : shown;
}

function makeContext(deps) {
  return {
    path: deps.formatPath || fallbackPath,
    describe: deps.describe || function () { return {}; }
  };
}

/**
 * Builds the top level descriptors (one per segment) for a message. `deps.formatPath` and
 * `deps.describe(segmentId, elementIndex, componentIndex, value)` are optional. At most
 * `deps.maxSegments` segments are listed; a final "more" descriptor reports the rest.
 */
function segmentDescriptors(message, deps) {
  const ctx = makeContext(deps || {});
  const limit = (deps && deps.maxSegments) || MAX_ROOT_NODES;
  const out = [];
  const segments = (message && message.segments) || [];
  const count = Math.min(segments.length, limit);
  for (let i = 0; i < count; i++) {
    const seg = segments[i];
    const names = ctx.describe(seg.id) || {};
    const preview = shorten(seg.raw.slice(seg.id.length + 1), PREVIEW_LENGTH);
    out.push({
      kind: 'segment',
      id: 'S' + seg.index,
      label: seg.id + '[' + seg.occurrence + ']',
      description: joinDescription(names.segmentName, preview),
      tooltip: [ctx.path(seg), shorten(seg.raw, 200), names.segmentName || ''].filter(Boolean).join('\n'),
      collapsible: (seg.elements || []).some(nonEmpty),
      start: seg.offset,
      end: seg.offset + seg.raw.length,
      path: ctx.path(seg),
      ref: { segment: seg }
    });
  }
  if (segments.length > count) {
    out.push({
      kind: 'more',
      id: 'more',
      label: '… ' + (segments.length - count) + ' more segments',
      description: 'use "EDI Lens: Go to Segment"',
      tooltip: 'The outline lists the first ' + count + ' segments.',
      collapsible: false,
      start: -1,
      end: -1,
      path: '',
      ref: {}
    });
  }
  return out;
}

function elementDescriptor(seg, element, ctx) {
  const names = ctx.describe(seg.id, element.index) || {};
  const repCount = (element.repetitions || []).length;
  const path = ctx.path(seg, element.index);
  return {
    kind: 'element',
    id: 'E' + seg.index + '.' + element.index,
    label: seg.id + '-' + element.index,
    description: joinDescription(names.elementName, shorten(element.raw, PREVIEW_LENGTH)),
    tooltip: [path, shorten(element.raw, 200), names.elementName || '', repCount > 1 ? repCount + ' repetitions' : ''].filter(Boolean).join('\n'),
    collapsible: elementHasChildren(element),
    start: element.offset,
    end: element.end,
    path: path,
    ref: { segment: seg, element: element }
  };
}

function componentDescriptor(seg, element, repetitionIndex, component, ctx) {
  const names = ctx.describe(seg.id, element.index, component.index, component.raw) || {};
  const rep = repetitionIndex > 1 ? repetitionIndex : undefined;
  const path = ctx.path(seg, element.index, component.index, undefined, rep);
  return {
    kind: 'component',
    id: 'C' + seg.index + '.' + element.index + (rep ? '(' + rep + ')' : '') + '.' + component.index,
    label: seg.id + '-' + element.index + (rep ? '(' + rep + ')' : '') + '.' + component.index,
    description: joinDescription(names.componentName, shorten(component.raw, PREVIEW_LENGTH), names.valueName),
    tooltip: [path, shorten(component.raw, 200), names.componentName || '', names.valueName || ''].filter(Boolean).join('\n'),
    collapsible: componentHasChildren(component),
    start: component.offset,
    end: component.end,
    path: path,
    ref: { segment: seg, element: element, repetitionIndex: repetitionIndex, component: component }
  };
}

function subDescriptor(seg, element, repetitionIndex, component, sub, ctx) {
  const rep = repetitionIndex > 1 ? repetitionIndex : undefined;
  const path = ctx.path(seg, element.index, component.index, sub.index, rep);
  return {
    kind: 'subcomponent',
    id: 'U' + seg.index + '.' + element.index + (rep ? '(' + rep + ')' : '') + '.' + component.index + '.' + sub.index,
    label: seg.id + '-' + element.index + (rep ? '(' + rep + ')' : '') + '.' + component.index + '.' + sub.index,
    description: shorten(sub.raw, PREVIEW_LENGTH),
    tooltip: [path, shorten(sub.raw, 200)].join('\n'),
    collapsible: false,
    start: sub.offset,
    end: sub.end,
    path: path,
    ref: { segment: seg, element: element, repetitionIndex: repetitionIndex, component: component }
  };
}

function componentLevel(seg, element, repetitionIndex, repetition, ctx) {
  const comps = (repetition.components || []).filter(nonEmpty);
  // A single component that has subcomponents is expanded directly one level further.
  if (comps.length === 1 && (repetition.components || []).length === 1 && componentHasChildren(comps[0])) {
    return comps[0].subcomponents.filter(nonEmpty).map(function (s) {
      return subDescriptor(seg, element, repetitionIndex, comps[0], s, ctx);
    });
  }
  return comps.map(function (c) { return componentDescriptor(seg, element, repetitionIndex, c, ctx); });
}

/**
 * Returns the child descriptors of a descriptor: the elements of a segment, the repetitions or
 * components of an element, the components of a repetition, the subcomponents of a component.
 * Empty items are left out; indexes in labels keep their real position.
 */
function childDescriptors(desc, deps) {
  const ctx = makeContext(deps || {});
  const ref = desc.ref || {};
  const seg = ref.segment;
  if (!seg) return [];
  if (desc.kind === 'segment') {
    return (seg.elements || []).filter(nonEmpty).map(function (e) { return elementDescriptor(seg, e, ctx); });
  }
  if (desc.kind === 'element') {
    const element = ref.element;
    const reps = element.repetitions || [];
    if (reps.length > 1) {
      const out = [];
      reps.forEach(function (rep, i) {
        if (rep.components.length === 0) return;
        const n = i + 1;
        const raw = rep.components.map(function (c) { return c.raw; }).join('');
        if (raw === '' && rep.components.length === 1) return;
        const path = ctx.path(seg, element.index, undefined, undefined, n);
        const first = rep.components[0];
        const last = rep.components[rep.components.length - 1];
        out.push({
          kind: 'repetition',
          id: 'R' + seg.index + '.' + element.index + '.' + n,
          label: seg.id + '-' + element.index + '(' + n + ')',
          description: shorten(element.raw.slice(first.offset - element.offset, last.end - element.offset), PREVIEW_LENGTH),
          tooltip: path,
          collapsible: rep.components.length > 1 || componentHasChildren(rep.components[0]),
          start: first.offset,
          end: last.end,
          path: path,
          ref: { segment: seg, element: element, repetitionIndex: n, repetition: rep }
        });
      });
      return out;
    }
    return reps.length ? componentLevel(seg, element, 1, reps[0], ctx) : [];
  }
  if (desc.kind === 'repetition') {
    return componentLevel(seg, ref.element, ref.repetitionIndex, ref.repetition, ctx);
  }
  if (desc.kind === 'component') {
    return (ref.component.subcomponents || []).filter(nonEmpty).map(function (s) {
      return subDescriptor(seg, ref.element, ref.repetitionIndex, ref.component, s, ctx);
    });
  }
  return [];
}

/**
 * Creates the outline view. `app` provides: vscode, getSettings(), getMessage(document),
 * dictionaryFor(message) and the core functions through getCore(). Returns
 * `{ view, refresh, dispose }`.
 */
function createTree(app) {
  const vscode = app.vscode;
  const changeEmitter = new vscode.EventEmitter();
  let document = null;
  let timer = null;
  let describe = null;
  let formatPath = null;

  function currentDocument() {
    const editor = vscode.window.activeTextEditor;
    if (editor) document = isSupportedLanguage(editor.document.languageId) ? editor.document : null;
    return document;
  }

  function deps() {
    return { formatPath: formatPath || undefined, describe: describe || undefined };
  }

  const provider = {
    onDidChangeTreeData: changeEmitter.event,
    getTreeItem: function (desc) {
      const collapsible = desc.collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      const item = new vscode.TreeItem(desc.label, collapsible);
      item.id = (document ? document.uri.toString() : '') + '|' + desc.id;
      item.description = desc.description;
      item.tooltip = desc.tooltip;
      item.contextValue = desc.kind === 'more' ? 'ediLens.more' : 'ediLens.node';
      const icons = { segment: 'symbol-namespace', element: 'symbol-field', repetition: 'symbol-array', component: 'symbol-property', subcomponent: 'symbol-constant', more: 'ellipsis' };
      item.iconPath = new vscode.ThemeIcon(icons[desc.kind] || 'symbol-misc');
      if (desc.start >= 0 && document) {
        item.command = { command: 'ediLens.revealRange', title: 'Reveal in editor', arguments: [document.uri, desc.start, desc.end] };
      }
      return item;
    },
    getChildren: async function (desc) {
      if (desc) return childDescriptors(desc, deps());
      const doc = currentDocument();
      view.message = undefined;
      if (!doc) return [];
      const settings = app.getSettings();
      if (app.isTooLarge(doc)) {
        view.message = 'This file is larger than the ' + settings.maxFileSizeMB + ' MB limit (setting ediLens.maxFileSizeMB). The outline is off for it.';
        return [];
      }
      const message = app.getMessage(doc);
      if (!message) return [];
      const dictionary = await app.dictionaryFor(message);
      describe = dictionary ? function (segmentId, e, c, value) { return describeSafe(dictionary, segmentId, e, c, value); } : null;
      formatPath = app.getCore().formatPath || null;
      return segmentDescriptors(message, deps());
    }
  };

  const view = vscode.window.createTreeView('ediLens.outline', { treeDataProvider: provider, showCollapseAll: true });

  function refresh() {
    if (timer) clearTimeout(timer);
    timer = null;
    changeEmitter.fire(undefined);
  }

  function refreshSoon() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_DELAY_MS);
  }

  const subscriptions = [
    view,
    changeEmitter,
    vscode.window.onDidChangeActiveTextEditor(function () { refresh(); }),
    vscode.workspace.onDidChangeTextDocument(function (event) {
      if (document && event.document === document) refreshSoon();
    }),
    vscode.workspace.onDidCloseTextDocument(function (closed) {
      if (document && closed === document) { document = null; refresh(); }
    })
  ];

  return {
    view: view,
    refresh: refresh,
    dispose: function () {
      if (timer) clearTimeout(timer);
      subscriptions.forEach(function (d) { try { d.dispose(); } catch (e) { /* already disposed */ } });
    }
  };
}

module.exports = {
  segmentDescriptors: segmentDescriptors,
  childDescriptors: childDescriptors,
  createTree: createTree,
  MAX_ROOT_NODES: MAX_ROOT_NODES
};
