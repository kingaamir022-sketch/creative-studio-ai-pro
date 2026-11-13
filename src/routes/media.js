'use strict';
// Media Library routes: upload (real files on disk), list/search/filter,
// preview/stream with ownership check, tags, favorite, folders, delete.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { probeMedia, makeThumbnail } = require('../ffmpeg');

const router = express.Router();

const ALLOWED = [
  { prefix: 'image/', kind: 'image' },
  { prefix: 'video/', kind: 'video' },
  { prefix: 'audio/', kind: 'audio' },
];

function kindFor(mime) {
  for (const a of ALLOWED) if (mime.startsWith(a.prefix)) return a.kind;
  return null;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(config.uploadsDir, String(req.user.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (kindFor(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type "${file.mimetype}". Only images, videos and audio are allowed.`));
  },
});

router.get('/', auth.requireAuth, (req, res) => {
  const { search = '', kind = '', folderId = '', favorite = '', tag = '' } = req.query;
  const items = db.listMedia(req.user.id, {
    search, kind, folderId: folderId || null, favorite: favorite === '1', tag,
  });
  res.json({ media: items.map(publicMedia) });
});

router.post('/upload', auth.requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than the ${config.maxUploadMB} MB limit.`
        : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded. Choose an image, video or audio file.' });
    const tags = typeof req.body.tags === 'string' ? req.body.tags.trim().slice(0, 500) : '';
    const folderId = req.body.folderId ? parseInt(req.body.folderId, 10) : null;
    const m = db.createMedia(req.user.id, {
      folderId: Number.isFinite(folderId) ? folderId : null,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      mimeType: req.file.mimetype,
      kind: kindFor(req.file.mimetype),
      sizeBytes: req.file.size,
      tags,
    });
    db.audit(req.user.id, 'media_upload', 'media', m.id, `Uploaded "${m.original_name}" (${formatBytes(m.size_bytes)})`);
    // Phase 3: probe video/audio in the background (real duration, size,
    // fps, codec) and make a thumbnail for videos. The upload response
    // does not wait for it; the library shows the data once it lands.
    if (m.kind === 'video' || m.kind === 'audio') {
      const filePath = path.join(config.uploadsDir, String(req.user.id), m.stored_name);
      setImmediate(async () => {
        try {
          const probe = await probeMedia(filePath);
          if (!probe) return;
          let thumbName = null;
          if (m.kind === 'video' && probe.hasVideo) {
            thumbName = `${m.stored_name}.thumb.jpg`;
            try {
              await makeThumbnail(filePath, path.join(config.uploadsDir, String(req.user.id), thumbName), probe.durationSeconds);
            } catch { thumbName = null; }
          }
          db.updateMedia(req.user.id, m.id, {
            width: probe.width, height: probe.height, durationSeconds: probe.durationSeconds,
            fps: probe.fps, codec: probe.codec, thumbnail: thumbName,
          });
        } catch { /* probe failure leaves the row as-is; render re-probes */ }
      });
    }
    res.status(201).json({ media: publicMedia(m) });
  });
});

router.get('/:id/file', auth.requireAuth, (req, res) => {
  const m = db.getMedia(req.user.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Media not found.' });
  const filePath = path.join(config.uploadsDir, String(req.user.id), m.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Stored file is missing on disk.' });
  res.type(m.mime_type);
  // Support byte ranges so video/audio preview seeks work.
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      res.status(206);
      res.set({ 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }
  res.set({ 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(filePath).pipe(res);
});

router.get('/:id/thumbnail', auth.requireAuth, (req, res) => {
  const m = db.getMedia(req.user.id, req.params.id);
  if (!m || !m.thumbnail) return res.status(404).json({ error: 'No thumbnail for this media.' });
  const filePath = path.join(config.uploadsDir, String(req.user.id), m.thumbnail);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Thumbnail file is missing on disk.' });
  res.type('image/jpeg');
  fs.createReadStream(filePath).pipe(res);
});

router.patch('/:id', auth.requireAuth, (req, res) => {
  const { tags, favorite, folderId, licenseNote } = req.body || {};
  if (tags !== undefined && (typeof tags !== 'string' || tags.length > 500)) {
    return res.status(400).json({ error: 'Tags must be a string of at most 500 characters.' });
  }
  if (licenseNote !== undefined && (typeof licenseNote !== 'string' || licenseNote.length > 300)) {
    return res.status(400).json({ error: 'License note must be a string of at most 300 characters.' });
  }
  const m = db.updateMedia(req.user.id, req.params.id, {
    tags, favorite, folderId: folderId === undefined ? undefined : (folderId ? parseInt(folderId, 10) : null),
    licenseNote,
  });
  if (!m) return res.status(404).json({ error: 'Media not found.' });
  res.json({ media: publicMedia(m) });
});

router.delete('/:id', auth.requireAuth, (req, res) => {
  const m = db.getMedia(req.user.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Media not found.' });
  const filePath = path.join(config.uploadsDir, String(req.user.id), m.stored_name);
  if (!db.deleteMedia(req.user.id, req.params.id)) return res.status(404).json({ error: 'Media not found.' });
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* file already gone */ }
  if (m.thumbnail) {
    try { const tp = path.join(config.uploadsDir, String(req.user.id), m.thumbnail); if (fs.existsSync(tp)) fs.unlinkSync(tp); } catch { /* ignore */ }
  }
  db.audit(req.user.id, 'media_delete', 'media', m.id, `Deleted "${m.original_name}"`);
  res.json({ ok: true });
});

// Media folders
router.get('/folders/list', auth.requireAuth, (req, res) => {
  res.json({ folders: db.listFolders(req.user.id, 'media') });
});
router.post('/folders', auth.requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required.' });
  res.status(201).json({ folder: db.createFolder(req.user.id, String(name).trim(), 'media') });
});
router.delete('/folders/:id', auth.requireAuth, (req, res) => {
  if (!db.deleteFolder(req.user.id, req.params.id)) return res.status(404).json({ error: 'Folder not found.' });
  res.json({ ok: true });
});

function publicMedia(m) {
  return {
    id: m.id, originalName: m.original_name, mimeType: m.mime_type, kind: m.kind,
    sizeBytes: m.size_bytes, width: m.width, height: m.height, durationSeconds: m.duration_seconds,
    fps: m.fps || null, codec: m.codec || null,
    tags: m.tags, favorite: Boolean(m.favorite), folderId: m.folder_id,
    licenseNote: m.license_note || '',
    url: `/api/media/${m.id}/file`,
    thumbnailUrl: m.thumbnail ? `/api/media/${m.id}/thumbnail` : null,
    createdAt: m.created_at,
  };
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

module.exports = router;
