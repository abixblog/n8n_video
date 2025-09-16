// server.mjs  (Node 18+ con "type":"module")
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
// Config por ENV (tuneable)
// =========================

// Frames (/frames)
const FRAMES_EVERY_SEC = Number(process.env.FRAMES_EVERY_SEC || 6);
const FRAMES_MAX       = Number(process.env.FRAMES_MAX || 10);
const FRAMES_SCALE_W   = Number(process.env.FRAMES_SCALE_W || 720);
const JPG_QUALITY      = Number(process.env.JPG_QUALITY || 3);

// Render (intento primario)
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

// Encoder/velocidad (primario)
const ENCODER = process.env.ENCODER || 'libx264'; // 'libx264' | 'h264_nvenc' | 'h264_qsv' | 'h264_vaapi'
const PRESET  = process.env.PRESET || 'superfast';
const CRF     = Number(process.env.CRF || 21);
const GOP     = Number(process.env.GOP || 120);
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '192k';
const THREADS = Number(process.env.FFMPEG_THREADS ?? 0); // 0 = auto
const HWACCEL = process.env.HWACCEL; // ej. 'auto'

// Fallback (si OOM/timeout)
const FB_ENABLE                 = process.env.FB_ENABLE === 'false' ? false : true;
const FB_W                      = Number(process.env.FB_W || 720);
const FB_H                      = Number(process.env.FB_H || 1280);
const FB_DISABLE_SUBS           = process.env.FB_DISABLE_SUBS === 'false' ? false : true;
const FB_THREADS                = Number(process.env.FB_THREADS || 1);
const FB_FILTER_THREADS         = Number(process.env.FB_FILTER_THREADS || 1);
const FB_ENCODER                = process.env.FB_ENCODER || ENCODER; // puedes forzar libx264 aquí
const FB_X264_PRESET            = process.env.FB_X264_PRESET || 'ultrafast';
const FB_X264_CRF               = Number(process.env.FB_X264_CRF || 28);
const FB_NVENC_PRESET           = process.env.FB_NVENC_PRESET || 'p1';
const FB_NVENC_CQ               = Number(process.env.FB_NVENC_CQ || 28);

// Red / timeouts
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 60_000);
const READ_TIMEOUT_MS    = Number(process.env.READ_TIMEOUT_MS    || 180_000);
const RENDER_TIMEOUT_MS  = Number(process.env.RENDER_TIMEOUT_MS  || 30 * 60_000); // 30 min
const JOB_TIMEOUT_MS     = Number(process.env.JOB_TIMEOUT_MS     || 35 * 60_000); // 35 min

// Cola
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY ?? 1));
const OUTPUT_TTL_MS   = Number(process.env.OUTPUT_TTL_MS || 30 * 60_000);

// Salidas
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

  // read-timeout
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

function isOomOrTimeout(err) {
  const s = `${err?.stderr || ''}\n${err?.message || ''}`;
  return /Out of memory|Cannot allocate|std::bad_alloc|Killed|ENOMEM|ffmpeg OOM|Timeout/i.test(s);
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
    if (isOomOrTimeout(err)) {
      const stderr = String(err.stderr || '');
      throw new Error('ffmpeg OOM/timeout');
    }
    const stderr = String(err.stderr || err.stdout || '');
    throw new Error(`ffmpeg failed: ${(stderr || err.message || '').slice(0, 1200)}`);
  }
}

function getBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0];
  const host  = (req.headers['x-forwarded-host']  || req.get('host'));
  return `${proto}://${host}`;
}

