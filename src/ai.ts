import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Item, Settings } from "./store";
import type { CalEvent } from "./gcal";

// 개인용 앱이라 브라우저에서 내 API 키로 바로 호출한다. 키는 이 기기에만 저장된다.
function client(s: Settings) {
  if (!s.apiKey) throw new Error("설정에서 Anthropic API 키를 먼저 넣어 주세요.");
  return new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
}

const fmtNow = () =>
  new Date().toLocaleString("ko-KR", { dateStyle: "full", timeStyle: "short" });

function describeItem(it: Item) {
  const subs = it.subtasks.length
    ? it.subtasks.map((s) => `  - [${s.done ? "x" : " "}] ${s.title}`).join("\n")
    : "  (아직 없음)";
  return `제목: ${it.title}\n마감: ${it.due || "없음"}\n메모: ${it.note || "없음"}\n세부 업무:\n${subs}`;
}

const ChatReply = z.object({
  reply: z.string().describe("사용자에게 하는 답변. 짧고 친근한 한국어."),
  suggested_subtasks: z
    .array(z.object({ title: z.string(), why: z.string() }))
    .describe("새로 추가하면 좋은 세부 업무. 이미 있는 것과 겹치면 넣지 않는다. 필요 없으면 빈 배열."),
});
export type ChatReply = z.infer<typeof ChatReply>;

export async function chatInItem(s: Settings, item: Item, userText: string): Promise<ChatReply> {
  const history = item.chat.slice(-20).map((m) => ({ role: m.role, content: m.text }));
  const res = await client(s).messages.parse({
    model: s.model,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(ChatReply) },
    system:
      "너는 사용자의 개인 비서다. 사용자가 앞으로 할 일 하나에 대해 이야기한다. " +
      "그 일을 끝내려면 무엇이 필요한지 같이 생각하고, 구체적이고 바로 실행할 수 있는 세부 업무를 제안한다. " +
      "세부 업무 제목은 동사로 끝나는 짧은 한국어로 쓴다.\n\n" +
      `지금: ${fmtNow()}\n\n현재 항목:\n${describeItem(item)}`,
    messages: [...history, { role: "user", content: userText }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    return { reply: "이 요청에는 답을 만들지 못했어요. 다르게 말해 주시겠어요?", suggested_subtasks: [] };
  }
  return res.parsed_output;
}

const Briefing = z.object({
  now: z.object({
    title: z.string().describe("지금 당장 하면 좋은 한 가지"),
    reason: z.string().describe("왜 지금 이걸 해야 하는지 한 문장"),
    item_id: z.string().describe("관련 항목 id, 없으면 빈 문자열"),
  }),
  next: z.array(z.object({ title: z.string(), item_id: z.string() })).describe("그다음 할 일 최대 3개"),
  updates: z
    .array(z.object({ text: z.string(), item_id: z.string() }))
    .describe("사용자가 확인하거나 갱신해야 할 것: 마감 지난 항목, 오래 손대지 않은 항목, 진행 상황 업데이트 필요 등. 최대 4개"),
});
export type Briefing = z.infer<typeof Briefing>;

export async function makeBriefing(s: Settings, items: Item[], events: CalEvent[]): Promise<Briefing> {
  const open = items.filter((i) => !i.done);
  const itemsText = open
    .map(
      (i) =>
        `[id=${i.id}] ${describeItem(i)}\n마지막 수정: ${new Date(i.updatedAt).toLocaleDateString("ko-KR")}`,
    )
    .join("\n\n");
  const evText = events.length
    ? events.map((e) => `- ${e.start} ~ ${e.end}: ${e.title}`).join("\n")
    : "(연결 안 됨 또는 일정 없음)";
  const res = await client(s).messages.parse({
    model: s.model,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(Briefing) },
    system:
      "너는 사용자의 개인 비서다. 할 일 목록과 캘린더를 보고, 지금 무엇을 해야 하는지 딱 하나를 골라 주고, " +
      "그다음 할 일과 사용자가 업데이트해야 할 내용을 알려준다. 캘린더 일정 사이의 빈 시간과 마감을 고려한다. 짧고 친근한 한국어로.",
    messages: [
      {
        role: "user",
        content: `지금: ${fmtNow()}\n\n## 할 일 목록\n${itemsText || "(없음)"}\n\n## 앞으로의 캘린더 일정\n${evText}`,
      },
    ],
  });
  if (!res.parsed_output) throw new Error("브리핑을 만들지 못했어요.");
  return res.parsed_output;
}

// API 키가 없을 때 쓰는 간단한 규칙 기반 브리핑
export function simpleBriefing(items: Item[]): Briefing {
  const open = items.filter((i) => !i.done);
  const score = (i: Item) => {
    if (!i.due) return Infinity;
    return new Date(i.due).getTime();
  };
  const sorted = [...open].sort((a, b) => score(a) - score(b));
  const first = sorted[0];
  const firstSub = first?.subtasks.find((s) => !s.done);
  const week = Date.now() - 7 * 86400000;
  return {
    now: first
      ? {
          title: firstSub ? `${first.title} · ${firstSub.title}` : first.title,
          reason: first.due ? `마감이 가장 가까운 일이에요 (${first.due}).` : "목록에서 가장 먼저 있는 일이에요.",
          item_id: first.id,
        }
      : { title: "할 일을 하나 추가해 보세요", reason: "아직 등록된 일이 없어요.", item_id: "" },
    next: sorted.slice(1, 4).map((i) => ({ title: i.title, item_id: i.id })),
    updates: [
      ...open
        .filter((i) => i.due && new Date(i.due + "T23:59:59").getTime() < Date.now())
        .map((i) => ({ text: `'${i.title}' 마감이 지났어요. 날짜를 바꾸거나 완료 처리할까요?`, item_id: i.id })),
      ...open
        .filter((i) => i.updatedAt < week)
        .map((i) => ({ text: `'${i.title}'을(를) 일주일 넘게 손대지 않았어요.`, item_id: i.id })),
    ].slice(0, 4),
  };
}
