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
// Config estática
// =========================
const FRAMES_EVERY_SEC = 6;
const FRAMES_MAX = 854;
const FRAMES_SCALE_W = 480;
const JPG_QUALITY = 3;

// ⚠️ Resolución por defecto bajada a 720×1280 para ahorrar RAM
const TARGET_W = Number(process.env.TARGET_W || 720);
const TARGET_H = Number(process.env.TARGET_H || 1280);

const MIRROR = true;
const PRE_ZOOM = 1.12;
const ROTATE_DEG = 0;

const CONTRAST = 1.15;
const BRIGHTNESS = 0.05;
const SATURATION = 1.1;
const SHARPEN = 0;

// ⚠️ CRF y PRESET más ligeros por defecto
const LOOP_VIDEO = true;
const CRF = Number(process.env.CRF || 24);
const PRESET = process.env.PRESET || 'ultrafast';
const AUDIO_BITRATE = '192k';

const THREADS = Number(process.env.FFMPEG_THREADS || 1);
const FILTER_THREADS = Number(process.env.FILTER_THREADS || 1);
const FILTER_COMPLEX_THREADS = Number(process.env.FILTER_COMPLEX_THREADS || 1);

// Timeouts/limites
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 60_000);
const READ_TIMEOUT_MS    = Number(process.env.READ_TIMEOUT_MS    || 120_000);
const RENDER_TIMEOUT_MS  = Number(process.env.RENDER_TIMEOUT_MS  || 25 * 60_000); // 25 min
const JOB_TIMEOUT_MS     = Number(process.env.JOB_TIMEOUT_MS     || 30 * 60_000); // 30 min

// Directorio de salidas (persistente por id)
const OUT_DIR = join(tmpdir(), 'renders');
await mkdir(OUT_DIR, { recursive: true });

// =========================
// Utilidades
// =========================
const execFileP = promisify(execFile);

async function sh(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileP(cmd, args, {
    maxBuffer: 8 * 1024 * 1024, // 8 MB
    timeout: 0,
    ...opts,
  });
  return { stdout, stderr };
}

// Ejecuta ffmpeg con detección de OOM y mensaje claro
async function runFfmpeg(args, timeoutMs) {
  try {
    await execFileP('ffmpeg', args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    const stderr = String(err.stderr || '');
    const killed =
      err.killed ||
      err.signal === 'SIGKILL' ||
      err.code === 137 ||
      /Killed|Out of memory|Cannot allocate|std::bad_alloc/i.test(stderr);

    if (killed) {
      throw new Error(
        'ffmpeg OOM (memoria insuficiente). Sube de plan o baja resolución/preset.'
      );
    }
    // recorta stderr para no desbordar respuestas
    const brief = stderr ? stderr.slice(0, 800) : (err.message || 'ffmpeg failed');
    throw new Error(`ffmpeg failed: ${brief}`);
  }
}

function toNodeReadable(stream) {
  if (!stream) throw new Error('empty stream');
  return typeof stream.pipe === 'function' ? stream : Readable.fromWeb(stream);
}

function assertContentType(res, allowed, label) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    throw new Error(`${label}: got HTML (probable página o enlace no directo)`);
  }
  if (!allowed.some((s) => ct.includes(s))) {
    throw new Error(`${label}: unexpected content-type ${ct || '(none)'}`);
  }
}

