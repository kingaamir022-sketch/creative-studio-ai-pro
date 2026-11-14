'use strict';
// Sheets — a real spreadsheet project type (v2.5.0, item #21).
//
// NOT a table block: a real grid with a formula evaluator. Cells hold a
// raw value (number, string, boolean) or a formula string starting with
// '='. Supported functions: SUM, AVERAGE, COUNT, MIN, MAX, IF, plus cell
// references (A1, $A$1), ranges (A1:B3), arithmetic (+ - * / ^ %),
// parentheses and string literals. Errors are real spreadsheet errors
// (#DIV/0!, #REF!, #NAME?, #VALUE!, #CIRC!) — never silently blanked.
//
// A sheet is stored as a project of type 'sheet':
//   { version: 1, title, cols: 10, rows: 50,
//     cells: { "A1": { v: 12 } | { f: "=SUM(A1:A3)" } | { v: "text", fmt: {...} } },
//     colWidths: { A: 120 }, rowHeights: { 1: 28 } }
// Cell formatting: fmt: { bold, italic, underline, align, color, bg,
//   numFmt: 'general'|'currency'|'percent'|'date', fontSize }.
const XLSX = require('xlsx');

const MAX_ROWS = 10000;
const MAX_COLS = 100; // A..CV
const MAX_CELLS = 200000;

function colToNum(col) {
  let n = 0;
  for (const ch of String(col || '').toUpperCase()) {
    if (ch < 'A' || ch > 'Z') return -1;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}
function numToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function parseRef(ref) {
  const m = String(ref || '').trim().match(/^\$?([A-Za-z]{1,3})\$?([0-9]{1,5})$/);
  if (!m) return null;
  const col = colToNum(m[1]);
  const row = parseInt(m[2], 10);
  if (col < 1 || col > MAX_COLS || row < 1 || row > MAX_ROWS) return null;
  return { col, row, addr: `${numToCol(col)}${row}` };
}
function addrOf(col, row) { return `${numToCol(col)}${row}`; }

function blankSheet({ title = 'Untitled Sheet', cols = 10, rows = 50 } = {}) {
  return {
    version: 1, title: String(title).slice(0, 120),
    cols: Math.max(1, Math.min(MAX_COLS, parseInt(cols, 10) || 10)),
    rows: Math.max(1, Math.min(MAX_ROWS, parseInt(rows, 10) || 50)),
    cells: {}, colWidths: {}, rowHeights: {},
  };
}

function validateSheet(s) {
  const errors = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, errors: ['Sheet must be a JSON object.'] };
  if (s.version !== undefined && s.version !== 1) errors.push('Unsupported sheet version.');
  if (!isFinite(s.cols) || s.cols < 1 || s.cols > MAX_COLS) errors.push(`Sheet cols must be 1–${MAX_COLS}.`);
  if (!isFinite(s.rows) || s.rows < 1 || s.rows > MAX_ROWS) errors.push(`Sheet rows must be 1–${MAX_ROWS}.`);
  if (!s.cells || typeof s.cells !== 'object' || Array.isArray(s.cells)) errors.push('Sheet cells must be an object keyed by address (e.g. "A1").');
  else {
    const keys = Object.keys(s.cells);
    if (keys.length > MAX_CELLS) errors.push(`A sheet may hold at most ${MAX_CELLS} non-empty cells.`);
    for (const addr of keys) {
      const ref = parseRef(addr);
      if (!ref) { errors.push(`Bad cell address "${addr}".`); continue; }
      if (ref.col > s.cols || ref.row > s.rows) errors.push(`Cell ${addr} is outside the sheet (${s.cols} cols × ${s.rows} rows).`);
      const c = s.cells[addr];
      if (!c || typeof c !== 'object') { errors.push(`Cell ${addr} must be an object.`); continue; }
      if (c.f !== undefined && (typeof c.f !== 'string' || !c.f.startsWith('='))) errors.push(`Cell ${addr}: formula must be a string starting with '='.`);
      if (c.f !== undefined && c.f.length > 2000) errors.push(`Cell ${addr}: formula is too long (max 2000 characters).`);
      if (c.v !== undefined && !['string', 'number', 'boolean'].includes(typeof c.v)) errors.push(`Cell ${addr}: value must be a string, number or boolean.`);
      if (typeof c.v === 'string' && c.v.length > 10000) errors.push(`Cell ${addr}: text is too long (max 10000 characters).`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// --- Formula evaluator ------------------------------------------------------
// Tokeniser + recursive-descent parser. Values: numbers, strings, booleans,
// errors (thrown as {code} and caught per-cell). Ranges expand to arrays.
class FormulaError extends Error { constructor(code) { super(code); this.code = code; } }
function err(code) { return new FormulaError(code); }

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/);
      if (!m) throw err('#VALUE!');
      tokens.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw err('#VALUE!');
      tokens.push({ t: 'str', v: src.slice(i + 1, end) }); i = end + 1; continue;
    }
    if (ch === '$' || /[A-Za-z]/.test(ch)) {
      const m = src.slice(i).match(/^\$?[A-Za-z]{1,3}\$?[0-9]{1,5}(?![A-Za-z0-9])/);
      if (m) { tokens.push({ t: 'ref', v: m[0] }); i += m[0].length; continue; }
      const fn = src.slice(i).match(/^[A-Za-z][A-Za-z0-9_]*/);
      if (fn) { tokens.push({ t: 'name', v: fn[0].toUpperCase() }); i += fn[0].length; continue; }
      throw err('#NAME?');
    }
    if ('+-*/^%(),:<>='.includes(ch)) {
      // Two-char comparison operators.
      if ((ch === '<' || ch === '>') && src[i + 1] === '=') { tokens.push({ t: 'op', v: ch + '=' }); i += 2; continue; }
      if (ch === '<' && src[i + 1] === '>') { tokens.push({ t: 'op', v: '<>' }); i += 2; continue; }
      tokens.push({ t: 'op', v: ch }); i += 1; continue;
    }
    throw err('#VALUE!');
  }
  tokens.push({ t: 'eof' });
  return tokens;
}

