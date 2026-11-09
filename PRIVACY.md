# Privacy

Last updated: 2026-11-09

EDI Lens works on your computer. This page states exactly what the extension sends over the network, which is very little.

## What stays on your computer

* The contents and names of your files. Parsing, validation, formatting, comparison, export and workspace scans are performed locally and nothing about them is sent anywhere.
* Your dictionary files and settings.
* There is **no telemetry**, no usage statistics, no crash reporting and no advertising.

## The one network request: the licence check (Pro only)

The optional Pro tier is unlocked with a licence key. After you enter a key (**EDI Lens: Enter Licence Key**), the extension talks to the licence service of the payment provider, Dodo Payments, at `live.dodopayments.com` (`test.dodopayments.com` while the product is in test mode). It uses only the provider's public licence endpoints, to activate, validate and deactivate a key.

Each request contains:

* the **licence key**, and
* for activation, the text **`VS Code on <platform>`**, for example `VS Code on Windows`, `VS Code on macOS` or `VS Code on Linux`. This label lets you tell your activations apart. It never contains your computer's name, your user name, your files or anything else about you or your machine.
* for validation and deactivation, the activation id that the service returned when you activated the key.

As with any internet request, the service sees your IP address.

When it happens:

* **Never without a key.** If you have not entered a licence key, the extension makes no network request.
* On activation (when you enter the key).
* On validation: a successful validation is remembered for 24 hours; the extension asks again at the next Pro feature use after that. If the service cannot be reached, the last successful validation keeps Pro working for 14 days.
* On deactivation (**EDI Lens: Remove Licence From This Machine**).
* **Show Licence Status** asks the service right away.

## What is stored locally

* The licence key, in VS Code's secret storage (your operating system's credential store where available).
* The activation id and the time of the last successful validation, in VS Code's extension storage.
* The location of a loaded dictionary file, for the workspace it was loaded in.

**Remove Licence From This Machine** deletes the key and this information and frees the activation.

## Buying

The **Buy Pro** command opens the payment provider's checkout page in your browser. Payment details are entered on that page and handled by the payment provider; the extension never sees them. Their privacy policy applies to the purchase.

## Questions

Open an issue at <https://github.com/ImadMuratspahic/edi-lens/issues>. Please do not include real business or patient data in a report.