// Descarga con timeout de conexión y de lectura del stream
async function downloadToFile(
  url,
  destPath,
  {
    allowedCT,
    label,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    readTimeoutMs = READ_TIMEOUT_MS,
  } = {}
) {
  const ctl = new AbortController();
  const connectTimer = setTimeout(() => ctl.abort(), connectTimeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!res.ok) throw new Error(`${label}: fetch failed ${res.status}`);
  if (allowedCT) assertContentType(res, allowedCT, label);

  const body = toNodeReadable(res.body);
  const ws = createWriteStream(destPath);

  // Read-timeout: si no llega data en readTimeoutMs, aborta
  let readTimer = setTimeout(() => {
    try { body.destroy(new Error(`${label}: read timeout`)); } catch {}
    try { ws.destroy(new Error(`${label}: read timeout`)); } catch {}
  }, readTimeoutMs);

  body.on('data', () => {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      try { body.destroy(new Error(`${label}: read timeout`)); } catch {}
      try { ws.destroy(new Error(`${label}: read timeout`)); } catch {}
    }, readTimeoutMs);
  });

  try {
    await pipeline(body, ws);
  } catch (e) {
    try { await rm(destPath, { force: true }); } catch {}
    throw e;
  } finally {
    clearTimeout(readTimer);
  }
}

