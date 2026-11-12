## Four Pro tools for files from partners

All of them are Pro features and run inside the free 14-day trial. They work on your computer only; nothing is uploaded.

**Anonymise Message / Anonymise Folder.** Makes a copy of a message in which the identifying values named by the active profiles and rules are replaced: names, identifiers, addresses, telephone numbers, dates of birth in the segments a profile covers, and the sender and receiver ids of the envelope. The structure stays as it was: same segments, same delimiters, same lengths, same counts, so the copy validates exactly like the original. Built-in profiles cover HL7 patient data, the identifying fields of X12 healthcare transactions and EDIFACT party data; a rule file `.edilens/anonymise.json` adds your own paths. Always read the copy before you share it: only the values named by the rules are replaced, free text is not searched, and a file in which no rule matched is reported as unchanged instead of being copied.

**Validate With Partner Rules.** Checks a message against your own implementation guide, written as a rule file `.edilens/rules.json`: required and forbidden segments, allowed codes, patterns, ranges, date formats, lengths, "if A then B" and totals. Violations appear in the Problems view with the rule id. **Create Rules From This Message** writes a starting rule file from a message you know is good.

**Query.** Finds the messages that satisfy a condition, in the open file or in a whole folder:

```
NAD[BY]-2.1 == "5412*" AND count(LIN) > 2
```

The matches are listed in the **Query Results** view; select one to jump to it. Queries can be saved per workspace and the results exported as CSV.

**Envelope tools.** **Split Interchange Into Messages** writes every message into its own file with a valid envelope. **Merge Messages Into One Interchange** does the opposite. **Renumber Control Numbers** renumbers headers and trailers together. **Generate Acknowledgement** writes a basic X12 997 or 999, an EDIFACT CONTRL or an HL7 ACK for the open file, marked as a test.

The paths in rules and queries use a qualifier in brackets: `NAD[BY]` is the NAD segment whose first element is `BY`. That differs from the paths shown by hovers, where `NAD[2]` is the second NAD of the file.
