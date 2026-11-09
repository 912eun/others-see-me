// Face Landmarker 모델을 public/models에 내려받아 번들에 포함 (선택)
import { mkdirSync, writeFileSync } from 'node:fs';
const URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
mkdirSync('public/models', { recursive: true });
const r = await fetch(URL);
if (!r.ok) throw new Error(`download failed: ${r.status}`);
writeFileSync('public/models/face_landmarker.task', Buffer.from(await r.arrayBuffer()));
console.log('saved public/models/face_landmarker.task');
