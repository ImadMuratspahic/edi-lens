# Formats and checks

This page lists exactly what EDI Lens reads and which checks it performs, with the problem codes shown in the Problems view. Validation is **structural**: envelopes, counts, control numbers, required header fields and delimiters. It does not check a message against a message-type specification, an implementation guide or a code list.

## How a file is recognised

| Format | File extensions | First segment | Delimiters |
| --- | --- | --- | --- |
| UN/EDIFACT | `.edi`, `.edifact`, `.edf` | `UNA`, `UNB` or `UNH` | From the `UNA` service string advice when present (component, element, decimal mark, release, repetition, segment terminator); otherwise `: + . ? '`. The release character is honoured: an escaped delimiter is data. A later `UNA` in the same file switches the delimiters for the segments after it. |
| ANSI X12 | `.x12`, `.x12edi` | `ISA` of 106 characters | From the fixed-width `ISA`: element separator (character 4), component separator (ISA16), segment terminator (character 106), repetition separator (ISA11 when it is not `U`). The terminator may be a line break. |
| HL7 v2 | `.hl7` | `MSH`, `FHS` or `BHS` | From `MSH-1` (field separator) and `MSH-2` (component, repetition, escape, subcomponent; a fifth truncation character is accepted). Segments end with CR, LF or CRLF. |

A leading byte order mark and leading blank lines are ignored. Any other file can be switched with **EDI Lens: Detect Format**; when a file opens as one of the three languages but clearly holds another one (an X12 file named `.edi`), the language is switched automatically (setting `ediLens.autoDetectLanguage`).

## Paths

Every item has a path `SEGMENT[occurrence]-element(repetition).component.subcomponent`, for example `NAD[2]-3.1`, `PID[1]-13(2).1`, `MSH[1]-9.2`. Everything after `SEGMENT[n]` is optional; the repetition defaults to 1; numbers are 1-based. For HL7 `MSH`, field 1 is the field separator and field 2 the encoding characters, as in the standard. Hover, outline, Copy Path, the CSV export and the comparison report use the same paths, so a path from one can be used in the setting `ediLens.compare.ignorePaths` (with `*` as wildcard).

## Syntax problems (all formats)

Found while reading the file, before the structural rules run.

| Code | Severity | Meaning |
| --- | --- | --- |
| `empty-input` | warning | The file is empty or contains only white space. |
| `unknown-format` | error | The text does not start like any of the three formats. |
| `bad-una` | error | The `UNA` service string advice is incomplete or declares an invalid delimiter. |
| `bad-isa` | error | The `ISA` header is missing, shorter than 106 characters or declares an invalid delimiter (a letter, digit or white space). |
| `bad-msh` | error | The `MSH`, `FHS` or `BHS` header has no field separator. |
| `short-encoding` | warning | `MSH-2` holds fewer than four encoding characters. |
| `empty-segment-id` | error | A segment starts with a delimiter instead of an identifier. |
| `unterminated-segment` | error | The last segment has no segment terminator. |
| `unclosed-release` | warning | The text ends with a release character that escapes nothing. |
| `too-many-issues` | info | More syntax problems were found than are listed; the rest were dropped. |
| `parse-failed` | error | The file could not be read at all (should never happen; please report it). |

## UN/EDIFACT

