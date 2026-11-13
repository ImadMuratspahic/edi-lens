# Getting started

## Install

1. Open the Extensions view in VS Code (`Ctrl+Shift+X`, `Cmd+Shift+X` on macOS).
2. Search for **EDI Lens** (publisher Small Steps Studio) and select **Install**.
3. Open **Help > Welcome**, choose the **Get started with EDI Lens** walkthrough, or run **EDI Lens: Open Getting Started Guide** from the Command Palette (`F1`).

Requires VS Code 1.82 or newer. Nothing else is installed and no account is needed.

## Open a file

Files with the extensions `.edi`, `.edifact`, `.edf` (UN/EDIFACT), `.x12`, `.x12edi` (ANSI X12) and `.hl7` (HL7 v2) open in the right language automatically. For any other file (`.txt`, `.dat`, an untitled editor with pasted text), run **EDI Lens: Detect Format**.

No file at hand? **EDI Lens: Open Sample EDIFACT**, **Open Sample X12** and **Open Sample HL7** open short messages with invented data in a new editor.

## Read

* **Status bar** (bottom right): format, number of segments, number of problems. Click it to open the Problems view.
* **Outline**: the EDI Lens icon in the activity bar. Segments, elements, components and subcomponents with value previews; select a row to jump to it, right-click for **Copy Path**.
* **Hover**: point at any value for its path (for example `NAD[2]-3.1`), the raw value, its position and length.
* **Go to Segment** (`F1`, then the command): type `NAD` or `NAD[2]` to filter, move through the list to preview.
* **Jump To Matching Trailer** moves between `UNH`/`UNT`, `ST`/`SE`, `BHS`/`BTS` and the other envelope pairs.

## Reformat

A file that arrives as one long line: **EDI Lens: Pretty Print** (or **Format Document**, `Shift+Alt+F`) puts one segment per line. **Minify** does the reverse. Only the white space between segments changes; the data is never touched.

## Check

Problems are reported when the file opens, when it is saved and a moment after you stop typing. They show in the editor as squiggles and in the Problems view with a stable code such as `X12-SE-COUNT`. The complete list of checks is in [formats.md](formats.md). **Validate Current File** checks on demand, also for files above the automatic size limit.

## Try the Pro features

Compare, Export, Validate Workspace, Load Dictionary and Batch Pretty Print Folder are Pro features, and so are the four tools for files from partners:

* [Anonymise](anonymise.md): a copy of a message or a folder with the identifying values replaced and the structure unchanged.
* [Partner rules](partner-rules.md): check messages against your own implementation guide, written as a rule file.
* [Query](query.md): find messages by their content in a file or a folder.
* [Envelope tools](envelope-tools.md): split, merge, renumber control numbers and write a test acknowledgement.

The first Pro command you run starts a free 14-day trial on this computer (no key, account or network). After the trial, or right away, a licence key (Personal or Business) unlocks them for good; see [licence.md](licence.md). Sample messages and rule files to try the tools with are in [examples](examples).

## Settings

Open the Settings editor and search for "EDI Lens". The most useful ones:

| Setting | What it does |
| --- | --- |
| `ediLens.validateOnType` | Check while typing (on by default). |
| `ediLens.maxFileSizeMB` | Largest file parsed automatically (10 MB). |
| `ediLens.hover.enabled` | Switch the hover off. |
| `ediLens.compare.ignoreSegments`, `ediLens.compare.ignorePaths` | Leave control numbers and dates out of a comparison. |
| `ediLens.export.neutraliseFormulas` | Protect CSV exports from spreadsheet formula cells (on by default). |
| `ediLens.anonymise.profiles`, `ediLens.anonymise.rulesFile` | What Anonymise replaces. |
| `ediLens.rules.file` | Where the partner rule file is. |
| `ediLens.query.maxResults` | How many matching messages Query lists. |
| `ediLens.envelope.startNumber` | First control number for the envelope tools. |

All settings are listed in the README.

## Keyboard shortcuts

None are assigned by default, so nothing collides with your other extensions. Open **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`), search for "EDI Lens" and assign your own.
