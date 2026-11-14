'use strict';
// Sheets frontend (v2.5.0, item #21) — real spreadsheet project type.
//
// initSheets(container) renders the Sheets studio: list + create + import
// (CSV/XLSX) + an editable grid backed by /api/sheets. Cells hold a raw
// value or a formula (=SUM(A1:A3), =AVERAGE, =COUNT, =MIN, =MAX, =IF …);
// the server evaluates formulas and returns values + errors (#DIV/0!,
// #REF!, #CIRC! …), so the grid never silently blanks a bad formula.
// A sheet's rows are also a bulk-job data source: GET /api/sheets/:id/rows
// returns { headers, rows } keyed by the header row.
//
// WIRING (parent/app): load this file with <script src="/sheets.js"> and
// call Sheets.initSheets(container) (or window.initSheets(container))
// from the app's Sheets view. The API mount is /api/sheets.
(function () {
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  async function api(p, opts) {
    const res = await fetch(p, { credentials: 'same-origin', ...(opts || {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new Error((json && json.error) || `Request failed (${res.status})`);
    return json;
  }
  function toast(msg, isErr) {
    if (window.toast) return window.toast(msg, isErr);
    // Fallback when the app helper is absent.
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:${isErr ? '#b91c1c' : '#16a34a'};color:#fff;padding:10px 16px;border-radius:8px;z-index:9999`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  async function initSheets(container) {
    if (!container) throw new Error('initSheets needs a container element.');
    let sheets = [];
    let current = null; // { sheet: {...full sheet incl. values/errors} }
    let selected = null; // { addr }

    async function loadList() {
      const r = await api('/api/sheets').catch(() => ({ sheets: [] }));
      sheets = r.sheets || [];
    }

    function cellDisplay(addr) {
      if (!current) return '';
      const s = current.sheet;
      const err = s.errors && s.errors[addr];
      if (err) return err;
      const v = s.values ? s.values[addr] : undefined;
      return v === null || v === undefined ? '' : String(v);
    }
    function cellRaw(addr) {
      if (!current) return '';
      const c = (current.sheet.content.cells || {})[addr];
      if (!c) return '';
      if (typeof c.f === 'string') return c.f;
      return c.v === undefined || c.v === null ? '' : String(c.v);
    }
    function fmtCell(addr) {
      const c = ((current.sheet.content.cells || {})[addr] || {}).fmt || {};
      const parts = [];
      if (c.bold) parts.push('font-weight:700');
      if (c.italic) parts.push('font-style:italic');
      if (c.underline) parts.push('text-decoration:underline');
      if (c.align) parts.push(`text-align:${c.align}`);
      if (c.color) parts.push(`color:${c.color}`);
      if (c.bg) parts.push(`background:${c.bg}`);
      if (c.fontSize) parts.push(`font-size:${c.fontSize}px`);
      return parts.join(';');
    }

    function render() {
      const listHtml = sheets.length
        ? sheets.map((s) => `<div class="sh-sheet ${current && current.sheet.id === s.id ? 'active' : ''}" data-open="${s.id}">
            <b>${esc(s.name)}</b><span class="muted">${s.cols} cols × ${s.rows} rows · ${s.cells} cells</span></div>`).join('')
        : '<p class="muted">No sheets yet — create one or import a CSV/XLSX file.</p>';
      container.innerHTML = `<div class="page-head"><div><h2>📊 Sheets</h2>
        <p class="muted">Real spreadsheets — a grid with formulas (=SUM, =AVERAGE, =COUNT, =MIN, =MAX, =IF, cell refs &amp; ranges), formatting, CSV/XLSX import &amp; export. Not a table block. A sheet's rows can feed a Bulk Video / Bulk Design job as its data source.</p></div></div>
      <div class="sh-wrap">
        <div class="card sh-list">
          <h3>Your sheets</h3>${listHtml}
          <div style="margin-top:12px"><label class="muted">New sheet</label>
            <input id="sh-new-name" class="input" placeholder="Sheet name" value="Untitled Sheet">
            <div style="display:flex;gap:6px;margin-top:6px">
              <label class="muted">Cols <input id="sh-new-cols" class="input" type="number" min="1" max="100" value="10" style="width:64px"></label>
              <label class="muted">Rows <input id="sh-new-rows" class="input" type="number" min="1" max="10000" value="50" style="width:72px"></label>
            </div>
            <button class="btn btn-primary" id="sh-create" style="margin-top:8px">Create sheet</button></div>
          <div style="margin-top:12px"><label class="muted">Import CSV / XLSX</label>
            <input id="sh-import-file" type="file" accept=".csv,.xlsx" class="input">
            <button class="btn" id="sh-import" style="margin-top:8px">Import file → new sheet</button></div>
        </div>
        <div class="card sh-main" id="sh-main"><p class="muted">Pick a sheet to open its grid.</p></div>
      </div>`;
      container.querySelector('#sh-create').addEventListener('click', async () => {
        const name = container.querySelector('#sh-new-name').value.trim() || 'Untitled Sheet';
        const cols = +container.querySelector('#sh-new-cols').value || 10;
        const rows = +container.querySelector('#sh-new-rows').value || 50;
        try {
          const r = await api('/api/sheets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, cols, rows }) });
          toast('Sheet created.');
          await loadList();
          render();
          openSheet(r.sheet.id);
        } catch (e) { toast(e.message, true); }
      });
      container.querySelector('#sh-import').addEventListener('click', async () => {
        const file = container.querySelector('#sh-import-file').files[0];
        if (!file) { toast('Pick a CSV or XLSX file first.', true); return; }
        const fd = new FormData();
        fd.append('file', file);
        try {
          const r = await api('/api/sheets/import', { method: 'POST', body: fd });
          toast(`Imported “${r.sheet.name}”.`);
          await loadList();
          render();
          openSheet(r.sheet.id);
        } catch (e) { toast(e.message, true); }
      });
      container.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openSheet(+el.dataset.open)));
      if (current) renderGrid();
    }

    async function openSheet(id) {
      try {
        const r = await api(`/api/sheets/${id}`);
        current = r;
        selected = null;
        render();
      } catch (e) { toast(e.message, true); }
    }

    function renderGrid() {
      const main = container.querySelector('#sh-main');
      if (!main || !current) return;
      const s = current.sheet;
      const content = s.content || {};
      const cols = content.cols || 10;
      const totalRows = content.rows || 50;
      const showRows = Math.min(totalRows, 100);
      const showCols = Math.min(cols, 26);
      const errCount = Object.keys(s.errors || {}).length;
      let head = '<th class="sh-corner"></th>';
      for (let c = 1; c <= showCols; c++) head += `<th>${colName(c)}</th>`;
      let body = '';
      for (let r = 1; r <= showRows; r++) {
        body += `<tr><th>${r}</th>`;
        for (let c = 1; c <= showCols; c++) {
          const addr = `${colName(c)}${r}`;
          const err = s.errors && s.errors[addr];
          body += `<td class="sh-cell ${err ? 'sh-err' : ''} ${selected && selected.addr === addr ? 'sh-sel' : ''}" data-addr="${addr}" style="${fmtCell(addr)}" title="${esc(cellRaw(addr) || '')}">${esc(cellDisplay(addr))}</td>`;
        }
        body += '</tr>';
      }
      main.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <h3 style="margin:0">${esc(s.name)}</h3>
          <span class="muted">${cols} cols × ${totalRows} rows · ${Object.keys(content.cells || {}).length} cells${errCount ? ` · ⚠️ ${errCount} formula error${errCount === 1 ? '' : 's'}` : ''}</span>
          <span style="flex:1"></span>
          <a class="btn btn-sm" href="/api/sheets/${s.id}/export/csv">⬇ CSV</a>
          <a class="btn btn-sm" href="/api/sheets/${s.id}/export/xlsx">⬇ XLSX</a>
          <button class="btn btn-sm" id="sh-rows">⇢ Bulk data source</button>
        </div>
        <div class="sh-formula"><label>fx</label><input id="sh-formula" class="input" placeholder="Select a cell, then type a value or a formula (=SUM(A1:A3))" value="${selected ? esc(cellRaw(selected.addr)) : ''}"></div>
        <div class="sh-gridwrap"><table class="sh-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
        ${totalRows > showRows || cols > showCols ? `<p class="muted" style="font-size:12px">Showing the first ${showRows} rows × ${showCols} columns — the full sheet is kept on the server and in exports.</p>` : ''}
        <div id="sh-rows-out" style="margin-top:10px"></div>
        <p class="muted" style="font-size:12px">Click a cell to edit it. Formulas start with <b>=</b> — try <b>=SUM(A1:A3)</b>, <b>=AVERAGE(B1:B5)</b>, <b>=IF(A1&gt;10,"big","small")</b>. Errors show as real spreadsheet errors (#DIV/0!, #REF!, #CIRC!), never silently blanked.</p>`;
      main.querySelectorAll('.sh-cell').forEach((td) => td.addEventListener('click', () => {
        selected = { addr: td.dataset.addr };
        renderGrid();
        const fx = main.querySelector('#sh-formula');
        if (fx) { fx.focus(); fx.select(); }
      }));
      const fx = main.querySelector('#sh-formula');
      fx.addEventListener('change', async () => {
        if (!selected) { toast('Click a cell first.', true); return; }
        const raw = fx.value;
        await saveCell(selected.addr, raw);
      });
      main.querySelector('#sh-rows').addEventListener('click', async () => {
        const out = main.querySelector('#sh-rows-out');
        out.innerHTML = '<p class="muted">Loading rows…</p>';
        try {
          const r = await api(`/api/sheets/${s.id}/rows`);
          out.innerHTML = `<div class="alert ok">✓ ${r.rowCount} data row${r.rowCount === 1 ? '' : 's'} under headers: ${esc(r.headers.join(', '))}. Use <code>GET /api/sheets/${s.id}/rows</code> as a Bulk Video / Bulk Design data source.</div>
            <pre style="white-space:pre-wrap;max-height:220px;overflow:auto;background:var(--surface-raised);padding:10px;border-radius:8px">${esc(JSON.stringify(r.rows.slice(0, 5), null, 2))}${r.rows.length > 5 ? '\n…' : ''}</pre>`;
        } catch (e) { out.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
      });
    }

    async function saveCell(addr, raw) {
      const cell = raw === '' ? null : (String(raw).startsWith('=') ? { f: String(raw) } : parseCellValue(raw));
      try {
        const r = await api(`/api/sheets/${current.sheet.id}/cells`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cells: { [addr]: cell } }) });
        current = r;
        renderGrid();
      } catch (e) { toast(e.message, true); }
    }
    function parseCellValue(raw) {
      const t = String(raw).trim();
      if (t === 'TRUE') return { v: true };
      if (t === 'FALSE') return { v: false };
      const n = Number(t);
      if (t !== '' && !Number.isNaN(n)) return { v: n };
      return { v: raw };
    }

    await loadList();
    render();
    return { refresh: async () => { await loadList(); render(); } };
  }

  window.Sheets = { initSheets };
  window.initSheets = initSheets;
})();
