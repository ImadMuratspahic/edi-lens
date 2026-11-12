## Three formats, one view

EDI Lens recognises files by their extension and by their first segment:

| Format | Extensions | First segment |
| --- | --- | --- |
| UN/EDIFACT | `.edi`, `.edifact`, `.edf` | `UNA`, `UNB` or `UNH` |
| ANSI X12 | `.x12`, `.x12edi` | `ISA` (106 characters) |
| HL7 v2 | `.hl7` | `MSH`, `FHS` or `BHS` |

The samples open in a new untitled editor. They contain invented parties, numbers and names only, so you can experiment freely. For a file with another extension, run **EDI Lens: Detect Format** from the Command Palette.

Everything happens on your computer: no file, file name or value ever leaves it.
