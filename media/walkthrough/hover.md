## Paths

Every item has a path of the form

`SEGMENT[occurrence]-element(repetition).component.subcomponent`

for example `NAD[2]-3.1`, `PID[1]-13(2).1` or `MSH[1]-9.2`. Everything after `SEGMENT[n]` is optional; the repetition defaults to 1. Numbers are 1-based, as in the standards. For HL7 `MSH`, field 1 is the field separator itself and field 2 holds the encoding characters.

The hover shows the path, the raw value, the position inside the segment and the length in characters. The same paths are used by the outline, **Copy Path At Cursor**, the CSV export and the comparison report, so a path from a hover can be pasted straight into the setting `ediLens.compare.ignorePaths`.

Hovers can be switched off with the setting `ediLens.hover.enabled`.
