// MediaPipe wasm을 public/mediapipe로 복사 (외부 CDN 없이 번들에 포함)
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/mediapipe', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe', { recursive: true });
console.log('copied mediapipe wasm → public/mediapipe');
