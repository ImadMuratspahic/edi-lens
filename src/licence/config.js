'use strict';
// Licence server settings. The extension only talks to the public licence endpoints of the
// payment provider, so no secret key is ever shipped.
//
// Flip `mode` to 'live' only after the live product exists and `buyUrlLive` holds its checkout
// link. `assertShippable()` is run by the package script and refuses to build otherwise.

const config = {
  mode: 'live',
  apiBaseTest: 'https://test.dodopayments.com',
  apiBaseLive: 'https://live.dodopayments.com',
  buyUrlTest: 'https://test.checkout.dodopayments.com/buy/pdt_0NqrEZaiFzCqjDPsdymnW?quantity=1',
  productIdLive: 'pdt_0NriIrMqPm9xOakMMZtw4',
  buyUrlLive: 'https://checkout.dodopayments.com/buy/pdt_0NriIrMqPm9xOakMMZtw4?quantity=1'
};

/**
 * Resolves the effective environment. `modeOverride` is the value of the `ediLens.licenceMode`
 * setting; anything other than 'test' or 'live' falls back to the built-in default mode.
 * Returns `{ mode, api, buyUrl }`; `buyUrl` is an empty string when no checkout link exists yet.
 */
function resolve(modeOverride) {
  const mode = modeOverride === 'live' || modeOverride === 'test' ? modeOverride : config.mode;
  if (mode === 'live') return { mode, api: config.apiBaseLive, buyUrl: config.buyUrlLive };
  return { mode, api: config.apiBaseTest, buyUrl: config.buyUrlTest };
}

/**
 * Throws when this build must not be published: a live mode (built in, or chosen as the default
 * of the `ediLens.licenceMode` setting in the given package manifest) without a valid https
 * checkout link. Used by the `vscode:prepublish` script.
 */
function assertShippable(manifest) {
  const problems = [];
  const modes = [config.mode];
  const props = manifest && manifest.contributes && manifest.contributes.configuration &&
    manifest.contributes.configuration.properties;
  if (props && props['ediLens.licenceMode']) modes.push(props['ediLens.licenceMode'].default);
  if (modes.indexOf('live') !== -1 && !config.buyUrlLive) {
    problems.push('live mode is selected but buyUrlLive is empty');
  }
  if (config.buyUrlLive && !/^https:\/\//.test(config.buyUrlLive)) {
    problems.push('buyUrlLive must be an https URL');
  }
  if (!/^https:\/\//.test(config.apiBaseLive) || !/^https:\/\//.test(config.apiBaseTest)) {
    problems.push('licence API base URLs must be https');
  }
  if (problems.length) throw new Error('Refusing to build: ' + problems.join('; '));
  return true;
}

module.exports = Object.assign(config, { resolve, assertShippable });
