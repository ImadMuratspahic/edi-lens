'use strict';
// Every sentence the licence and trial features show to the user, in one place and free of
// editor API calls so that each wording can be unit-tested. Each message says what happened and
// what to do next.

const config = require('./config');

const PRODUCT = 'EDI Lens';

/** Formats a time in milliseconds as a date for messages (the user's locale and time zone). */
function dateText(ms) {
  return new Date(ms).toLocaleDateString();
}

function dayWord(n) { return n === 1 ? '1 day' : n + ' days'; }

/** 'Personal licence' or 'Business licence' for a licence type, or '' when it is not known. */
function licenceTypeLabel(type) {
  return type === 'business' ? 'Business licence' : type === 'personal' ? 'Personal licence' : '';
}

/** The two prices in one phrase, for the Pro notice. */
function pricePhrase() {
  return 'Personal ' + config.priceText + ', Business ' + config.businessPriceText;
}

/** Describes the licence and trial state in one or two sentences, for Show Licence Status. */
function licenceStatusText(st) {
  const env = st.mode === 'test' ? ' (licence server: test environment)' : '';
  const trial = st.trial || { state: 'unused' };
  const kind = licenceTypeLabel(st.licenceType);
  // A stored key that does not work never hides a trial that is still running.
  const trialNote = trial.state === 'active' ? ' The Pro features stay on through your trial: ' + dayWord(trial.daysLeft) + ' left (ends ' + dateText(trial.endsAt) + ').' : '';
  if (st.pro && st.via === 'grace') {
    return PRODUCT + ' Pro' + (kind ? ' (' + kind + ')' : '') + ' is active in offline mode: the licence server could not be reached, so the last successful check is used. Pro stays active until ' +
      dateText(st.graceEndsAt) + '. Connect to the internet before then; the check then runs again on its own.' + env;
  }
  if (st.pro) {
    return PRODUCT + ' Pro is active on this computer (' + (kind ? kind + ', ' : '') + 'key ' + st.keyHint + '). Last verified ' +
      new Date(st.lastGoodAt).toLocaleString() + '.' + env;
  }
  if (st.hasKey && st.via === 'product') {
    return 'The stored licence key ' + st.keyHint + ' belongs to another product, so ' + (trialNote ? 'it does not unlock Pro' : 'the Pro features are off') + '. Remove it with "' + PRODUCT + ': Remove Licence From This Machine" and enter an ' + PRODUCT + ' Pro key.' + trialNote + env;
  }
  if (st.hasKey && st.via === 'rejected') {
    return 'The licence server reports that the key ' + st.keyHint + ' is no longer valid (revoked, expired or disabled), so ' + (trialNote ? 'it does not unlock Pro' : 'the Pro features are off') + '. ' +
      'Enter a different key, or remove this one with "' + PRODUCT + ': Remove Licence From This Machine". If you believe the key should work, contact ' + config.supportContact() + '.' + trialNote + env;
  }
  if (st.hasKey) {
    return (trialNote ? 'The' : 'Pro is off: the') + ' licence key ' + st.keyHint + ' could not be verified for more than ' + config.graceDays + ' days because the licence server was not reachable. Connect to the internet and run this command again; the key stays stored.' + trialNote + env;
  }
  const offer = 'a licence key (one-time purchase: ' + pricePhrase() + '; each key works on up to ' + config.activationLimit + ' computers)';
  if (trial.state === 'active') {
    return PRODUCT + ' Pro trial: ' + dayWord(trial.daysLeft) + ' left (ends ' + dateText(trial.endsAt) + '). Every Pro feature is on until then. The trial is recorded only on this computer; no key is stored.' + env;
  }
  if (trial.state === 'expired') {
    return PRODUCT + ' Free. Your ' + config.trialDays + '-day Pro trial ended on ' + dateText(trial.endsAt) + '. The free features keep working; ' + offer + ' turns the Pro features back on.' + env;
  }
  return PRODUCT + ' Free. No licence key is stored on this computer. Running any Pro command starts a free ' + config.trialDays + '-day trial of the Pro features; the trial is recorded only on this computer and needs no account.' + env;
}

