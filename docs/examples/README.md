# Examples

Sample messages and rule files for the Pro tools. Every party, person, identifier and address in them is invented.

| File | What it is |
| --- | --- |
| [messages/orders-three.edi](messages/orders-three.edi) | A UN/EDIFACT interchange with three purchase orders. The third one breaks five of the rules below. |
| [messages/po-two.x12](messages/po-two.x12) | An ANSI X12 interchange with two 850 purchase orders. |
| [messages/adt-two.hl7](messages/adt-two.hl7) | Two HL7 v2 messages (an admission and a discharge) of one patient. |
| [rules-edifact-orders.json](rules-edifact-orders.json) | Partner rules for the orders: required parties, order number pattern, currencies, a line count that must match. |
| [rules-x12-850.json](rules-x12-850.json) | Partner rules for the 850s, two of them as warnings. |
| [rules-hl7-adt.json](rules-hl7-adt.json) | Partner rules for the ADT messages. |
| [anonymise.json](anonymise.json) | Anonymise rules: the three built-in profiles plus a few own paths. |

## Try them

Copy this folder somewhere, open it in VS Code and run the commands from the command palette. The first Pro command starts the free 14-day trial.

1. **Partner rules.** Copy `rules-edifact-orders.json` to `.edilens/rules.json`, open `messages/orders-three.edi` and run **EDI Lens: Validate With Partner Rules**. Five violations appear for the third order: no delivery party, an order number in the wrong form, a currency that is not accepted, no delivery date and a line count that does not match.
2. **Query.** With `messages/orders-three.edi` open, run **EDI Lens: Query** with `count(LIN) > 2` (the second order), `MOA[86]-1.2 > 500` (the first two) or `NOT exists(NAD[DP])` (the third).
3. **Anonymise.** Copy `anonymise.json` to `.edilens/anonymise.json`, open `messages/adt-two.hl7` and run **EDI Lens: Anonymise Message**. The patient, the next of kin and the doctor get other names, the record number and the date of birth change, and both messages still show the same patient.
4. **Envelope tools.** With `messages/po-two.x12` open, run **EDI Lens: Split Interchange Into Messages** (two files, each a complete interchange), **EDI Lens: Generate Acknowledgement** (a test 997 that accepts both orders) and **EDI Lens: Renumber Control Numbers**.
