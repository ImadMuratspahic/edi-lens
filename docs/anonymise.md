# Anonymise (Pro)

**EDI Lens: Anonymise Message** and **EDI Lens: Anonymise Folder** make copies of messages in which the identifying values are replaced, so that a message can go into a ticket, a chat or a test system. Both are Pro features and run inside the free 14-day trial. Everything happens on your computer.

## What you get

* **Anonymise Message** works on the file in the active editor and opens the copy in a new, unsaved editor next to it. The original file and its editor are not changed.
* **Anonymise Folder** (command palette, or right-click a folder in the Explorer) asks for confirmation, then writes a copy of every message file of the folder into a new folder next to it, named `<folder>-anonymised`, with the same sub-folders and file names. Files that are already there are replaced; the source files are never changed. A progress notification shows the file being worked on and has a cancel button. Files are found with the setting `ediLens.workspace.include`; at most 2,000 files are read, each up to `ediLens.maxFileSizeMB`.
* Both end with a **report** in Markdown: files anonymised and left out, values replaced per rule, protected values left alone. The report contains counts only, never a value from a file.

## What is guaranteed

1. **Only values named by a rule are touched.** Every delimiter, release character, escape sequence, segment and element stays where it was.
2. **Same length.** Every action except `blank` writes a value of exactly the same length. A letter is replaced by a letter, a digit by a digit; punctuation and spaces stay. Letters of other alphabets are replaced by basic letters. The fixed-width X12 `ISA` therefore stays 106 characters long.
3. **Same validity.** Because nothing structural changes, the copy has exactly the problems the original has, at the same places, or none, for every action except `blank` (emptying a value that ends in an unfinished escape can remove that one problem). This is tested on 126 sample files and on several hundred damaged variants of them.
4. **Protected envelope values.** A rule that points at one of these is skipped and counted in the report:

   | Format | Never replaced |
   | --- | --- |
   | UN/EDIFACT | all of `UNA`, `UNH`, `UNT`, `UNE`, `UNZ`; `UNB-1` and `UNB-5`; `UNG-1` and `UNG-5` |
   | ANSI X12 | all of `ST`, `SE`, `GE`, `IEA`; every `ISA` element except 2, 4, 6 and 8; `GS-1`, `GS-6`, `GS-7`, `GS-8` |
   | HL7 v2 | `MSH-1`, `MSH-2`, `MSH-9` to `MSH-12`; the delimiter fields of `BHS` and `FHS`; all of `BTS` and `FTS` |

5. **Consistent replacements.** The same original value always becomes the same replacement inside one run (also across the files of a folder run), so references between segments and files still match. Spaces around a value are padding and do not count: `NORTHBAY       ` in an `ISA` and `NORTHBAY` in a `GS` get the same replacement.
6. **Nothing is passed off as anonymised.** When no rule matched a value in the body of a file, Anonymise Message makes no copy and says so, and Anonymise Folder does not write the file: the report lists it under "Unchanged: no rule matched" and a warning gives the count. With the setting `ediLens.anonymise.copyUnchanged` such files are copied unchanged into the target folder and are still listed as unchanged.

## Actions

| Action | Result | Example |
| --- | --- | --- |
| `mask` | letters become `X`, digits become `9` | `RS-4471902` becomes `XX-9999999` |
| `pseudonym` | other letters and digits, the same for the same original within a run | `RS-4471902` becomes `EC-9263416` |
| `fake-name` | like `pseudonym`, but consonants and vowels alternate so the result reads like a name | `Hartwell` becomes `Zonefiku` |
| `fake-date` | the date moves back by a number of days (1 to 365) that is the same for the whole run | `19840712` becomes `19831109` |
| `keep` | the value stays; use it to switch a profile rule off for one path | |
| `blank` | the value is emptied; in the fixed-width `ISA` it is filled with spaces | |

`fake-date` reads `CCYYMMDD` at the start of a value (a time or zone after it is kept), a range of two such dates or date-times (`20240101-20240131` or `202401011030-202401311200`: both dates move and the times stay), and a value of exactly six digits as `YYMMDD`. Because every date of a run moves by the same number of days, the order of dates and the days between them stay as they were, and two different dates never meet in one replacement. A value that is not a real date, or a range whose second part is not a real date, is replaced like a `pseudonym` and counted in the report as "not recognised".

