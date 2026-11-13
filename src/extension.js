'use strict';
// EDI Lens entry point. Builds the shared `app` object, installs every part of the extension and
// keeps a failure in one part from taking the others down.

const vscode = require('vscode');
const os = require('node:os');
const fmt = require('./format');
const { createLicence } = require('./licence/licence');
const { createDiagnostics } = require('./diagnostics');
const { createTree } = require('./tree');
const { registerHover } = require('./hover');
const { createStatus } = require('./status');
const { registerCommands, registerAutoDetect } = require('./commands');

const DICTIONARY_KEY = 'ediLens.dictionaryUri';

function numberSetting(value, fallback, min, max) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function stringList(value) {
  return Array.isArray(value) ? value.filter(function (v) { return typeof v === 'string' && v.trim() !== ''; }) : [];
}

/**
 * The licence server environment: the live one. No setting, command or other part of the user
 * interface can change it. Only an extension development host that was started with
 * EDI_LENS_LICENCE_MODE=test asks for the payment provider's test environment, and even then it
 * only gets it when the checkout of the source code is there: the test hosts and test product ids
 * are in src/licence/test-environment.js, a file that is not part of the packaged extension, so an
 * installed copy answers every such request with the live environment (see src/licence/config.js).
 */
function licenceModeFor(context, environment) {
  const env = environment || process.env;
  const development = vscode.ExtensionMode !== undefined && !!context && context.extensionMode !== undefined &&
    context.extensionMode !== vscode.ExtensionMode.Production;
  return development && env.EDI_LENS_LICENCE_MODE === 'test' ? 'test' : 'live';
}

