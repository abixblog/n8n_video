import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream, createReadStream } from "node:fs";
import { createWriteStream, readFile, rm } from "node:fs/promises";
import fetch from "node-fetch";
import { tmpdir } from "node:os";
import { join } from "node:path";

app.post("/frames", async (req, res) => {
  if (RUNNING >= MAX_RUNNING) return res.status(503).json({ error: "busy" });
  RUNNING++;

  try {
    const { video_url, every_sec = 6, max_frames = 10, scale = 720, times } = req.body || {};
    if (!video_url) return res.status(400).json({ error: "video_url required" });

    // descarga por streaming
    const inFile = join(tmpdir(), `in_${Date.now()}.mp4`);
    const r = await fetch(video_url);
    if (!r.ok) return res.status(400).json({ error: "fetch video failed", status: r.status });
    await pipeline(Readable.fromWeb(r.body), createWriteStream(inFile));

    const frames = [];

    if (Array.isArray(times) && times.length) {
      // modo preciso: un -ss por cada tiempo (más liviano para videos largos)
      for (const t of times.slice(0, max_frames)) {
        const out = join(tmpdir(), `f_${t}.jpg`);
        await sh("ffmpeg", ["-y", "-ss", String(t), "-i", inFile, "-frames:v", "1", "-vf", `scale=${scale}:-2`, out]);
        const buf = await readFile(out);
        frames.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
        await rm(out, { force: true });
      }
    } else {
      // modo simple: fps=1/every_sec
      const outPattern = join(tmpdir(), "f-%03d.jpg");
      await sh("ffmpeg", ["-y", "-i", inFile, "-vf", `fps=1/${every_sec},scale=${scale}:-2`, "-frames:v", String(max_frames), outPattern]);
      for (let i = 1; i <= max_frames; i++) {
        const p = outPattern.replace("%03d", String(i).padStart(3, "0"));
        try {
          const buf = await readFile(p);
          frames.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
          await rm(p, { force: true });
        } catch { break; }
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

app.post("/render", async (req, res) => {
  const { video_url, audio_url, loop_video = true } = req.body || {};
  if (!video_url || !audio_url) {
    return res.status(400).json({ error: "video_url and audio_url required" });
  }

  const inV = join(tmpdir(), `v_${Date.now()}.mp4`);
  const inA = join(tmpdir(), `a_${Date.now()}.mp3`);
  const out = join(tmpdir(), `out_${Date.now()}.mp4`);
  let finished = false;

  // Descarga por streaming (sin cargar todo a memoria)
  const vres = await fetch(video_url);
  if (!vres.ok) return res.status(400).json({ error: "fetch video failed", status: vres.status });
  await pipeline(Readable.fromWeb(vres.body), createWriteStream(inV));

  const ares = await fetch(audio_url);
  if (!ares.ok) return res.status(400).json({ error: "fetch audio failed", status: ares.status });
  await pipeline(Readable.fromWeb(ares.body), createWriteStream(inA));

  // Filtro de video (espejo + zoom + rotación + contraste)
  const filters = [
    "hflip",
    "scale=iw*1.10:ih*1.10",
    "crop=iw:ih",
    "rotate=3*PI/180",
    "eq=contrast=1.10"
  ].join(",");

  // Construye args de ffmpeg
  const args = ["-y"];
  if (loop_video) args.push("-stream_loop", "-1"); // 🔁 loop al video
  args.push(
    "-i", inV, "-i", inA,
    "-filter:v", filters,
    "-map", "0:v:0", "-map", "1:a:0",
    "-shortest",                    // termina cuando acaba el audio
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-c:a", "aac", "-b:a", "192k",
    "-pix_fmt", "yuv420p",
    out
  );

  try {
    await sh("ffmpeg", args);

    // Stream de salida → respuesta (sin cargar a memoria)
    res.setHeader("Content-Type", "video/mp4");
    await pipeline(createReadStream(out), res);
    finished = true;
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  } finally {
    // Limpieza de temporales aunque el cliente aborte
    const clean = async () => {
      try { await rm(inV, { force: true }); } catch {}
      try { await rm(inA, { force: true }); } catch {}
      try { await rm(out, { force: true }); } catch {}
    };
    if (finished) {
      // respuesta OK → limpia ya
      await clean();
    } else {
      // si el cliente aborta la conexión
      res.on("close", clean);
      // y si el server llega aquí por error, también limpia
      await clean();
    }
  }
});
