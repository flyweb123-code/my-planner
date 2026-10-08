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

const Suggestions = z.object({
  subtasks: z.array(z.object({ title: z.string(), why: z.string() })),
});
export type Suggestion = z.infer<typeof Suggestions>["subtasks"][number];

const suggestTool = {
  name: "suggest_subtasks",
  description:
    "대화 중에 이 일을 끝내는 데 필요한 구체적인 세부 업무가 떠오르면 사용자에게 추가 버튼으로 제안한다. " +
    "이미 목록에 있는 것은 넣지 않는다. 사용자가 세부 업무를 나눠 달라고 하거나 계획을 세울 때 쓰고, 그냥 잡담이나 질문에 답할 때는 쓰지 않는다.",
  input_schema: {
    type: "object" as const,
    properties: {
      subtasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "동사로 끝나는 짧은 한국어 세부 업무" },
            why: { type: "string", description: "왜 필요한지 한 문장" },
          },
          required: ["title", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["subtasks"],
    additionalProperties: false,
  },
  eager_input_streaming: true,
};

// Claude 앱처럼 답을 실시간으로 받아 보여 준다. 세부 업무 제안은 도구 호출로 따로 받는다.
export async function streamChat(
  s: Settings,
  item: Item,
  onText: (textSoFar: string) => void,
): Promise<{ text: string; suggestions: Suggestion[] }> {
  const history = item.chat.slice(-30).map((m) => ({ role: m.role, content: m.text }));
  const stream = client(s).messages.stream({
    model: s.model,
    max_tokens: 64000,
    output_config: { effort: "low" },
    system:
      "너는 사용자의 개인 비서이자 대화 상대다. 사용자는 앞으로 할 일 하나에 대해 너와 편하게 이야기한다. " +
      "Claude 앱에서 대화하듯 자연스럽고 친근한 한국어로 답하고, 필요하면 목록이나 굵은 글씨 같은 마크다운을 써도 된다. " +
      "그 일을 끝내는 데 필요한 구체적인 세부 업무가 정리되면 suggest_subtasks 도구로 제안한다. 도구를 쓸 때도 본문 답변은 먼저 쓴다.\n\n" +
      `지금: ${fmtNow()}\n\n이 항목의 현재 상태:\n${describeItem(item)}`,
    tools: [suggestTool],
    tool_choice: { type: "auto" },
    messages: history,
  });
  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    onText(text);
  });
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal" && !text) {
    text = "이 요청에는 답을 만들지 못했어요. 다르게 말해 주시겠어요?";
  }
  const suggestions: Suggestion[] = [];
  for (const block of final.content) {
    if (block.type === "tool_use" && block.name === "suggest_subtasks") {
      const parsed = Suggestions.safeParse(block.input);
      if (parsed.success) suggestions.push(...parsed.data.subtasks);
    }
  }
  if (!text && suggestions.length) text = "이렇게 나눠 보면 어떨까요?";
  return { text, suggestions };
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
