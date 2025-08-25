// server.js (Node 20, ESM) — API FFmpeg configurable

import express from 'express';
import cors from 'cors';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream, createReadStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fetch from 'node-fetch'; // (Node 20 ya trae fetch, pero lo dejamos por compat)
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function toNodeReadable(body) {
  if (!body) throw new Error('empty body');
  // Si ya es Node stream (tiene .pipe), úsalo tal cual:
  if (typeof body.pipe === 'function') return body;
  // Si es Web ReadableStream, conviértelo:
  return Readable.fromWeb(body);
}

const execFileP = promisify(execFile);

// ---------------- utilidades básicas ----------------
async function sh(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileP(cmd, args, { ...opts });
  return { stdout, stderr };
}

async function fetchWithTimeout(url, { timeoutMs = 30000, retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      clearTimeout(t);
      return res;
    } catch (e) {
      clearTimeout(t);
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function probeSize(filePath) {
  try {
    const { stdout } = await sh('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      filePath,
    ]);
    const j = JSON.parse(stdout || '{}');
    const st = j.streams?.[0] || {};
    return { width: st.width || 0, height: st.height || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

// ---------------- helpers de parseo ----------------
function bool(v, d = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string')
    return ['1', 'true', 'on', 'yes', 'si', 'sí'].includes(v.toLowerCase());
  if (typeof v === 'number') return v !== 0;
  return d;
}
function num(v, d, min = null, max = null) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = d;
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return n;
}

// ---------------- express app ----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// auth opcional por header X-Token (bypass /health)
app.use((req, res, next) => {
  const API_TOKEN = process.env.API_TOKEN || null;
  if (!API_TOKEN) return next();
  if (req.path === '/health') return next();
  if (req.header('x-token') === API_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// health
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ---------------- semáforo con cola (evita 503 por busy) ----------------
let RUNNING = 0;
const MAX_RUNNING = Number(process.env.MAX_RUNNING || 1);
const waiters = [];
async function withSlot(fn) {
  if (RUNNING >= MAX_RUNNING) {
    await new Promise((res) => waiters.push(res));
  }
  RUNNING++;
  try {
    return await fn();
  } finally {
    RUNNING--;
    const next = waiters.shift();
    if (next) next();
  }
}

// ---------------- /frames ----------------
app.post('/frames', async (req, res) => {
  await withSlot(async () => {
    try {
      let {
        video_url,
        every_sec = 6,
        max_frames = 10,
        scale = 1080, // ancho objetivo para los JPG
        times,
        jpg_quality = 3, // 2–5 (menor = mejor calidad, más peso)
      } = req.body || {};
      if (!video_url)
        return res.status(400).json({ error: 'video_url required' });

      max_frames = Math.max(1, Math.min(50, Number(max_frames) || 10));
      jpg_quality = Math.max(2, Math.min(7, Number(jpg_quality) || 3));
      scale = Math.max(240, Math.min(2160, Number(scale) || 1080));
      every_sec = Math.max(1, Number(every_sec) || 6);

      // descarga
      const inFile = join(tmpdir(), `in_${Date.now()}.mp4`);
      const r = await fetchWithTimeout(video_url, {
        timeoutMs: 30000,
        retries: 1,
      });
      await pipeline(toNodeReadable(r.body), createWriteStream(inFile));

      // si el video es menor que "scale", no lo fuerces
      const src = await probeSize(inFile);
      const effScale = src.width && src.width < scale ? src.width : scale;

      const frames = [];

      if (Array.isArray(times) && times.length) {
        const ts = times
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n >= 0)
          .slice(0, max_frames);

        for (const t of ts) {
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
            `scale=${effScale}:-2:flags=lanczos`,
            '-q:v',
            String(jpg_quality),
            '-threads',
            String(process.env.FFMPEG_THREADS || 1),
            out,
          ]);
          const buf = await readFile(out);
          frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
          await rm(out, { force: true });
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
          `fps=1/${every_sec},scale=${effScale}:-2:flags=lanczos`,
          '-frames:v',
          String(max_frames),
          '-q:v',
          String(jpg_quality),
          '-threads',
          String(process.env.FFMPEG_THREADS || 1),
          outPattern,
        ]);
        for (let i = 1; i <= max_frames; i++) {
          const p = outPattern.replace('%03d', String(i).padStart(3, '0'));
          try {
            const buf = await readFile(p);
            frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
            await rm(p, { force: true });
          } catch {
            break;
          }
        }
      }

      await rm(inFile, { force: true });
      return res.json({ frames, count: frames.length, src });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });
});

app.post("/render", async (req, res) => {
  const b = req.body || {};

  // Requeridos
  const video_url = b.video_url;
  const audio_url = b.audio_url;
  if (!video_url || !audio_url) {
    return res.status(400).json({ error: "video_url and audio_url required" });
  }

  // Canvas (por defecto vertical 1080x1920)
  const target_width  = num(b.target_width,  1080, 240, 3840);
  const target_height = num(b.target_height, 1920, 240, 3840);

  // Transformaciones visuales
  const mirror      = bool(b.mirror, true);      // hflip
  const vflip       = bool(b.vflip, false);      // volteo vertical
  const zoom_factor = num(b.zoom_factor, 1.10, 0.5,  2.0);
  const rotate_deg  = num(b.rotate_deg, 3,   -180, 180);

  // Color / tono
  const contrast    = num(b.contrast,    1.20, 0.5,  3.0);
  const brightness  = num(b.brightness,  0.00, -1.0, 1.0);
  const saturation  = num(b.saturation,  1.00, 0.0,  3.0);
  const gamma       = num(b.gamma,       1.00, 0.10, 3.0);
  const grayscale   = bool(b.grayscale, false);

  // Nitidez / blur
  const sharpen     = num(b.sharpen, 0.0, 0.0, 2.0);
  const blur        = num(b.blur,    0.0, 0.0, 5.0);

  // Subtítulos opcionales
  const srt_url     = b.srt_url || null;

  // Audio
  const loop_video  = bool(b.loop_video, true);
  const audio_gain  = num(b.audio_gain, 1.0, 0.0, 10.0);

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.mp3`);
  const out = join(tmpdir(), `out_${Date.now()}.mp4`);
  let srtPath = null;
  let finished = false;

  // helper para construir el filtro final con estrategia "cover" o "pad"
  const buildFilters = (mode /* "cover" | "pad" */) => {
    const vf = [];
    if (mirror) vf.push("hflip");
    if (vflip)  vf.push("vflip");
    if (zoom_factor !== 1) vf.push(`scale=iw*${zoom_factor}:ih*${zoom_factor}`);
    vf.push("crop=iw:ih"); // dummy para mantener canvas tras zoom
    if (rotate_deg) vf.push(`rotate=${rotate_deg}*PI/180`);

    // color
    const sat = grayscale ? 0 : saturation;
    const eqParams = [];
    if (contrast   !== 1) eqParams.push(`contrast=${contrast.toFixed(2)}`);
    if (brightness !== 0) eqParams.push(`brightness=${brightness.toFixed(2)}`);
    if (sat        !== 1) eqParams.push(`saturation=${sat.toFixed(2)}`);
    if (gamma      !== 1) eqParams.push(`gamma=${gamma.toFixed(2)}`);
    if (eqParams.length)  vf.push(`eq=${eqParams.join(":")}`);

    if (blur    > 0) vf.push(`gblur=sigma=${blur.toFixed(2)}`);
    if (sharpen > 0) vf.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${sharpen.toFixed(2)}`);

    // Normaliza SAR y encaja al canvas
    vf.push("setsar=1");

    if (mode === "cover") {
      // Escalar para cubrir y recortar exacto
      vf.push(`scale=${target_width}:${target_height}:force_original_aspect_ratio=increase`);
      vf.push(`crop=${target_width}:${target_height}`);
    } else {
      // Letterbox: encajar sin recortar y rellenar con pad centrado
      vf.push(`scale=${target_width}:${target_height}:force_original_aspect_ratio=decrease`);
      vf.push(`pad=${target_width}:${target_height}:(ow-iw)/2:(oh-ih)/2`);
    }

    if (srtPath) {
      const style = "FontName=DejaVu Sans,Fontsize=36,BorderStyle=3,Outline=2,Shadow=0,PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,MarginV=48,Alignment=2";
      vf.push(`subtitles='${srtPath.replace(/\\/g, "/")}':force_style='${style}'`);
    }

    return vf.join(",");
  };

  try {
    // Descargas con timeout y retry (y stream compatible Node/Web)
    const vres = await fetchWithTimeout(video_url, { timeoutMs: 60000, retries: 1 });
    await pipeline(toNodeReadable(vres.body), createWriteStream(inV));

    const ares = await fetchWithTimeout(audio_url, { timeoutMs: 60000, retries: 1 });
    await pipeline(toNodeReadable(ares.body), createWriteStream(inA));

    if (srt_url) {
      srtPath = join(tmpdir(), `subs_${Date.now()}.srt`);
      const s = await fetchWithTimeout(srt_url, { timeoutMs: 30000, retries: 1 });
      await pipeline(toNodeReadable(s.body), createWriteStream(srtPath));
    }

    // 1º intento: COVER (crop centrado)
    let filters = buildFilters("cover");
    let args = ["-y"];
    if (loop_video) args.push("-stream_loop", "-1");
    args.push(
      "-i", inV, "-i", inA,
      "-v", "error",
      "-filter:v", filters,
      "-map", "0:v:0", "-map", "1:a:0",
      "-shortest",
      ...(audio_gain !== 1 ? ["-filter:a", `volume=${audio_gain}`] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-c:a", "aac", "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-threads", String(process.env.FFMPEG_THREADS || 1),
      out
    );

    try {
      await sh("ffmpeg", args);
    } catch (e) {
      // 2º intento automático: LETTERBOX (pad centrado)
      const msg = (e?.stderr || e?.stdout || e?.message || "").toString();
      // Si falla por crop/tamaño, reintenta con pad
      if (/crop|Invalid too big|Error initializing filter 'scale'|Failed to inject frame/i.test(msg)) {
        filters = buildFilters("pad");
        args = ["-y"];
        if (loop_video) args.push("-stream_loop", "-1");
        args.push(
          "-i", inV, "-i", inA,
          "-v", "error",
          "-filter:v", filters,
          "-map", "0:v:0", "-map", "1:a:0",
          "-shortest",
          ...(audio_gain !== 1 ? ["-filter:a", `volume=${audio_gain}`] : []),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
          "-c:a", "aac", "-b:a", "192k",
          "-pix_fmt", "yuv420p",
          "-movflags", "+faststart",
          "-threads", String(process.env.FFMPEG_THREADS || 1),
          out
        );
        await sh("ffmpeg", args);
      } else {
        throw e;
      }
    }

    // respuesta en streaming (sin cargar a memoria)
    res.setHeader("Content-Type", "video/mp4");
    await pipeline(createReadStream(out), res);
    finished = true;
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  } finally {
    // limpieza garantizada
    const clean = async () => {
      try { await rm(inV,   { force: true }); } catch {}
      try { await rm(inA,   { force: true }); } catch {}
      try { await rm(out,   { force: true }); } catch {}
      try { if (srtPath) await rm(srtPath, { force: true }); } catch {}
    };
    if (finished) {
      await clean();
    } else {
      res.on?.("close", clean);
      await clean();
    }
  }
});

// ---------------- listen ----------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ffmpeg api on :${PORT}`);
});
