# Licence, trial and Pro

## What is free

Everything that is not marked "Pro": syntax colouring, outline, hover, status bar, Pretty Print, Minify, Format Document, Go to Segment, Copy Path, Jump To Matching Trailer, Detect Format and structural validation. The free features need no key, no account and no network connection, and they stay free in later versions.

## The trial

| | |
| --- | --- |
| Length | 14 days per computer |
| Starts | the first time you run a Pro command (not at install) |
| Needs | nothing: no key, no account, no network |
| Recorded | only in the editor's extension storage on this computer; nothing is sent anywhere |
| Shows | the days left in **EDI Lens: Show Licence Status** and in a reminder shown at most once a day |
| Ends | with a clear message on the next Pro command, with **Buy Pro** and **Enter Licence Key** buttons; the free features keep working |

The trial is not renewed. It is recorded per editor profile. A licence key always takes precedence over the trial; when a stored key stops working while the trial still runs, the Pro features stay on through the trial and **Show Licence Status** says so.

## Pro

| | |
| --- | --- |
| Features | Anonymise Message and Anonymise Folder, partner rules, Query, the envelope tools (split, merge, renumber, test acknowledgement), Compare With Another File, Export As JSON/CSV/XML, Validate Workspace, Load Dictionary, Batch Pretty Print Folder |
| Price | one-time payment: Pro Personal USD 29, Pro Business USD 59 per user, at the time of writing; the checkout page shows the final price and taxes for your country |
| Scope | one key is for one person on up to three computers at the same time |
| Duration | the key never expires and covers every update of EDI Lens |
| Seller | Dodo Payments, the payment provider and merchant of record; its buyer terms apply to payment, invoices and refunds |

### Personal or Business

| | Pro Personal | Pro Business |
| --- | --- | --- |
| Price | USD 29, once | USD 59 per user, once |
| For | one person who pays for the licence themselves; use at work is allowed | companies and other organisations that pay for the people who use Pro |
| Keys | one key | One key per user: set the number of users with the Buy command, or add ?quantity=N to the checkout link. |
| Computers | up to three per key | up to three per key |
| Moving a key | to another computer of the same person | to another computer or to a colleague in the same organisation |

Both unlock the same features and never expire. **Show Licence Status** says which kind is active on a computer. Pro is sold only through the online checkout: purchase orders, invoices with payment terms, custom contracts and vendor questionnaires are not offered.

### Buy

1. Run **EDI Lens: Buy Pro** and choose Personal or Business. For Business, enter the number of users (1 to 100). The checkout page opens in your browser; the checkout page itself has no field for the number of users.
2. Pay. The licence keys are e-mailed to the address you enter at checkout.
3. Run **EDI Lens: Enter Licence Key** and paste the key. The extension activates it with the licence server once and confirms.

### Entering a key again, or another key

* **The same key again** (for example after a reinstall of the editor that kept its storage): the key is checked with the licence server and confirmed. No second activation is used.
* **Another key** (for example a Business key replaces a Personal key): the new key is activated and stored first; then the activation of the old key is released. If the licence server does not confirm the release, the message says so, because the old key then still counts one of its three activations.
* **The limit of three computers is reached:** the message names it. Run **Remove Licence From This Machine** on a computer you no longer use; that frees its activation.

### Move a licence to another computer

1. On the old computer run **EDI Lens: Remove Licence From This Machine**. This deletes the key there and frees one of the three activations.
2. On the new computer run **EDI Lens: Enter Licence Key**.

A Business key is moved to a colleague in the same way: the previous user removes the licence on each of their computers, the new user enters the key.

If the old computer is gone (lost, broken, reinstalled), the activation is still counted. Contact support (below) so it can be released.

### Lost your key?

The key was e-mailed by the payment provider right after the purchase. Search the mailbox you used at checkout, including the spam folder, for "Dodo Payments" or "EDI Lens". Your purchases are also listed in the payment provider's customer portal. If you still cannot find it, contact support and say that you need help with your licence. Never post a key in a public issue.

### Offline

After a key is entered, the licence is checked with the licence server once a day at most (a successful check is trusted for 24 hours). If the server cannot be reached, the last successful check keeps Pro working for 14 days; **Show Licence Status** tells you until when. After those 14 days without any successful check, Pro turns off until the computer is online again; the key stays stored and nothing needs to be entered again.

### What is sent

Only the licence check, only after you enter a key: the key, the label `VS Code on <platform>` (activation only) and the activation id (validation and deactivation). No file contents, file names, user or computer names. From the answer to an activation the extension keeps the activation id and the product id; it does not keep the buyer's name or e-mail address. The trial sends nothing. Details: [PRIVACY.md](../PRIVACY.md).

### Messages you may see

| Message | Meaning | What to do |
| --- | --- | --- |
| "not recognised" | The server does not know this key. | Copy the key from the purchase e-mail again; check for typing errors. |
| "This key belongs to another product" | The key is valid, but it was sold for another product, not for EDI Lens Pro. The activation made for the check was released again. | Enter the key from your EDI Lens Pro purchase e-mail. |
| "did not say which product this key belongs to" | The answer of the licence server was incomplete, so the key was not accepted; the activation was released again. | Try again in a few minutes; contact support if it keeps happening. |
| "not active (expired, disabled or refunded)" | The server knows the key but has disabled it. | If you believe this is wrong, contact support. |
| "maximum number of computers (3)" | All three activations are in use. | Run **Remove Licence From This Machine** on one of the other computers, or contact support for a lost computer. |
| "could not be reached" | No connection to the licence server. | Check the internet connection, proxy and firewall (host `live.dodopayments.com`); nothing was changed. |
| "could not be saved in the secret storage" | The editor could not save the key. On Linux without a keyring the editor may keep the key only until it is closed; where it cannot save it at all, the activation is released again and a licence that was stored before is kept. | Start a keyring (GNOME Keyring, KWallet) or use an editor build with secret storage, then enter the key again. If the editor kept the key only for the session, enter it again after a restart: no further activation is used. |
| "offline mode ... until <date>" | The server is unreachable; the grace period runs. | Connect to the internet before that date. |
| "could not be verified for more than 14 days" | The grace period is over. | Connect to the internet and run **Show Licence Status**. |
| "no longer valid (revoked, expired or disabled)" | The stored key was rejected by the server. | Enter a different key or remove this one; contact support if you believe it should work. |

## Support

<https://github.com/small-steps-studio/edi-lens/issues>. In the editor, **EDI Lens: Report A Problem** copies a diagnostics block (no file contents, no key) and opens that page. The full terms are in [LICENSE.txt](../LICENSE.txt) and [TERMS.md](../TERMS.md).
