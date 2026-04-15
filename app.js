/* ============================================================
   mbox-csv.com — app.js
   MBOX parser + CSV generator, 100% client-side
   ============================================================ */
'use strict';

/* ── CSV column definitions ── */
const CSV_COLUMNS = [
  { key: 'date',      label: 'Date' },
  { key: 'from',      label: 'From' },
  { key: 'to',        label: 'To' },
  { key: 'cc',        label: 'CC' },
  { key: 'bcc',       label: 'BCC' },
  { key: 'subject',   label: 'Subject' },
  { key: 'body',      label: 'Body' },
  { key: 'messageId', label: 'Message-ID' },
];

/* ── App state ── */
const state = { file: null, emails: [] };

/* ============================================================
   MBOX PARSER
   ============================================================ */

/**
 * Split raw MBOX text into individual raw email strings.
 * MBOX uses "From " lines (no colon) as message separators.
 * Lines starting with ">From " inside a body are unescaped.
 */
function parseMbox(content) {
  // Normalise line endings
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');

  const messages = [];
  let current = null;

  for (const line of lines) {
    // A separator line starts with "From " but NOT "From:"
    if (line.startsWith('From ') && !line.startsWith('From:')) {
      if (current !== null) messages.push(current.join('\n'));
      current = [];
    } else if (current !== null) {
      // Unescape ">From " that was escaped inside the body
      current.push(line.startsWith('>From ') ? line.slice(1) : line);
    }
  }

  if (current !== null && current.length > 0) messages.push(current.join('\n'));
  return messages;
}

/* ── Header parsing ── */

/**
 * Parse RFC 2822 headers from a header block string.
 * Handles folded (multi-line) headers and MIME encoded-words.
 */
function parseHeaders(headerText) {
  const headers = {};
  const lines = headerText.split('\n');
  let key = null;
  let val = '';

  const flush = () => {
    if (!key) return;
    const k = key.toLowerCase();
    // Keep first occurrence of most headers; ignore duplicate Received etc.
    if (!headers[k]) headers[k] = decodeHeaderValue(val.trim());
    key = null; val = '';
  };

  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && key) {
      // Continuation line
      val += ' ' + line.trim();
    } else {
      flush();
      const colon = line.indexOf(':');
      if (colon > 0) {
        key = line.slice(0, colon).trim();
        val = line.slice(colon + 1);
      }
    }
  }
  flush();
  return headers;
}

/**
 * Decode MIME encoded-words  →  =?charset?B|Q?text?=
 */
function decodeHeaderValue(value) {
  if (!value.includes('=?')) return value;
  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return b64Decode(text, charset);
      }
      // Quoted-Printable variant
      const raw = text.replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_m2, h) => String.fromCharCode(parseInt(h, 16)));
      return toUnicode(raw, charset);
    } catch { return _m; }
  });
}

function b64Decode(b64, charset) {
  const binary = atob(b64.replace(/\s/g, ''));
  return toUnicode(binary, charset);
}

function toUnicode(binary, charset) {
  try {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    try { return decodeURIComponent(escape(binary)); } catch { return binary; }
  }
}

/* ── MIME body parsing ── */

function extractBoundary(ct) {
  const m = ct.match(/boundary=["']?([^"';\s\r\n]+)["']?/i);
  return m ? m[1] : null;
}

function extractCharset(ct) {
  const m = ct.match(/charset=["']?([^"';\s\r\n]+)["']?/i);
  return m ? m[1] : 'utf-8';
}

function decodeTransferEncoding(body, enc) {
  const e = (enc || '7bit').toLowerCase().trim();
  if (e === 'quoted-printable') return decodeQP(body);
  if (e === 'base64') return decodeB64Body(body);
  return body;
}

