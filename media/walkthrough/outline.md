## The outline

The **EDI Lens** icon in the activity bar opens the outline of the active file:

* **Segment** rows such as `NAD[2]` (the second `NAD` segment) with a preview of the value.
* **Element** rows such as `NAD-3`, then **components** such as `NAD-3.1` and, for HL7 v2, **subcomponents**.
* Repeated elements show one row per repetition: `PID-13(2)`.

Select a row to reveal it in the editor. Right-click a row and choose **Copy Path** to put its path on the clipboard. The outline follows the active editor and refreshes a moment after you stop typing.

Empty elements are left out of the tree; the numbers in the labels keep their real positions, so `NAD-3` is always the third element.
