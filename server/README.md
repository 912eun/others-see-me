# AI 보정 프록시 (Cloudflare Workers)

앱은 API 키를 갖지 않고 이 서버만 호출해요. 키는 Cloudflare의 Secret에만 저장돼요.

## 막아둔 것
| 위험 | 대응 |
|---|---|
| 앱 코드에서 키 추출 | 키는 서버 Secret에만. 앱 번들·저장소 어디에도 없음 |
| 남이 프록시를 직접 호출해 생성기로 사용 | 프롬프트는 서버 고정, 클라이언트는 숫자 2개(거리·각도)만 보냄 |
| 대량 호출로 요금 폭탄 | IP당 하루 5회, 전체 하루 200회 (wrangler.toml에서 조절) + Google Cloud 예산 알림 |
| 다른 사이트에서 호출 | 허용 Origin만 응답 (1차 필터) |
| 큰 파일·이상한 형식 | 1.5MB 이하 JPEG/PNG/WebP만 |
| 사진 유출 | 서버에 저장·로그 안 함. IP도 해시로만 카운트 |

남은 한계: IP 제한은 VPN 등으로 우회 가능해요. 토스 출시 때는 토스 로그인으로 받은 사용자 키를 서버에서 검증해 사람 단위로 제한하는 게 맞아요.

## 배포 (10분)
1. Gemini API 키 발급: Google AI Studio → API 키. **결제를 연결한 키 권장**: 무료 등급은 입력 데이터가 Google 서비스 개선에 쓰일 수 있다고 약관에 적혀 있으니 직접 확인하세요. Google Cloud 콘솔 → 결제 → 예산 및 알림에서 월 예산 알림도 꼭 설정.
2. Cloudflare 가입 후, 이 폴더에서:
   ```bash
   npx wrangler login
   npx wrangler kv namespace create USAGE      # 출력된 id를 wrangler.toml에 붙여넣기
   npx wrangler secret put GEMINI_API_KEY      # 키는 터미널에만 입력
   npx wrangler deploy                          # https://others-see-me-ai.<계정>.workers.dev
   ```
3. 앱에 주소 연결 (둘 중 하나)
   - 저장소 Settings → Secrets and variables → Actions → **Variables** 탭에 `AI_ENDPOINT` = 위 workers.dev 주소 → Actions에서 재배포
   - 또는 테스트용으로 폰에서 `https://912eun.github.io/others-see-me/?ai=<workers.dev 주소>` 한 번 열기

## 테스트
루트에서 `npm test` (Gemini 호출은 가짜로 대체: Origin 차단, 프롬프트 고정, 횟수 제한, 크기 검사, IP 비저장)
