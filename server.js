// ===== IMPORTS CORREGIDOS =====
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream, createReadStream } from "node:fs";
import { readFile, rm } from "node:fs/promises"; // <- SIN createWriteStream aquí
import fetch from "node-fetch";
import { tmpdir } from "node:os";
import { join } from "node:path";

// asume que tienes una utilidad sh(cmd, args[]) que ejecuta ffmpeg
// import { sh } from "./utils/sh.js"

// ===== LIMITAR CONCURRENCIA (ajustable por env) =====
let RUNNING = 0;
const MAX_RUNNING = Number(process.env.MAX_RUNNING || 1);

// (Opcional) endpoint de salud para mantener “caliente”
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ===== /frames – más estable, soporta 'times' o 'every_sec' =====
app.post("/frames", async (req, res) => {
  if (RUNNING >= MAX_RUNNING) return res.status(503).json({ error: "busy" });
  RUNNING++;

  try {
    let {
      video_url,
      every_sec = 6,
      max_frames = 10,
      scale = 1080,          // ⬅️ por defecto 1080 de ancho
      times,
      jpg_quality = 3        // 2–5 (menor = mejor calidad)
    } = req.body || {};
    if (!video_url) return res.status(400).json({ error: "video_url required" });

    // saneos
    max_frames  = Math.max(1, Math.min(50, Number(max_frames) || 10));
    scale       = Math.max(240, Math.min(2160, Number(scale) || 1080));
    jpg_quality = Math.max(2, Math.min(7, Number(jpg_quality) || 3));

    // descarga por streaming
    const inFile = join(tmpdir(), `in_${Date.now()}.mp4`);
    const r = await fetch(video_url);
    if (!r.ok) return res.status(400).json({ error: "fetch video failed", status: r.status });
    await pipeline(Readable.fromWeb(r.body), createWriteStream(inFile));

    const frames = [];

    if (Array.isArray(times) && times.length) {
      // modo preciso: un -ss por cada tiempo (más liviano para videos largos)
      const ts = times
        .map(n => Number(n))
        .filter(n => Number.isFinite(n) && n >= 0)
        .slice(0, max_frames);

      for (const t of ts) {
        const out = join(tmpdir(), `f_${t}.jpg`);
        await sh("ffmpeg", [
          "-y",
          "-ss", String(t), "-i", inFile,
          "-frames:v", "1",
          "-vf", `scale=${scale}:-2:flags=lanczos`,
          "-q:v", String(jpg_quality),
          out
        ]);
        const buf = await readFile(out);
        frames.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
        await rm(out, { force: true });
      }
    } else {
      // modo simple: fps=1/every_sec
      every_sec = Math.max(1, Number(every_sec) || 6);
      const outPattern = join(tmpdir(), "f-%03d.jpg");
      await sh("ffmpeg", [
        "-y",
        "-i", inFile,
        "-vf", `fps=1/${every_sec},scale=${scale}:-2:flags=lanczos`,
        "-frames:v", String(max_frames),
        "-q:v", String(jpg_quality),
        outPattern
      ]);
      for (let i = 1; i <= max_frames; i++) {
        const p = outPattern.replace("%03d", String(i).padStart(3, "0"));
        try {
          const buf = await readFile(p);
          frames.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
          await rm(p, { force: true });
        } catch {
          break;
        }
      }
    }

    await rm(inFile, { force: true });
    res.json({ frames, count: frames.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    RUNNING--;
  }
});

// ===== /render – 1080x1920 mín., loop opcional, subtítulos opcionales, cleanup garantizado =====
app.post("/render", async (req, res) => {
  const {
    video_url,
    audio_url,
    loop_video = true,
    // Canvas objetivo (portrait). Cambia a 1920x1080 si quieres landscape.
    target_width  = 1080,
    target_height = 1920,
    // Efectos
    zoom_factor = 1.10,
    rotate_deg  = 3,
    contrast    = 1.20,
    // Subtítulos opcionales (.srt)
    srt_url
  } = req.body || {};

  if (!video_url || !audio_url) {
    return res.status(400).json({ error: "video_url and audio_url required" });
  }

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.mp3`);
  const out = join(tmpdir(), `out_${Date.now()}.mp4`);
  let srtPath = null;
  let finished = false;

  try {
    // Descargas por streaming
    const vres = await fetch(video_url);
    if (!vres.ok) return res.status(400).json({ error: "fetch video failed", status: vres.status });
    await pipeline(Readable.fromWeb(vres.body), createWriteStream(inV));

    const ares = await fetch(audio_url);
    if (!ares.ok) return res.status(400).json({ error: "fetch audio failed", status: ares.status });
    await pipeline(Readable.fromWeb(ares.body), createWriteStream(inA));

    if (srt_url) {
      srtPath = join(tmpdir(), `subs_${Date.now()}.srt`);
      const s = await fetch(srt_url);
      if (!s.ok) return res.status(400).json({ error: "fetch srt failed", status: s.status });
      await pipeline(Readable.fromWeb(s.body), createWriteStream(srtPath));
    }

    // Filtros de video:
    // espejo → zoom leve → recorte "dummy" → rotación → contraste → COVER a 1080x1920 → recorte exacto
    const baseFilters = [
      "hflip",
      `scale=iw*${Number(zoom_factor)},ih*${Number(zoom_factor)}`,
      "crop=iw:ih",
      `rotate=${Number(rotate_deg)}*PI/180`,
      `eq=contrast=${Number(contrast).toFixed(2)}`,
      `scale=${Number(target_width)}:${Number(target_height)}:force_original_aspect_ratio=cover`,
      `crop=${Number(target_width)}:${Number(target_height)}`
    ];

    if (srtPath) {
      // Estilo seguro para ASS; requiere fuente instalada (p. ej. DejaVu Sans)
      const style = "FontName=DejaVu Sans,Fontsize=36,BorderStyle=3,Outline=2,Shadow=0,PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,MarginV=48,Alignment=2";
      baseFilters.push(`subtitles='${srtPath.replace(/\\/g, "/")}':force_style='${style}'`);
    }

    const filters = baseFilters.join(",");

    // FFmpeg args
    const args = ["-y"];
    if (loop_video) args.push("-stream_loop", "-1"); // 🔁 loop del video hasta que termine el audio
    args.push(
      "-i", inV, "-i", inA,
      "-filter:v", filters,
      "-map", "0:v:0", "-map", "1:a:0",
      "-shortest",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-c:a", "aac", "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", // mejor reproducción web
      out
    );

    await sh("ffmpeg", args);

    // Respuesta en streaming (sin cargar a memoria)
    res.setHeader("Content-Type", "video/mp4");
    await pipeline(createReadStream(out), res);
    finished = true;
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  } finally {
    // Limpieza de temporales siempre
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