function decodeQP(text) {
  return text
    .replace(/=\r?\n/g, '')                                    // soft line-break
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeB64Body(text) {
  try {
    const clean = text.replace(/\s+/g, '');
    return clean ? atob(clean) : '';
  } catch { return text; }
}

function applyCharset(binary, charset) {
  if (!charset) return binary;
  const lc = charset.toLowerCase();
  if (lc === 'us-ascii' || lc === 'ascii') return binary;
  try {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch { return binary; }
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recursively extract the plain-text from a MIME part.
 * Prefers text/plain; falls back to text/html.
 */
function extractBody(rawBody, contentType, transferEncoding) {
  const ct = (contentType || 'text/plain').toLowerCase();

  if (ct.startsWith('multipart/')) {
    const boundary = extractBoundary(contentType);
    return boundary ? extractMultipart(rawBody, boundary) : rawBody;
  }

  const decoded = decodeTransferEncoding(rawBody, transferEncoding);
  const charset  = extractCharset(contentType);
  const text     = applyCharset(decoded, charset);

  return ct.startsWith('text/html') ? stripHtml(text) : text;
}

function extractMultipart(body, boundary) {
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = body.split(new RegExp(`--${esc}`));

  let plainText = '';
  let htmlText  = '';

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '--') continue;

    const blankIdx = trimmed.indexOf('\n\n');
    if (blankIdx === -1) continue;

    const partHeaders = parseHeaders(trimmed.slice(0, blankIdx));
    const partBody    = trimmed.slice(blankIdx + 2).replace(/\r?\n?--$/, '');
    const partCT      = (partHeaders['content-type'] || 'text/plain').toLowerCase();
    const partCTE     = (partHeaders['content-transfer-encoding'] || '7bit');

    if (partCT.startsWith('text/plain') && !plainText) {
      const decoded  = decodeTransferEncoding(partBody, partCTE);
      const charset  = extractCharset(partHeaders['content-type'] || '');
      plainText = applyCharset(decoded, charset || 'utf-8');
    } else if (partCT.startsWith('text/html') && !htmlText) {
      const decoded  = decodeTransferEncoding(partBody, partCTE);
      const charset  = extractCharset(partHeaders['content-type'] || '');
      htmlText = stripHtml(applyCharset(decoded, charset || 'utf-8'));
    } else if (partCT.startsWith('multipart/')) {
      const nested = extractBoundary(partHeaders['content-type'] || '');
      if (nested && !plainText) {
        plainText = extractMultipart(partBody, nested);
      }
    }
  }

  return plainText || htmlText || '';
}

/**
 * Parse a single raw email string into a structured object.
 */
function parseEmail(rawEmail) {
  const blankIdx = rawEmail.indexOf('\n\n');
  const headerText = blankIdx === -1 ? rawEmail : rawEmail.slice(0, blankIdx);
  const rawBody    = blankIdx === -1 ? ''        : rawEmail.slice(blankIdx + 2);

  const headers = parseHeaders(headerText);
  const ct      = headers['content-type'] || 'text/plain';
  const cte     = headers['content-transfer-encoding'] || '7bit';

  const bodyRaw = extractBody(rawBody, ct, cte);
  const body    = bodyRaw
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    date:      headers['date']       || '',
    from:      headers['from']       || '',
    to:        headers['to']         || '',
    cc:        headers['cc']         || '',
    bcc:       headers['bcc']        || '',
    subject:   headers['subject']    || '',
    body,
    messageId: headers['message-id'] || '',
  };
}

/* ============================================================
   CSV GENERATOR
   ============================================================ */

function emailsToCSV(emails, columns) {
  const cols = columns || CSV_COLUMNS;
  const header = cols.map(c => csvEsc(c.label)).join(',');
  const rows   = emails.map(e => cols.map(c => csvEsc(e[c.key] ?? '')).join(','));
  // UTF-8 BOM ensures Excel opens it with correct encoding
  return '\uFEFF' + [header, ...rows].join('\n');
}

function csvEsc(val) {
  return '"' + String(val).replace(/"/g, '""') + '"';
}

/* ============================================================
   UI
   ============================================================ */

document.addEventListener('DOMContentLoaded', init);

function init() {
  document.getElementById('current-year').textContent = new Date().getFullYear();
  buildColumnCheckboxes();
  bindUploadZone();
  bindButtons();
}

/* ── Column checkboxes ── */
function buildColumnCheckboxes() {
  const container = document.getElementById('column-checkboxes');
  CSV_COLUMNS.forEach(col => {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    label.innerHTML = `<input type="checkbox" value="${col.key}" checked><span>${col.label}</span>`;
    container.appendChild(label);
  });
}

function getSelectedColumns() {
  const boxes = document.querySelectorAll('#column-checkboxes input[type="checkbox"]:checked');
  const keys  = new Set([...boxes].map(b => b.value));
  return CSV_COLUMNS.filter(c => keys.has(c.key));
}

/* ── Upload zone ── */
function bindUploadZone() {
  const zone      = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');

  browseBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
  zone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    fileInput.value = '';   // allow re-selecting same file
  });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
}

function bindButtons() {
  document.getElementById('clear-btn').addEventListener('click', resetUI);
  document.getElementById('retry-btn').addEventListener('click', resetUI);
  document.getElementById('convert-another-btn').addEventListener('click', resetUI);
  document.getElementById('download-btn').addEventListener('click', () => {
    const cols = getSelectedColumns();
    triggerDownload(emailsToCSV(state.emails, cols), csvFilename());
    flashButton(document.getElementById('download-btn'), 'Downloaded!');
  });
}