function evaluateFormula(formula, getCellValue) {
  // getCellValue(addr) -> { value, error } for a referenced cell (already
  // evaluated, with cycle detection handled by the caller via a marker).
  const src = String(formula).slice(1); // drop '='
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expectOp = (v) => { const tk = next(); if (tk.t !== 'op' || tk.v !== v) throw err('#VALUE!'); };

  function parseExpr() { return parseCompare(); }
  function parseCompare() {
    let left = parseAdd();
    for (;;) {
      const tk = peek();
      if (tk.t === 'op' && ['=', '<', '>', '<=', '>=', '<>'].includes(tk.v)) {
        next();
        const right = parseAdd();
        left = compareValues(left, right, tk.v);
      } else return left;
    }
  }
  function parseAdd() {
    let left = parseMul();
    for (;;) {
      const tk = peek();
      if (tk.t === 'op' && (tk.v === '+' || tk.v === '-')) { next(); const r = parseMul(); left = applyOp(left, r, tk.v); }
      else return left;
    }
  }
  function parseMul() {
    let left = parsePow();
    for (;;) {
      const tk = peek();
      if (tk.t === 'op' && (tk.v === '*' || tk.v === '/')) { next(); const r = parsePow(); left = applyOp(left, r, tk.v); }
      else return left;
    }
  }
  function parsePow() {
    let base = parseUnary();
    const tk = peek();
    if (tk.t === 'op' && tk.v === '^') { next(); const exp = parsePow(); return applyOp(base, exp, '^'); }
    return base;
  }
  function parseUnary() {
    const tk = peek();
    if (tk.t === 'op' && tk.v === '-') { next(); return applyOp(0, parseUnary(), '-'); }
    if (tk.t === 'op' && tk.v === '+') { next(); return parseUnary(); }
    return parsePostfix(parsePrimary());
  }
  function parsePostfix(v) {
    const tk = peek();
    if (tk.t === 'op' && tk.v === '%') { next(); return toNumber(v) / 100; }
    return v;
  }
  function parsePrimary() {
    const tk = next();
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'str') return tk.v;
    if (tk.t === 'ref') {
      // A range: A1:B3 — only valid as a function argument; here a bare
      // range is an error (use it inside SUM/AVERAGE/...).
      if (peek().t === 'op' && peek().v === ':') {
        next();
        const end = next();
        if (end.t !== 'ref') throw err('#REF!');
        return rangeValues(tk.v, end.v);
      }
      const ref = parseRef(tk.v);
      if (!ref) throw err('#REF!');
      const got = getCellValue(ref.addr);
      if (got.error) throw err(got.error);
      return got.value === undefined || got.value === null || got.value === '' ? 0 : got.value;
    }
    if (tk.t === 'name') {
      if (tk.v === 'TRUE') return true;
      if (tk.v === 'FALSE') return false;
      if (peek().t === 'op' && peek().v === '(') {
        next();
        const args = [];
        if (!(peek().t === 'op' && peek().v === ')')) {
          for (;;) {
            args.push(parseExpr());
            if (peek().t === 'op' && peek().v === ',') { next(); continue; }
            break;
          }
        }
        expectOp(')');
        return callFunction(tk.v, args);
      }
      throw err('#NAME?');
    }
    if (tk.t === 'op' && tk.v === '(') {
      const v = parseExpr();
      expectOp(')');
      return v;
    }
    throw err('#VALUE!');
  }
  function rangeValues(a, b) {
    const ra = parseRef(a), rb = parseRef(b);
    if (!ra || !rb) throw err('#REF!');
    const vals = [];
    for (let r = Math.min(ra.row, rb.row); r <= Math.max(ra.row, rb.row); r++) {
      for (let c = Math.min(ra.col, rb.col); c <= Math.max(ra.col, rb.col); c++) {
        const got = getCellValue(addrOf(c, r));
        if (got.error) throw err(got.error);
        vals.push(got.value);
      }
    }
    return vals;
  }
  function flatNums(args) {
    const out = [];
    for (const a of args) {
      if (Array.isArray(a)) for (const v of a) { if (typeof v === 'number') out.push(v); }
      else if (typeof a === 'number') out.push(a);
      else if (typeof a === 'boolean') out.push(a ? 1 : 0);
      else if (typeof a === 'string' && a !== '' && !Number.isNaN(Number(a))) out.push(Number(a));
    }
    return out;
  }
  function callFunction(name, args) {
    switch (name) {
      case 'SUM': return flatNums(args).reduce((s, v) => s + v, 0);
      case 'AVERAGE': { const ns = flatNums(args); if (!ns.length) throw err('#DIV/0!'); return ns.reduce((s, v) => s + v, 0) / ns.length; }
      case 'COUNT': return flatNums(args).length;
      case 'MIN': { const ns = flatNums(args); if (!ns.length) throw err('#VALUE!'); return Math.min(...ns); }
      case 'MAX': { const ns = flatNums(args); if (!ns.length) throw err('#VALUE!'); return Math.max(...ns); }
      case 'IF': {
        if (args.length < 2 || args.length > 3) throw err('#VALUE!');
        return truthy(args[0]) ? args[1] : (args.length === 3 ? args[2] : false);
      }
      case 'ABS': { if (args.length !== 1) throw err('#VALUE!'); return Math.abs(toNumber(args[0])); }
      case 'ROUND': { if (args.length < 1 || args.length > 2) throw err('#VALUE!'); const p = args.length === 2 ? Math.trunc(toNumber(args[1])) : 0; const f = 10 ** p; return Math.round(toNumber(args[0]) * f) / f; }
      case 'CONCAT': case 'CONCATENATE': return args.map((a) => String(a ?? '')).join('');
      case 'LEN': { if (args.length !== 1) throw err('#VALUE!'); return String(args[0] ?? '').length; }
      case 'UPPER': return String(args[0] ?? '').toUpperCase();
      case 'LOWER': return String(args[0] ?? '').toLowerCase();
      default: throw err('#NAME?');
    }
  }
  function truthy(v) { return v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== ''); }
  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    throw err('#VALUE!');
  }
  function compareValues(a, b, op) {
    if (typeof a === 'string' || typeof b === 'string') {
      const x = String(a ?? ''), y = String(b ?? '');
      if (op === '=') return x === y;
      if (op === '<>') return x !== y;
      if (op === '<') return x < y;
      if (op === '>') return x > y;
      if (op === '<=') return x <= y;
      return x >= y;
    }
    const x = toNumber(a), y = toNumber(b);
    if (op === '=') return x === y;
    if (op === '<>') return x !== y;
    if (op === '<') return x < y;
    if (op === '>') return x > y;
    if (op === '<=') return x <= y;
    return x >= y;
  }
  function applyOp(a, b, op) {
    if (op === '+') return toNumber(a) + toNumber(b);
    if (op === '-') return toNumber(a) - toNumber(b);
    if (op === '*') return toNumber(a) * toNumber(b);
    if (op === '/') { const d = toNumber(b); if (d === 0) throw err('#DIV/0!'); return toNumber(a) / d; }
    if (op === '^') return toNumber(a) ** toNumber(b);
    throw err('#VALUE!');
  }
  const value = parseExpr();
  if (peek().t !== 'eof') throw err('#VALUE!');
  return value;
}

