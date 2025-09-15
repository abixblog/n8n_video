import express from 'express';
import cors from 'cors';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream, createReadStream } from 'node:fs';
import { readFile, rm, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// =========================
// Config estática
// =========================

// Frames (solo para /frames)
const FRAMES_EVERY_SEC = 6;
const FRAMES_MAX = 854;
const FRAMES_SCALE_W = 480;
const JPG_QUALITY = 3;

// Render
const TARGET_W = Number(process.env.TARGET_W || 1080);
const TARGET_H = Number(process.env.TARGET_H || 1920);

const MIRROR = true;
const PRE_ZOOM = 1.12;
const ROTATE_DEG = 0;

const CONTRAST = 1.15;
const BRIGHTNESS = 0.05;
const SATURATION = 1.1;
const SHARPEN = 0;

// Calidad / rendimiento
const CRF = Number(process.env.CRF || 21);
const PRESET = process.env.PRESET || 'faster';
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '192k';
// 0 = auto (FFmpeg decide hilos según CPU)
const THREADS = Number(process.env.FFMPEG_THREADS ?? 0);

// Loop: dejamos infinito y cortamos con -shortest
const LOOP_VIDEO = process.env.LOOP_VIDEO === 'false' ? false : true;

// Timeouts de red
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 60_000);
const READ_TIMEOUT_MS    = Number(process.env.READ_TIMEOUT_MS    || 180_000);

// Directorio de trabajo (para archivos intermedios)
const OUT_DIR = join(tmpdir(), 'renders-sync');
await mkdir(OUT_DIR, { recursive: true });

// =========================
// Utilidades
// =========================
const execFileP = promisify(execFile);

