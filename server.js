import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream, createReadStream } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import fetch from "node-fetch";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    "scale=iw*1.05:ih*1.05",
    "crop=iw:ih",
    "rotate=3*PI/180",
    "eq=contrast=1.08"
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
