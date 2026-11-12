# Envelope tools (Pro)

Testing and support need single messages out of large interchanges, merged test files, fresh control numbers and matching acknowledgements. The four envelope tools do this. They are Pro features and run inside the free 14-day trial. The body of a message is never changed by any of them: it is copied character for character.

The setting `ediLens.envelope.startNumber` (default 1) is the first control number Split, Merge and Generate Acknowledgement use, and the value Renumber offers.

## Split Interchange Into Messages

Writes every message of the file in the active editor into its own file.

1. Run **EDI Lens: Split Interchange Into Messages** and choose a folder.
2. The files are named after the open file with a running number: `orders-001.edi`, `orders-002.edi`, ... If files with those names exist, the command asks before it replaces them.

| Format | Each file contains |
| --- | --- |
| UN/EDIFACT | `UNA` (when the source has one), a copy of the `UNB` of the message's interchange with a fresh control reference, the `UNG` with a fresh reference when the message sits in a group, the message from `UNH` to `UNT`, then `UNE` (count 1) and `UNZ` (count 1) |
| ANSI X12 | a copy of the `ISA` with a fresh `ISA13`, the `GS` with a fresh `GS06`, the transaction set from `ST` to `SE`, then `GE*1` and `IEA*1` |
| HL7 v2 | the `MSH` with the segments that belong to it; batch segments (`FHS`, `BHS`, `BTS`, `FTS`) are left out |

The delimiters and the line break style of the source are kept. The message keeps its own reference (`UNH`, `ST02`, `MSH-10`). The control numbers count up from the start value, one per file; a number is written in the style of the original (`IC00901` becomes `IC00001`, `000000417` becomes `000000001`). The open file is not changed.

## Merge Messages Into One Interchange

Run **EDI Lens: Merge Messages Into One Interchange** and select the files (or right-click a folder in the Explorer to take every message file in it). The files are taken in name order and the result opens in a new, unsaved editor.

* The envelope (`UNA`, `UNB` or `ISA`) comes from the first file, with a control number from the start value.
* **X12:** every group of every file is kept as a group, with group control numbers counting up; the transaction sets of a group are renumbered `0001`, `0002`, ...
* **UN/EDIFACT:** messages are renumbered 1, 2, 3, ... through the interchange. Either all files use functional groups (`UNG`) or none does.
* **HL7:** the messages are wrapped in a batch: a `BHS` built from the first `MSH`, the messages, and `BTS` with the count. The messages keep their own control ids (`MSH-10`); they are not renumbered. The batch gets one line-end style, that of the first file.
* Trailer counts and references are written to match.

All files must be in the same format and use the same delimiters (element separator, component separator, release character, segment terminator).

## Renumber Control Numbers

Renumbers the control numbers of the file in the active editor, headers and trailers together. The command asks for the start value and for what to do with references; it is one edit that Undo takes back.

| Level | Numbers | Counting |
| --- | --- | --- |
| Interchange | `UNB-5` and `UNZ-2`; `ISA13` and `IEA02` | up from the start value through the file |
| Group | `UNG-5` and `UNE-2`; `GS06` and `GE02` | up from the start value through the file |
| Message | `UNH-1` and `UNT-2`; `ST02` and `SE02`; `MSH-10` | up from the start value inside each X12 group or EDIFACT interchange; HL7 control ids count through the file |

A number keeps its style: an all-digit number keeps its width (`0001` becomes `0005`), a number with text in front keeps the text (`RS2403-0147` becomes `RS2403-0005`), `ISA13` keeps its nine digits. Counts are not touched.

**References.** Acknowledgement segments quote the control numbers of the messages they answer: `AK1`, `AK2` and `TA1` in X12, `UCI`, `UCF` and `UCM` in EDIFACT, `MSA-2` in HL7.

* **Keep references** (the default) leaves them as they are. Choose this when the acknowledged messages are somewhere else.
* **Update references** changes a reference when the message it names is in the same file and was renumbered; references to messages that are not in the file stay.

## Generate Acknowledgement

Opens a basic acknowledgement for the file in the active editor in a new editor next to it.