/** Returns the one-sentence message for a failed activation reason. */
function activationFailureText(result) {
  // Said only when the server confirmed it; otherwise the user is told that the seat may still count.
  const released = result.released === false
    ? 'The activation that was made for the check could not be released (the licence server did not confirm it), so it may still count against the limit of ' + config.activationLimit + '; if a later activation is refused, contact ' + config.supportContact() + '. Nothing was stored.'
    : 'The activation that was made for the check was released again and nothing was stored.';
  switch (result.reason) {
    case 'limit':
      return 'This key is already active on the maximum number of computers (' + config.activationLimit + '), so it was not activated here. Run "' + PRODUCT + ': Remove Licence From This Machine" on one of the other computers (that frees its activation), then enter the key here again. If you no longer have access to that computer, contact ' + config.supportContact() + '.' +
        (result.hasStored ? ' The licence that is already stored on this computer was not changed.' : '');
    case 'invalid':
      return 'That key was not recognised. Check it for typing errors (copy and paste it from the purchase e-mail) and try again. Nothing was changed on this computer.';
    case 'inactive':
      return 'The licence server knows this key but reports it as not active (expired, disabled or refunded), so it cannot be used. If you believe this is wrong, contact ' + config.supportContact() + ' (never post the key itself in a public issue).';
    case 'network':
      return 'The licence server could not be reached. Check your internet connection (and any proxy or firewall rule for ' + new URL(config.apiBaseLive).host + '), then try again; nothing was changed.';
    case 'product':
      return 'This key belongs to another product, not to ' + PRODUCT + ' Pro, so it was not accepted. ' + released + ' Enter the key from your ' + PRODUCT + ' Pro purchase e-mail.';
    case 'unverified':
      return 'The licence server did not say which product this key belongs to, so the key was not accepted. ' + released + ' Please try again in a few minutes; if it keeps failing, contact ' + config.supportContact() + '.';
    case 'storage':
      if (result.kept) return 'The key is valid, but the editor could not save the licence state on this computer, so nothing was changed. On Linux a keyring such as GNOME Keyring or KWallet must be running; then try again.';
      return 'The key could not be saved in the secret storage of this editor (no credential store is available). ' + released + ' Pro stays off on this computer. On Linux a keyring such as GNOME Keyring or KWallet must be running; then try again.';
    default:
      return 'The licence check failed' + (result.status ? ' (HTTP ' + result.status + ')' : '') + '. Please try again in a few minutes; if it keeps failing, contact ' + config.supportContact() + '.';
  }
}

/** The notice shown when a Pro command runs without a licence and without an active trial. */
function proNoticeText(feature, trial) {
  const t = trial || { state: 'unused' };
  let why;
  if (t.state === 'expired') why = 'Your ' + config.trialDays + '-day trial ended on ' + dateText(t.endsAt) + '.';
  else if (t.state === 'unavailable') why = 'The free trial could not be started because the editor\'s storage is not writable on this computer.';
  else why = 'A licence key unlocks it.';
  return feature + ' is an ' + PRODUCT + ' Pro feature. ' + why + ' All free features keep working without a licence. Pro is a one-time purchase (' + pricePhrase() + '); each key works on up to ' + config.activationLimit + ' computers.';
}

/** The message shown once, when the trial starts. */
function trialStartedText(trial) {
  return 'Your free ' + config.trialDays + '-day trial of ' + PRODUCT + ' Pro has started: every Pro feature is available until ' + dateText(trial.endsAt) + '. The trial is recorded only on this computer and needs no account, key or internet connection.';
}