// Evaluate every cell in a sheet. Returns { values: {addr: value},
// errors: {addr: '#DIV/0!'...} }. Formula cells that reference each other
// in a cycle report #CIRC! instead of recursing forever.
function evaluateSheet(sheet) {
  const values = {};
  const errors = {};
  const state = {}; // addr -> 'visiting' | 'done'
  const cells = (sheet && sheet.cells) || {};
  function evalCell(addr) {
    if (state[addr] === 'done') return { value: values[addr], error: errors[addr] || null };
    if (state[addr] === 'visiting') return { value: null, error: '#CIRC!' };
    const cell = cells[addr];
    if (!cell) return { value: null, error: null };
    state[addr] = 'visiting';
    try {
      if (typeof cell.f === 'string') {
        const v = evaluateFormula(cell.f, (ref) => evalCell(ref));
        values[addr] = v;
      } else {
        values[addr] = cell.v === undefined ? null : cell.v;
      }
    } catch (e) {
      errors[addr] = e && e.code ? e.code : '#VALUE!';
      values[addr] = null;
    }
    state[addr] = 'done';
    return { value: values[addr], error: errors[addr] || null };
  }
  for (const addr of Object.keys(cells)) evalCell(addr);
  return { values, errors };
}

// Rows as a data source for bulk jobs: every row becomes an object keyed
// by the header row (row 1). Empty rows are skipped. `headerRow` is 1-based.
function sheetRows(sheet, { headerRow = 1 } = {}) {
  const { values } = evaluateSheet(sheet);
  const headers = [];
  for (let c = 1; c <= sheet.cols; c++) {
    const v = values[addrOf(c, headerRow)];
    headers.push(v === null || v === undefined || v === '' ? `Column ${numToCol(c)}` : String(v));
  }
  const rows = [];
  for (let r = headerRow + 1; r <= sheet.rows; r++) {
    const row = {};
    let any = false;
    headers.forEach((h, i) => {
      const v = values[addrOf(i + 1, r)];
      row[h] = v === null || v === undefined ? '' : v;
      if (v !== null && v !== undefined && v !== '') any = true;
    });
    if (any) rows.push(row);
  }
  return { headers, rows };
}

