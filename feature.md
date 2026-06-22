# Noripan Canvas Improvement Ideas

코드 기준: `src/vs/workbench/contrib/noripanCanvas/browser/*`

## 1. 캔버스 생성 로직 중복 제거

- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvas.contribution.ts:98`
- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvas.contribution.ts:130`
- 새 캔버스 파일 생성, `.noripan` 폴더 보장, 중복 없는 파일명 탐색, 에디터 열기 로직이 거의 동일하게 두 번 구현되어 있음.
- 공통 helper 또는 작은 service로 묶으면 이후 기본 템플릿 변경이나 파일명 정책 변경 시 수정 지점이 줄어듦.

## 2. 자동 테스트 추가

- 현재 `noripanCanvas` 전용 테스트가 보이지 않음.
- 우선순위가 높은 테스트 대상:
- `normalizeNoripanCanvasDocument()` / `serializeNoripanCanvasDocument()` round-trip
- `NoripanCanvasEditorInput`의 `save`, `saveAs`, `revert`, dirty 상태 전이
- surface 이동/리사이즈/grouping 시 문서 상태가 의도대로 유지되는지
- 브라우저 surface는 UI 통합 테스트까지는 아니어도 최소한 모델 연결 실패 케이스를 검증할 가치가 있음.

## 3. 로깅과 오류 처리 정리

- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvasEditor.ts:395`
- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvasEditor.ts:435`
- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvasEditor.ts:657`
- 현재 `console.log` / `console.error`가 직접 사용되고 있고, 일부 에러는 비지역화된 `throw new Error(...)`로 끝남.
- VS Code 코드베이스 패턴에 맞게 `ILogService` 또는 관련 로깅 경로를 사용하고, 사용자에게 노출되는 실패는 localize된 알림/메시지로 바꾸는 편이 좋음.

## 4. 브라우저 surface의 부분 가시성 UX 개선

- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvasEditor.ts:823`
- 현재 브라우저 surface는 top/left 방향으로 일부만 걸치면 아예 숨김 처리됨.
- 구현 제약은 이해되지만, 사용자는 "사라졌다"고 느끼기 쉬움.
- 개선 방향:
- 부분적으로 걸친 경우 placeholder overlay를 보여주기
- 현재 제한 사유를 surface 안에 안내하기
- clipping 전략을 더 개선할 수 있는지 별도 검토하기

## 5. 드래그/리사이즈 중 렌더링 비용 줄이기

- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvasEditor.ts:420`
- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvasEditor.ts:933`
- pointer move마다 문서 patch, minimap 렌더, 레이아웃 갱신이 반복됨.
- surface 수가 많아지면 체감 성능이 떨어질 가능성이 큼.
- `requestAnimationFrame` 단위로 드래그 갱신을 coalesce하거나, minimap/group overlay를 delta update로 바꾸면 효과가 있을 가능성이 높음.

## 6. `noripanCanvasEditor.ts` 분리

- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvasEditor.ts`
- 파일 하나에 interaction, minimap, terminal/text editor/browser attach, grouping, zoom, persistence가 모두 들어가 있고 길이도 매우 김.
- 다음 정도로 나누면 유지보수가 쉬워질 것 같음.
- surface interaction
- browser surface host/layout
- minimap state/rendering
- document patch helpers

## 7. 접근성 및 키보드 조작 보강

- 현재 상호작용의 중심이 포인터 드래그와 컨텍스트 메뉴에 치우쳐 있음.
- 추가 후보:
- surface 헤더/버튼 `aria-label` 보강
- 키보드로 surface 선택, 이동, 최소화, 닫기 지원
- 현재 포커스된 surface 시각 표시 강화
- screen reader에서 surface 타입과 제목을 읽을 수 있게 구조화

## 8. 문서 포맷 진화 대비

- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvas.ts:50`
- 포맷 버전은 `1`로 고정되어 있지만, 실제로는 UI 상태와 여러 surface 타입이 이미 섞여 있음.
- 앞으로 note, image, link, selection sync 같은 surface가 늘어나면 마이그레이션 포인트가 필요해질 가능성이 높음.
- 지금 단계에서라도 version 체크, migration entry point, invalid payload 진단 메시지를 조금 더 구조화해 두면 확장하기 편함.

## 9. autosave/충돌 대응 검토

- 현재 문서는 editor input dirty 상태를 통해 저장되지만, 캔버스 특성상 배치 작업이 잦아서 저장 타이밍이 중요함.
- 개선 후보:
- idle 기반 autosave
- 외부 파일 변경 감지 후 reload/merge UX
- 잘못된 JSON 수정 시 복구 가능한 backup 또는 last-known-good 상태 유지

## 10. 코드 스타일 일관성 정리

- `src/vs/workbench/contrib/noripanCanvas/browser/noripanCanvasEditor.ts` 안에 한글 주석과 영어 주석이 혼재되어 있음.
- 팀 기준 문체에 맞춰 주석 언어와 설명 수준을 정리하면 이후 협업 시 읽기 쉬워짐.
- 특히 좌표 변환/클램프 같은 핵심 로직은 짧고 일관된 설명만 남기고, 나머지는 함수명으로 의미가 드러나게 정리하는 편이 좋음.
