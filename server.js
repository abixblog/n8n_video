// server.mjs  (Node 18+, package.json: { "type": "module" })
import express from 'express';
import cors from 'cors';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream, createReadStream } from 'node:fs';
import { readFile, rm, stat, mkdir, access } from 'node:fs/promises';
import { constants as FS_CONST } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// =========================
// Configuración ESTÁTICA (NO TOCAR)
// =========================

// FRAMES
const FRAMES_EVERY_SEC = 6;   // 1 frame cada 6 s
const FRAMES_MAX = 10;        // máximo 10 frames
const FRAMES_SCALE_W = 1080;  // ancho de las miniaturas
const JPG_QUALITY = 3;        // 2 (mejor) .. 7 (peor)

// RENDER (efectos fijos)
const TARGET_W = 1080;
const TARGET_H = 1920;

const MIRROR = true;       // espejo horizontal
const PRE_ZOOM = 1.12;     // zoom leve previo (escala relativa)
const ROTATE_DEG = 0;      // grados de rotación

const CONTRAST = 1.15;
const BRIGHTNESS = 0.05;
const SATURATION = 1.1;
const SHARPEN = 0;         // 0 = off; típicamente 0.3–1.0

// =========================
// Ajustes de performance
// =========================
const PRESET = process.env.FFMPEG_PRESET || 'ultrafast'; // más rápido
const CRF = Number(process.env.CRF || 23);               // tamaño/calidad
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '160k';
const THREADS = Number(process.env.FFMPEG_THREADS || 0); // 0=auto

// =========================
// Timeouts / Cola
// =========================
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 60_000);
const READ_TIMEOUT_MS    = Number(process.env.READ_TIMEOUT_MS    || 180_000);
const RENDER_TIMEOUT_MS  = Number(process.env.RENDER_TIMEOUT_MS  || 30 * 60_000);
const JOB_TIMEOUT_MS     = Number(process.env.JOB_TIMEOUT_MS     || 35 * 60_000);

const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY ?? 1));
const OUTPUT_TTL_MS   = Number(process.env.OUTPUT_TTL_MS || 30 * 60_000);

// Directorio persistente para salidas
const OUT_DIR = join(tmpdir(), 'renders_async_simple');
await mkdir(OUT_DIR, { recursive: true });

// =========================
// Utilidades
// =========================
const execFileP = promisify(execFile);

async function sh(cmd, args, opts = {}) {
  return execFileP(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 0,
    ...opts,
  });
}

function toNodeReadable(stream) {
  if (!stream) throw new Error('empty stream');
  return typeof stream.pipe === 'function' ? stream : Readable.fromWeb(stream);
}

function assertContentType(res, allowed, label) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) throw new Error(`${label}: got HTML (enlace no directo)`);
  if (!allowed.some((s) => ct.includes(s))) {
    throw new Error(`${label}: unexpected content-type ${ct || '(none)'}`);
  }
}

// Descarga con timeout de conexión y de lectura
async function downloadToFile(url, destPath, { allowedCT, label, connectTimeoutMs = CONNECT_TIMEOUT_MS, readTimeoutMs = READ_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const ct = setTimeout(() => ctl.abort(), connectTimeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(ct);
  }
  if (!res.ok) throw new Error(`${label}: fetch failed ${res.status}`);
  if (allowedCT) assertContentType(res, allowedCT, label);

  const rs = toNodeReadable(res.body);
  const ws = createWriteStream(destPath);

  let rt = setTimeout(() => {
    try { rs.destroy(new Error(`${label}: read timeout`)); } catch {}
    try { ws.destroy(new Error(`${label}: read timeout`)); } catch {}
  }, readTimeoutMs);

  rs.on('data', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      try { rs.destroy(new Error(`${label}: read timeout`)); } catch {}
      try { ws.destroy(new Error(`${label}: read timeout`)); } catch {}
    }, readTimeoutMs);
  });

  try {
    await pipeline(rs, ws);
  } finally {
    clearTimeout(rt);
  }
}

async function probeDuration(filePath) {
  try {
    const { stdout } = await sh('ffprobe', [
      '-v','error',
      '-show_entries','format=duration',
      '-of','default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) ? d : 0;
  } catch { return 0; }
}

function getBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0];
  const host  = (req.headers['x-forwarded-host']  || req.get('host'));
  return `${proto}://${host}`;
}

// =========================
// Cola en memoria (asíncrono)
// =========================
const JOBS = new Map(); // id -> { id, status, outPath, error, createdAt, updatedAt, doneAt, params }
let RUNNING = 0;

function enqueueRender(params) {
  const id = randomUUID();
  JOBS.set(id, {
    id,
    status: 'queued',
    outPath: join(OUT_DIR, `${id}.mp4`),
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    doneAt: null,
    params,
  });
  setImmediate(maybeRun);
  return id;
}

