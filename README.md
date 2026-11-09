# 남이 보는 내 얼굴 (프로토타입)

토스 미니앱(앱인토스 WebView)용 웹 프로토타입. 모든 처리는 기기 안에서 하고 사진을 서버로 보내지 않음.

## 기능
1. **촬영 가이드** — MediaPipe Face Landmarker로 홍채 크기 기반 거리(11.7mm 기준), 상하·좌우·기울기, 화면 중앙 여부를 실시간 판정. 조건이 0.7초 유지되면 3초 카운트다운 후 자동 촬영
   - 모드: 폰 세워두고(1~2m 거리 요구) / 손에 들고(거리 무관, 뒤에서 원근 보정)
   - 거리 보정: 줄자로 잰 거리에서 1회 캘리브레이션 → 이 폰의 초점거리 저장
2. **반전 토글** — 기본은 남이 보는 방향(비반전), 거울 모드 전환
3. **시력 시뮬레이션** — 근시 디옵터·조명(동공 크기)·상대와의 거리로 흐림 계산
4. **보정** — 찍은 사진을 1.5m 눈높이 시점으로 자동 보정. 슬라이더 없음, 꾹 누르면 보정 전
   - **AI 보정**(동의 시): 측정한 거리·각도를 프록시 서버(`server/`)로 보내 Gemini 이미지 편집으로 원근·각도 왜곡만 살짝 교정. 키는 서버에만
   - **기본 보정**(AI 미설정·거절·실패 시): 기기 안에서 3D 랜드마크 재투영 + WebGL 메시 워프 (원근만)

수식과 근거는 `RESEARCH.md`, 구현은 `src/lib/` (geometry · warp · vision).

## 실사용 검증
- `VITE_QA=1` 로 빌드하거나 주소 뒤에 `?qa` 를 붙이면 검증 모드 (거리·자세·원근 보정 측정 기록, CSV 내보내기)
- `main`에 push하면 GitHub Actions가 검증 빌드를 GitHub Pages로 배포 (`.github/workflows/pages.yml`)
- 절차와 통과 기준은 `QA.md`

## 실행
```bash
npm install          # postinstall이 MediaPipe wasm을 public/mediapipe로 복사
npm run fetch-model  # (권장) 얼굴 모델을 public/models에 받아 번들에 포함
npm run dev          # 같은 Wi-Fi의 폰에서 https 필요 (아래 참고)
npm test             # 거리·자세·워프·시력 수식 단위 테스트
```
- 폰 브라우저에서 카메라를 쓰려면 https가 필요. 로컬 테스트는 `npx vite --host` + `@vitejs/plugin-basic-ssl` 또는 ngrok 등 사용
- `harness/` 는 카메라 없이 결과 화면(워프·블러)을 확인하는 개발용 페이지: `npm run dev` 후 `/harness/index.html`

## 앱인토스 이식 시 확인할 것
- **카메라**: SDK가 공식 제공하는 건 `openCamera`(네이티브 카메라로 사진 1장)뿐. WebView에서 `getUserMedia` 실시간 스트림이 되는지 샌드박스 앱에서 먼저 확인할 것. 안 되면 앱이 자동으로 "사진으로 시작하기" 모드로 전환됨 → 이 경로의 파일 입력을 `openCamera({ base64: true })`로 교체하면 됨 (`CameraScreen.tsx`의 `PhotoFallback`)
- **권한**: 콘솔/granite 설정에 카메라 권한 등록, `openCamera.getPermission()` / `openPermissionDialog()` 처리
- **저장**: 지금은 `<a download>`. 토스 안에서는 `saveBase64`(File API)로 교체
- **SDK 연동**: 콘솔에 앱 등록 후 공식 문서 "기존 웹 프로젝트에 SDK 연동하기" 순서대로 `appName`, `displayName`, `icon` 설정. iframe 사용 금지

## 실기기에서 검증이 필요한 부분
- pitch 부호(카메라가 낮을 때 음수): 합성 데이터 테스트는 통과했지만 실제 MediaPipe z 출력으로 한 번 확인 필요. 반대면 `estimatePose`의 pitch 부호만 뒤집으면 됨
- 기본 화각 70° 가정 → 캘리브레이션 전 거리 오차
- 원근 보정의 머리카락·귀 경계 자연스러움 (`warp.ts`의 링 반경·깊이 가정 조절)
