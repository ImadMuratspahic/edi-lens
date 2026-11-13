'use strict';
// Licence server settings, the trial length and the support links: the one place where these
// values live. The extension only talks to the public licence endpoints of the payment
// provider, so no secret key is ever shipped.
//
// The installed extension always uses the live environment. The payment provider's test
// environment (its host, its checkout address and the ids of its two test products) lives in
// ./test-environment.js, which is not part of the packaged extension (.vscodeignore): it exists
// only for an extension development host (see src/extension.js) and for the unit tests, and no
// setting or command can select it. Without that file a request for the test environment is
// answered with the live one, and the package carries no test host and no test product id.
// `assertShippable()` is run by the package script and refuses to build otherwise.
//
// `products` is the list of products whose keys unlock Pro, per environment. A key of any other
// product of the same seller is refused when it is activated.

let testEnvironment = null;
try { testEnvironment = require('./test-environment'); } catch (e) { testEnvironment = null; }

const config = {
  mode: 'live',
  apiBaseTest: testEnvironment ? testEnvironment.apiBase : '',
  apiBaseLive: 'https://live.dodopayments.com',
  buyUrlTest: testEnvironment ? testEnvironment.checkoutBase + testEnvironment.products.personal + '?quantity=1' : '',
  productIdLive: 'pdt_0NriIrMqPm9xOakMMZtw4',
  buyUrlLive: 'https://checkout.dodopayments.com/buy/pdt_0NriIrMqPm9xOakMMZtw4?quantity=1',
  checkoutBaseTest: testEnvironment ? testEnvironment.checkoutBase : '',
  checkoutBaseLive: 'https://checkout.dodopayments.com/buy/',
  // True in a development checkout, false in the packaged extension.
  testEnvironmentAvailable: !!testEnvironment,
  products: {
    live: { personal: 'pdt_0NriIrMqPm9xOakMMZtw4', business: 'pdt_0NrkGSyl3UXB82kEhwUxy' },
    test: testEnvironment ? Object.assign({}, testEnvironment.products) : { personal: '', business: '' }
  },

  // Length of the free Pro trial in days. Every message, document and test reads this value.
  trialDays: 14,
  // Days a validated licence keeps working while the licence server cannot be reached.
  graceDays: 14,
  // Hours a successful licence check is trusted before the server is asked again.
  cacheHours: 24,
  // Number of computers one key may be active on (set on the payment provider's product).
  activationLimit: 3,
  // One-time price as shown on the listing (the checkout page shows the final amount and taxes).
  priceText: 'USD 29',
  // One-time price of a Business licence, per user.
  businessPriceText: 'USD 59 per user',
  // Largest number of users the Buy command accepts for one Business checkout.
  maxUsers: 100,
  // How Business licences are counted (a purchase for N users yields N separate keys). This one
  // sentence is quoted by the Buy command, the README, the documentation and the legal texts.
  businessSeatsText: 'One key per user: set the number of users with the Buy command, or add ?quantity=N to the checkout link.',
  // Name of the payment provider and merchant of record, as shown in licence messages.
  providerName: 'Dodo Payments',

  // Support and documentation links. `supportEmail` may stay empty: the messages then point at
  // the issues page only. Never put a personal name or a private address here.
  supportEmail: '',
  issuesUrl: 'https://github.com/small-steps-studio/edi-lens/issues',
  docsUrl: 'https://github.com/small-steps-studio/edi-lens#readme',
  repositoryUrl: 'https://github.com/small-steps-studio/edi-lens'
};

/**
 * Resolves the effective environment. `modeOverride` is 'test' or 'live' (tests and a development
 * host pass it); anything else falls back to the built-in default mode. 'test' is honoured only
 * when the test environment file exists, which is never the case in the packaged extension: there
 * every request is answered with the live environment.
 * Returns `{ mode, api, buyUrl }`; `buyUrl` is an empty string when no checkout link exists yet.
 */
function resolve(modeOverride) {
  let mode = modeOverride === 'live' || modeOverride === 'test' ? modeOverride : config.mode;
  if (mode === 'test' && !testEnvironment) mode = 'live';
  if (mode === 'live') return { mode, api: config.apiBaseLive, buyUrl: config.buyUrlLive };
  return { mode, api: config.apiBaseTest, buyUrl: config.buyUrlTest };
}

/**
 * Returns the support contact in one phrase for messages: the e-mail address when one is
 * configured, otherwise the issues page.
 */
function supportContact() {
  return config.supportEmail ? config.supportEmail + ' or ' + config.issuesUrl : config.issuesUrl;
}

/**
 * Throws when this build must not be published: a mode other than live, a manifest that offers
 * the licence environment as a setting, a live mode without a valid https checkout link, a checkout link that does not carry its product id, or implausible limits.
 * Used by the `vscode:prepublish` script and the release gate.
 */