## The seed

Each run asks for a **seed**, typed like a password.

* **With a seed**, a later run with the same seed over the same files gives the same replacements (with the same rules and the same version of the extension). With other files, such as a second batch, a value whose replacement had to move to stay distinct can get another one (see below), so files that must match are best anonymised together in one run. Anybody who holds the seed can reproduce the whole mapping and check a guessed original value against it, so a seed is a secret: choose a long one and keep it as safe as the original messages.
* **Without a seed**, the key is 32 random bytes from the operating system's secure random source (`crypto.randomBytes`), drawn for that run and forgotten afterwards; the replacements cannot be reproduced.

Every replacement is derived with HMAC-SHA256 keyed with the seed (or with the random key). The seed is used as it is; it is not stretched, so a short or common seed can be guessed. It is never stored and never written to the report.

Within one run, two different original values never get the same replacement: when the first replacement of a value is already taken by another value, the next one is used. The report says so, and warns when this could not be kept (more than 500,000 distinct values, or a kind of value with fewer possible replacements than values). Because of this, a later run with the same seed that contains other values, or the same values in another order, can give a value that had to move a different replacement than before; a value whose first replacement is free in both runs gets the same one.

## Built-in profiles

The setting `ediLens.anonymise.profiles` lists the profiles in use (all four by default). Each one applies to its own format only, and replaces exactly the paths below: the main identifying fields, not every field that could identify somebody.

| Profile | Paths |
| --- | --- |
| `hl7-patient` | `PID`: 2.1, 3.1, 3.4, 3.6, 4.1 (identifiers with assigning authority and facility), 5, 6, 9 (names), 7, 29 (dates), 11 (street, other designation, city, postal code), 13, 14 (number and e-mail parts), 18.1, 19, 20.1, 21.1, 23. `NK1`: 2, 4, 5, 6, 16, 30, 31, 32. `IN1`: 16, 18, 19, 36, 49.1. `GT1`: 3, 4, 5, 6, 7, 8, 12, 19.1. State, country and the use and type codes of addresses and telephone numbers stay. |
| `x12-healthcare` | `NM1` with entity code `IL`, `QC`, `03` or `74`: elements 3, 4, 5 (names) and 9 (identifier). `N3-1`, `N3-2`, `N4-1`, `N4-3` (every address in the file, also of providers). `DMG-2`. `REF-2` with qualifier `SY`, `1W`, `EJ`, `0F`, `1L`, `IG` or `EA`. `CLM-1`, `CLP-1`. `PER-2`, `PER-4`, `PER-6`, `PER-8`. |
| `x12-party` | `N1-2` (name), `N1-4` (identifier), `N2-1`, `N2-2`, `N3-1`, `N3-2`, `N4-1`, `N4-3`, `PER-2`, `PER-4`, `PER-6`, `PER-8`, in any transaction. The entity code in `N1-1`, the state in `N4-2` and the country in `N4-4` stay. |
| `edifact-party` | `NAD`: 2.1, 3, 4, 5, 6, 8 (the qualifier in 1, the code list parts of 2, the region in 7 and the country in 9 stay). `CTA-2.1`, `CTA-2.2`. `COM-1.1`. `FII-2.1`, `FII-2.2`, `FII-2.3`, `FII-3.1`. |

### What the profiles do not cover

Read this list before you rely on a profile; add rules for what matters in your messages.

* **HL7:** `PV1` (doctors, visit number, times), `PD1`, `MRG`, `IN2`, `DG1`, `OBX` and `NTE` (results and free text, where a name can be repeated), `EVN`, Z segments; inside the covered segments the less common fields (for example `PID-12`, `NK1-13`, `GT1-16`, `IN1-2` to `IN1-11`).
* **X12:** `NM1` of other entities than subscriber, patient and dependent (`IL`, `QC`, `03`, `74`), which includes providers and other persons; `REF` with other qualifiers than the seven listed; `SBR`, `PAT`, `DTP` and `DTM` (dates of service), `BPR` (bank accounts), `TRN`, `BHT`, `NTE`, `MSG`.
* **EDIFACT:** `RFF` (which can hold tax and registration numbers), `BGM-2`, `LOC`, `TDT`, `DOC`, `PNA`, `ADR`, `GIN`, `FTX`, the bank name in `FII-3`.
* **All formats:** file names. Anonymise Folder keeps them, and the report lists them.

