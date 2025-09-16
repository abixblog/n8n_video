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
  if (!stream) throw new Error('empty stream');
  return typeof stream.pipe === 'function' ? stream : Readable.fromWeb(stream);
}

async function fetchWithTimeout(url, { timeoutMs = 45000 } = {}) {
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
    throw new Error(`${label}: got HTML (enlace no directo)`);
  }
  if (!allowed.some((s) => ct.includes(s))) {
    throw new Error(`${label}: unexpected content-type ${ct || '(none)'}`);
  }
}

async function probeDuration(filePath) {
  try {
    const { stdout } = await sh('ffprobe', [
      '-v','error','-show_entries','format=duration',
      '-of','default=noprint_wrappers=1:nokey=1', filePath
    ]);
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) ? d : 0;
  } catch { return 0; }
}

// =========================
// App
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
    const r = await fetchWithTimeout(video_url, { timeoutMs: 60000 });
    if (!r.ok) return res.status(400).json({ error: 'fetch video failed', status: r.status });
    assertContentType(r, ['video', 'mp4', 'quicktime', 'x-matroska', 'octet-stream'], 'video_url');
    await pipeline(toNodeReadable(r.body), createWriteStream(inFile));

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

// -------- /render --------
// Body: { video_url, audio_url, srt_url }
app.post('/render', async (req, res) => {
  const { video_url, audio_url, srt_url } = req.body || {};
  if (!video_url || !audio_url) {
    return res.status(400).json({ error: 'video_url and audio_url required' });
  }

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.m4a`); // puede ser mp3/m4a/wav; lo guardamos tal cual
  const out = join(tmpdir(), `out_${Date.now()}.mp4`);
  let srtPath = null;
  let finished = false;

  try {
    // Video
    const vres = await fetchWithTimeout(video_url, { timeoutMs: 120000 });
    if (!vres.ok) return res.status(400).json({ error: 'fetch video failed', status: vres.status });
    assertContentType(vres, ['video','mp4','quicktime','x-matroska','octet-stream'], 'video_url');
    await pipeline(toNodeReadable(vres.body), createWriteStream(inV));

    // Audio (narración)
    const ares = await fetchWithTimeout(audio_url, { timeoutMs: 120000 });
    if (!ares.ok) return res.status(400).json({ error: 'fetch audio failed', status: ares.status });
    assertContentType(ares, ['audio','mpeg','mp3','aac','mp4','x-m4a','wav','x-wav','octet-stream'], 'audio_url');
    await pipeline(toNodeReadable(ares.body), createWriteStream(inA));

    // Subtítulos (opcional)
    if (srt_url) {
      srtPath = join(tmpdir(), `subs_${Date.now()}.srt`);
      const s = await fetchWithTimeout(srt_url, { timeoutMs: 60000 });
      if (!s.ok) return res.status(400).json({ error: 'fetch srt failed', status: s.status });
      assertContentType(s, ['srt','text','plain','octet-stream'], 'srt_url');
      await pipeline(toNodeReadable(s.body), createWriteStream(srtPath));
    }

    // -------- Cadena de filtros de VIDEO (simple y rápida) --------
    const vf = [];
    if (MIRROR) vf.push('hflip');
    if (PRE_ZOOM !== 1) vf.push(`scale=iw*${PRE_ZOOM}:ih*${PRE_ZOOM}`);
    vf.push('crop=iw:ih');
    if (ROTATE_DEG) vf.push(`rotate=${ROTATE_DEG}*PI/180`);
    vf.push(`eq=contrast=${CONTRAST}:brightness=${BRIGHTNESS}:saturation=${SATURATION}`);
    if (SHARPEN > 0) vf.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${SHARPEN}`);
    vf.push(`scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase`);
    vf.push(`crop=${TARGET_W}:${TARGET_H}`);

    // *** NO MODIFICAR ESTOS ESTILOS ***
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
        'Alignment=2',           // usa 5 si los quieres en el centro vertical
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

    // -------- Comando FFmpeg (sin loops, sin filter_complex de audio) --------
    const args = [
      '-y', '-loglevel', 'warning',
      '-i', inV,
      '-i', inA,
      '-filter:v', vf.join(','),
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',
      '-c:v', 'libx264',
      '-preset', PRESET,
      '-crf', String(CRF),
      '-c:a', 'aac',
      '-b:a', AUDIO_BITRATE,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-threads', String(THREADS),
      out
    ];

    await sh('ffmpeg', args);

    res.setHeader('Content-Type', 'video/mp4');
    await pipeline(createReadStream(out), res);
    finished = true;
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  } finally {
    const clean = async () => {
      try { await rm(inV, { force: true }); } catch {}
      try { await rm(inA, { force: true }); } catch {}
      try { await rm(out, { force: true }); } catch {}
      try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    };
    if (finished) await clean();
    else { res.on?.('close', clean); await clean(); }
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ready on :${PORT} (/frames, /render)`);
});
