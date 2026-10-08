import type { Item } from "./store";

// 미리보기 빌드에서만 쓰는 예시 데이터
export function demoItems(): Item[] {
  const d = (n: number) => {
    const x = new Date();
    x.setDate(x.getDate() + n);
    return x.toLocaleDateString("sv-SE");
  };
  const now = Date.now();
  return [
    {
      id: "ex1", title: "(예시) 데스크톱 앱 새 버전 출시", note: "", due: d(2), done: false, createdAt: now, updatedAt: now,
      subtasks: [
        { id: "s1", title: "윈도우 빌드 테스트하기", done: true, byClaude: true, createdAt: 1 },
        { id: "s2", title: "릴리즈 노트 쓰기", done: false, byClaude: true, createdAt: 2 },
        { id: "s3", title: "사이트 다운로드 링크 바꾸기", done: false, byClaude: false, createdAt: 3 },
      ],
      chat: [
        { role: "user", text: "이번 주 안에 출시하려면 뭐가 남았지?", ts: 1 },
        { role: "assistant", text: "윈도우 빌드는 끝났으니, 릴리즈 노트와 사이트 링크만 정리하면 돼요.", ts: 2 },
      ],
    },
    { id: "ex2", title: "(예시) 종합소득세 자료 정리", note: "", due: d(-1), done: false, createdAt: now, updatedAt: now - 9 * 86400000, subtasks: [], chat: [] },
    { id: "ex3", title: "(예시) 운동 루틴 짜기", note: "", due: "", done: false, createdAt: now, updatedAt: now, subtasks: [], chat: [] },
  ];
}
