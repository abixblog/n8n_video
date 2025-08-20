import express from "express";
import fetch from "node-fetch";
import { execFile } from "node:child_process";
import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const app = express();
app.use(express.json({ limit: "50mb" }));

// Optional simple auth via header X-Token
const API_TOKEN = process.env.API_TOKEN || "Dsl8UTgQ3fJFR7zrjXOAKhtxBZ2cmWVSM9ECuP5Ne1kap6qH";
app.use((req, res, next) => {
  if (!API_TOKEN) return next();
  if (req.header("x-token") === API_TOKEN) return next();
  return res.status(401).json({ error: "unauthorized" });
});

function sh(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 200 }, (e, so, se) =>
      e ? rej(se || e) : res(so)
    );
  });
}

// POST /frames  -> extract 1 frame every N seconds (returns data URIs)
app.post("/frames", async (req, res) => {
  try {
    const { video_url, every_sec = 6, max_frames = 20, scale = 1080 } = req.body || {};
    if (!video_url) return res.status(400).json({ error: "video_url required" });

    const inFile = join(tmpdir(), "in.mp4");
    const r = await fetch(video_url);
    if (!r.ok) return res.status(400).json({ error: "fetch video failed", status: r.status });
    await writeFile(inFile, Buffer.from(await r.arrayBuffer()));

    const outPattern = join(tmpdir(), "f-%03d.jpg");
    const vf = `fps=1/${every_sec},scale=${scale}:-2`;
    await sh("ffmpeg", ["-y", "-i", inFile, "-vf", vf, "-frames:v", String(max_frames), outPattern]);

    const frames = [];
    for (let i = 1; i <= max_frames; i++) {
      const p = outPattern.replace("%03d", String(i).padStart(3, "0"));
      try {
        const buf = await readFile(p);
        frames.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
        await rm(p);
      } catch {
        break;
      }
    }
    await rm(inFile);
    res.json({ frames, count: frames.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /render -> mirror/zoom/rotate/contrast, mute original and mux external audio
app.post("/render", async (req, res) => {
  try {
    const { video_url, audio_url } = req.body || {};
    if (!video_url || !audio_url) return res.status(400).json({ error: "video_url and audio_url required" });

    const inV = join(tmpdir(), "v.mp4");
    const inA = join(tmpdir(), "a.mp3");
    const out = join(tmpdir(), "out.mp4");

    const vres = await fetch(video_url);
    if (!vres.ok) return res.status(400).json({ error: "fetch video failed", status: vres.status });
    const ares = await fetch(audio_url);
    if (!ares.ok) return res.status(400).json({ error: "fetch audio failed", status: ares.status });

    await writeFile(inV, Buffer.from(await vres.arrayBuffer()));
    await writeFile(inA, Buffer.from(await ares.arrayBuffer()));

    const filters = [
      "hflip",                 // mirror horizontally
      "scale=iw*1.05:ih*1.05", // slight zoom
      "crop=iw:ih",            // keep canvas
      "rotate=3*PI/180",       // 3 degrees
      "eq=contrast=1.08"       // ~+8% contrast
    ].join(",");

    await sh("ffmpeg", [
      "-y", "-i", inV, "-i", inA,
      "-filter:v", filters,
      "-map", "0:v:0", "-map", "1:a:0",
      "-shortest",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-c:a", "aac", "-b:a", "192k",
      "-pix_fmt", "yuv420p", out
    ]);

    const buf = await readFile(out);
    res.setHeader("Content-Type", "video/mp4");
    res.send(buf);
    await Promise.all([rm(inV), rm(inA), rm(out)]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/", (_req, res) => res.json({ ok: true }));
app.listen(8080, () => console.log("ffmpeg api on :8080"));
