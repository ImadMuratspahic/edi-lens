# Changelog

## 0.2.1

Changed:

* Publisher: **Small Steps Studio**, extension id `SmallStepsStudio.edi-lens-viewer`; source code and issues at <https://github.com/small-steps-studio/edi-lens>. Features, commands, settings, prices and licence terms are those of 0.2.0.

Fixed:

* Entering a key that cannot be saved (for example when the editor has no credential store) no longer discards a licence that was already stored on the computer; the message says whether the previous licence was kept.
* When the editor has lost the stored key and another key is entered, the message no longer says that the old activation was released; no release is sent for a key that is not known.
* **Remove Licence From This Machine** no longer asks the licence server anything before you have confirmed; after you confirm it only frees the activation.
* A trial record whose start and last use both lie more than a day in the future now counts as a trial that has ended instead of holding the trial clock still.
* The payment provider's test environment (host and test product ids) is no longer part of the installed extension.
* Anonymise: two different values never receive the same replacement within a run, and the report says so. With a seed, the same files and rules give the same replacements again; with other files, a value whose replacement had to move to stay distinct can get another one. `fake-date` moves both dates of a date-time range (`CCYYMMDDHHMM-CCYYMMDDHHMM`).
* Generate Acknowledgement: no HL7 acknowledgement is written when MSH-12 of the source does not hold a version number, and an acknowledgement with any warning is no longer handed out.
* The documentation says that editors other than VS Code were not tested, and describes what happens on Linux without a credential store.

## 0.2.0

New:

* **Anonymise Message and Anonymise Folder (Pro).** Copies of messages with the identifying values replaced: same length, same delimiters, same counts, so the copy validates exactly like the original. Actions `mask`, `pseudonym`, `fake-name`, `fake-date`, `keep` and `blank`; built-in profiles for the main identifying fields of HL7 patient data and of X12 healthcare transactions, for X12 party segments and for EDIFACT party data; the sender and receiver ids of the envelope are replaced too (setting `ediLens.anonymise.envelopeIds`); a file in which no rule matched is reported as unchanged and is not written; your own rules in `.edilens/anonymise.json`; the same value always gets the same replacement, and a seed makes a run repeatable. The report lists counts only. **Export Pseudonym Map (Pro)** writes the table of originals and replacements only when you ask for it.
* **Partner rules (Pro).** **Validate With Partner Rules** checks a message against your own implementation guide in `.edilens/rules.json`: required and forbidden segments, occurrences, required elements, code lists, patterns, ranges, date formats, lengths, conditions and equal values (totals), per message or per group. Violations are problems with the rule id and your message. **Create Rules From This Message** writes a starting rule file; **Validate Folder With Partner Rules** checks a folder with progress and cancel and gives an HTML and a CSV report; **Clear Partner Rules Results** removes the problems.
* **Query (Pro).** Numbers are compared exactly, digit by digit, also 18-digit identifiers; a text in quotes is compared as text. A small query language over messages (`NAD[BY]-2.1 == "5412*" AND count(LIN) > 2`) for the open file or a folder, with a **Query Results** view, saved queries per workspace, **Export Query Results As CSV**, **Clear Query Results** and **Delete Saved Query**.
* **Envelope tools (Pro).** **Split Interchange Into Messages**, **Merge Messages Into One Interchange**, **Renumber Control Numbers** (with the choice to keep or update references) and **Generate Acknowledgement** (a basic X12 997 or 999, EDIFACT CONTRL or HL7 ACK, marked as a test).
* **JSON schemas** for the two rule files: the editor checks `.edilens/rules.json` and `.edilens/anonymise.json` while you type.
* **Pro Business licence.** Next to Pro Personal (USD 29, for a person who pays for it themselves) there is Pro Business (USD 59 per user, for organisations). One key per user: set the number of users with the Buy command, or add ?quantity=N to the checkout link. **Buy Pro** asks which one and, for Business, for the number of users. Both unlock the same features on up to three computers per key. **Show Licence Status** names the licence type.
* New settings: `ediLens.anonymise.profiles`, `ediLens.anonymise.envelopeIds`, `ediLens.anonymise.copyUnchanged`, `ediLens.anonymise.rulesFile`, `ediLens.rules.file`, `ediLens.query.ignoreCase`, `ediLens.query.maxResults`, `ediLens.envelope.startNumber`, `ediLens.envelope.x12Acknowledgement`.
* **14-day Pro trial.** The first Pro command you run starts a free trial of every Pro feature on that computer. No key, account or network is needed; the trial is recorded only in the editor's storage of that computer. **Show Licence Status** and the trial notice show the days left; a reminder appears at most once a day. A licence key always takes precedence over the trial.
* **Getting started walkthrough** (Help > Welcome > Walkthroughs, or **EDI Lens: Open Getting Started Guide**): open a sample, read the outline, hover a value, run validation, try Pro, and the Pro tools for partner files.
* **EDI Lens: Open Sample EDIFACT / X12 / HL7** open short sample messages with invented data in a new editor.
* **EDI Lens: Report A Problem** copies a diagnostics block (versions, platform, settings, licence state; never file contents, names or the key) and opens the issues page. **EDI Lens: Show Documentation** opens the manual.
* A **Lost your key?** button in the licence messages explains where the key was sent and what to do.
* `docs/` folder with getting started, the complete list of checks and problem codes per format, pages for Anonymise, partner rules, Query and the envelope tools with sample messages and rule files, licence and troubleshooting pages.

Changed:

