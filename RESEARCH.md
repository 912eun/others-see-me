# 선행연구 정리 & 적용 포인트

✅ = 이번 프로토타입에 반영 · 🔜 = 다음 단계 후보

## 1. 셀카 원근 왜곡과 보정

| 연구 | 핵심 발견 | 적용 |
|---|---|---|
| Ward et al., *JAMA Facial Plastic Surgery* 2018 — "Nasal Distortion in Short-Distance Photographs: The Selfie Effect" | 광대 폭을 맞춰 비교하면 30cm 셀카의 코는 약 30% 크게 찍힘. 1.5m(5ft)에서는 차이 거의 없음 | ✅ 보정 목표 기본값 1.5m, 결과 화면에 "30cm 셀카는 코가 약 30% 크게" 문구 |
| Fried et al., *SIGGRAPH* 2016 — "Perspective-aware Manipulation of Portrait Photos" | 3D 머리 모델을 맞춘 뒤 가상 카메라 거리를 바꾸고 2D 워프로 사진에 입힘 | ✅ 같은 구조: MediaPipe 3D 랜드마크 → dolly-zoom 재투영(f' = f·D/d) → piecewise-affine 워프(WebGL). 메시 밖(머리카락·귀)은 링 2겹으로 감쇠 |
| Zhao et al., *ICCV* 2019 — "Learning Perspective Undistortion of Portraits" | 촬영 거리 추정이 틀리면 보정이 과하거나 모자람 | ✅ 촬영 거리 슬라이더로 사용자가 직접 미세조정 |
| Shih et al., *SIGGRAPH* 2019 — "Distortion-Free Wide-Angle Portraits on Camera Phones" | 화면 가장자리 얼굴의 늘어짐은 렌즈 투영 문제로 별개 | ✅ 가이드에서 얼굴을 화면 가운데로 유도해 이 왜곡을 회피 |
| DisCO (arXiv 2302.12253, 2023), SUPER (arXiv 2406.12700, 2024) | 3D GAN 역투영으로 거리 재렌더링. 품질은 좋지만 무거움 | 🔜 기기 내 실시간은 메시 워프가 현실적이라는 근거. 귀·머리카락 복원이 필요하면 서버 옵션으로 검토 |
| Bryan, Perona, Adolphs, *PLoS ONE* 2012 | 근거리에서 찍힌 얼굴은 신뢰도·유능함·매력 평가가 낮고, 관찰자는 이를 의식 못 함 | 🔜 보정 기능 소개 문구의 근거 |
| Noyes & Jenkins, *Cognition* 2017 | 0.32m와 2.7m 사진은 낯선 사람이 같은 인물로 매칭하기 어려울 만큼 다름 | ✅ "조금 떨어져서 2.7m" 프리셋 |

## 2. 거울상 vs 실제 모습

| 연구 | 핵심 발견 | 적용 |
|---|---|---|
| Mita, Dermer, Knight, *JPSP* 1977 | 본인은 거울상, 친구는 실제상을 선호 (단순노출 효과) | ✅ 기본 표시는 '남이 보는(비반전)', 토글 아래 "어색한 건 정상" 설명 |
| Amestoy et al., *Frontiers in Psychology* 2010 | 성인 71%가 자기 거울상, 76%가 친구의 실제상 선호 | 🔜 "10명 중 7명은…" 문구, 첫 진입 시 둘 중 고르기 미니 실험 |
| Huang, Suchow, Haberman, VSS 2024 포스터 | 셀카 시대에도 거울상 선호 유지, 순응시키면 감소 | 🔜 "며칠 보면 익숙해져요" 안내 (포스터 수준이라 약한 근거) |
| Brady et al., *Brain and Cognition* 2005 | 친숙한 얼굴의 좌우 비대칭이 기억에 남아 있음 | 🔜 반전 시 가장 달라지는 부분(가르마·점·비대칭 미소) 하이라이트 |

## 3. 랜드마크 기반 거리 추정

| 연구 | 핵심 발견 | 적용 |
|---|---|---|
| Ablavatski et al., arXiv 2006.11341, 2020 (MediaPipe Iris) | 홍채 수평 직경은 11.7±0.5mm로 거의 일정. 거리 추정 평균 상대오차 4.3% | ✅ 1순위 거리 추정: d = f·11.7mm / 홍채px, 7프레임 중앙값 필터 |
| Kartynnik et al., arXiv 1907.06724, 2019 | Face Mesh 468점의 기반. Z는 상대 깊이 | ✅ Z를 홍채 거리로 메트릭 스케일 변환해 워프에 사용 |
| Dodgson, *Proc. SPIE* 2004 | 성인 IPD 평균 약 63mm, 개인차 큼 | ✅ 홍채가 4px 미만으로 불안정할 때만 IPD로 대체 |
| Li et al., arXiv 1612.04131 (2016) · Al-Burgan & Weremczuk, *IJET* 2026 | 폰 화각을 모르면 오차 큼, 먼 거리일수록 정확도 하락 | ✅ 기본 화각 70° 가정 + 줄자 1회 캘리브레이션, "렌즈를 봐주세요" 안내 |

## 4. 카메라 높이·각도

| 연구 | 핵심 발견 | 적용 |
|---|---|---|
| Sedgewick et al., *Frontiers in Psychology* 2017 | 셀카 촬영 각도에 성별 차이 (남성은 아래, 여성은 위에서) | ✅ 기준은 눈높이 정면. pitch ±10°, roll ±6° 이내에서만 자동 촬영 |
| Marshall et al., *Evolutionary Psychology* 2020 | 고개 기울기만으로 매력·지배성 인상이 바뀜 | ✅ 정면 사진을 비교 기준선으로 고정 |

## 5. 시력(굴절이상) 시뮬레이션

| 연구 | 핵심 발견 | 적용 |
|---|---|---|
| Strasburger, Bach, Heinrich, *i-Perception* 2018 — "Blur Unblurred" | 흐림 각직경 ≈ 동공(mm) × 초점오차(D) (rad 단위로는 동공(m)×D) | ✅ 남는 초점오차 = max(0, 근시D − 1/거리), 흐림 직경 → 가우시안 σ ≈ 직경/4 |
| Watson & Yellott, *Journal of Vision* 2012 | 휘도에 따른 동공 크기 통합식 | ✅ Stanley–Davies 항으로 계산: 낮 야외 2.4mm · 실내 2.8mm · 어두운 실내 3.7mm · 밤거리 5.0mm (양안 60°×60° 시야 가정, 연령 보정 생략) |
| CLEERE Study Group, *Optom. Vis. Sci.* 2021 | 근시 0.30~0.40D마다 최소분해각 약 0.5′ 증가 | ✅ 맨눈 시력 ≈ 1 / (1 + 0.5·D/0.35) → -1D≈0.4, -2D≈0.26. 아동 데이터라 "근사치" 표기 |
| Barsky, APGV 2004 — Vision-Realistic Rendering | 파면 수차로 PSF를 만들어 개인 시각 재현 | 🔜 얼굴은 깊이 범위가 작아 단일 PSF로 충분. 난시는 타원 커널(축 각도 + 두 주경선)로 확장 |
| Loftus & Harley, *Psychonomic Bulletin & Review* 2005 | 거리가 멀어지는 것과 흐려지는 것은 시각계에 등가 | ✅ 정상 시력도 1′ 해상 한계를 저역통과로 적용, 근시 흐림을 그 위에 합산 |

## 6. 셀카 vs 남이 찍은 사진

| 연구 | 핵심 발견 | 적용 |
|---|---|---|
| Re et al., *SPPS* 2016 — "Selfie Indulgence" | 본인은 자기 셀카를 더 매력적으로 보지만, 남들은 셀카 속 인물을 덜 매력적·더 자기애적으로 평가 | 🔜 앱 핵심 메시지 문구 |
| White, Burton, Kemp, *BJP* 2016 | 본인이 고른 '나 같은' 사진이 오히려 낯선 사람의 인식 정확도가 낮음, 웃는 사진이 유리 | 🔜 연속 촬영 후 blendshape `mouthSmile` 중간값 프레임 자동 선택 |
| Chen et al., *CVPR* 2024 — Total Selfie | 셀카 → 타인 시점 전신사진 변환 | 참고 |

## 남은 불확실성
- 기기별 화각: 캘리브레이션 전 거리는 추정치 → UI에 "(추정)" 표기
- 디옵터↔시력 환산: 아동 데이터 기반 → "근사치" 표기
- 원근 보정: 가까이서 가려졌던 귀·옆머리는 복원 불가(워프의 한계)

## Sources
- https://pmc.ncbi.nlm.nih.gov/articles/PMC5876805/
- https://gfx.cs.princeton.edu/pubs/Fried_2016_PMO/
- https://openaccess.thecvf.com/content_ICCV_2019/papers/Zhao_Learning_Perspective_Undistortion_of_Portraits_ICCV_2019_paper.pdf
- https://people.csail.mit.edu/yichangshih/wide_angle_portrait/
- https://arxiv.org/abs/2302.12253
- https://arxiv.org/abs/2406.12700
- https://authors.library.caltech.edu/records/etxwp-3q903
- https://pure.hud.ac.uk/en/publications/camera-to-subject-distance-affects-face-configuration-and-perceiv/
- https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2010.00039/full
- https://www.visionsciences.org/presentation/?id=1048
- https://ro.ecu.edu.au/ecuworks/5289
- https://arxiv.org/abs/2006.11341
- https://research.google/blog/mediapipe-iris-real-time-iris-tracking-depth-estimation/
- https://arxiv.org/abs/1907.06724
- https://ar5iv.arxiv.org/html/1612.04131
- https://wydawnictwo.pan.pl/index.php/ijet/article/view/1734
- https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2017.00604/full
- https://journals.sagepub.com/doi/10.1177/2041669518765850
- https://humansystems.arc.nasa.gov/publications/watson_formula_pupilsize.pdf
- https://experts.arizona.edu/en/publications/uncorrected-refractive-error-and-distance-visual-acuity-in-childr/
- https://people.eecs.berkeley.edu/~barsky/VisRendPapers/vrr1.pdf
- https://link.springer.com/article/10.3758/BF03196348
- https://journals.sagepub.com/doi/10.1177/1948550616644299
- https://opus.lib.uts.edu.au/handle/10453/160107
- https://openaccess.thecvf.com/content/CVPR2024/html/Chen_Total_Selfie_Generating_Full-Body_Selfies_CVPR_2024_paper.html