| Code | Severity | Meaning |
| --- | --- | --- |
| `EDIFACT-NO-SEGMENTS` | error | No segments were found; an interchange needs at least `UNB` and `UNZ`. |
| `EDIFACT-UNB-MISSING` | error | The first segment (after an optional `UNA`) is not `UNB`. |
| `EDIFACT-UNB-NOT-FIRST` | error | A `UNB` exists but is not the first segment. |
| `EDIFACT-UNB-SYNTAX-ID-MISSING` | error | `UNB` has no syntax identifier (element 1, for example `UNOC`). |
| `EDIFACT-UNB-REF-MISSING` | error | `UNB` has no interchange control reference (element 5). |
| `EDIFACT-UNZ-MISSING` | error | An interchange opened by `UNB` is not closed by `UNZ`. |
| `EDIFACT-UNZ-UNEXPECTED` | error | `UNZ` without a matching `UNB`. |
| `EDIFACT-UNZ-NOT-LAST` | error | A segment follows `UNZ` (another `UNB` is allowed). |
| `EDIFACT-UNZ-COUNT` | error | `UNZ` element 1 does not equal the number of messages (or functional groups) in the interchange. |
| `EDIFACT-UNZ-REF` | error | `UNZ` element 2 does not repeat the `UNB` control reference. |
| `EDIFACT-UNE-MISSING` | error | A group opened by `UNG` is not closed by `UNE`. |
| `EDIFACT-UNE-UNEXPECTED` | error | `UNE` without a matching `UNG`. |
| `EDIFACT-UNE-COUNT` | error | `UNE` element 1 does not equal the number of messages in the group. |
| `EDIFACT-UNE-REF` | error | `UNE` element 2 does not repeat the `UNG` group reference. |
| `EDIFACT-UNH-REF-MISSING` | error | `UNH` has no message reference number (element 1). |
| `EDIFACT-UNT-MISSING` | error | A message opened by `UNH` is not closed by `UNT`. |
| `EDIFACT-UNT-UNEXPECTED` | error | `UNT` without a matching `UNH`. |
| `EDIFACT-UNT-COUNT` | error | `UNT` element 1 does not equal the number of segments from `UNH` to `UNT` inclusive. |
| `EDIFACT-UNT-REF` | error | `UNT` element 2 does not repeat the `UNH` message reference. |
| `EDIFACT-MESSAGE-EMPTY` | warning | A message has no segments between `UNH` and `UNT`. |
| `EDIFACT-SEGMENT-ID-EMPTY` | error | A segment has no identifier (a stray terminator or a delimiter at the start). |
| `EDIFACT-SEGMENT-ID-INVALID` | warning | A segment identifier is not three upper-case letters or digits. |
| `EDIFACT-RELEASE-UNCLOSED` | error | A segment ends with an unmatched release character, so its terminator is escaped. |
| `EDIFACT-INTERNAL` | error | Validation stopped early because the structure could not be read (please report it). |

## ANSI X12

| Code | Severity | Meaning |
| --- | --- | --- |
| `X12-NO-SEGMENTS` | error | No segments were found; an interchange needs at least `ISA` and `IEA`. |
| `X12-ISA-MISSING` | error | The first segment is not `ISA`. |
| `X12-ISA-LENGTH` | error | `ISA` is not 105 characters plus its terminator (106 in total). |
| `X12-ISA16-MISSING` | error | ISA16, the component element separator, is missing. |
| `X12-ISA-CONTROL-MISSING` | error | ISA13, the interchange control number, is missing. |
| `X12-IEA-MISSING` | error | An interchange opened by `ISA` is not closed by `IEA`. |
| `X12-IEA-UNEXPECTED` | error | `IEA` without a matching `ISA`. |
| `X12-IEA-COUNT` | error | IEA01 does not equal the number of functional groups in the interchange. |
| `X12-IEA-CONTROL` | error | IEA02 does not repeat ISA13. |
| `X12-GS-OUTSIDE-ISA` | error | `GS` appears outside an `ISA`..`IEA` interchange. |
| `X12-GS-CONTROL-MISSING` | error | GS06, the group control number, is missing. |
| `X12-GE-MISSING` | error | A group opened by `GS` is not closed by `GE`. |
| `X12-GE-UNEXPECTED` | error | `GE` without a matching `GS`. |
| `X12-GE-COUNT` | error | GE01 does not equal the number of transaction sets in the group. |
| `X12-GE-CONTROL` | error | GE02 does not repeat GS06. |
| `X12-ST-OUTSIDE-GS` | error | `ST` appears outside a `GS`..`GE` group. |
| `X12-ST-CONTROL-MISSING` | error | ST02, the transaction set control number, is missing. |
| `X12-SE-MISSING` | error | A transaction set opened by `ST` is not closed by `SE`. |
| `X12-SE-UNEXPECTED` | error | `SE` without a matching `ST`. |
| `X12-SE-COUNT` | error | SE01 does not equal the number of segments from `ST` to `SE` inclusive. |
| `X12-SE-CONTROL` | error | SE02 does not repeat ST02. |
| `X12-TRANSACTION-EMPTY` | warning | A transaction set has no segments between `ST` and `SE`. |
| `X12-DUPLICATE-CONTROL` | warning | An ISA13, GS06 or ST02 control number was already used earlier in the same file, interchange or group. |
| `X12-SEGMENT-ID-EMPTY` | error | A segment has no identifier. |
| `X12-SEGMENT-ID-INVALID` | warning | A segment identifier is not two or three upper-case letters or digits. |
| `X12-INTERNAL` | error | Validation stopped early because the structure could not be read (please report it). |

