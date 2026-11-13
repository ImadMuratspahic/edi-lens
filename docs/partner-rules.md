# Partner rules (Pro)

The built-in validation checks the structure of a message, which is the same for everybody. Every trading partner also has an implementation guide: which segments must be there, which codes are allowed, how a number must look. Partner rules let you write that guide down once and check messages against it. They are a Pro feature and run inside the free 14-day trial.

## Commands

| Command | What it does |
| --- | --- |
| **EDI Lens: Validate With Partner Rules** | Checks the file in the active editor against the rule file. Violations appear in the editor and in the Problems view, with the source `EDI Lens rules`, a problem code and the rule id in front of the message. |
| **EDI Lens: Create Rules From This Message** | Writes a starting rule file from the open message and opens it in a new editor. |
| **EDI Lens: Validate Folder With Partner Rules** | Checks every message file of a folder (command palette, or right-click a folder in the Explorer), with progress and a cancel button. Opens an HTML report and offers **Save HTML Report...** and **Save CSV Report...**. |
| **EDI Lens: Clear Partner Rules Results** | Removes the rule violations from the Problems view (free). |

Rule violations are kept apart from the structural problems of the free validation; clearing one list does not touch the other. The violations of a file belong to the text that was checked: when you edit the file they are removed, and running the command again gives a fresh list.

## The rule file

By default the rule file is `.edilens/rules.json` in the workspace folder (for a folder run: in that folder). The setting `ediLens.rules.file` names another path; an absolute path works without an open folder. The editor checks the file against a JSON schema while you type.

```json
{
  "name": "Harbor Supply purchase orders",
  "format": "edifact",
  "messageTypes": ["ORDERS"],
  "rules": [
    { "id": "HS-01", "type": "segment-required", "segment": "NAD[DP]", "message": "The delivery party (NAD+DP) is missing." },
    { "id": "HS-02", "type": "value-in", "path": "BGM-1.1", "values": ["220", "221"] }
  ]
}
```

| Property | Meaning |
| --- | --- |
| `name` | Name of the guide, shown in messages and reports. Optional. |
| `format` | `edifact`, `x12` or `hl7`. A file in another format is not checked. |
| `messageTypes` | The message types the rules apply to: `ORDERS`, `850`, `ADT^A01` (`ADT` alone matches every ADT message; `*` is a wildcard). Leave it out to check every message. |
| `rules` | Up to 1,000 rules. |

Every rule may have:

| Property | Meaning |
| --- | --- |
| `id` | Short id shown in front of the violation, for example `[HS-01]`. Without it the rule is called `rule 3` by its position. Ids must be unique. |
| `message` | The sentence shown for a violation. Without it EDI Lens writes one that names the path, the value and what was expected. |
| `severity` | `error` (default), `warning` or `info`. |
| `messageTypes` | Limits this one rule to some message types. |
| `within`, `until` | Group scoping, see below. |