/** The daily reminder while the trial runs. */
function trialReminderText(trial) {
  return PRODUCT + ' Pro trial: ' + dayWord(trial.daysLeft) + ' left (ends ' + dateText(trial.endsAt) + '). This reminder appears at most once a day.';
}

/** Help for a buyer who cannot find the licence key. */
function lostKeyText() {
  return 'Your licence key was e-mailed to the address you entered at checkout by the payment provider, ' + config.providerName + ', right after the purchase. ' +
    'Search that mailbox, including the spam folder, for "' + config.providerName + '" or "' + PRODUCT + '". Your purchases are also listed in the payment provider\'s customer portal. ' +
    'If you still cannot find the key, contact ' + config.supportContact() + ' and say that you need help with your licence (never post a key in a public issue).';
}

/** The two choices of the Buy command: [{ tier, label, description, detail }]. */
function buyChoices() {
  return [
    {
      tier: 'personal',
      label: PRODUCT + ' Pro Personal',
      description: config.priceText + ', one-time',
      detail: 'For one person who pays for the licence themselves. One key for up to ' + config.activationLimit + ' of your computers; use at work is allowed.'
    },
    {
      tier: 'business',
      label: PRODUCT + ' Pro Business',
      description: config.businessPriceText + ', one-time',
      detail: 'For companies and other organisations. ' + config.businessSeatsText + ' You are asked for the number of users next.'
    }
  ];
}

/** The question of the Buy command for a Business purchase. */
function businessUsersQuestion() {
  return 'How many users? (1-' + config.maxUsers + ')';
}

/** Checks the answer to businessUsersQuestion(); returns an error text or null. */
function businessUsersError(input) {
  const text = String(input === undefined || input === null ? '' : input).trim();
  if (!/^[0-9]{1,3}$/.test(text) || Number(text) < 1 || Number(text) > config.maxUsers) {
    return 'Enter a whole number from 1 to ' + config.maxUsers + '.';
  }
  return null;
}

/**
 * The message shown after a key was accepted. `result` is what activate() returned: a key that
 * was already active here is said to be so (no new activation was used), and a replaced key
 * whose activation could not be released is named.
 */
function activatedText(licenceType, result) {
  const kind = licenceTypeLabel(licenceType);
  const r = result || {};
  if (r.already) {
    return 'This key is already active on this computer' + (kind ? ' (' + kind + ')' : '') + '. It was checked with the licence server and is valid; no further activation was used.';
  }
  const replaced = !r.replaced ? '' : r.previousReleased
    ? ' The activation of the key that was stored before was released.'
    : ' The activation of the key that was stored before could not be released (the licence server did not confirm it); it may still count against that key\'s limit of ' + config.activationLimit + '. If that key is refused elsewhere, contact ' + config.supportContact() + '.';
  return PRODUCT + ' Pro is now active on this computer' + (kind ? ' (' + kind + ')' : '') + '. Thank you. The key is kept in the editor\'s secret storage; "' + PRODUCT + ': Remove Licence From This Machine" frees the activation again' +
    (licenceType === 'business' ? ', for example to pass the key on to a colleague.' : '.') + replaced;
}

/** The confirmation shown before the licence is removed from this computer. */
function removeConfirmText() {
  return 'Remove the licence from this computer? This frees one of the ' + config.activationLimit + ' activations so the key can be used on another computer. The Pro features turn off here until a key is entered again.';
}

module.exports = {
  licenceStatusText: licenceStatusText,
  activationFailureText: activationFailureText,
  proNoticeText: proNoticeText,
  trialStartedText: trialStartedText,
  trialReminderText: trialReminderText,
  lostKeyText: lostKeyText,
  removeConfirmText: removeConfirmText,
  licenceTypeLabel: licenceTypeLabel,
  buyChoices: buyChoices,
  businessUsersQuestion: businessUsersQuestion,
  businessUsersError: businessUsersError,
  activatedText: activatedText,
  dateText: dateText
};
