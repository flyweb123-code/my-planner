# 내 비서 (개인 일정 관리 앱)

Mac, Windows, iPhone 어디서나 브라우저로 열고 홈 화면에 앱처럼 추가해서 쓰는 웹앱(PWA)입니다.

- 홈: 지금 할 일 한 가지, 확인이 필요한 것, 그다음 할 일, 다가오는 캘린더 일정
- 할 일: 항목을 누르면 세부 업무 목록과 Claude 대화가 나옴. Claude가 제안한 세부 업무를 눌러서 추가
- 설정: Anthropic API 키, 모델 선택, 구글 OAuth 클라이언트 ID, 백업/복원

개발: `npm install` → `npm run dev`. 배포용 빌드: `npm run build` (dist 폴더). 예시 데이터가 든 미리보기: `VITE_DEMO=1 npx vite build`.
데이터는 지금은 각 기기 브라우저에만 저장됩니다.
