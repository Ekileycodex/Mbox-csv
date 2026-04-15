# mbox-csv.com

Free, private, browser-based MBOX → CSV converter.

Upload a `.mbox` file, get a clean CSV with every email's Date, From, To, CC, BCC, Subject, Body, and Message-ID. Nothing is uploaded to any server — all processing happens in the browser.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Full single-page site (hero, converter, how-it-works, FAQ, footer) |
| `styles.css` | Responsive design, CSS variables, component styles |
| `app.js` | MBOX parser, MIME decoder, CSV generator, UI logic |

## Features

- Drag & drop or click-to-browse upload
- Handles Gmail Takeout, Thunderbird, Apple Mail, and any standard MBOX
- Full MIME parsing: multipart, quoted-printable, base64, encoded-words
- UTF-8 BOM in output for seamless Excel compatibility
- Column selector — choose exactly which fields to export
- Preview table (first 5 emails) before downloading
- Works entirely offline after first page load
