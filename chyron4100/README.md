# Chyron 4100 emulator

A browser recreation of the Chyron 4100 broadcast character generator workflow:
compose pages on the preview channel, record them to numbered messages on
"disk", read them back and take them to air on the program channel.

Unofficial and not affiliated with Chyron. It emulates the operator workflow
(numbered messages, status-line prompts, preview/program, roll and crawl), not
the original hardware or its disk format.

## Running

Open `index.html` in a browser. No build step or server is needed. Fonts load
from Google Fonts and fall back to system faces when offline.

## Keys

| Key | Function |
| --- | --- |
| Typing | Writes on the preview at the cursor |
| Arrows / Home / End | Move the cursor. Shift+Left/Right selects |
| Enter / Tab | New row / jump to next row |
| Ctrl+Arrows | Position the row (Shift for 10 px steps). Row offsets push the rows below |
| F1 Read · F2 Record | Prompt for a message number 0001-9999 |
| F3 Erase page · F4 Directory | Clear the preview / browse the disk |
| PgUp / PgDn | Read the previous / next recorded message |
| F5 Font · F6 Color · F7 Edge · F8 Box | Attribute prompts (fonts 1-8, colors 00-15, edge 0-4, box `11` or `11F` for full width) |
| F9 Justify · F10 Mode | Cycle L/C/R; mode `S`, `R`, `C` plus speed, e.g. `R4` |
| Ctrl+E | Scope for attribute changes: cursor, row, or page |
| Ctrl+Enter / Ctrl+Delete | Take preview to air / clear program |
| Ctrl+M · Ctrl+Space | Toggle cut/mix · hold a roll or crawl |
| Ctrl+B · Ctrl+G · Ctrl+Z · Ctrl+O | Background · safe area · undo · disk import/export |

The disk is stored in the browser's localStorage. Use Disk I/O to back it up as
JSON or to import one. Sample messages 1001-1006 (title, lower third, score,
credit roll, crawl, penalty) are fictional.
