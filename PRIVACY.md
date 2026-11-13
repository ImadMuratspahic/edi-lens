# Privacy

Last updated: 2026-11-12 (EDI Lens 0.2.1)

EDI Lens works on your computer. This page states exactly what the extension stores and what it sends over the network, which is very little.

## What stays on your computer

* The contents and names of your files. Parsing, validation, formatting, comparison, export, workspace scans, anonymising, partner rules, queries and the envelope tools are performed locally and nothing about them is sent anywhere.
* The replacement table of an anonymise run (which original value became which replacement). It exists only in memory and is gone when the window is closed. It is written to a file only when you run **EDI Lens: Export Pseudonym Map** and choose where; that file then holds original values and is yours to protect. The anonymise report contains counts only.
* Your rule files (`.edilens/anonymise.json`, `.edilens/rules.json`) and the queries you save for a workspace.
* Your dictionary files and settings.
* The free 14-day trial of the Pro features. Its start time, the time it was last used and the time of the last reminder are kept in the editor's extension storage on this computer. Nothing about the trial is sent anywhere, not even to the payment provider, and it needs no account.
* There is **no telemetry**, no usage statistics, no crash reporting and no advertising.

## The one network request: the licence check (Pro only)

The optional Pro tier is unlocked with a licence key. After you enter a key (**EDI Lens: Enter Licence Key**), the extension talks to the licence service of the payment provider, Dodo Payments, at `live.dodopayments.com`. It uses only the provider's public licence endpoints, to activate, validate and deactivate a key.

Each request contains:

* the **licence key**, and
* for activation, the text **`VS Code on <platform>`**, for example `VS Code on Windows`, `VS Code on macOS` or `VS Code on Linux`. This label lets you tell your activations apart. It never contains your computer's name, your user name, your files or anything else about you or your machine.
* for validation and deactivation, the activation id that the service returned when you activated the key.

As with any internet request, the service sees your IP address.

Who receives it, where it goes and how long it is kept:

* The recipient is Dodo Payments, the payment provider and merchant of record that sells the licence key. The data is sent to its servers at `live.dodopayments.com` and to nobody else. The author of the extension does not run a server and receives none of it.
* The provider may process data in several countries. How long it keeps data, and under which legal basis, is set out in its own privacy policy: <https://dodopayments.com/legal/privacy-policy>. The extension itself keeps nothing but the items listed under "What is stored locally" below.
* The data is **not anonymous**. A licence key belongs to a purchase and therefore to the buyer's record at the payment provider. The platform label contains no personal data.
* No data from this request is used for advertising, analytics or profiling by the extension.

When it happens:

* **Never without a key.** If you have not entered a licence key, the extension makes no network request. The free features and the trial work entirely offline.
* On activation (when you enter the key).
* On validation: a successful validation is remembered for 24 hours; the extension asks again at the next Pro feature use after that. Showing names from a loaded dictionary is such a use, so the check can also run when the editor starts in a workspace for which a dictionary is remembered. Entering a key that is already active on this computer validates it; it is not activated a second time. If the service cannot be reached, the last successful validation keeps Pro working for 14 days.
* On deactivation (**EDI Lens: Remove Licence From This Machine**).
* **Show Licence Status** asks the service right away when a key is stored.
* When a key replaces another key, the activation of the old key is released with one more request.
* **Report A Problem** makes no request: it reads the licence state from what is stored.
* The address of the licence service is fixed. No setting can change it.

## What is stored locally

* The licence key, in VS Code's secret storage (your operating system's credential store where available).
* The activation id, the id of the product the key belongs to (which tells a Personal from a Business licence), the time of the last check and the time of the last successful validation, in VS Code's extension storage.
* **Not stored:** the answer of the licence service to an activation also contains the buyer's name, e-mail address and customer record. The extension reads the activation id and the product id from that answer and keeps nothing else of it.
* The trial record (start, last use, last reminder), in VS Code's extension storage.
* The location of a loaded dictionary file and the queries you saved, for the workspace they belong to.

**Remove Licence From This Machine** deletes the key and the activation data and frees the activation. The trial record is kept. It lives in the editor's storage of the profile you use; a different profile or editor has its own.

## Report A Problem

**EDI Lens: Report A Problem** copies a short diagnostics block to your clipboard and opens the public issues page in your browser. The block contains the extension and editor versions, the operating system, the format, size and problem counts of the active file, your EDI Lens settings and the licence state (Free, Trial or Pro). Settings that could hold a folder or file name (the two file patterns of the workspace features and the ignored paths of Compare) are given only as "default", "customised" or a count. It never contains file contents, file names, paths, the licence key, user or computer names. Nothing is sent until you paste it into an issue yourself.

## Buying

The **Buy Pro** command asks which licence you want (and, for Business, for how many users) and opens the payment provider's checkout page in your browser; the number of users is part of the link. Payment details are entered on that page and handled by the payment provider; the extension never sees them. Their privacy policy applies to the purchase.

## Questions

Open an issue at <https://github.com/small-steps-studio/edi-lens/issues>. Please do not include real business or patient data in a report.
