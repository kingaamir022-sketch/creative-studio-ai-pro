'use strict';
// Minimal PDF 1.4 writer (v2.2.3, Docs & Slides).
// Writes raster pages: each page is one JPEG image drawn to fill the page,
// plus optional vector overlays (lines / rectangles) used for print crop
// marks and safe-zone guides. No dependency, no font embedding — text lives
// inside the rendered images, so what the user sees in the preview is
// exactly what lands in the PDF (the never-overflow rule is enforced by the
// renderer that produced the images, not by this writer).
//
// PDF coordinates: points, origin at the BOTTOM-LEFT of the page.
const fs = require('fs');
const { spawn } = require('child_process');
const { probeMedia } = require('./ffmpeg');

function pdfEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function colorOps(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}
function fmt(n) { return String(Math.round(n * 1000) / 1000); }

// Convert a PNG to a JPEG with FFmpeg (PDF embeds JPEGs directly).
// Returns { width, height } of the image.
async function pngToJpeg(pngPath, jpegPath, quality = 3) {
  if (!fs.existsSync(pngPath)) throw new Error(`PNG not found: ${pngPath}`);
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-v', 'error', '-i', pngPath, '-q:v', String(quality), jpegPath],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`PNG→JPEG failed (code ${code}): ${errText.slice(-400)}`))));
  });
  const info = await probeMedia(jpegPath);
  if (!info || !info.width) throw new Error('JPEG conversion produced no readable image.');
  return { width: info.width, height: info.height };
}

// pages: [{ jpegPath, widthPt, heightPt, title?, vector?: {
//   lines: [{x1,y1,x2,y2,color,width}], rects: [{x,y,w,h,color,width}] } }]
// Returns { pages, bytes }.
function writeImagePdf(pages, outPath) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('At least one PDF page is required.');
  const objects = []; // 1-based: objects[i] is the raw body of object (i+1)
  const add = (body) => { objects.push(body); return objects.length; };
  // Reserve ids: 1 = catalog, 2 = pages tree. Page objects start at 3.
  const catalogId = add(''); // 1
  const pagesId = add(''); // 2
  const pageIds = [];
  for (const p of pages) {
    if (!p.jpegPath || !fs.existsSync(p.jpegPath)) throw new Error(`PDF page image not found: ${p.jpegPath}`);
    if (!p.widthPt || !p.heightPt || p.widthPt < 36 || p.heightPt < 36) throw new Error('PDF page size must be at least 36pt.');
    const jpeg = fs.readFileSync(p.jpegPath);
    if (!p.imgWidth || !p.imgHeight) throw new Error('PDF page needs imgWidth/imgHeight (JPEG pixel size — pngToJpeg returns them).');
    // Placeholder: the real image object (with the binary JPEG stream) is
    // attached below, after the content/page objects are created.
    const imgId = add('');
    const content = [];
    content.push('q');
    content.push(`${fmt(p.widthPt)} 0 0 ${fmt(p.heightPt)} 0 0 cm /Im${imgId} Do`);
    content.push('Q');
    const vec = p.vector || {};
    for (const ln of vec.lines || []) {
      content.push(`${colorOps(ln.color)} RG ${fmt(ln.width || 0.5)} w ${fmt(ln.x1)} ${fmt(ln.y1)} m ${fmt(ln.x2)} ${fmt(ln.y2)} l S`);
    }
    for (const rc of vec.rects || []) {
      content.push(`${colorOps(rc.color)} RG ${fmt(rc.width || 0.75)} w ${fmt(rc.x)} ${fmt(rc.y)} ${fmt(rc.w)} ${fmt(rc.h)} re S`);
    }
    const streamText = content.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(streamText)} >>\nstream\n${streamText}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(p.widthPt)} ${fmt(p.heightPt)}] /Resources << /XObject << /Im${imgId} ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
    // Attach the JPEG bytes to the image object (binary-safe).
    objects[imgId - 1] = {
      header: `<< /Type /XObject /Subtype /Image /Width ${Math.round(p.imgWidth || 0)} /Height ${Math.round(p.imgHeight || 0)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      binary: jpeg,
      footer: '\nendstream',
    };
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // Serialise with a real xref table (byte offsets).
  const chunks = [];
  let offset = 0;
  const push = (buf) => { chunks.push(buf); offset += buf.length; };
  push(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  const offsets = [0]; // object 0 (free)
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    const obj = objects[i];
    push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    if (typeof obj === 'string') {
      push(Buffer.from(obj + '\nendobj\n', 'latin1'));
    } else {
      push(Buffer.from(obj.header, 'latin1'));
      push(obj.binary);
      push(Buffer.from(obj.footer + '\nendobj\n', 'latin1'));
    }
  }
  const xrefPos = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  push(Buffer.from(xref, 'latin1'));
  const pdf = Buffer.concat(chunks);
  fs.writeFileSync(outPath, pdf);
  return { pages: pages.length, bytes: pdf.length };
}

module.exports = { writeImagePdf, pngToJpeg, pdfEscape };
