# Query (Pro)

**EDI Lens: Query** finds the messages that satisfy a condition, in the file of the active editor or in every message file of a folder. It answers questions such as "which messages have this order number" or "all invoices of this buyer above 1000". Query is a Pro feature and runs inside the free 14-day trial.

## Running a query

1. Run **EDI Lens: Query** (command palette, the editor context menu, the toolbar of the Query Results view, or right-click a folder in the Explorer).
2. Choose where to search when there is a choice: the file in the active editor or a workspace folder.
3. Pick a saved query or type a new one. The input box checks the query while you type and names the position of a mistake.
4. A new query can be given a name; it is then saved for this workspace. Leave the name empty to run it once.

The matches appear in the **Query Results** view under the EDI Lens icon in the activity bar: one entry per file, below it one per matching message (message number, type, control reference, line), below that the values that satisfied the query with their path. Select an entry to open the file at that place.

| Command | What it does |
| --- | --- |
| **EDI Lens: Query** | Runs a query. |
| **EDI Lens: Export Query Results As CSV** | Opens the results as CSV in a new editor: `file,message_number,message_type,reference,line,column,path,value`, one row per matched value. |
| **EDI Lens: Clear Query Results** | Empties the view (free). |
| **EDI Lens: Delete Saved Query** | Removes one saved query of the workspace (free). |

A folder search shows a progress notification with a cancel button, reads one file at a time (at most 2,000 files, each up to `ediLens.maxFileSizeMB`) and stops listing at `ediLens.query.maxResults` messages (default 1,000). Files that are not UTF-8 text or not messages are left out and counted.

## Selectors

A selector names a kind of segment and, optionally, a value inside it. The same selectors are used by [partner rules](partner-rules.md) and [anonymise rules](anonymise.md).

| Selector | Meaning |
| --- | --- |
| `NAD` | every `NAD` segment of the message |
| `NAD[BY]` | the `NAD` segments whose first element (its first component) is `BY`. Also `NM1[IL]`, `N1[ST]`, `DTM[137]`, `QTY[21]`, `REF[DP]` |
| `NM1[IL\|QC]` | one of several qualifiers |
| `NAD[5412*]` | `*` is a wildcard in a qualifier |
| `OBX[3=GLU]` | the qualifier sits in element 3 |
| `OBX[3.1=2345-7]` | the qualifier sits in element 3, component 1 |
| `LIN#2` | the second matching segment of the message |
| `NAD[BY]-2` | element 2 of those segments (the whole element) |
| `NAD[BY]-2.1` | element 2, component 1 |
| `PID-3.4.2` | element 3, component 4, subcomponent 2 (HL7) |
| `PID-13(2).1` | only the second repetition of element 13 |

**The brackets hold a qualifier, not a count.** This differs from the paths shown by hovers and by Copy Path, where `NAD[2]` is the second `NAD` of the file. In a selector, `NAD[2]` means "the `NAD` whose first element is `2`"; write `NAD#2` to count. Results are always shown with the hover path (for example `NAD[2]-2.1`).

Element numbers are those of the hover: for HL7 `MSH`, field 1 is the field separator and field 2 the encoding characters, so the message type is `MSH-9`. Segment ids are written exactly as in the file (upper case). Values are compared as they stand in the file, without leading and trailing spaces; release characters and HL7 escape sequences are not removed.

## The language

```
NAD[BY]-2.1 == "5412*" AND count(LIN) > 2
MOA[86]-1.2 > 1000 AND NOT exists(CTA)
PID-5.1 == "Hartwell" OR sum(FT1-12) >= 2500
```

| Part | Meaning |
| --- | --- |
| `PATH == "text"` | a value equals the text. `*` in the text is a wildcard: `"5412*"`, `"*gate 4*"` |
| `PATH != "text"` | a value differs from the text |
| `PATH > 1000` | also `<`, `<=`, `>=`, `==`, `!=` with a number: a comparison of numbers (a decimal comma is understood) |
| `count(SEG)` | the number of matching segments; `count(PATH)` the number of filled values |
| `sum(PATH)` | the sum of the numeric values |
| `exists(SEG)`, `exists(PATH)` | at least one such segment, or one filled value, is there |
| `A AND B`, `A OR B`, `NOT A` | combinations; `&&`, `\|\|` and `!` are accepted too. `AND` binds tighter than `OR`; use brackets to group |
| `=`, `<>` | accepted for `==` and `!=` |

* Texts stand in double or single quotes; inside, `\"` is a quote. A `*` in a text is always a wildcard; a literal `*` cannot be searched for.
* **Text or number.** A comparison with a text in quotes compares text: `RFF[ON]-1.2 == "12345"` does not match the value `0012345`, and `"9" < "10"` is false as for any text. A comparison with a number (`== 12345`), with `count(...)` or `sum(...)` compares numbers, and so does a comparison of two paths whose values are both numbers. **Numbers are compared exactly, digit by digit, however long they are**: `GIN-2.1 == 340123456789012345` does not match `340123456789012346`. Leading zeros and zeros at the end of a fraction do not count: `0012` is `12`, `1.50` is `1.5`. Sums are exact as well.
* Either side of a comparison may be a path, `count(...)`, `sum(...)`, a text or a number; at least one side must read the message. `NAD[BY]-2.1 == NAD[IV]-2.1` compares two values of the same message.
* **A path may match several values in one message. A comparison is true when at least one value satisfies it.** So `QTY[21]-1.2 > 100` finds messages with at least one such quantity, and `QTY[21]-1.2 != 0` finds messages with at least one quantity that is not 0. For "no value is ...", write `NOT (QTY[21]-1.2 == 0)`.
* A path that matches nothing makes a comparison false; `sum(...)` over no values is no value (not 0), `count(...)` is 0.
* Upper and lower case matter in texts unless `ediLens.query.ignoreCase` is on.

A query is checked once for every message: from `UNH` to `UNT`, from `ST` to `SE`, or an `MSH` with the segments that follow it. Envelope segments outside messages (`UNB`, `ISA`, `GS`, `BHS`) are not part of any message and cannot be queried.

## More examples

| Question | Query |
| --- | --- |
| Orders of one buyer | `NAD[BY]-2.1 == "5412345000176"` |
| A purchase order number in X12 | `BEG-3 == "PO-24-01178"` |
| Invoices above an amount | `BGM-1.1 == 380 AND MOA[86]-1.2 > 1000` |
| Messages without a contact | `NOT exists(CTA)` |
| Large orders | `count(LIN) > 50` or `count(PO1) > 50` |
| A lab result below a limit | `OBX[3.1=2823-3]-5 < 3.5` |
| One patient across message types | `PID-3.1 == "RS-4471902"` |
| Admissions only | `MSH-9.1 == "ADT" AND MSH-9.2 == "A01"` |
| Totals that do not add up | `sum(MOA[203]-1.2) != MOA[79]-1.2` |

## Limits

* At most 20 matched values are listed per message; the message itself is always listed. A part of a query that stands under `NOT` lists no values.
* A query may be 1,000 characters long and have 100 parts.
* When both sides of a comparison are paths, up to 5,000 values per side are compared in one message.
* Query reads a file segment by segment and only looks into the segments the query names, so memory use does not grow with the size of a file.

## Problem codes

| Code | Meaning |
| --- | --- |
| `QUERY-SYNTAX` | The query is not valid. The message gives the position (counted from 1) and what was expected there. |
| `QUERY-TOO-LONG` | The query is longer than 1,000 characters. |
| `QUERY-NOT-EDI` | The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message, so it was not searched. In a folder search such files are counted as left out. |