## HL7 v2

| Code | Severity | Meaning |
| --- | --- | --- |
| `HL7-MSH-MISSING` | error | No segments were found, or the first segment is not `MSH`, `FHS` or `BHS`. |
| `HL7-MSH-FIELD-SEPARATOR` | error | `MSH` is not followed by a field separator character. |
| `HL7-MSH-ENCODING` | error | `MSH-2` does not hold four (or five) distinct encoding characters that are no letters, digits or white space. |
| `HL7-MSH-TYPE-MISSING` | error | `MSH-9`, the message type, is empty. |
| `HL7-MSH-CONTROL-ID-MISSING` | error | `MSH-10`, the message control id, is empty. |
| `HL7-MSH-VERSION-MISSING` | warning | `MSH-12`, the version id, is empty. |
| `HL7-SEGMENT-ID-INVALID` | error | A segment identifier is not three characters (A-Z, 0-9) starting with a letter. |
| `HL7-BLANK-LINE` | info | A blank line sits between segments. |
| `HL7-BTS-MISSING` | error | A batch opened by `BHS` is not closed by `BTS`. |
| `HL7-BTS-UNEXPECTED` | error | `BTS` without a matching `BHS`. |
| `HL7-BTS-COUNT` | error | BTS-1 (when given) does not equal the number of messages in the batch. |
| `HL7-FTS-MISSING` | error | A file opened by `FHS` is not closed by `FTS`. |
| `HL7-FTS-UNEXPECTED` | error | `FTS` without a matching `FHS`. |
| `HL7-FTS-COUNT` | error | FTS-1 (when given) does not equal the number of batches (or messages) in the file. |
| `HL7-INTERNAL` | error | Validation stopped early because the structure could not be read (please report it). |

## What is not checked

* Segment order and mandatory segments of a message type (no implementation guides).
* Code values (qualifiers, units, countries) and data types.
* Field lengths and the number of elements per segment.
* Date and time plausibility.
* Business rules such as totals.

For names of segments, elements and code values you can load your own JSON dictionary (Pro); see the README under "Load Dictionary".

## Formatting rules

* **Pretty Print** puts one segment per line and keeps every segment's own terminator; a `UNA` stays first. For X12 and EDIFACT files whose terminator is a line break, nothing changes.
* **Minify** removes the line breaks between segments. HL7 segments keep a carriage return, because that is the HL7 segment terminator.
* Both only change white space between segments; the values are never touched. A file is only rewritten by **Batch Pretty Print Folder** after a check that its data is identical once both versions are minified.

## Limits

| Limit | Value | Where |
| --- | --- | --- |
| Automatic parsing | 10 MB (setting `ediLens.maxFileSizeMB`, up to 500) | outline, hover, status bar, problems; larger files on demand with **Validate Current File** |
| Re-check while typing | files up to 2 MB | larger files are re-checked on save |
| Problems per file | 500 (setting `ediLens.maxIssues`, up to 5,000) | Problems view |
| Outline | first 20,000 segments | the rest through **Go to Segment** |
| Workspace scan | 2,000 files, 5 MB per file | **Validate Workspace**, **Batch Pretty Print Folder** |
| Comparison view | 3,000 rows | **Compare With Another File** |
| Dictionary | 2 MB of text, 2,000 segments, 100,000 entries | **Load Dictionary** |