function nextQueued() {
  for (const j of JOBS.values()) if (j.status === 'queued') return j;
  return null;
}

function maybeRun() {
  if (RUNNING >= MAX_CONCURRENCY) return;
  const job = nextQueued();
  if (!job) return;

  job.status = 'processing';
  job.updatedAt = Date.now();
  RUNNING++;

  processJob(job)
    .catch(() => {})
    .finally(() => {
      RUNNING--;
      maybeRun();
    });
}

function withJobTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => t = setTimeout(() => rej(new Error('render job timeout')), ms));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function processJob(job) {
  // heartbeat para updatedAt
  const hb = setInterval(() => { job.updatedAt = Date.now(); }, 5000);
  try {
    await withJobTimeout(doRenderOnce(job), JOB_TIMEOUT_MS);
    job.status = 'done';
    job.updatedAt = job.doneAt = Date.now();
  } catch (err) {
    job.error = String(err);
    job.status = 'error';
    job.updatedAt = Date.now();
  } finally {
    clearInterval(hb);
  }
}

// Limpieza periódica de outputs
setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (job.status === 'done' && job.doneAt && now - job.doneAt > OUTPUT_TTL_MS) {
      try { await rm(job.outPath, { force: true }); } catch {}
      JOBS.delete(id);
    } else if (job.status === 'error' && now - job.updatedAt > 10 * 60_000) {
      JOBS.delete(id);
    }
  }
}, 5 * 60_000);

