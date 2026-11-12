## What is checked

Validation is **structural**: envelopes, counts, control numbers and delimiters.

* **UN/EDIFACT**: `UNB` first and `UNZ` last, `UNH`/`UNT` pairs, segment counts, message and interchange references, `UNG`/`UNE` groups, syntax identifier, unclosed release characters.
* **ANSI X12**: the 106-character `ISA`, `ISA`/`IEA`, `GS`/`GE` and `ST`/`SE` nesting, segment counts, control numbers, duplicate control numbers, empty transaction sets.
* **HL7 v2**: `MSH` first, field separator and encoding characters, message type, control id and version, segment ids, blank lines, `FHS`/`FTS` and `BHS`/`BTS` batch counts.

Every problem has a stable code such as `X12-SE-COUNT` and points at the exact characters. The status bar shows the format, the segment count and the number of problems; click it to open the Problems view.

EDI Lens does not check a message against a message-type specification, an implementation guide or a code list.
