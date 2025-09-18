// server.mjs  (Node 18+ con "type":"module" en package.json) 
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
// Config (ajústalo por env)
// =========================

// Thumbnails (/frames)
const FRAMES_EVERY_SEC = Number(process.env.FRAMES_EVERY_SEC || 6);
const FRAMES_MAX       = Number(process.env.FRAMES_MAX || 10);
const FRAMES_SCALE_W   = Number(process.env.FRAMES_SCALE_W || 1080);
const JPG_QUALITY      = Number(process.env.JPG_QUALITY || 3);

// Render (video)
const TARGET_W   = Number(process.env.TARGET_W || 1080);
const TARGET_H   = Number(process.env.TARGET_H || 1920);
const MIRROR     = process.env.MIRROR === 'false' ? false : true;
const PRE_ZOOM   = Number(process.env.PRE_ZOOM ?? 1.12);
const ROTATE_DEG = Number(process.env.ROTATE_DEG || 0);
const CONTRAST   = Number(process.env.CONTRAST ?? 1.15);
const BRIGHTNESS = Number(process.env.BRIGHTNESS ?? 0.05);
const SATURATION = Number(process.env.SATURATION ?? 1.10);
const SHARPEN    = Number(process.env.SHARPEN ?? 0);
const LOOP_VIDEO = process.env.LOOP_VIDEO === 'false' ? false : true;

// Render (codec/velocidad)
const ENCODER = process.env.ENCODER || 'libx264';     // libx264 | h264_nvenc | h264_qsv | h264_vaapi
const PRESET  = process.env.PRESET  || 'veryfast';    // x264: ultrafast..veryslow
const CRF     = Number(process.env.CRF || 21);
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '192k';
const THREADS = Number(process.env.FFMPEG_THREADS ?? 0); // 0 = auto
const GOP     = Number(process.env.GOP || 120);           // keyframe interval
const HWACCEL = process.env.HWACCEL; // ej: 'auto' (si el host lo soporta)

// Red / timeouts
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 60_000);
const READ_TIMEOUT_MS    = Number(process.env.READ_TIMEOUT_MS    || 180_000);
const RENDER_TIMEOUT_MS  = Number(process.env.RENDER_TIMEOUT_MS  || 30 * 60_000);
const JOB_TIMEOUT_MS     = Number(process.env.JOB_TIMEOUT_MS     || 35 * 60_000);

// Cola
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY ?? 1));
const OUTPUT_TTL_MS   = Number(process.env.OUTPUT_TTL_MS || 30 * 60_000);

// Salidas persistentes por id
const OUT_DIR = join(tmpdir(), 'renders_async');
await mkdir(OUT_DIR, { recursive: true });

// =========================
// Utils
// =========================
const execFileP = promisify(execFile);

function toNodeReadable(stream) {
  if (!stream) throw new Error('empty stream');
  return typeof stream.pipe === 'function' ? stream : Readable.fromWeb(stream);
}

function assertContentType(res, allowed, label) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) throw new Error(`${label}: got HTML (enlace no directo)`);
  if (!allowed.some(s => ct.includes(s))) throw new Error(`${label}: unexpected content-type ${ct || '(none)'}`);
}

async function downloadToFile(
  url,
  destPath,
  { allowedCT, label, connectTimeoutMs = CONNECT_TIMEOUT_MS, readTimeoutMs = READ_TIMEOUT_MS } = {}
) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), connectTimeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`${label}: fetch failed ${res.status}`);
  if (allowedCT) assertContentType(res, allowedCT, label);

  const body = toNodeReadable(res.body);
  const ws = createWriteStream(destPath);

  // read-timeout (si el stream se queda colgado)
  let rt = setTimeout(() => {
    try { body.destroy(new Error(`${label}: read timeout`)); } catch {}
    try { ws.destroy(new Error(`${label}: read timeout`)); } catch {}
  }, readTimeoutMs);

  body.on('data', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      try { body.destroy(new Error(`${label}: read timeout`)); } catch {}
      try { ws.destroy(new Error(`${label}: read timeout`)); } catch {}
    }, readTimeoutMs);
  });

  try {
    await pipeline(body, ws);
  } finally {
    clearTimeout(rt);
  }
}