/* ── File handling ── */
function handleFile(file) {
  state.file = file;
  setFileBar(file);
  showEl('file-bar');
  showEl('column-selector');
  hideEl('error-section');
  hideEl('results-section');
  showEl('progress-section');
  updateProgress(0, 'Reading file…');
  setTimeout(() => processFile(file), 80);
}

async function processFile(file) {
  try {
    updateProgress(5, 'Reading file…');
    const text = await readAsText(file);

    updateProgress(20, 'Parsing MBOX…');
    await tick();

    const rawMsgs = parseMbox(text);
    const total   = rawMsgs.length;

    if (total === 0) {
      showError('No emails found. Please check that this is a valid MBOX file.');
      return;
    }

    updateProgress(30, `Found ${total.toLocaleString()} emails — converting…`);
    await tick();

    const emails    = [];
    const batchSize = 200;

    for (let i = 0; i < total; i += batchSize) {
      const slice = rawMsgs.slice(i, i + batchSize);
      for (const raw of slice) {
        try { emails.push(parseEmail(raw)); } catch { /* skip malformed */ }
      }
      const pct = 30 + Math.round(((i + slice.length) / total) * 65);
      updateProgress(pct, `Converted ${Math.min(i + batchSize, total).toLocaleString()} / ${total.toLocaleString()}…`);
      await tick();
    }

    state.emails = emails;
    updateProgress(100, 'Done!');
    await tick();

    renderResults(emails);
  } catch (err) {
    console.error(err);
    showError('Something went wrong while processing the file. Please try again.');
  }
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsText(file, 'utf-8');
  });
}

function tick() { return new Promise(r => setTimeout(r, 0)); }

/* ── Progress ── */
function updateProgress(pct, msg) {
  const bar   = document.getElementById('progress-bar');
  const track = document.getElementById('progress-bar-track');
  const text  = document.getElementById('progress-text');
  if (bar)   bar.style.width = pct + '%';
  if (track) track.setAttribute('aria-valuenow', pct);
  if (text)  text.textContent = msg || pct + '%';
}

/* ── Results ── */
function renderResults(emails) {
  hideEl('progress-section');
  showEl('results-section');

  document.getElementById('email-count').textContent = emails.length.toLocaleString();
  document.getElementById('email-count-label').textContent =
    emails.length === 1 ? 'email found' : 'emails found';

  renderPreview(emails.slice(0, 5));
}

function renderPreview(emails) {
  const container = document.getElementById('preview-table-container');
  if (!container) return;

  const cols = ['date', 'from', 'subject'];

  const table = document.createElement('table');
  table.className = 'preview-table';

  // Header
  const thead = table.createTHead();
  const hRow  = thead.insertRow();
  cols.forEach(key => {
    const th = document.createElement('th');
    th.textContent = CSV_COLUMNS.find(c => c.key === key)?.label || key;
    hRow.appendChild(th);
  });

  // Body
  const tbody = table.createTBody();
  emails.forEach(email => {
    const row = tbody.insertRow();
    cols.forEach(key => {
      const td = row.insertCell();
      td.textContent = trunc(email[key] || '—', 70);
    });
  });

  container.innerHTML = '';
  container.appendChild(table);
}

/* ── File bar ── */
function setFileBar(file) {
  document.getElementById('file-name').textContent = file.name;
  document.getElementById('file-size').textContent = fmtSize(file.size);
}

/* ── Error ── */
function showError(msg) {
  hideEl('progress-section');
  hideEl('results-section');
  document.getElementById('error-message').textContent = msg;
  showEl('error-section');
}

/* ── Reset ── */
function resetUI() {
  state.file   = null;
  state.emails = [];
  hideEl('file-bar');
  hideEl('column-selector');
  hideEl('progress-section');
  hideEl('results-section');
  hideEl('error-section');
  document.getElementById('preview-table-container').innerHTML = '';
  updateProgress(0, '');
}

/* ── Download ── */
function triggerDownload(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvFilename() {
  const base = state.file
    ? state.file.name.replace(/\.[^.]+$/, '')
    : 'emails';
  return base + '.csv';
}

function flashButton(btn, msg) {
  const orig = btn.innerHTML;
  btn.textContent = msg;
  btn.classList.add('success');
  setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('success'); }, 2200);
}

/* ── Helpers ── */
function showEl(id) { const el = document.getElementById(id); if (el) el.hidden = false; }
function hideEl(id) { const el = document.getElementById(id); if (el) el.hidden = true; }

function fmtSize(bytes) {
  if (bytes < 1024)             return bytes + ' B';
  if (bytes < 1024 ** 2)        return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3)        return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return                               (bytes / 1024 ** 3).toFixed(1) + ' GB';
}

function trunc(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}
