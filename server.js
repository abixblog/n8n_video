import express from 'express';
import cors from 'cors';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream, createReadStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// =========================
// Configuración ESTÁTICA
// =========================

// FRAMES (parámetros fijos)
const FRAMES_EVERY_SEC = 6; // 1 frame cada 6 s
const FRAMES_MAX = 10; // máximo 10 frames
const FRAMES_SCALE_W = 1080; // ancho de las miniaturas
const JPG_QUALITY = 3; // 2 (mejor) .. 7 (peor)

// RENDER (efectos fijos)
const TARGET_W = 1080;
const TARGET_H = 1920;

const MIRROR = true; // espejo horizontal
const PRE_ZOOM = 1.12; // zoom leve previo (escala relativa)
const ROTATE_DEG = 0; // grados de rotación

const CONTRAST = 1.15;
const BRIGHTNESS = 0.05;
const SATURATION = 1.1;
const SHARPEN = 0; // 0 = off; típicamente 0.3–1.0

const LOOP_VIDEO = true; // si el audio es más largo, repetir video
const CRF = 21; // calidad H.264
const PRESET = 'veryfast';
const AUDIO_BITRATE = '192k';
const THREADS = Number(process.env.FFMPEG_THREADS || 1);

// =========================
// Utilidades
// =========================

const execFileP = promisify(execFile);

async function sh(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileP(cmd, args, { ...opts });
  return { stdout, stderr };
}

function toNodeReadable(stream) {
  // Convierte Web ReadableStream -> Node stream; si ya es Node stream (PassThrough), lo deja igual
  if (!stream) throw new Error('empty stream');
  return typeof stream.pipe === 'function' ? stream : Readable.fromWeb(stream);
}

async function fetchWithTimeout(url, { timeoutMs = 30000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function assertContentType(res, allowed, label) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    throw new Error(
      `${label}: got HTML (probable página de plataforma o enlace no directo).`
    );
  }
  if (!allowed.some((s) => ct.includes(s))) {
    throw new Error(`${label}: unexpected content-type ${ct || '(none)'}`);
  }
}