## Sender and receiver ids of the envelope

The first segment of a message names the parties: `UNB-2` and `UNB-3` (and `UNG-2`, `UNG-3`), `ISA06` and `ISA08` (and `GS02`, `GS03`), `MSH-3` to `MSH-6` (and the same fields of `BHS` and `FHS`). With the setting `ediLens.anonymise.envelopeIds` at its default `pseudonymise` these ids are replaced as pseudonyms whenever a file is anonymised, whatever profiles are active. Within a run a value always gets the same pseudonym, so where a rule also replaces the same id in the body as a pseudonym (a `NAD` or `NM1` identifier, the assigning authority in `PID-3`), both get the same replacement, and the copy still fits together. An id in a field that no rule names stays as it is in the body.

Set it to `keep` when the copy must still be routed by a test system that looks at these ids. The copy then names the real sender and receiver in its first segment; the completion message says so. A rule with the action `keep` in your rule file switches a single id off, for example `{ "format": "x12", "path": "ISA-8", "action": "keep" }`.

Control numbers, counts, delimiters, message types and versions are never replaced (see the table above), so the envelope stays valid in both cases.

## Your own rules

Put a rule file at `.edilens/anonymise.json` in the workspace folder (or point the setting `ediLens.anonymise.rulesFile` at another file; an absolute path works without a folder). The file is optional. While you edit it, the editor checks it against a JSON schema and offers completions.

```json
{
  "profiles": ["hl7-patient"],
  "rules": [
    { "format": "hl7", "path": "PV1-7", "action": "fake-name" },
    { "format": "x12", "path": "NM1[IL]-9", "action": "mask" },
    { "format": "edifact", "path": "NAD[BY]-2.1", "action": "keep" }
  ]
}
```

* `rules`: each rule names a `format` (`edifact`, `x12`, `hl7`), a `path` and an `action`. The path is a [selector](query.md#selectors) with an element: `PID-5` covers the whole element (every component and repetition is replaced on its own), `PID-3.1` one component, `NM1[IL]-3` only segments with that qualifier.
* **Order matters:** your rules come first, then the profiles; the first rule that covers a value decides. `keep` in your file therefore switches a profile rule off.
* `profiles`: when the file has this list it replaces the setting; `[]` uses your rules only.

A complete example is in [examples/anonymise.json](examples/anonymise.json), with sample messages in [examples/messages](examples/messages).

## The replacement table

While a run works, EDI Lens keeps a table of originals and replacements in memory (up to 100,000 values; beyond that values are still replaced the same way but no longer listed). It is never written anywhere by itself and is gone when the window is closed.

**EDI Lens: Export Pseudonym Map** writes the table of the last run as CSV (`action,original,replacement`) to a file you choose, after a warning. That file contains the original values: keep it as safe as the original messages.

## Limits you should know

* **Rules, not recognition.** Only the values named by rules are replaced. Free text (`FTX`, `NTE`, `OBX` with text, `MSG`) is not searched for names, and identifying values in fields that no rule names stay. Read a copy before you share it.
* **Not encryption.** A pseudonym hides a value from a reader; it does not protect it against somebody who has the seed. A kind of value has only so many possible replacements (there are ten one-digit numbers): when all are taken, the run keeps the last value as it is, and if that is not possible either the report warns that two values share a replacement.
* **Content checks may differ.** The structure stays valid, but a check digit, a code from a code list or a postal code that a partner system verifies will usually no longer be right after `pseudonym`. Use `keep` for values that must stay.
* **Whether a copy is anonymous in the legal sense depends on what else it contains and on who receives it.** EDI Lens replaces values; the decision to share remains yours. EDI Lens makes no statement about any privacy law.

## Problem codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `ANON-RULES-INVALID` | The rule file is not valid JSON or a rule in it is not understood; the message quotes the rule. Nothing was anonymised. | Correct the file; the editor marks the place. |
| `ANON-NO-RULES` | No rule applies to the format of the file: no profile is selected for it and the rule file has no rule for it. The envelope ids alone do not count. | Select a profile in `ediLens.anonymise.profiles` or add rules. |
| `ANON-NOT-EDI` | The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message. | Open a message file, or run **EDI Lens: Detect Format**. |