async function runFfmpeg(args, timeoutMs = RENDER_TIMEOUT_MS) {
  try {
    await execFileP('ffmpeg', args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: { ...process.env },
    });
  } catch (err) {
    const stderr = String(err.stderr || '');
    const killed = err.killed || err.signal === 'SIGKILL' || err.code === 137 ||
                   /Killed|Out of memory|Cannot allocate|std::bad_alloc/i.test(stderr);
    if (killed) throw new Error('ffmpeg OOM/timeout. Baja resolución/preset o sube plan.');
    throw new Error(`ffmpeg failed: ${(stderr || err.message || '').slice(0, 1500)}`);
  }
}

function getBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0];
  const host  = (req.headers['x-forwarded-host']  || req.get('host'));
  return `${proto}://${host}`;
}

// ✅ probeDuration
async function probeDuration(filePath) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v','error',
      '-show_entries','format=duration',
      '-of','default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

// Escapes seguros para filtros de ffmpeg
function escapeFilterPath(p) {
  // Usar forward slashes, y escapar caracteres especiales para filtros (no para shell)
  return p
    .replace(/\\/g, '/')   // windows -> posix
    .replace(/:/g, '\\:')  // separador de campos en filtros
    .replace(/'/g, "\\'")  // quote interna en filtros
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]');
}
function escapeForceStyle(s) {
  // Solo escapar comillas simples
  return s.replace(/'/g, "\\'");
}

// =========================
// Cola en memoria
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

async function processJob(job) {
  // heartbeat para que el cliente vea "updatedAt" moverse
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

function withJobTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => t = setTimeout(() => rej(new Error('render job timeout')), ms));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Limpieza de outputs y errores viejos
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
/* App */
// =========================
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// -------- /frames (simple) --------
app.post('/frames', async (req, res) => {
  try {
    const { video_url } = req.body || {};
    if (!video_url) return res.status(400).json({ error: 'video_url required' });

    const inFile = join(tmpdir(), `in_${Date.now()}.mp4`);
    await downloadToFile(video_url, inFile, {
      allowedCT: ['video','mp4','quicktime','x-matroska','octet-stream'],
      label: 'video_url',
    });

    const outPattern = join(tmpdir(), `f_${Date.now()}-%03d.jpg`);
    await runFfmpeg([
      '-y','-v','error',
      ...(HWACCEL ? ['-hwaccel', HWACCEL] : []),
      '-i', inFile,
      // más rápido que lanczos:
      '-vf', `fps=1/${FRAMES_EVERY_SEC},scale=${FRAMES_SCALE_W}:-2:flags=fast_bilinear`,
      '-frames:v', String(FRAMES_MAX),
      '-q:v', String(JPG_QUALITY),
      '-threads', String(THREADS),
      outPattern
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
    res.json({ frames, count: frames.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// -------- Render ASÍNCRONO --------
// Body JSON:
// {
//   "video_url": "...", "audio_url": "...",
//   "srt_url": "...? (opcional)",
//   "bgm_url": "...? (opcional)",
//   "bgm_volume": 0.16, "bgm_offset_sec": 0,
//   "duck": true, "duck_threshold": 0.1, "duck_ratio": 8, "duck_attack_ms": 5, "duck_release_ms": 250,
//   "vo_gain": 1.0,              // 🔊 NUEVO: multiplicador lineal VO
//   "vo_db": 0                   // 🔊 NUEVO: alternativa en dB (prioridad si viene)
// }
app.post('/render', async (req, res) => {
  try {
    const {
      video_url, audio_url,
      srt_url, bgm_url,
      bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
      bgm_offset_sec,
      vo_gain,              // 🔊 NEW
      vo_db,                // 🔊 NEW
    } = req.body || {};

    if (!video_url || !audio_url)
      return res.status(400).json({ error: 'video_url and audio_url required' });

    const id = enqueueRender({
      video_url, audio_url, srt_url, bgm_url,
      bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
      bgm_offset_sec,
      vo_gain, vo_db,       // 🔊 NEW
    });

    const base = getBase(req);
    res.status(202).json({
      id,
      status_url: `${base}/render/${id}`,
      video_url:  `${base}/render/${id}/video`,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/render/:id', async (req, res) => {
  const id = req.params.id;
  const base = getBase(req);
  const job = JOBS.get(id);

  if (!job) {
    const path = join(OUT_DIR, `${id}.mp4`);
    try {
      await access(path, FS_CONST.F_OK);
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

app.get('/render/:id/video', async (req, res) => {
  const id = req.params.id;
  const outPath = join(OUT_DIR, `${id}.mp4`);

  const job = JOBS.get(id);
  if (job) {
    if (job.status === 'error')  return res.status(500).json({ error: job.error });
    if (job.status !== 'done')   return res.status(425).json({ error: 'not ready' });
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
  const {
    video_url, audio_url,
    srt_url, bgm_url,
    bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
    bgm_offset_sec,
    vo_gain,    // 🔊 NEW
    vo_db,      // 🔊 NEW
  } = job.params;

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.mp3`);
  let srtPath = null, bgmPath = null;

  try {
    // --- Descargas ---
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
    if (bgm_url) {
      bgmPath = join(tmpdir(), `bgm_${Date.now()}.mp3`);
      await downloadToFile(bgm_url, bgmPath, {
        allowedCT: ['audio','mpeg','mp3','aac','mp4','x-m4a','wav','x-wav','octet-stream'],
        label: 'bgm_url',
      });
    }

    // --- Duraciones ---
    const dV   = await probeDuration(inV);
    const dA   = await probeDuration(inA);
    const dBGM = bgmPath ? await probeDuration(bgmPath) : 0;
    const tgtCut = Number.isFinite(dA) && dA > 0 ? dA + 0.5 : null;

    // --- Filtros de video (rápidos) ---
    const vf = [];
    if (MIRROR) vf.push('hflip');
    if (PRE_ZOOM && PRE_ZOOM !== 1) vf.push(`crop=iw/${PRE_ZOOM}:ih/${PRE_ZOOM}`);
    if (ROTATE_DEG) vf.push(`rotate=${ROTATE_DEG}*PI/180:fillcolor=black`);
    if (CONTRAST !== 1 || BRIGHTNESS !== 0 || SATURATION !== 1) {
      vf.push(`eq=contrast=${CONTRAST}:brightness=${BRIGHTNESS}:saturation=${SATURATION}`);
    }
    if (SHARPEN > 0) vf.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${SHARPEN}`);
    vf.push(`scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase:flags=fast_bilinear`);
    vf.push(`crop=${TARGET_W}:${TARGET_H}`);

    if (srtPath) {
      const FS = Math.max(6, Math.round(6 * (TARGET_H / 1080)));
      const ML = Math.round(TARGET_W * 0.01);
      const MR = ML;
      const MV = Math.round(TARGET_H * 0.06);
      const style = [
        'FontName=DejaVu Sans',
        `Fontsize=${FS}`,
        'Bold=1',
        'BorderStyle=1','Outline=1','Shadow=0',
        'PrimaryColour=&H00FFFFFF&',
        'OutlineColour=&H000000&',
        'Alignment=2',
        `MarginV=${MV}`, `MarginL=${ML}`, `MarginR=${MR}`,
        'WrapStyle=0',
      ].join(',');
      const styleEsc = escapeForceStyle(style);
      const srtEsc   = escapeFilterPath(srtPath);
      vf.push(
        `subtitles=${srtEsc}:original_size=${TARGET_W}x${TARGET_H}:force_style='${styleEsc}':charenc=UTF-8`
      );
    }
    const vChain = `[0:v]${vf.join(',')}[vout]`;

    // --- Audio (VO + BGM con ducking) ---
    const BGM_VOL   = Math.max(0, Math.min(2, Number(bgm_volume ?? 0.16)));
    const DUCK      = duck === undefined ? true : !!duck;
    const DUCK_T    = Number(duck_threshold ?? 0.1);
    const DUCK_R    = Number(duck_ratio ?? 8);
    const DUCK_A    = Number(duck_attack_ms ?? 5);
    const DUCK_REL  = Number(duck_release_ms ?? 250);
    const BGM_OFF_S = Math.max(0, Number(bgm_offset_sec ?? 0));
    const BGM_OFF_MS = Math.round(BGM_OFF_S * 1000);

    // 🔊 VO gain (lineal) o en dB
    const VO_DB   = Number.isFinite(Number(vo_db)) ? Number(vo_db) : null;
    let   VO_GAIN = Number.isFinite(Number(vo_gain)) ? Number(vo_gain) : 1.0;
    if (VO_DB !== null) VO_GAIN = Math.pow(10, VO_DB / 20);
    VO_GAIN = Math.max(0.01, Math.min(5.0, VO_GAIN));

    let aChain;
    if (bgmPath) {
      const maybeDelay = BGM_OFF_MS ? `,adelay=${BGM_OFF_MS}|${BGM_OFF_MS}` : '';
      aChain = [
        `[1:a]aresample=44100,volume=${VO_GAIN},aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[nar_mix][nar_side]`,
        `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${BGM_VOL}${maybeDelay}[bgm]`,
        DUCK
          ? `[bgm][nar_side]sidechaincompress=threshold=${DUCK_T}:ratio=${DUCK_R}:attack=${DUCK_A}:release=${DUCK_REL}[duck]`
          : `[bgm]anull[duck]`,
        `[nar_mix][duck]amix=inputs=2:duration=first:dropout_transition=200[aout]`,
      ].join(';');
    } else {
      aChain = `[1:a]aresample=44100,volume=${VO_GAIN},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`;
    }
    const filterComplex = [vChain, aChain].join(';');

    // --- Inputs con loops finitos y límites ---
    const args = ['-y','-v','error'];
    if (HWACCEL) args.push('-hwaccel', HWACCEL);

    // VIDEO (idx 0)
    if (LOOP_VIDEO && dA > 0 && dV > 0 && dA > dV) {
      const loopsV = Math.max(0, Math.ceil(dA / dV) - 1);
      if (loopsV > 0) args.push('-stream_loop', String(loopsV));
    }
    args.push('-i', inV);

    // VO (idx 1)
    args.push('-i', inA);

    // BGM (idx 2)
    if (bgmPath) {
      if (process.env.LOOP_BGM !== 'false' && dA > 0 && dBGM > 0 && dA > dBGM) {
        const loopsB = Math.max(0, Math.ceil(dA / dBGM) - 1);
        if (loopsB > 0) args.push('-stream_loop', String(loopsB));
      }
      args.push('-i', bgmPath);
    }

    args.push(
      '-filter_complex', filterComplex,
      '-filter_threads','0',
      '-map','[vout]','-map','[aout]',
      '-shortest',
      // video
      '-c:v', ENCODER,
      ...(ENCODER === 'libx264'
        ? ['-preset', PRESET, '-crf', String(CRF), '-x264-params', `keyint=${GOP}:min-keyint=${GOP}:scenecut=0`]
        : ['-g', String(GOP), '-b:v', '0'] // nvenc/qsv/vaapi
      ),
      // audio
      '-c:a','aac','-b:a', AUDIO_BITRATE,
      // mux
      '-pix_fmt','yuv420p',
      '-movflags','+faststart',
      '-threads', String(THREADS),
      '-max_muxing_queue_size','1024',
      job.outPath
    );

    // Corte exacto al largo de la narración (si lo tenemos)
    if (tgtCut) {
      // insertar justo antes del output
      args.splice(args.length - 1, 0, '-t', String(Math.max(0.1, tgtCut)));
    }

    await runFfmpeg(args, RENDER_TIMEOUT_MS);

    // Limpieza
    try { await rm(inV, { force: true }); } catch {}
    try { await rm(inA, { force: true }); } catch {}
    try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    try { if (bgmPath) await rm(bgmPath, { force: true }); } catch {}
  } catch (err) {
    try { await rm(inV, { force: true }); } catch {}
    try { await rm(inA, { force: true }); } catch {}
    try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    try { if (bgmPath) await rm(bgmPath, { force: true }); } catch {}
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

// ---------------- listen ----------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ready on :${PORT} (/frames, /render [POST], /render/:id [GET], /render/:id/video [GET])`);
  maybeRun();
});
setInterval(maybeRun, 1000);