async function runFfmpeg(args) {
  try {
    // Sin timeout aquí: ahora renderizas en caliente en un server con más recursos
    await execFileP('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const stderr = String(err.stderr || '');
    const killed =
      err.killed ||
      err.signal === 'SIGKILL' ||
      err.code === 137 ||
      /Killed|Out of memory|Cannot allocate|std::bad_alloc/i.test(stderr);

    if (killed) {
      throw new Error('ffmpeg: memoria insuficiente (OOM). Baja resolución/preset o sube de plan.');
    }
    throw new Error(`ffmpeg failed: ${(stderr || err.message || '').slice(0, 1000)}`);
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
  } finally {
    clearTimeout(readTimer);
  }
}

// =========================
// App
// =========================
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// -------- /frames (igual que antes) --------
app.post('/frames', async (req, res) => {
  try {
    const { video_url, every_sec, max_frames, scale, jpg_quality } = req.body || {};
    if (!video_url) return res.status(400).json({ error: 'video_url required' });

    const EVERY_SEC = Math.max(1, Number(every_sec ?? FRAMES_EVERY_SEC));
    const MAX_FR    = Math.max(1, Math.min(50, Number(max_frames ?? FRAMES_MAX)));
    const SCALE_W   = Math.max(240, Math.min(2160, Number(scale ?? FRAMES_SCALE_W)));
    const JPGQ      = Math.max(2, Math.min(7, Number(jpg_quality ?? JPG_QUALITY)));

    const inFile = join(OUT_DIR, `in_${Date.now()}.mp4`);
    await downloadToFile(video_url, inFile, {
      allowedCT: ['video', 'mp4', 'octet-stream', 'quicktime', 'x-matroska'],
      label: 'video_url',
    });

    const outPattern = join(OUT_DIR, `f_${Date.now()}-%03d.jpg`);
    await runFfmpeg([
      '-y', '-v', 'error',
      '-i', inFile,
      '-vf', `fps=1/${EVERY_SEC},scale=${SCALE_W}:-2:flags=lanczos`,
      '-frames:v', String(MAX_FR),
      '-q:v', String(JPGQ),
      '-threads', String(THREADS),
      outPattern,
    ]);

    const frames = [];
    for (let i = 1; i <= MAX_FR; i++) {
      const p = outPattern.replace('%03d', String(i).padStart(3, '0'));
      try {
        const buf = await readFile(p);
        frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
        await rm(p, { force: true });
      } catch {
        break;
      }
    }
    await rm(inFile, { force: true });
    res.json({ frames, count: frames.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// -------- /render (SÍNCRONO) --------
app.post('/render', async (req, res) => {
  const {
    video_url,
    audio_url,       // narración / VO (requerido)
    srt_url,         // opcional
    bgm_url,         // opcional: música de fondo
    bgm_volume,      // 0..2 (por defecto 0.16)
    duck,            // true/false (por defecto true)
    duck_threshold,  // p.ej. 0.1
    duck_ratio,      // p.ej. 8
    duck_attack_ms,  // p.ej. 5
    duck_release_ms, // p.ej. 250
    bgm_offset_sec,  // p.ej. 0..n
  } = req.body || {};

  if (!video_url || !audio_url) {
    return res.status(400).json({ error: 'video_url and audio_url required' });
  }

  const inV = join(OUT_DIR, `v_${Date.now()}.mp4`);
  const inA = join(OUT_DIR, `a_${Date.now()}.mp3`);
  const out = join(OUT_DIR, `out_${Date.now()}.mp4`);
  let srtPath = null;
  let bgmPath = null;
  let finished = false;

  try {
    // --------- Descargas ---------
    await downloadToFile(video_url, inV, {
      allowedCT: ['video','mp4','quicktime','x-matroska','octet-stream'],
      label: 'video_url',
    });
    await downloadToFile(audio_url, inA, {
      allowedCT: ['audio','mpeg','mp3','aac','mp4','x-m4a','wav','x-wav','octet-stream'],
      label: 'audio_url',
    });
    if (srt_url) {
      srtPath = join(OUT_DIR, `subs_${Date.now()}.srt`);
      await downloadToFile(srt_url, srtPath, {
        allowedCT: ['srt','text','plain','octet-stream'],
        label: 'srt_url',
      });
    }
    if (bgm_url) {
      bgmPath = join(OUT_DIR, `bgm_${Date.now()}.mp3`);
      await downloadToFile(bgm_url, bgmPath, {
        allowedCT: ['audio','mpeg','mp3','aac','mp4','x-m4a','wav','x-wav','octet-stream'],
        label: 'bgm_url',
      });
    }

    // --------- VIDEO FILTERS ---------
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

    // --------- AUDIO (VO + BGM con ducking) ---------
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

    // --------- FFmpeg (render directo) ---------
    const args = [
      '-y', '-v', 'error',
      ...(LOOP_VIDEO ? ['-stream_loop', '-1'] : []),
      '-i', inV,                         // 0:v
      '-i', inA,                         // 1:a VO
      ...(bgmPath ? ['-stream_loop', '-1', '-i', bgmPath] : []), // 2:a BGM
      '-filter_complex', filterComplex,
      '-map', '[vout]', '-map', '[aout]',
      '-shortest',
      '-c:v', 'libx264',
      '-preset', PRESET,
      '-crf', String(CRF),
      '-c:a', 'aac',
      '-b:a', AUDIO_BITRATE,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-threads', String(THREADS),
      out,
    ];

    await runFfmpeg(args);

    // --------- Enviar el MP4 ---------
    const st = await stat(out);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Content-Disposition', 'inline; filename="render.mp4"');
    await pipeline(createReadStream(out), res);
    finished = true;
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  } finally {
    // Limpieza
    const clean = async () => {
      try { await rm(inV, { force: true }); } catch {}
      try { await rm(inA, { force: true }); } catch {}
      try { await rm(out, { force: true }); } catch {}
      try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
      try { if (bgmPath) await rm(bgmPath, { force: true }); } catch {}
    };
    if (finished) await clean();
    else {
      res.on?.('close', clean);
      await clean();
    }
  }
});

// -------- /health --------
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// ---------------- listen ----------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ready on :${PORT} (/frames, /render [POST])`);
});