// Devuelve duración en segundos (float). 0 si falla.
async function probeDuration(filePath) {
  try {
    const { stdout } = await sh('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

// =========================
// App
// =========================

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// -------- /frames (estático) --------
// Body: { video_url }
// Devuelve: { frames: [dataURL...], count, src }
// -------- /frames (DINÁMICO por duración) --------
// Body: { video_url, every_sec?, max_frames?, scale?, jpg_quality? }
// Devuelve: { frames: [dataURL...], count }
app.post('/frames', async (req, res) => {
  try {
    const { video_url, every_sec, max_frames, scale, jpg_quality } =
      req.body || {};

    if (!video_url)
      return res.status(400).json({ error: 'video_url required' });

    // Defaults (puedes ajustar estos valores por defecto si quieres)
    const EVERY_SEC = Math.max(1, Number(every_sec ?? 6));
    const MAX_FRAMES = Math.max(1, Math.min(50, Number(max_frames ?? 10)));
    const SCALE_W = Math.max(240, Math.min(2160, Number(scale ?? 1080)));
    const JPG_QUALITY = Math.max(2, Math.min(7, Number(jpg_quality ?? 3)));
    const THREADS = Number(process.env.FFMPEG_THREADS || 1);

    // 1) Descarga del video (streaming)
    const inFile = join(tmpdir(), `in_${Date.now()}.mp4`);
    const r = await fetchWithTimeout(video_url, { timeoutMs: 60000 });
    if (!r.ok)
      return res
        .status(400)
        .json({ error: `fetch video failed`, status: r.status });
    assertContentType(r, ['video', 'mp4', 'octet-stream'], 'video_url');
    await pipeline(toNodeReadable(r.body), createWriteStream(inFile));

    // 2) Duración con ffprobe
    const dur = await probeDuration(inFile);

    // 3) Construye los tiempos dinámicos
    let times = [];
    if (dur > 0) {
      // tiempos: EVERY_SEC, 2*EVERY_SEC, ... <= dur
      for (let t = EVERY_SEC; t <= dur; t += EVERY_SEC) {
        times.push(+t.toFixed(3));
        if (times.length >= MAX_FRAMES) break;
      }
      if (times.length === 0) {
        times = [+Math.max(0, dur / 2).toFixed(3)];
      }
    } else {
      const outPattern = join(tmpdir(), `f_${Date.now()}-%03d.jpg`);
      await sh('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-i',
        inFile,
        '-vf',
        `fps=1/${EVERY_SEC},scale=${SCALE_W}:-2:flags=lanczos`,
        '-frames:v',
        String(MAX_FRAMES),
        '-q:v',
        String(JPG_QUALITY),
        '-threads',
        String(THREADS),
        outPattern,
      ]);

      const frames = [];
      for (let i = 1; i <= MAX_FRAMES; i++) {
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
      return res.json({ frames, count: frames.length, duration: dur });
    }

    const frames = [];
    for (const t of times.slice(0, MAX_FRAMES)) {
      const out = join(tmpdir(), `f_${t}_${Date.now()}.jpg`);
      await sh('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-ss',
        String(t),
        '-i',
        inFile,
        '-frames:v',
        '1',
        '-vf',
        `scale=${SCALE_W}:-2:flags=lanczos`,
        '-q:v',
        String(JPG_QUALITY),
        '-threads',
        String(THREADS),
        out,
      ]);
      const buf = await readFile(out);
      frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
      await rm(out, { force: true });
    }

    await rm(inFile, { force: true });
    res.json({
      frames,
      count: frames.length,
      duration: dur,
      used_times: times.slice(0, MAX_FRAMES),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/render', async (req, res) => {
  const {
    video_url,
    audio_url,       // narración / VO
    srt_url,         // opcional
    bgm_url,         // opcional: música de fondo
    bgm_volume,      // opcional: 0..2 (por defecto 0.16)
    duck,            // opcional: true/false (por defecto true)
    duck_threshold,  // opcional: umbral (p.ej. 0.1)
    duck_ratio,      // opcional: compresión (p.ej. 8)
    duck_attack_ms,  // opcional: p.ej. 5
    duck_release_ms, // opcional: p.ej. 250
    bgm_offset_sec,  // opcional: retraso de la música en segundos
  } = req.body || {};

  if (!video_url || !audio_url) {
    return res.status(400).json({ error: 'video_url and audio_url required' });
  }

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.mp3`); // narración / VO
  let srtPath = null;
  let bgmPath = null;
  let ff; // proceso de ffmpeg para poder matarlo si el cliente corta

  const clean = async () => {
    try { await rm(inV, { force: true }); } catch {}
    try { await rm(inA, { force: true }); } catch {}
    try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    try { if (bgmPath) await rm(bgmPath, { force: true }); } catch {}
  };

  try {
    // --------- DESCARGAS ---------
    const vres = await fetchWithTimeout(video_url, { timeoutMs: 120000 });
    if (!vres.ok)
      return res.status(400).json({ error: 'fetch video failed', status: vres.status });
    assertContentType(vres, ['video', 'mp4', 'quicktime', 'x-matroska', 'octet-stream'], 'video_url');
    await pipeline(toNodeReadable(vres.body), createWriteStream(inV));

    const ares = await fetchWithTimeout(audio_url, { timeoutMs: 120000 });
    if (!ares.ok)
      return res.status(400).json({ error: 'fetch audio failed', status: ares.status });
    assertContentType(ares, ['audio','mpeg','mp3','aac','mp4','x-m4a','wav','x-wav','octet-stream'], 'audio_url');
    await pipeline(toNodeReadable(ares.body), createWriteStream(inA));

    if (srt_url) {
      srtPath = join(tmpdir(), `subs_${Date.now()}.srt`);
      const s = await fetchWithTimeout(srt_url, { timeoutMs: 60000 });
      if (!s.ok)
        return res.status(400).json({ error: 'fetch srt failed', status: s.status });
      assertContentType(s, ['srt','text','plain','octet-stream'], 'srt_url');
      await pipeline(toNodeReadable(s.body), createWriteStream(srtPath));
    }

    if (bgm_url) {
      bgmPath = join(tmpdir(), `bgm_${Date.now()}.mp3`);
      const b = await fetchWithTimeout(bgm_url, { timeoutMs: 120000 });
      if (!b.ok)
        return res.status(400).json({ error: 'fetch bgm failed', status: b.status });
      assertContentType(b, ['audio','mpeg','mp3','aac','mp4','x-m4a','wav','x-wav','octet-stream'], 'bgm_url');
      await pipeline(toNodeReadable(b.body), createWriteStream(bgmPath));
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
    const BGM_VOL = Math.max(0, Math.min(2, Number(bgm_volume ?? 0.16)));
    const DUCK = duck === undefined ? true : !!duck;
    const DUCK_T = Number(duck_threshold ?? 0.1);
    const DUCK_R = Number(duck_ratio ?? 8);
    const DUCK_A = Number(duck_attack_ms ?? 5);
    const DUCK_REL = Number(duck_release_ms ?? 250);
    const BGM_OFF = Math.max(0, Number(bgm_offset_sec ?? 0));
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
      aChain = `[1:a]aresample=async=1:min_hard_comp=0.100:first_pts=0,` +
               `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`;
    }

    const filterComplex = [vChain, aChain].join(';');

    // --------- STREAMING (evita 502) ---------
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="render.mp4"');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();

    const args = ['-hide_banner', '-loglevel', 'error'];

    if (LOOP_VIDEO) args.push('-stream_loop', '-1');
    args.push('-i', inV, '-i', inA);
    if (bgmPath) args.push('-stream_loop', '-1', '-i', bgmPath);

    args.push(
      '-filter_complex', filterComplex,
      '-map', '[vout]', '-map', '[aout]',
      '-shortest',
      '-c:v', 'libx264',
      '-preset', PRESET,
      '-crf', String(CRF),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', AUDIO_BITRATE,
      // MP4 fragmentado para reproducir mientras llega
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );

    ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // si el cliente cierra, matamos ffmpeg
    const onCloseClient = () => { try { ff.kill('SIGKILL'); } catch {} };
    res.on('close', onCloseClient);
    res.on('error', onCloseClient);

    // forward de stdout -> respuesta
    ff.stdout.pipe(res);

    // logs de error (opcional)
    ff.stderr.on('data', (d) => {
      // console.error('[ffmpeg]', d.toString());
    });

    ff.on('close', async (code) => {
      res.off('close', onCloseClient);
      res.off('error', onCloseClient);
      await clean();
      if (code !== 0 && !res.writableEnded) {
        res.destroy(new Error('ffmpeg failed'));
      }
    });

    ff.on('error', async (err) => {
      await clean();
      if (!res.headersSent) res.status(500).json({ error: String(err) });
      else res.destroy(err);
    });

  } catch (err) {
    await clean();
    if (!res.headersSent) res.status(500).json({ error: String(err) });
    else res.destroy(err);
  }
});


app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// ---------------- listen ----------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ready on :${PORT} (/frames, /render)`);
});