async function probeDuration(filePath) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1', filePath
    ]);
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) ? d : 0;
  } catch { return 0; }
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
// App
// =========================
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// /frames simple y rápido
app.post('/frames', async (req, res) => {
  try {
    const { video_url, every_sec, max_frames, scale, jpg_quality } = req.body || {};
    if (!video_url) return res.status(400).json({ error: 'video_url required' });

    const EVERY_SEC = Math.max(1, Number(every_sec ?? FRAMES_EVERY_SEC));
    const MAXF      = Math.max(1, Math.min(50, Number(max_frames ?? FRAMES_MAX)));
    const SCALE_W   = Math.max(240, Math.min(2160, Number(scale ?? FRAMES_SCALE_W)));
    const JPGQ      = Math.max(2, Math.min(7, Number(jpg_quality ?? JPG_QUALITY)));

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
      '-vf', `fps=1/${EVERY_SEC},scale=${SCALE_W}:-2:flags=fast_bilinear`,
      '-frames:v', String(MAXF),
      '-q:v', String(JPGQ),
      '-threads', String(THREADS || 0),
      outPattern
    ]);

    const frames = [];
    for (let i = 1; i <= MAXF; i++) {
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

// /render asíncrono
app.post('/render', async (req, res) => {
  try {
    const {
      video_url, audio_url,
      srt_url, bgm_url,
      bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
      bgm_offset_sec,
    } = req.body || {};

    if (!video_url || !audio_url)
      return res.status(400).json({ error: 'video_url and audio_url required' });

    const id = enqueueRender({
      video_url, audio_url, srt_url, bgm_url,
      bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
      bgm_offset_sec,
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
// Render real con fallback
// =========================
async function doRenderOnce(job) {
  const {
    video_url, audio_url,
    srt_url, bgm_url,
    bgm_volume, duck, duck_threshold, duck_ratio, duck_attack_ms, duck_release_ms,
    bgm_offset_sec,
  } = job.params;

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.mp3`);
  let srtPath = null, bgmPath = null;

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
  if (bgm_url) {
    bgmPath = join(tmpdir(), `bgm_${Date.now()}.mp3`);
    await downloadToFile(bgm_url, bgmPath, {
      allowedCT: ['audio','mpeg','mp3','aac','mp4','x-m4a','wav','x-wav','octet-stream'],
      label: 'bgm_url',
    });
  }

  // Función para armar filtros de video según modo
  const buildVf = (mode /* 'primary' | 'fallback' */, allowSubs = true) => {
    const vf = [];
    if (mode === 'primary') {
      if (MIRROR) vf.push('hflip');
      if (PRE_ZOOM && PRE_ZOOM !== 1) vf.push(`scale=iw*${PRE_ZOOM}:ih*${PRE_ZOOM},crop=iw:ih`);
      if (ROTATE_DEG) vf.push(`rotate=${ROTATE_DEG}*PI/180:fillcolor=black`);
      if (CONTRAST !== 1 || BRIGHTNESS !== 0 || SATURATION !== 1) {
        vf.push(`eq=contrast=${CONTRAST}:brightness=${BRIGHTNESS}:saturation=${SATURATION}`);
      }
      if (SHARPEN > 0) vf.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${SHARPEN}`);
      vf.push(`scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase:flags=fast_bilinear`);
      vf.push(`crop=${TARGET_W}:${TARGET_H}`);
    } else {
      // Fallback: filtros mínimos
      vf.push(`scale=${FB_W}:${FB_H}:force_original_aspect_ratio=increase:flags=fast_bilinear`);
      vf.push(`crop=${FB_W}:${FB_H}`);
    }

    if (allowSubs && srtPath) {
      const baseH = mode === 'primary' ? TARGET_H : FB_H;
      const baseW = mode === 'primary' ? TARGET_W : FB_W;
      const FS = Math.max(6, Math.round(6 * (baseH / 1080)));
      const ML = Math.round(baseW * 0.04);
      const MR = ML;
      const MV = Math.round(baseH * 0.05);
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
        `subtitles='${srtPath.replace(/\\/g,'/')}':original_size=${baseW}x${baseH}:force_style='${style}':charenc=UTF-8`
      );
    }
    return `[0:v]${vf.join(',')}[vout]`;
  };

  // Audio chain builder
  const buildA = (mode /* 'primary' | 'fallback' */) => {
    const BGM_VOL   = Math.max(0, Math.min(2, Number(bgm_volume ?? 0.16)));
    const DUCK      = duck === undefined ? true : !!duck;
    const DUCK_T    = Number(duck_threshold ?? 0.1);
    const DUCK_R    = Number(duck_ratio ?? 8);
    const DUCK_A    = Number(duck_attack_ms ?? 5);
    const DUCK_REL  = Number(duck_release_ms ?? 250);
    const BGM_OFF_S = Math.max(0, Number(bgm_offset_sec ?? 0));
    const BGM_OFF_MS = Math.round(BGM_OFF_S * 1000);

    if (!bgmPath) {
      return `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`;
    }

    const maybeDelay = BGM_OFF_MS ? `,adelay=${BGM_OFF_MS}|${BGM_OFF_MS}` : '';

    if (mode === 'primary') {
      return [
        `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[nmix][nside]`,
        `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${BGM_VOL}${maybeDelay}[bgm]`,
        `[bgm][nside]sidechaincompress=threshold=${DUCK_T}:ratio=${DUCK_R}:attack=${DUCK_A}:release=${DUCK_REL}[duck]`,
        `[nmix][duck]amix=inputs=2:duration=first:dropout_transition=200[aout]`,
      ].join(';');
    }
    // Fallback: sin ducking (más simple)
    return [
      `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[nmix]`,
      `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${BGM_VOL}${maybeDelay}[bgm]`,
      `[nmix][bgm]amix=inputs=2:duration=first:dropout_transition=200[aout]`,
    ].join(';');
  };

  // Ejecuta un intento de render con parámetros dados
  const renderAttempt = async (mode /* 'primary' | 'fallback' */) => {
    const useSubs = !(mode === 'fallback' && FB_DISABLE_SUBS);
    const vChain  = buildVf(mode, useSubs);
    const aChain  = buildA(mode);
    const filterComplex = [vChain, aChain].join(';');

    // Selección de encoder/flags
    const useEncoder = mode === 'fallback' ? FB_ENCODER : ENCODER;
    const args = [
      '-y','-v','error',
      ...(HWACCEL ? ['-hwaccel', HWACCEL] : []),
      ...(LOOP_VIDEO ? ['-stream_loop','-1'] : []),
      '-i', inV,
      '-i', inA,
      ...(bgmPath ? ['-stream_loop','-1','-i', bgmPath] : []),
      '-filter_complex', filterComplex,
      '-map','[vout]','-map','[aout]',
      '-shortest',
      // video
      '-c:v', useEncoder,
      ...(useEncoder === 'libx264'
        ? (mode === 'fallback'
            ? ['-preset', FB_X264_PRESET, '-crf', String(FB_X264_CRF), '-x264-params', `keyint=${GOP}:min-keyint=${GOP}:scenecut=0`]
            : ['-preset', PRESET,           '-crf', String(CRF),        '-x264-params', `keyint=${GOP}:min-keyint=${GOP}:scenecut=0`]
          )
        : // NVENC/QSV/VAAPI (simple y rápido)
          (mode === 'fallback'
            ? ['-preset', FB_NVENC_PRESET, '-rc','vbr','-cq', String(FB_NVENC_CQ), '-g', String(GOP)]
            : ['-g', String(GOP), '-b:v','0']
          )
      ),
      // audio
      '-c:a','aac','-b:a', AUDIO_BITRATE,
      // mux
      '-pix_fmt','yuv420p',
      '-movflags','+faststart',
      ...(mode === 'fallback'
        ? ['-threads', String(FB_THREADS), '-filter_threads', String(FB_FILTER_THREADS)]
        : ['-threads', String(THREADS || 0), '-filter_threads', '0']
      ),
      '-max_muxing_queue_size','2048',
      job.outPath,
    ];

    const to = mode === 'fallback' ? Math.max(RENDER_TIMEOUT_MS * 0.6, 10 * 60_000) : RENDER_TIMEOUT_MS;
    await runFfmpeg(args, to);
  };

  try {
    // Primer intento (normal)
    await renderAttempt('primary');
  } catch (err) {
    if (!FB_ENABLE || !isOomOrTimeout(err)) {
      // error "real" o fallback deshabilitado
      await cleanup();
      throw err;
    }
    // Fallback por OOM/timeout
    try {
      await renderAttempt('fallback');
    } catch (err2) {
      await cleanup();
      throw err2;
    }
  }

  // limpiar temporales
  await cleanup();

  async function cleanup() {
    try { await rm(inV, { force: true }); } catch {}
    try { await rm(inA, { force: true }); } catch {}
    try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    try { if (bgmPath) await rm(bgmPath, { force: true }); } catch {}
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