// =========================
/** App **/
// =========================
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// -------- /frames --------
app.post('/frames', async (req, res) => {
  try {
    const { video_url } = req.body || {};
    if (!video_url) return res.status(400).json({ error: 'video_url required' });

    const inFile = join(tmpdir(), `in_${Date.now()}.mp4`);
    await downloadToFile(video_url, inFile, {
      allowedCT: ['video','mp4','quicktime','x-matroska','octet-stream'],
      label: 'video_url',
    });

    const dur = await probeDuration(inFile);

    const times = [];
    if (dur > 0) {
      for (let t = FRAMES_EVERY_SEC; t <= dur && times.length < FRAMES_MAX; t += FRAMES_EVERY_SEC) {
        times.push(+t.toFixed(3));
      }
      if (!times.length) times.push(+Math.max(0, dur / 2).toFixed(3));
    } else {
      // fallback fps si no se pudo leer duración
      const outPattern = join(tmpdir(), `f_${Date.now()}-%03d.jpg`);
      await sh('ffmpeg', [
        '-y','-v','error',
        '-i', inFile,
        '-vf', `fps=1/${FRAMES_EVERY_SEC},scale=${FRAMES_SCALE_W}:-2:flags=lanczos`,
        '-frames:v', String(FRAMES_MAX),
        '-q:v', String(JPG_QUALITY),
        '-threads', String(THREADS),
        outPattern,
      ]);
      const frames = [];
      for (let i = 1; i <= FRAMES_MAX; i++) {
        const p = outPattern.replace('%03d', String(i).padStart(3, '0'));
        try {
          const buf = await readFile(p);
          frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
          await rm(p, { force: true });
        } catch { break; }
      }
      await rm(inFile, { force: true });
      return res.json({ frames, count: frames.length, duration: dur });
    }

    const frames = [];
    for (const t of times) {
      const out = join(tmpdir(), `f_${t}_${Date.now()}.jpg`);
      await sh('ffmpeg', [
        '-y','-v','error',
        '-ss', String(t),
        '-i', inFile,
        '-frames:v','1',
        '-vf', `scale=${FRAMES_SCALE_W}:-2:flags=lanczos`,
        '-q:v', String(JPG_QUALITY),
        '-threads', String(THREADS),
        out,
      ]);
      const buf = await readFile(out);
      frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
      await rm(out, { force: true });
    }
    await rm(inFile, { force: true });
    res.json({ frames, count: frames.length, duration: dur, used_times: times });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// -------- /render (ASÍNCRONO) --------
// Body: { video_url, audio_url, srt_url? }
app.post('/render', async (req, res) => {
  const { video_url, audio_url, srt_url } = req.body || {};
  if (!video_url || !audio_url) {
    return res.status(400).json({ error: 'video_url and audio_url required' });
  }

  const id = enqueueRender({ video_url, audio_url, srt_url });
  const base = getBase(req);

  return res.status(202).json({
    id,
    status_url: `${base}/render/${id}`,
    video_url:  `${base}/render/${id}/video`,
  });
});

// GET estado
app.get('/render/:id', async (req, res) => {
  const id = req.params.id;
  const base = getBase(req);
  const job = JOBS.get(id);

  if (!job) {
    const outPath = join(OUT_DIR, `${id}.mp4`);
    try {
      await access(outPath, FS_CONST.F_OK);
      return res.json({ id, status: 'done', error: null, createdAt: null, updatedAt: null, doneAt: null, video_url: `${base}/render/${id}/video` });
    } catch {
      return res.status(404).json({ error: 'not found' });
    }
  }

  const payload = {
    id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    doneAt: job.doneAt,
  };
  if (job.status === 'done') payload.video_url = `${base}/render/${id}/video`;
  res.json(payload);
});

// GET MP4 final
app.get('/render/:id/video', async (req, res) => {
  const id = req.params.id;
  const outPath = join(OUT_DIR, `${id}.mp4`);

  const job = JOBS.get(id);
  if (job) {
    if (job.status === 'error')  return res.status(500).json({ error: job.error });
    if (job.status !== 'done')   return res.status(425).json({ error: 'not ready' }); // 425 Too Early
  }

  try {
    const st = await stat(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Content-Disposition', 'inline; filename="render.mp4"');
    await pipeline(createReadStream(outPath), res);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

// =========================
// Render real (trabajo único)
// =========================
async function doRenderOnce(job) {
  const { video_url, audio_url, srt_url } = job.params;

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.m4a`);
  let srtPath = null;

  try {
    // Descargas
    await downloadToFile(video_url, inV, {
      allowedCT: ['video','mp4','quicktime','x-matroska','octet-stream'],
      label: 'video_url',
    });
    await downloadToFile(audio_url, inA, {
      allowedCT: ['audio','mpeg','mp3','aac','mp4','x-m4a','wav','x-wav','octet-stream'],
      label: 'audio_url',
    });
    if (srt_url) {
      srtPath = join(tmpdir(), `subs_${Date.now()}.srt`);
      await downloadToFile(srt_url, srtPath, {
        allowedCT: ['srt','text','plain','octet-stream'],
        label: 'srt_url',
      });
    }

    // Filtros de video
    const vf = [];
    if (MIRROR) vf.push('hflip');
    if (PRE_ZOOM !== 1) vf.push(`scale=iw*${PRE_ZOOM}:ih*${PRE_ZOOM}`);
    vf.push('crop=iw:ih');
    if (ROTATE_DEG) vf.push(`rotate=${ROTATE_DEG}*PI/180`);
    vf.push(`eq=contrast=${CONTRAST}:brightness=${BRIGHTNESS}:saturation=${SATURATION}`);
    if (SHARPEN > 0) vf.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${SHARPEN}`);
    vf.push(`scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase`);
    vf.push(`crop=${TARGET_W}:${TARGET_H}`);

    if (srtPath) {
      const FS = Math.max(6, Math.round(6 * (TARGET_H / 1080)));
      const sidePct = 0.04;
      const ML = Math.round(TARGET_W * sidePct);
      const MR = ML;
      const MV = Math.round(TARGET_H * 0.05);
      const style = [
        'FontName=DejaVu Sans',
        `Fontsize=${FS}`,
        'BorderStyle=1',
        'Outline=0',
        'Shadow=0',
        'PrimaryColour=&H00FFFFFF&',
        'Alignment=2',
        `MarginV=${MV}`,
        `MarginL=${ML}`,
        `MarginR=${MR}`,
        'WrapStyle=0',
      ].join(',');
      vf.push(
        `subtitles='${srtPath.replace(/\\/g, '/')}'` +
        `:original_size=${TARGET_W}x${TARGET_H}` +
        `:force_style='${style}'` +
        `:charenc=UTF-8`
      );
    }

    // ffmpeg (simple: video + audio + opcional srt)
    const args = [
      '-y','-v','error',
      '-i', inV,
      '-i', inA,
      '-filter:v', vf.join(','),
      '-map','0:v:0',
      '-map','1:a:0',
      '-shortest',
      '-c:v','libx264',
      '-preset', PRESET,
      '-crf', String(CRF),
      '-c:a','aac',
      '-b:a', AUDIO_BITRATE,
      '-pix_fmt','yuv420p',
      '-movflags','+faststart',
      '-threads', String(THREADS),
      job.outPath
    ];

    await execFileP('ffmpeg', args, { timeout: RENDER_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });

    // limpia temporales
    try { await rm(inV, { force: true }); } catch {}
    try { await rm(inA, { force: true }); } catch {}
    try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
  } catch (err) {
    try { await rm(inV, { force: true }); } catch {}
    try { await rm(inA, { force: true }); } catch {}
    try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    try { await rm(job.outPath, { force: true }); } catch {}
    throw err;
  }
}

// =========================
// Health
// =========================
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ready on :${PORT} (/frames, /render [POST], /render/:id [GET], /render/:id/video [GET])`);
  maybeRun();
});
setInterval(maybeRun, 1000);