function assertShippable(manifest) {
  const problems = [];
  const modes = [config.mode];
  if (config.mode !== 'live') problems.push('the built-in licence mode must be live');
  const props = manifest && manifest.contributes && manifest.contributes.configuration &&
    manifest.contributes.configuration.properties;
  if (props && props['ediLens.licenceMode']) problems.push('the manifest must not offer the licence environment as a setting (ediLens.licenceMode)');
  if (modes.indexOf('live') !== -1 && !config.buyUrlLive) {
    problems.push('live mode is selected but buyUrlLive is empty');
  }
  if (config.buyUrlLive && !/^https:\/\//.test(config.buyUrlLive)) {
    problems.push('buyUrlLive must be an https URL');
  }
  if (config.buyUrlLive && config.productIdLive && config.buyUrlLive.indexOf(config.productIdLive) === -1) {
    problems.push('buyUrlLive does not contain productIdLive');
  }
  if (!/^https:\/\//.test(config.apiBaseLive) || (testEnvironment && !/^https:\/\//.test(config.apiBaseTest))) {
    problems.push('licence API base URLs must be https');
  }
  if (config.apiBaseLive !== 'https://live.dodopayments.com') problems.push('the live licence host must be live.dodopayments.com');
  if (config.checkoutBaseLive !== 'https://checkout.dodopayments.com/buy/') problems.push('the live checkout base is wrong');
  if (testEnvironment && (config.products.live.personal === config.products.test.personal || config.products.live.business === config.products.test.business)) {
    problems.push('live and test product ids must differ');
  }
  if (!/^https:\/\//.test(config.issuesUrl) || !/^https:\/\//.test(config.docsUrl)) {
    problems.push('support links must be https URLs');
  }
  for (const env of testEnvironment ? ['live', 'test'] : ['live']) {
    for (const tier of ['personal', 'business']) {
      const id = config.products && config.products[env] ? config.products[env][tier] : undefined;
      if (typeof id !== 'string' || !/^pdt_[A-Za-z0-9]{10,60}$/.test(id) || /placeholder/i.test(id)) {
        problems.push('the ' + env + ' ' + tier + ' product id is missing or still a placeholder');
      }
    }
  }
  if (config.products && config.products.live && config.products.live.personal !== config.productIdLive) {
    problems.push('productIdLive and products.live.personal differ');
  }
  if (config.products && config.products.live && config.products.live.personal === config.products.live.business) {
    problems.push('the Personal and Business products must be different');
  }
  if (config.buyUrlLive && config.buyUrlLive !== config.checkoutBaseLive + config.productIdLive + '?quantity=1') {
    problems.push('buyUrlLive is not the Personal checkout link');
  }
  if (!(config.trialDays >= 1 && config.trialDays <= 90)) {
    problems.push('trialDays must be between 1 and 90');
  }
  if (problems.length) throw new Error('Refusing to build: ' + problems.join('; '));
  return true;
}

const TIERS = ['personal', 'business'];
const PRODUCT_ID = /^pdt_[A-Za-z0-9]{10,60}$/;

function modeOf(modeOverride) { return resolve(modeOverride).mode; }

/** Returns the product ids whose keys unlock Pro in the given environment (well-formed ids only). */
function allowedProductIds(modeOverride) {
  const set = config.products[modeOf(modeOverride)] || {};
  return TIERS.map(function (t) { return set[t]; }).filter(function (id) { return typeof id === 'string' && PRODUCT_ID.test(id); });
}

/** Returns 'personal' or 'business' for a product id of the given environment, or '' for any other id. */
function licenceTypeOf(modeOverride, productId) {
  const set = config.products[modeOf(modeOverride)] || {};
  if (typeof productId !== 'string' || !PRODUCT_ID.test(productId)) return '';
  for (const t of TIERS) if (set[t] === productId) return t;
  return '';
}

/**
 * Returns the checkout link of a tier ('personal' or 'business') in the given environment, or an
 * empty string when that product does not exist. `users` (1 to maxUsers) is the quantity of a
 * Business purchase; a Personal purchase is always one licence.
 */
function buyUrlFor(modeOverride, tier, users) {
  const mode = modeOf(modeOverride);
  const id = (config.products[mode] || {})[tier];
  if (typeof id !== 'string' || !PRODUCT_ID.test(id)) return '';
  let quantity = 1;
  if (tier === 'business') {
    quantity = users;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > config.maxUsers) return '';
  }
  return (mode === 'live' ? config.checkoutBaseLive : config.checkoutBaseTest) + id + '?quantity=' + quantity;
}

module.exports = Object.assign(config, { resolve, supportContact, assertShippable, allowedProductIds, licenceTypeOf, buyUrlFor, TIERS });