// --- CSV ----------------------------------------------------------------------
function sheetToCsv(sheet) {
  const { values, errors } = evaluateSheet(sheet);
  const lines = [];
  for (let r = 1; r <= sheet.rows; r++) {
    const cells = [];
    let any = false;
    for (let c = 1; c <= sheet.cols; c++) {
      const addr = addrOf(c, r);
      const v = errors[addr] || values[addr];
      if (v !== null && v !== undefined && v !== '') any = true;
      const s = v === null || v === undefined ? '' : String(v);
      cells.push(/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    }
    if (!any && r > 1) {
      // Trailing empty rows are dropped; interior empties are kept so row
      // numbers stay aligned with the grid.
      const restEmpty = (() => {
        for (let rr = r + 1; rr <= sheet.rows; rr++) {
          for (let cc = 1; cc <= sheet.cols; cc++) {
            const a = addrOf(cc, rr);
            if (values[a] !== null && values[a] !== undefined && values[a] !== '') return false;
          }
        }
        return true;
      })();
      if (restEmpty) break;
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function csvToSheet(csvText, { title = 'Imported Sheet' } = {}) {
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('CSV is empty.');
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV has no rows.');
  const cols = Math.max(1, Math.min(MAX_COLS, Math.max(...rows.map((r) => r.length))));
  const sheetRowsCount = Math.min(MAX_ROWS, rows.length);
  const sheet = blankSheet({ title, cols, rows: sheetRowsCount });
  rows.slice(0, sheetRowsCount).forEach((row, ri) => {
    row.slice(0, cols).forEach((val, ci) => {
      if (val === '' || val === null || val === undefined) return;
      const num = Number(val);
      sheet.cells[addrOf(ci + 1, ri + 1)] = { v: (typeof val === 'string' && val.trim() !== '' && !Number.isNaN(num)) ? num : val };
    });
  });
  return sheet;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  row.push(field);
  rows.push(row);
  // Drop a final empty row from a trailing newline.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

// --- XLSX ---------------------------------------------------------------------
function sheetToXlsx(sheet) {
  const { values, errors } = evaluateSheet(sheet);
  const aoa = [];
  for (let r = 1; r <= sheet.rows; r++) {
    const row = [];
    let any = false;
    for (let c = 1; c <= sheet.cols; c++) {
      const addr = addrOf(c, r);
      const cell = (sheet.cells || {})[addr];
      const v = errors[addr] || values[addr];
      if (v !== null && v !== undefined && v !== '') any = true;
      // Keep the formula in the file (Excel recalculates it); the cached
      // value is what other readers show.
      if (cell && typeof cell.f === 'string') row.push({ f: cell.f.slice(1), v: typeof v === 'number' ? v : undefined });
      else row.push(v === null || v === undefined ? null : v);
    }
    if (!any) {
      let restEmpty = true;
      for (let rr = r + 1; rr <= sheet.rows && restEmpty; rr++) {
        for (let cc = 1; cc <= sheet.cols; cc++) {
          const a = addrOf(cc, rr);
          if (values[a] !== null && values[a] !== undefined && values[a] !== '') { restEmpty = false; break; }
        }
      }
      if (restEmpty) break;
    }
    aoa.push(row);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [[]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(sheet.title || 'Sheet').slice(0, 31) || 'Sheet');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function xlsxToSheet(buffer, { title = 'Imported Sheet' } = {}) {
  if (!buffer || !buffer.length) throw new Error('XLSX file is empty.');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('XLSX has no sheets.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const rows = aoa.filter((r) => Array.isArray(r) && r.some((v) => v !== null && v !== undefined && v !== ''));
  if (!rows.length) throw new Error('XLSX sheet is empty.');
  const cols = Math.max(1, Math.min(MAX_COLS, Math.max(...rows.map((r) => r.length))));
  const sheet = blankSheet({ title, cols, rows: Math.min(MAX_ROWS, rows.length) });
  rows.slice(0, sheet.rows).forEach((row, ri) => {
    row.slice(0, cols).forEach((val, ci) => {
      if (val === null || val === undefined || val === '') return;
      // Preserve a stored formula (cell.f) instead of only its cached value.
      const addr = addrOf(ci + 1, ri + 1);
      const wsCell = ws[addr];
      if (wsCell && typeof wsCell.f === 'string' && wsCell.f) {
        sheet.cells[addr] = { f: `=${wsCell.f}` };
        return;
      }
      sheet.cells[addr] = { v: val };
    });
  });
  return sheet;
}

module.exports = {
  MAX_ROWS, MAX_COLS,
  colToNum, numToCol, parseRef, addrOf,
  blankSheet, validateSheet,
  evaluateFormula, evaluateSheet, sheetRows,
  sheetToCsv, csvToSheet, parseCsv,
  sheetToXlsx, xlsxToSheet,
};