async function probeDuration(filePath) {
  try {
    const { stdout } = await sh('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
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

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function withTimeout(promise, ms, onTimeout) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(onTimeout || `Timeout after ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(t); }
}

// =========================
// Cola en memoria (async)
// =========================
const JOBS = new Map(); // id -> { id, status, outPath, error, createdAt, updatedAt, doneAt, params }
let RUNNING = 0;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY ?? 1) || 1);
const OUTPUT_TTL_MS = Number(process.env.OUTPUT_TTL_MS || 30 * 60 * 1000);

function enqueueRender(params) {
  const id = randomUUID();
  const outPath = join(OUT_DIR, `${id}.mp4`);
  JOBS.set(id, {
    id,
    status: 'queued',
    outPath,
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
  for (const job of JOBS.values()) if (job.status === 'queued') return job;
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
  // Heartbeat de "sigue vivo"
  const hb = setInterval(() => { job.updatedAt = Date.now(); }, 5000);
  try {
    await withTimeout(
      doRenderOnce(job.id, job.params, job.outPath),
      JOB_TIMEOUT_MS,
      'render job timeout'
    );
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

// Limpieza periódica
setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (job.status === 'done' && job.doneAt && now - job.doneAt > OUTPUT_TTL_MS) {
      try { if (job.outPath) await rm(job.outPath, { force: true }); } catch {}
      JOBS.delete(id);
    }
    if (job.status === 'error' && now - job.updatedAt > 10 * 60 * 1000) {
      JOBS.delete(id);
    }
  }
}, 5 * 60 * 1000);

// =========================
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// -------- /frames --------
app.post('/frames', async (req, res) => {
  try {
    const { video_url, every_sec, max_frames, scale, jpg_quality } = req.body || {};
    if (!video_url) return res.status(400).json({ error: 'video_url required' });

    const EVERY_SEC   = Math.max(1, Number(every_sec ?? FRAMES_EVERY_SEC));
    const MAX_FRAMES  = Math.max(1, Math.min(50, Number(max_frames ?? FRAMES_MAX)));
    const SCALE_W     = Math.max(240, Math.min(2160, Number(scale ?? FRAMES_SCALE_W)));
    const JPGQ        = Math.max(2, Math.min(7, Number(jpg_quality ?? JPG_QUALITY)));

    const inFile = join(tmpdir(), `in_${Date.now()}.mp4`);
    await downloadToFile(video_url, inFile, { allowedCT: ['video','mp4','octet-stream'], label: 'video_url' });
    const dur = await probeDuration(inFile);

    let times = [];
    if (dur > 0) {
      for (let t = EVERY_SEC; t <= dur; t += EVERY_SEC) {
        times.push(+t.toFixed(3));
        if (times.length >= MAX_FRAMES) break;
      }
      if (times.length === 0) times = [+Math.max(0, dur/2).toFixed(3)];
    }

    const frames = [];
    if (times.length) {
      for (const t of times.slice(0, MAX_FRAMES)) {
        const out = join(tmpdir(), `f_${t}_${Date.now()}.jpg`);
        await sh('ffmpeg', [
          '-y','-v','error',
          '-ss', String(t), '-i', inFile,
          '-frames:v','1',
          '-vf', `scale=${SCALE_W}:-2:flags=lanczos`,
          '-q:v', String(JPGQ),
          '-threads', String(THREADS),
          out,
        ]);
        const buf = await readFile(out);
        frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
        await rm(out, { force: true });
      }
    } else {
      const outPattern = join(tmpdir(), `f_${Date.now()}-%03d.jpg`);
      await sh('ffmpeg', [
        '-y','-v','error',
        '-i', inFile,
        '-vf', `fps=1/${EVERY_SEC},scale=${SCALE_W}:-2:flags=lanczos`,
        '-frames:v', String(MAX_FRAMES),
        '-q:v', String(JPGQ),
        '-threads', String(THREADS),
        outPattern,
      ]);
      for (let i = 1; i <= MAX_FRAMES; i++) {
        const p = outPattern.replace('%03d', String(i).padStart(3, '0'));
        try {
          const buf = await readFile(p);
          frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
          await rm(p, { force: true });
        } catch { break; }
      }
    }

    await rm(inFile, { force: true });
    res.json({ frames, count: frames.length, duration: dur, used_times: times.slice(0, FRAMES_MAX) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// =========================
// Render asíncrono
// =========================
app.post('/render', async (req, res) => {
  try {
    const {
      video_url, audio_url,
      srt_url, bgm_url,
      bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
      bgm_offset_sec,
    } = req.body || {};

    if (!video_url || !audio_url) {
      return res.status(400).json({ error: 'video_url and audio_url required' });
    }

    const id = enqueueRender({
      video_url, audio_url, srt_url, bgm_url,
      bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
      bgm_offset_sec,
    });

    const base = getBase(req);
    return res.status(202).json({
      id,
      status_url: `${base}/render/${id}`,
      video_url:  `${base}/render/${id}/video`,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

app.get('/render/:id', async (req, res) => {
  const id = req.params.id;
  const base = getBase(req);

  let job = JOBS.get(id);
  if (!job) {
    const outPath = join(OUT_DIR, `${id}.mp4`);
    try {
      await access(outPath, FS_CONST.F_OK);
      return res.json({
        id, status: 'done', error: null,
        createdAt: null, updatedAt: null, doneAt: null,
        video_url: `${base}/render/${id}/video`,
      });
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
    if (job.status === 'error') return res.status(500).json({ error: job.error });
    if (job.status !== 'done') return res.status(425).json({ error: 'not ready' });
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
// Render real (una vez)
// =========================
async function doRenderOnce(id, params, outPath) {
  const {
    video_url, audio_url,
    srt_url, bgm_url,
    bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
    bgm_offset_sec,
  } = params;

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.mp3`);
  let srtPath = null;
  let bgmPath = null;

  try {
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

    // ===== Duraciones para loop finito (evita -stream_loop -1) =====
    const durV = await probeDuration(inV);
    const durA = await probeDuration(inA);
    const durB = bgmPath ? await probeDuration(bgmPath) : 0;

    const videoInputArgs = [];
    if (LOOP_VIDEO && durV > 0 && durA > 0 && durV < durA) {
      const loops = Math.max(0, Math.ceil(durA / durV) - 1);
      if (loops > 0) videoInputArgs.push('-stream_loop', String(loops));
    }
    videoInputArgs.push('-i', inV);

    const bgmInputArgs = [];
    if (bgmPath) {
      // cubrir VO + offset
      const need = (durA || 0) + (Number(bgm_offset_sec || 0));
      if (durB > 0 && need > durB) {
        const loops = Math.max(0, Math.ceil(need / durB) - 1);
        if (loops > 0) bgmInputArgs.push('-stream_loop', String(loops));
      }
      bgmInputArgs.push('-i', bgmPath);
    }

    // ====== VIDEO FILTERS ======
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
      const ML = Math.round(TARGET_W * 0.04);
      const MR = ML;
      const MV = Math.round(TARGET_H * 0.05);
      const style = [
        'FontName=DejaVu Sans',
        `Fontsize=${FS}`,
        'BorderStyle=1','Outline=0','Shadow=0',
        'PrimaryColour=&H00FFFFFF&',
        'Alignment=2',
        `MarginV=${MV}`, `MarginL=${ML}`, `MarginR=${MR}`,
        'WrapStyle=0',
      ].join(',');
      vf.push(
        `subtitles='${srtPath.replace(/\\/g,'/')}':original_size=${TARGET_W}x${TARGET_H}:force_style='${style}':charenc=UTF-8`
      );
    }

    const vChain = `[0:v]${vf.join(',')}[vout]`;

    // ====== AUDIO (VO + BGM con ducking) ======
    const BGM_VOL  = Math.max(0, Math.min(2, Number(bgm_volume ?? 0.16)));
    const DUCK     = duck === undefined ? true : !!duck;
    const DUCK_T   = Number(duck_threshold ?? 0.1);
    const DUCK_R   = Number(duck_ratio ?? 8);
    const DUCK_A   = Number(duck_attack_ms ?? 5);
    const DUCK_REL = Number(duck_release_ms ?? 250);
    const BGM_OFF  = Math.max(0, Number(bgm_offset_sec ?? 0));
    const BGM_OFF_MS = Math.round(BGM_OFF * 1000);

    let aChain;
    if (bgmPath) {
      const maybeDelay = BGM_OFF_MS ? `,adelay=${BGM_OFF_MS}|${BGM_OFF_MS}` : '';
      aChain = [
        `[1:a]aresample=async=1:min_hard_comp=0.100:first_pts=0,` +
          `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
          `asplit=2[nar_mix][nar_side]`,
        `[2:a]aresample=async=1:min_hard_comp=0.100:first_pts=0,` +
          `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
          `volume=${BGM_VOL}${maybeDelay}[bgm]`,
        DUCK
          ? `[bgm][nar_side]sidechaincompress=threshold=${DUCK_T}:ratio=${DUCK_R}:attack=${DUCK_A}:release=${DUCK_REL}[duck]`
          : `[bgm]anull[duck]`,
        `[nar_mix][duck]amix=inputs=2:duration=first:dropout_transition=200[aout]`,
      ].join(';');
    } else {
      aChain =
        `[1:a]aresample=async=1:min_hard_comp=0.100:first_pts=0,` +
        `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`;
    }

    const filterComplex = [vChain, aChain].join(';');

    // ====== ffmpeg (sin stream_loop infinito; filtros limitados) ======
    const args = [
      '-y','-v','error',
      ...videoInputArgs,       // [-stream_loop N] -i inV
      '-i', inA,               // VO
      ...bgmInputArgs,         // (opcional) [-stream_loop N] -i bgm
      '-filter_complex', filterComplex,
      '-map','[vout]','-map','[aout]',
      '-shortest',
      '-c:v','libx264',
      '-preset', PRESET,
      '-crf', String(CRF),
      '-c:a','aac',
      '-b:a', AUDIO_BITRATE,
      '-pix_fmt','yuv420p',
      '-movflags','+faststart',
      '-threads', String(THREADS),
      '-filter_threads', String(FILTER_THREADS),
      '-filter_complex_threads', String(FILTER_COMPLEX_THREADS),
      '-max_muxing_queue_size','4096',
      outPath
    ];

    await runFfmpeg(args, RENDER_TIMEOUT_MS);

    // Limpia temporales
    try { await rm(inV, { force: true }); } catch {}
    try { await rm(inA, { force: true }); } catch {}
    try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    try { if (bgmPath) await rm(bgmPath, { force: true }); } catch {}
  } catch (err) {
    try { await rm(inV, { force: true }); } catch {}
    try { await rm(inA, { force: true }); } catch {}
    try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    try { if (bgmPath) await rm(bgmPath, { force: true }); } catch {}
    try { await rm(outPath, { force: true }); } catch {}
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
