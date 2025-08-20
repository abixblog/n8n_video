# ffmpeg-api (frames & render)

Endpoints:
- `POST /frames` → { video_url, every_sec=6, max_frames=20, scale=1080 } → `{ frames: [dataURIs...] }`
- `POST /render` → { video_url, audio_url } → MP4 (mirrored, slight zoom, 3° rotate, +contrast, external audio)

## Run locally
```bash
docker build -t ffmpeg-api .
docker run -p 8080:8080 ffmpeg-api
```

## Test
```bash
curl -X POST http://localhost:8080/frames   -H 'Content-Type: application/json'   -d '{"video_url":"https://drive.google.com/uc?export=download&id=FILE_ID","every_sec":6,"max_frames":10}'

curl -X POST http://localhost:8080/render   -H 'Content-Type: application/json'   -d '{"video_url":"https://drive.google.com/uc?export=download&id=FILE_ID","audio_url":"https://drive.google.com/uc?export=download&id=AUDIO_ID"}'   --output out.mp4
```

## Deploy
- Cloud Run / Railway / Render / Fly.io → deploy with Dockerfile.
- Optional auth: set env `API_TOKEN`, and call with header `X-Token: <value>`.
