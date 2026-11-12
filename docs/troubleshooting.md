# Troubleshooting

Before anything else: **EDI Lens: Report A Problem** copies a diagnostics block (versions, platform, settings, licence state; no file contents, no names, no key) that you can paste into an issue.

## The file is not recognised

* **Status bar shows nothing, no colouring.** The file extension is not one of `.edi`, `.edifact`, `.edf`, `.x12`, `.x12edi`, `.hl7`. Run **EDI Lens: Detect Format**, or add the extension to your `files.associations` setting (`"*.dat": "edifact"`).
* **"No UN/EDIFACT, ANSI X12 or HL7 v2 content was recognised".** The first non-blank characters must be `UNA`, `UNB`, `UNH`, a 106-character `ISA`, `MSH`, `FHS` or `BHS`. Files wrapped in an envelope (XML, JSON, MLLP framing bytes, mail headers) must be unwrapped first.
* **An X12 file opened as EDIFACT (or the other way round).** With `ediLens.autoDetectLanguage` on, the language is corrected automatically on open. Otherwise run **Detect Format**.

## Problems that look wrong

* **`X12-ISA-LENGTH`.** The `ISA` must be exactly 105 characters plus its terminator. Padding of ISA02, ISA04, ISA06 and ISA08 is often lost by editors or e-mail; restore the spaces.
* **A whole file is one segment, or the outline is empty.** The delimiters declared in `UNA`, `ISA` or `MSH` do not match the data (for example a `UNA` copied from another file). Fix the header; EDI Lens follows what the file declares.
* **`EDIFACT-UNT-COUNT` after editing.** The count in `UNT` (and `SE`, `GE`, `IEA`, `UNE`, `UNZ`) must be updated by hand after segments are added or removed; EDI Lens reports it but does not change data.
* **`HL7-BLANK-LINE` notes.** HL7 segments are separated by a single line break; blank lines are reported as notes and do not stop anything.
* **Too few problems.** At most `ediLens.maxIssues` (500) are listed per file.
* **A problem is not a problem for your partner.** EDI Lens checks envelopes, counts, control numbers and delimiters only. It does not know message-type specifications or code lists; see [formats.md](formats.md) for the exact list.

## Large files

* **"file over limit" in the status bar.** The file is larger than `ediLens.maxFileSizeMB` (10 MB). Run **Validate Current File** to check it on demand, or raise the setting (up to 500 MB) if the computer has enough memory. Compare and the exports keep to the limit.
* **Slow while typing.** Files above 2 MB are only re-checked on save.

## Formatting

* **Pretty Print changes nothing.** The file is already one segment per line, or the segment terminator is itself a line break (X12 files with a newline terminator).
* **"The file could not be changed".** The editor is read-only or the file has no write permission.
* **Minify on an HL7 message shows no change.** VS Code shows every carriage return as a line break, and the carriage return is the HL7 segment terminator; the file is minified all the same.
* **Batch Pretty Print skipped files.** Files that are not valid UTF-8, contain no segments, are empty or larger than 5 MB are skipped and counted in the final message.

## Pro tools

* **A rule or a query matches nothing.** In rules and queries the brackets hold a qualifier, not a count: `NAD[2]` is the `NAD` whose first element is `2`. Write `NAD#2` for the second `NAD`, or `NAD[BY]` for the buyer. Segment ids are upper case. See [query.md](query.md#selectors).
* **"No partner rule file was found".** The file is looked for at `ediLens.rules.file` (default `.edilens/rules.json`) inside the workspace folder of the open file, or inside the folder a folder run was started on. Without an open folder, set an absolute path.
* **A pattern "was not accepted".** Backreferences, lookarounds and a repeated group that contains a repetition, an optional part or an alternative are refused, because they can take very long. Rewrite the pattern without them; see [partner-rules.md](partner-rules.md#rule-types).
* **The anonymised copy still shows a name.** Only the values named by rules are replaced; free text is not searched. Add a rule for that path, see [anonymise.md](anonymise.md).
* **Split or Merge says the envelope is damaged.** Run **Validate Current File**, repair the envelope problems it lists, then run the command again.
* **The rule file shows no squiggles while editing.** The JSON schema applies to files named `.edilens/rules.json`, `.edilens/anonymise.json`, `*.edilens-rules.json` and `*.edilens-anonymise.json`.

## Licence and trial

* **"is an EDI Lens Pro feature" although you bought a key.** Run **EDI Lens: Show Licence Status**. It says whether a key is stored and what the server answered; the buttons lead to **Enter Licence Key** and **Lost your key?**.
* **The trial did not start.** The editor's storage was not writable (read-only profile, some portable set-ups). The message says so; a licence key still works.
* **Activation problems.** The meaning of every licence message is in [licence.md](licence.md#messages-you-may-see).
* **"This key belongs to another product".** The key is valid but was sold for another product. Enter the key from your EDI Lens Pro purchase e-mail; nothing was stored and the activation made for the check was released.
* **Behind a corporate proxy.** The licence check uses the editor's `http.proxy` settings on recent VS Code versions. If the activation reports "could not be reached", check those settings; the free features and a running trial are not affected.
* **Remote development (SSH, WSL, containers).** EDI Lens runs on the remote side, so the licence check leaves from the remote machine's network (proxy and firewall rules of that machine apply). The licence key and the trial record are kept in the editor's own storage, which VS Code holds on your local computer.

## Other editors built on VS Code

EDI Lens uses only the standard extension interface. In some editors the **Buy Pro** and **Show Documentation** links ask for confirmation before the browser opens; in editors without a credential store the key cannot be saved and the activation is released again (see above).

## Still stuck

Open an issue at <https://github.com/ImadMuratspahic/edi-lens/issues> with the diagnostics block from **Report A Problem**, what you did, what you expected and, if possible, a small example file with invented data. Never post real business or patient data or a licence key.
