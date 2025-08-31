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
      // Si el video es corto y no se alcanzó ningún múltiplo, toma 1 frame al medio:
      if (times.length === 0) {
        times = [+Math.max(0, dur / 2).toFixed(3)];
      }
    } else {
      // Fallback: si no tenemos duración, extraemos con fps como antes
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

    // 4) Extrae 1 frame por cada 'time' (más preciso/eficiente)
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

// -------- /render (estático) --------
// Body: { video_url, audio_url, srt_url? }
// Responde: MP4 (stream)
// -------- /render (estático) --------
// Body: { video_url, audio_url, srt_url? }
// Responde: MP4 (stream)
app.post('/render', async (req, res) => {
  const { video_url, audio_url, srt_url } = req.body || {};
  if (!video_url || !audio_url) {
    return res.status(400).json({ error: 'video_url and audio_url required' });
  }

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.mp3`);
  const out = join(tmpdir(), `out_${Date.now()}.mp4`);
  let srtPath = null;
  let finished = false;

  try {
    // Video
    const vres = await fetchWithTimeout(video_url, { timeoutMs: 120000 });
    if (!vres.ok)
      return res
        .status(400)
        .json({ error: 'fetch video failed', status: vres.status });
    assertContentType(
      vres,
      ['video', 'mp4', 'quicktime', 'x-matroska', 'octet-stream'],
      'video_url'
    );
    await pipeline(toNodeReadable(vres.body), createWriteStream(inV));

    // Audio
    const ares = await fetchWithTimeout(audio_url, { timeoutMs: 120000 });
    if (!ares.ok)
      return res
        .status(400)
        .json({ error: 'fetch audio failed', status: ares.status });
    assertContentType(
      ares,
      [
        'audio',
        'mpeg',
        'mp3',
        'aac',
        'mp4',
        'x-m4a',
        'wav',
        'x-wav',
        'octet-stream',
      ],
      'audio_url'
    );
    await pipeline(toNodeReadable(ares.body), createWriteStream(inA));

    // Subtítulos (opcional) — AQUÍ creamos srtPath
    // --- descarga del SRT (no lo borres) ---
    if (srt_url) {
      srtPath = join(tmpdir(), `subs_${Date.now()}.srt`);
      const s = await fetchWithTimeout(srt_url, { timeoutMs: 60000 });
      if (!s.ok)
        return res
          .status(400)
          .json({ error: 'fetch srt failed', status: s.status });
      assertContentType(s, ['srt', 'text', 'plain', 'octet-stream'], 'srt_url');
      await pipeline(toNodeReadable(s.body), createWriteStream(srtPath));
    }

    // --- cadena de filtros de video ---
    const vf = [];
    if (MIRROR) vf.push('hflip');
    if (PRE_ZOOM !== 1) vf.push(`scale=iw*${PRE_ZOOM}:ih*${PRE_ZOOM}`);
    vf.push('crop=iw:ih');
    if (ROTATE_DEG) vf.push(`rotate=${ROTATE_DEG}*PI/180`);
    vf.push(
      `eq=contrast=${CONTRAST}:brightness=${BRIGHTNESS}:saturation=${SATURATION}`
    );
    if (SHARPEN > 0)
      vf.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${SHARPEN}`);
    vf.push(
      `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase`
    );
    vf.push(`crop=${TARGET_W}:${TARGET_H}`);

    // --- SUBTÍTULOS (UNA SOLA VEZ, AL FINAL) ---
    // pequeño, sin fondo, borde amarillo, centrado vertical, más margen
    if (srtPath) {
      const baseFs1080 = 5;
      const FS = Math.max(6, Math.round(baseFs1080 * (TARGET_H / TARGET_W)));
      const style = [
        'FontName=DejaVu Sans',
        `Fontsize=${FS}`,
        'BorderStyle=1', // 1=contorno, 3=caja
        'Outline=1',
        'Shadow=0',
        'PrimaryColour=&H00FFFFFF&',
        'OutlineColour=&H0000FFFF&',
        'Alignment=2', // centrado abajo
        'MarginV=96',
        'MarginL=40',
        'MarginR=40',
        'WrapStyle=2',
      ].join(',');
      vf.push(
        `subtitles='${srtPath.replace(
          /\\/g,
          '/'
        )}':force_style='${style}':charenc=UTF-8`
      );
    }

    const args = ['-y'];
    if (LOOP_VIDEO) args.push('-stream_loop', '-1');
    args.push(
      '-i',
      inV,
      '-i',
      inA,
      '-v',
      'error',
      '-filter:v',
      vf.join(','),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-shortest',
      '-c:v',
      'libx264',
      '-preset',
      PRESET,
      '-crf',
      String(CRF),
      '-c:a',
      'aac',
      '-b:a',
      AUDIO_BITRATE,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-threads',
      String(THREADS),
      out
    );

    await sh('ffmpeg', args);

    res.setHeader('Content-Type', 'video/mp4');
    await pipeline(createReadStream(out), res);
    finished = true;
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  } finally {
    const clean = async () => {
      try {
        await rm(inV, { force: true });
      } catch {}
      try {
        await rm(inA, { force: true });
      } catch {}
      try {
        await rm(out, { force: true });
      } catch {}
      try {
        if (srtPath) await rm(srtPath, { force: true });
      } catch {}
    };
    if (finished) await clean();
    else {
      res.on?.('close', clean);
      await clean();
    }
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
