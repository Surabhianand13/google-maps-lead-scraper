require('dotenv').config({ override: true });

const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let ffmpegAvailable = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  ffmpegAvailable = true;
  console.log('[storeguard] ffmpeg detected — video frame extraction enabled');
} catch {
  console.log('[storeguard] ffmpeg not found — videos will be rejected');
}

const db = new Database(path.join(__dirname, 'storeguard.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    store TEXT NOT NULL,
    camera TEXT,
    captured_at TEXT,
    media_path TEXT,
    media_type TEXT,
    flagged INTEGER,
    severity TEXT,
    confidence INTEGER,
    summary TEXT,
    flags_json TEXT,
    scene_description TEXT,
    recommendation TEXT,
    reviewer_status TEXT DEFAULT 'pending',
    reviewer_note TEXT DEFAULT ''
  );
`);

const STORES = [
  'Store 1 MG Road',
  'Store 2 Koramangala',
  'Store 3 Indiranagar',
  'Store 4 Jayanagar',
  'Store 5 HSR Layout',
  'Store 6 Banashankari',
  'Store 7 Whitefield',
  'Store 8 Electronic City',
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

const MAX_VIDEO_FRAMES = 8;

function extractVideoFrame(videoPath, outputPath, seconds) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-ss', String(seconds), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outputPath],
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

function probeDuration(videoPath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
      (err, stdout) => {
        if (err) return resolve(null);
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) && d > 0 ? d : null);
      },
    );
  });
}

async function encodeJpegBase64(imagePath) {
  const buf = await sharp(imagePath)
    .rotate()
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return buf.toString('base64');
}

async function prepareImages(filePath, mimeType) {
  const isVideo = mimeType && mimeType.startsWith('video/');

  if (!isVideo) {
    return [await encodeJpegBase64(filePath)];
  }

  if (!ffmpegAvailable) {
    throw new Error('Video uploaded but ffmpeg is not installed on this machine.');
  }

  const duration = await probeDuration(filePath);
  const frameCount = duration ? Math.min(MAX_VIDEO_FRAMES, Math.max(2, Math.ceil(duration / 30))) : 1;

  const timestamps = [];
  if (duration && frameCount > 1) {
    const step = duration / (frameCount + 1);
    for (let i = 1; i <= frameCount; i++) timestamps.push(+(step * i).toFixed(2));
  } else {
    timestamps.push(duration ? Math.min(2, duration / 2) : 0);
  }

  const framePaths = [];
  const images = [];
  try {
    for (let i = 0; i < timestamps.length; i++) {
      const framePath = `${filePath}.frame-${i}.jpg`;
      try {
        await extractVideoFrame(filePath, framePath, timestamps[i]);
        framePaths.push(framePath);
        images.push(await encodeJpegBase64(framePath));
      } catch (e) {
        console.warn(`[storeguard] frame extract failed at ${timestamps[i]}s:`, e.message);
      }
    }
    if (!images.length) throw new Error('Could not extract any frames from video.');
    console.log(`[storeguard] sampled ${images.length} frames from ${duration ? duration.toFixed(1) + 's' : 'video'}`);
    return images;
  } finally {
    for (const p of framePaths) { try { fs.unlinkSync(p); } catch {} }
  }
}

const VISION_PROMPT = `You are a retail loss-prevention auditor reviewing CCTV from a small store in India (typical formats: bakery / café / kirana / mobile shop / pharmacy / apparel / jewellery). The images below are SEQUENTIAL frames from one short clip (or a single screenshot). They are ordered earliest → latest.

Work in this exact order. Do not skip steps.

STEP 1 — OBSERVE (do not judge yet)
- Read the labels under each image to identify the store type from what you actually see (products, signage, counters, billing machines, packaging). Do NOT assume it is jewellery just because there are display cases. Bakeries and cafés have glass counters too.
- Identify who is staff vs customer. Staff are usually behind the counter, in aprons / uniforms, or operating the POS / billing machine / weighing scale.
- Locate the POS / billing terminal, cash drawer, weighing scale, and any handheld scanner. If you cannot see one of these, say so — do not invent it.

STEP 2 — TRACK MOTION ACROSS FRAMES
- Compare consecutive frames. Describe concrete changes you actually see: a hand moves from till to pocket, a cash note changes hands, a product leaves the counter without being scanned, the cash drawer opens/closes, an employee turns away from the camera, items are handed over without a receipt being printed.
- Be specific about WHICH frames show the change (e.g. "between frame 4 and frame 6 the employee places a note under the counter mat"). If frames are too far apart in time to tell, say so.

STEP 3 — JUDGE
Decide flagged / severity / confidence ONLY from what you observed above. Do not flag generic "looks normal" behavior, and do not flag based on guesses. Specifically watch for:
1. Cash accepted without a corresponding POS transaction or printed bill
2. Cash drawer opened without a transaction
3. Goods handed over with no receipt / no scan
4. Use of a personal phone / scanner instead of store POS
5. Employee pocketing cash, notes, or items
6. Items being passed to someone over/around the counter without billing

Calibrate confidence honestly:
- 80+ only if multiple frames clearly show the behavior
- 50–79 if it is plausible but partly occluded or ambiguous
- Below 50 if it is mostly a guess — in that case flagged should be false

Output ONLY this exact JSON (no markdown, no backticks, no commentary):
{"flagged": true|false, "severity": "high"|"medium"|"low"|"none", "confidence": 0-100, "summary": "2-3 sentence plain-English summary grounded in what you actually saw", "flags": ["specific observations tied to frame numbers, e.g. 'frame 3→5: employee accepts ₹500 note, no POS interaction visible'"], "scene_description": "what the store actually is and what is visible — be concrete about products, counters, equipment", "recommendation": "what the reviewer should do next"}`;

async function callClaude(base64Images) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const imageBlocks = base64Images.map((data, idx) => ([
    { type: 'text', text: `Frame ${idx + 1} of ${base64Images.length}:` },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
  ])).flat();

  const body = {
    model: MODEL,
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: VISION_PROMPT },
        ],
      },
    ],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text}`);
  }
  const json = await res.json();
  const text = json.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Could not parse JSON from Claude: ${text}`);
  return JSON.parse(match[0]);
}

function rowToIncident(row) {
  let flags = [];
  try { flags = JSON.parse(row.flags_json || '[]'); } catch {}
  return {
    id: row.id,
    created_at: row.created_at,
    store: row.store,
    camera: row.camera,
    captured_at: row.captured_at,
    media_url: row.media_path ? `/uploads/${path.basename(row.media_path)}` : null,
    media_type: row.media_type,
    flagged: !!row.flagged,
    severity: row.severity,
    confidence: row.confidence,
    summary: row.summary,
    flags,
    scene_description: row.scene_description,
    recommendation: row.recommendation,
    reviewer_status: row.reviewer_status,
    reviewer_note: row.reviewer_note,
  };
}

function cleanup() {
  const cutoff = Date.now() - THREE_DAYS_MS;
  const stale = db.prepare('SELECT id, media_path FROM incidents WHERE created_at < ?').all(cutoff);
  if (!stale.length) return;
  const del = db.prepare('DELETE FROM incidents WHERE id = ?');
  for (const row of stale) {
    if (row.media_path) {
      try { fs.unlinkSync(row.media_path); } catch {}
    }
    del.run(row.id);
  }
  console.log(`[storeguard] cleanup removed ${stale.length} incident(s) older than 3 days`);
}
cleanup();
setInterval(cleanup, 60 * 60 * 1000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/stores', (req, res) => res.json(STORES));

app.get('/api/incidents', (req, res) => {
  const cutoff = Date.now() - THREE_DAYS_MS;
  const rows = db
    .prepare('SELECT * FROM incidents WHERE created_at >= ? ORDER BY created_at DESC')
    .all(cutoff);
  res.json(rows.map(rowToIncident));
});

app.post('/api/analyse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filePath = req.file.path;
  try {
    const { store, camera, datetime } = req.body;
    if (!store) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Store is required' });
    }
    const images = await prepareImages(filePath, req.file.mimetype);
    const result = await callClaude(images);

    const stmt = db.prepare(`
      INSERT INTO incidents
      (created_at, store, camera, captured_at, media_path, media_type,
       flagged, severity, confidence, summary, flags_json, scene_description, recommendation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      Date.now(),
      store,
      camera || '',
      datetime || '',
      filePath,
      req.file.mimetype,
      result.flagged ? 1 : 0,
      result.severity || 'none',
      Math.round(Number(result.confidence) || 0),
      result.summary || '',
      JSON.stringify(result.flags || []),
      result.scene_description || '',
      result.recommendation || '',
    );
    const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(info.lastInsertRowid);
    res.json(rowToIncident(row));
  } catch (err) {
    console.error('[analyse] error:', err);
    try { fs.unlinkSync(filePath); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/incidents/:id', (req, res) => {
  const id = Number(req.params.id);
  const { reviewer_status, reviewer_note } = req.body;
  const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(
    'UPDATE incidents SET reviewer_status = COALESCE(?, reviewer_status), reviewer_note = COALESCE(?, reviewer_note) WHERE id = ?',
  ).run(reviewer_status, reviewer_note, id);
  const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  res.json(rowToIncident(updated));
});

app.delete('/api/incidents/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.media_path) {
    try { fs.unlinkSync(row.media_path); } catch {}
  }
  db.prepare('DELETE FROM incidents WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[storeguard] http://localhost:${PORT}`);
  if (!API_KEY) console.warn('[storeguard] WARNING: ANTHROPIC_API_KEY not set in .env');
});