| Source | Acknowledgement |
| --- | --- |
| ANSI X12 | a `997` (or a `999` with the setting `ediLens.envelope.x12Acknowledgement`): one interchange per source interchange, one transaction set per source group with `AK1`, an `AK2` and `AK5` (`IK5` in a 999) per transaction set, and `AK9` |
| UN/EDIFACT | a `CONTRL` message per source interchange with `UCI`, a `UCF` per group and a `UCM` per message |
| HL7 v2 | an `ACK` message (`MSH` and `MSA`) per source message |

Sender and receiver are swapped, the date and time are the current ones, the control numbers of the source are quoted. The `UNB` date of a CONTRL has the width of the source (eight digits where the source uses them, as from syntax version 4, otherwise six); the message itself is always written as `CONTRL:D:3:UN`, also for a version 4 source.

**It is a test acknowledgement, and it is marked as one:** `ISA15` is `T`, the `UNB` test indicator (element 11) is `1`, `MSH-11` is `T` and `MSA-3` reads `TEST ACKNOWLEDGEMENT`. The message shown after the command says so as well.

**Accepted or rejected** is decided by the envelope alone: a message is accepted (`A`, action code `7`, `AA`) when it is closed by its trailer and the trailer's count and reference agree with the message; otherwise it is rejected.

| What is wrong | X12 997 / 999 | EDIFACT CONTRL | HL7 ACK |
| --- | --- | --- | --- |
| Message trailer missing (`SE`, `UNT`) | `AK5*R*2` (`IK5*R*2`) | `UCM` action `4` | |
| Control number of header and trailer differ | `AK5*R*3` | `UCM` action `4` | |
| Segment count of the trailer wrong | `AK5*R*4` | `UCM` action `4` | |
| No message type or control id in `MSH` | | | `MSA` `AE` |
| Group trailer missing, or its control number or count wrong (`GE`, `UNE`) | `AK9` with `E` (or `R` when no transaction set was accepted) and the code `3`, `4` or `5` in `AK905` | `UCF` action `4`, its messages are not listed | |
| Interchange trailer missing, or its control number or count wrong (`IEA`, `UNZ`) | no acknowledgement is written (`ENV-BAD-ENVELOPE`): a 997 has no place to report it | `UCI` action `4`, no `UCM` | |

A group or interchange whose own trailer is wrong is therefore never reported as accepted. A source whose header (`ISA`, `UNB`, `MSH`) is damaged gets no acknowledgement at all (`ENV-BAD-ENVELOPE`), because the acknowledgement is built from that header. This says nothing about the content of a message, and it is not what the partner's system would answer. Do not send the result as a production acknowledgement.

Acknowledgements are not acknowledged again: X12 groups with the functional id `FA`, `CONTRL` messages and HL7 `ACK` messages are skipped.

## Limits

* Split and Merge refuse a file whose envelope is damaged (a missing header or trailer, a message outside an interchange) and name the first problem. Run **EDI Lens: Validate Current File** and repair it first.
* Split, Merge and Generate Acknowledgement accept up to 200,000 messages in one file. Renumber has no such limit.
* `ISA13` holds nine digits, so control numbers cannot go past 999999999.
* The tools read a file segment by segment and keep only the envelope segments, so a very large message does not need more memory than a small one.

## Problem codes

| Code | Meaning |
| --- | --- |
| `ENV-NOT-EDI` | The text does not start like a UN/EDIFACT, ANSI X12 or HL7 v2 message. |
| `ENV-NO-MESSAGES` | No message (`UNH`, `ST`, `MSH`) or no control number was found, so there is nothing to do. |
| `ENV-BAD-ENVELOPE` | The envelope is damaged (a header or trailer is missing or cannot be read, a message stands outside an interchange, an X12 interchange trailer disagrees with its header), or the file holds more than 200,000 messages. The message names the problem; nothing was written. |
| `ENV-MIXED-FORMATS` | The files to merge are not all in the same format. |
| `ENV-DELIMITER-MISMATCH` | A file to merge uses other delimiters than the first one. |
| `ENV-MIXED-GROUPS` | Some EDIFACT files to merge use functional groups and others do not. |
| `ENV-NOTHING-TO-ACK` | The file holds only acknowledgements, which are not acknowledged again. |
| `ENV-NUMBER-TOO-LARGE` | A control number would run past 999999999 (for X12: would not fit into the nine digits of `ISA13`). Choose a smaller start value. |
| `ENV-BAD-START` | The start value is not a whole number from 1 to 999999999. |