* **CSV export neutralises spreadsheet formulas by default** (`ediLens.export.neutraliseFormulas` is now `true`): values that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading apostrophe. Turn the setting off to export the exact values.
* **A licence key is only accepted when it belongs to EDI Lens Pro.** When a key is entered, the licence server names the product it was sold for; a key of another product is refused with "This key belongs to another product", and the activation that was made for the check is released again. Keys entered in 0.1.x are not affected.
* **Entering a key again no longer uses another activation.** A key that is already active on the computer is validated instead of activated a second time; a key that replaces another one releases the activation of the old key; the messages say whether an activation was released or could not be.
* **The setting `ediLens.licenceMode` is removed.** The extension always uses the live licence service; nothing in the settings or the commands can change that.
* The extension keeps the id of the product next to the activation id. It does not keep the buyer's name or e-mail address that the licence server returns.
* Every error and licence message now says what happened and what to do next. Activation of a key the server reports as not active (expired, disabled, refunded) is told apart from an unknown key.
* The licence status message shows the trial state; the Pro message shows **Buy Pro** and **Enter Licence Key** and says when the trial ended.
* The Marketplace pricing label is **Trial** (free features plus a trial of Pro; Pro is sold outside the Marketplace, as before).
* `LICENSE.txt` rewritten as a clear end-user licence (single-user key, up to three computers, Personal and Business licences, a Business key may be moved to a colleague, no resale, free features without a key, warranty disclaimer, liability limited to the price paid); new `TERMS.md`.
* The redundant `onCommand` and `onView` activation events were removed (the editor derives them from the contributions).

Upgrading from 0.1.x:

* Nothing has to be done. Command ids, setting names, file associations and the minimum VS Code version (1.82) are unchanged. A licence key entered in 0.1.x keeps working without entering it again and without using another activation; the 24-hour check and the 14-day offline grace period work as before.
* The setting `ediLens.licenceMode` was removed; a value left in a settings file is ignored (the editor shows it as an unknown setting and it can be deleted).
* A key you bought before 0.2.0 is a Pro Personal key and unlocks the new Pro tools as well; nothing is charged again.
* The activity bar container of EDI Lens has a second view, **Query Results**, collapsed below the outline. The outline itself is unchanged. Hide the new view from its context menu if you do not use it.
* **Buy Pro** now asks which licence you want before it opens the checkout page.
* If you have a licence, the trial never starts and you see no trial message. If you use the free features only, nothing is recorded and nothing is sent until you run a Pro command yourself; that first Pro command starts the 14-day trial.
* One default changed: `ediLens.export.neutraliseFormulas` is now `true`. CSV exports made with the default now put an apostrophe in front of values that start with `=`, `+`, `-`, `@`, a tab or a carriage return (this includes negative numbers such as `-12.50`). If you process the CSV with a program and need the exact values, set the setting to `false`; a value you set yourself is kept.
* Hover and **Copy Path At Cursor** on the separator between two HL7 subcomponents now give the component path (for example `OBX[1]-5.1`) instead of the first subcomponent. All other free features behave as in 0.1.1; several messages are worded more precisely.

Fixed:

* Hovering the separator between two HL7 subcomponents reported the first subcomponent instead of the enclosing component.

Reliability:

* A corpus of 126 sample files (42 per format, invented data, varied delimiters, line endings, batches and escapes) is tested in every build: outline, hover, validation, formatting round trips, exports and comparison; mutated copies (deleted, duplicated and truncated text, swapped delimiters, injected control characters) must never crash. Zero false positives on the valid files. The new Pro tools run over the same corpus: every file is anonymised and validated again, rules created from a file must pass on it, query results are compared with expectations worked out by hand, split followed by merge must give back every message, and every acknowledgement must validate and quote the right control numbers.
* Anonymise, partner rules, Query, Renumber, Split and Generate Acknowledgement read a file segment by segment; a 50 MB file per format is worked through inside a 1 GB heap in the test suite.
* The test suite was run on Windows with Node 24, in three time zones and from a project path containing spaces and non-ASCII characters. A workflow that runs it on Windows, macOS and Linux with Node 20 and 22 is included in the repository; it has not run yet, so those platforms are untested for this version.

## 0.1.1

Fixes:

* Very large files: the parser now builds the elements of a segment only when they are read. A 50 MB file can be checked with **Validate Current File** without exhausting the memory of the editor (before, files of that size could stop the extension host).
* **Compare With Another File** and the exports keep to the `ediLens.maxFileSizeMB` limit and say so, instead of attempting a file far above it.
* **Enter Licence Key**: when the editor cannot keep the key in its secret storage (no credential store available), the activation is released again and a clear message is shown. Before, the activation stayed used up on the licence server although nothing was stored.
* Outline previews and hovers on a value of several megabytes are no longer slow.

## 0.1.0

First release. EDI Lens is free to use; Pro features are unlocked with a one-time licence key sold outside the Marketplace.

Free:

* Syntax colouring and language support for UN/EDIFACT, ANSI X12 and HL7 v2.
* Detect Format, with automatic language switch when a file's content clearly belongs to another of the three formats.
* Outline view in the activity bar: segment, element, component tree with value previews, click to reveal, Copy Path.
* Hover with path, raw value, position and length.
* Pretty Print, Minify and Format Document.
* Go to Segment, Copy Path At Cursor, Jump To Matching Trailer.
* Structural validation as problems, on open, on save and while typing, with stable problem codes.
* Status bar with format, segment count and issue count.

Pro (licence key):

* Compare With Another File with element-level differences and ignore rules.
* Export As JSON, CSV and XML.
* Validate Workspace with a Markdown report.
* Load Dictionary: segment, element, component and code value names in hovers and the outline, from your own JSON file.
* Batch Pretty Print Folder, with confirmation before anything is written.