Paths and segments are written as [selectors](query.md#selectors): `NAD[BY]` is the `NAD` whose first element is `BY`; `NAD[BY]-2.1` its element 2, component 1.

## Rule types

| `type` | Properties | A violation is reported when |
| --- | --- | --- |
| `segment-required` | `segment` | no such segment is in the message (or group) |
| `segment-forbidden` | `segment` | such a segment is there; one violation per segment |
| `occurrences` | `segment`, `min`, `max` | the number of such segments is below `min` or above `max` |
| `element-required` | `path` | the value is empty or missing in a segment the path names |
| `value-in` | `path`, `values`, `ignoreCase` | a filled value is not in the list (a code list) |
| `pattern` | `path`, `pattern`, `ignoreCase` | a filled value does not match the regular expression |
| `range` | `path`, `min`, `max` | a filled value is not a number, or is outside the range (compared as ordinary numbers with about 15 significant digits, like `min` and `max` in a JSON file; use `equal` for long identifiers) |
| `date` | `path`, `format` | a filled value is not a real date in that format |
| `length` | `path`, `min`, `max` | the length of a filled value (in characters) is outside the range |
| `condition` | `if`, `then` | the condition holds and the rule in `then` is violated |
| `equal` | `left`, `right`, `tolerance` | both sides have a value and the values differ |

Notes:

* **Empty values** are only reported by `element-required`. The other value rules look at filled values, so "optional, but if present then ..." needs no special case.
* A path without a repetition number looks at every repetition of a repeating element; a path may match several segments, and each one is checked.
* **`date` formats** are built from `CCYY` (or `YYYY`), `YY`, `MM`, `DD`, `hh`, `mm`, `ss` and separators: `CCYYMMDD`, `YYMMDD`, `CCYYMMDDhhmm`, `CCYY-MM-DD`. The value must be a real calendar date (no 30 February).
* **`pattern`** is a JavaScript regular expression, searched anywhere in the value; use `^` and `$` to match the whole value. To keep a rule file from freezing the editor, these are refused when the file is loaded: backreferences, lookarounds, and a repeated group that itself contains a repetition, an optional part or an alternative (for example `(a+)+`, `(ab?)+` or `(a|b)*`). A pattern with more than three open-ended repetitions runs with a time limit, and every pattern rule has two seconds in total per file: a pattern that is slow on every value is stopped (`RULES-PATTERN-STOPPED`) instead of blocking the editor.
* **`condition`**: `if` is `{ "segment": "CTA" }` (the segment is present), `{ "path": "BGM-1.1" }` (a value is filled), `{ "path": "BGM-1.1", "equals": "220" }` or `{ "path": "BGM-1.1", "in": ["220", "221"] }`; add `"not": true` to reverse it. `then` is any rule of the first nine types.
* **`equal`**: each side is a path (its first filled value), `count(SEG)` (segments) or `count(PATH)` (filled values), `sum(PATH)` (the sum of the numeric values) or a number. Two numbers are compared as numbers, exactly and digit by digit however long they are (an 18-digit identifier is never rounded; a decimal comma is understood; leading zeros and zeros at the end of a fraction do not count; `tolerance` allows a small difference and is applied exactly too), anything else as text. Write a long number that a rule compares with as text in quotes (`"right": "340123456789012345"`), because a number in a JSON file keeps only about 15 digits. When one side has no value, nothing is reported.

```json
{ "id": "T1", "type": "equal", "left": "sum(MOA[203]-1.2)", "right": "MOA[79]-1.2", "tolerance": 0.01 }
```

## Groups: `within` and `until`

Rules are checked once per message: from `UNH` to `UNT`, from `ST` to `SE`, or an `MSH` with the segments that follow it. With `within` a rule is checked once per group instead:

```json
{ "id": "L1", "type": "segment-required", "segment": "QTY[21]", "within": "LIN", "until": ["UNS"] }
```

A group starts at each segment that `within` names and ends before the next segment with the same id, before a segment whose id is listed in `until`, or at the end of the message. `within` may carry a qualifier, for example `"within": "HL[3=22]"` for the subscriber loops of an X12 837: groups then start only at those segments, and every `HL` ends a group. Segments outside any group are not looked at by that rule.

## Create Rules From This Message

Open a message you know is good and run **EDI Lens: Create Rules From This Message**. The starting rule file contains:

* a `segment-required` rule for every segment id that occurs in every message of the file,
* an `element-required` rule for every element that is filled in all segments of an id,
* a `value-in` rule for every position that only holds a few short codes (up to three characters, at most ten different ones).

The file it was created from always passes these rules. They describe one file, not the partner's guide: a second message will often show that a rule is too strict. Review the file, delete what does not belong, add what the guide says, then save it as `.edilens/rules.json`. Nothing is saved for you.

## Folder report

The HTML report lists, per file, the messages checked and a table of violations (line, severity, code, message number, text), then the files that were not checked and why (another format or message type, not UTF-8, too large). The CSV has the columns `file,line,column,severity,code,rule,message_number,message_type,message`. Values that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading apostrophe unless `ediLens.export.neutraliseFormulas` is off. A run reads at most 2,000 files, each up to `ediLens.maxFileSizeMB`, and lists at most `ediLens.maxIssues` violations per file.

## Examples

Complete rule files with sample messages are in [examples](examples): [rules-edifact-orders.json](examples/rules-edifact-orders.json) (try it on `messages/orders-three.edi`: the third order breaks five rules), [rules-x12-850.json](examples/rules-x12-850.json) and [rules-hl7-adt.json](examples/rules-hl7-adt.json).

## Problem codes

| Code | Meaning |
| --- | --- |
| `RULES-SEGMENT-REQUIRED` | A required segment is missing in a message or group. Reported at the start of the message or group. |
| `RULES-SEGMENT-FORBIDDEN` | A segment that must not be used is present. |
| `RULES-OCCURRENCES` | A segment occurs too rarely or too often. |
| `RULES-ELEMENT-REQUIRED` | A required value is empty or missing. |
| `RULES-VALUE-NOT-IN-LIST` | A value is not in the list of allowed values. |
| `RULES-PATTERN` | A value does not match the pattern. |
| `RULES-RANGE` | A value is not a number or is outside the range. |
| `RULES-DATE` | A value is not a date in the required format. |
| `RULES-LENGTH` | A value is too short or too long. |
| `RULES-CONDITION` | The condition of a rule holds and its consequence is violated. |
| `RULES-EQUAL` | Two values that must be equal differ. |
| `RULES-PATTERN-STOPPED` | A pattern took too long (on one value, or more than two seconds in total) and was not applied to the rest of the file. Simplify the pattern. |
| `RULES-FILE-INVALID` | The rule file is not valid JSON or a rule in it is not understood. The message quotes the rule and the reason; nothing was checked. |
| `RULES-NOT-EDI` | The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message, or holds no message. |

## Limits

* Rules look at one message at a time; a rule cannot compare two messages or two files.
* Partner rules are what you write. EDI Lens ships no rules, no code lists and no text of any standard or guide.
* A rule file is read as JSON only; nothing in it is executed.