/** Activates the extension. Never throws: each part is installed on its own. */
function activate(context) {
  let output = null;
  function log(text) {
    if (!output) output = vscode.window.createOutputChannel('EDI Lens');
    output.appendLine(text);
  }

  let settingsCache = null;
  function getSettings() {
    if (settingsCache) return settingsCache;
    const c = vscode.workspace.getConfiguration('ediLens');
    settingsCache = {
      validateOnType: c.get('validateOnType', true) !== false,
      maxFileSizeMB: numberSetting(c.get('maxFileSizeMB', 10), 10, 0.1, 500),
      maxIssues: Math.floor(numberSetting(c.get('maxIssues', 500), 500, 1, 5000)),
      hoverEnabled: c.get('hover.enabled', true) !== false,
      autoDetectLanguage: c.get('autoDetectLanguage', true) !== false,
      workspaceInclude: String(c.get('workspace.include', '**/*.{edi,edifact,edf,x12,x12edi,hl7}') || '**/*.{edi,edifact,edf,x12,x12edi,hl7}'),
      workspaceExclude: String(c.get('workspace.exclude', '**/{node_modules,.git,.hg,.svn}/**') || '**/{node_modules,.git,.hg,.svn}/**'),
      exportNeutraliseFormulas: c.get('export.neutraliseFormulas', true) !== false,
      compare: {
        ignoreSegments: stringList(c.get('compare.ignoreSegments', [])),
        ignorePaths: stringList(c.get('compare.ignorePaths', [])),
        ignoreCase: c.get('compare.ignoreCase', false) === true,
        trimValues: c.get('compare.trimValues', false) === true
      },
      anonymise: {
        rulesFile: String(c.get('anonymise.rulesFile', '.edilens/anonymise.json') || '.edilens/anonymise.json'),
        profiles: stringList(c.get('anonymise.profiles', ['hl7-patient', 'x12-healthcare', 'x12-party', 'edifact-party'])),
        envelopeIds: c.get('anonymise.envelopeIds', 'pseudonymise') === 'keep' ? 'keep' : 'pseudonymise',
        copyUnchanged: c.get('anonymise.copyUnchanged', false) === true
      },
      rules: { file: String(c.get('rules.file', '.edilens/rules.json') || '.edilens/rules.json') },
      query: {
        ignoreCase: c.get('query.ignoreCase', false) === true,
        maxResults: Math.floor(numberSetting(c.get('query.maxResults', 1000), 1000, 1, 10000))
      },
      envelope: {
        startNumber: Math.floor(numberSetting(c.get('envelope.startNumber', 1), 1, 1, 999999999)),
        x12Acknowledgement: c.get('envelope.x12Acknowledgement', '997') === '999' ? '999' : '997'
      }
    };
    return settingsCache;
  }

  const licenceMode = licenceModeFor(context);

  const licence = createLicence({
    secrets: context.secrets,
    globalState: context.globalState,
    getMode: function () { return licenceMode; }
  });

  const messages = fmt.createMessageCache();
  const sizeChecks = new WeakMap();

  const app = {
    vscode: vscode,
    context: context,
    licence: licence,
    state: { dictionary: null },
    workspaceCollection: vscode.languages.createDiagnosticCollection('ediLens.workspace'),
    diagnostics: null,
    tree: null,
    status: null,
    getSettings: getSettings,
    getCore: fmt.getCore,
    getPro: fmt.getPro,
    // Version and platform facts for "Report A Problem" (never a host name or a user name).
    extensionVersion: (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || require('../package.json').version,
    osRelease: function () { try { return os.release(); } catch (e) { return ''; } },

    // True when the document is larger than the size limit (cached per document version).
    isTooLarge: function (document) {
      const limit = getSettings().maxFileSizeMB;
      const hit = sizeChecks.get(document);
      if (hit && hit.version === document.version && hit.limit === limit) return hit.big;
      const big = fmt.exceedsLimit(document.getText().length, limit);
      sizeChecks.set(document, { version: document.version, limit: limit, big: big });
      return big;
    },

    // Parsed message of a document, or null (too large unless `force`, or parser unavailable).
    getMessage: function (document, force) {
      if (!force && app.isTooLarge(document)) return null;
      return messages.get(document, document.version, function () { return document.getText(); });
    },

    // The dictionary to use for a message: Pro (licence or running trial) only, and only for the
    // dictionary's own format. Reading never starts the trial.
    dictionaryFor: async function (message) {
      const d = app.state.dictionary;
      if (!d || !message || d.format !== message.format) return null;
      return (await licence.hasAccess()) ? d : null;
    },

    setDictionary: async function (dictionary, uriText) {
      app.state.dictionary = dictionary;
      await context.workspaceState.update(DICTIONARY_KEY, uriText ? uriText : undefined);
    },

    // Reloads the dictionary remembered for this workspace (Pro only); silent when it is gone.
    restoreDictionary: async function () {
      const stored = context.workspaceState.get(DICTIONARY_KEY);
      if (!stored) { app.state.dictionary = null; return; }
      if (!(await licence.hasAccess())) { app.state.dictionary = null; return; }
      try {
        const pro = fmt.getPro();
        if (!pro.dictionary) return;
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(stored));
        const decoded = fmt.decodeUtf8(bytes);
        const loaded = decoded ? pro.dictionary.loadDictionary(decoded.text) : null;
        app.state.dictionary = loaded && loaded.ok ? loaded.dictionary : null;
      } catch (e) {
        app.state.dictionary = null;
      }
    },

    afterLicenceChange: async function () {
      await app.restoreDictionary();
      if (app.tree) app.tree.refresh();
    }
  };

  const subscriptions = context.subscriptions;
  subscriptions.push(app.workspaceCollection);
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (event) {
    if (event.affectsConfiguration('ediLens')) settingsCache = null;
  }));

  function install(name, fn) {
    try {
      const result = fn();
      if (Array.isArray(result)) result.forEach(function (d) { subscriptions.push(d); });
      else if (result && typeof result.dispose === 'function') subscriptions.push(result);
      return result;
    } catch (err) {
      log('Could not start ' + name + ': ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  install('commands', function () { return registerCommands(app); });
  install('language detection', function () { return registerAutoDetect(app); });
  app.diagnostics = install('diagnostics', function () { return createDiagnostics(app); });
  app.tree = install('outline', function () { return createTree(app); });
  install('Pro tools', function () {
    const tools = fmt.loadModule('protools');
    if (!tools || !app.proHelpers) throw new Error('the module could not be loaded');
    return tools.registerProTools(app, app.proHelpers);
  });
  install('hover', function () { return registerHover(app); });
  install('formatting', function () {
    return fmt.registerFormatting(vscode, function (document) { return app.getMessage(document, false); });
  });
  app.status = install('status bar', function () { return createStatus(app); });
  if (app.diagnostics && app.status) {
    app.diagnostics.onDidUpdate(function (document) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === document) app.status.update();
    });
    app.status.update();
  }

  // Warm the licence cache and restore the remembered dictionary without delaying start-up. A
  // machine without a stored key makes no network request here, and the trial is only read.
  app.afterLicenceChange().then(undefined, function (err) {
    log('Start-up licence check failed: ' + (err && err.message ? err.message : err));
  });
}

/** Called by the editor on shutdown; everything is released through the subscriptions. */
function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate, licenceModeFor: licenceModeFor };
