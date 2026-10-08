import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Action, Item, Msg, Settings } from "./store";
import type { CalEvent } from "./gcal";

// 개인용 앱이라 브라우저에서 내 API 키로 바로 호출한다. 키는 이 기기에만 저장된다.
function client(s: Settings) {
  if (!s.apiKey) throw new Error("설정에서 Anthropic API 키를 먼저 넣어 주세요.");
  return new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
}

const fmtNow = () =>
  new Date().toLocaleString("ko-KR", { dateStyle: "full", timeStyle: "short" });

// 같은 할 일 안의 다른 대화(할 일 전체 대화, 세부 업무별 대화)에서 최근 내용을 뽑는다.
// skip: 지금 진행 중인 대화는 messages로 따로 들어가므로 빼기 위한 표시 ("item" 또는 세부 업무 id)
function talkNotes(it: Item, perChat: number, maxLen: number, skip?: string) {
  const clip = (t: string) => (t.length > maxLen ? t.slice(0, maxLen) + "…" : t).replace(/\s+/g, " ");
  const fmt = (label: string, chat: Msg[] | undefined) =>
    chat && chat.length
      ? `- ${label}:\n` + chat.slice(-perChat).map((m) => `    ${m.role === "user" ? "사용자" : "클론"}: ${clip(m.text)}`).join("\n")
      : "";
  const parts = [
    skip === "item" ? "" : fmt("할 일 전체 대화", it.chat),
    ...it.subtasks.map((x) => (skip === x.id ? "" : fmt(`세부 업무 '${x.title}' 대화`, x.chat))),
  ].filter(Boolean);
  return parts.length ? `\n이 할 일에서 나눈 다른 대화(최근 내용):\n${parts.join("\n")}` : "";
}

function describeItem(it: Item, notes?: { perChat: number; maxLen: number; skip?: string }) {
  const subs = it.subtasks.length
    ? it.subtasks.map((s) => `  - [${s.done ? "x" : " "}] ${s.title}`).join("\n")
    : "  (아직 없음)";
  return `제목: ${it.title}\n일정: ${it.due || "없음"}${it.time ? " " + it.time + (it.endTime ? "~" + it.endTime : "") : ""}${!it.time && it.endDate && it.endDate !== it.due ? " ~ " + it.endDate : ""}\n메모: ${it.note || "없음"}\n세부 업무:\n${subs}${notes ? talkNotes(it, notes.perChat, notes.maxLen, notes.skip) : ""}`;
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
export type World = { items: Item[]; events: CalEvent[]; home: Msg[] };

const eventsText = (events: CalEvent[]) =>
  events.length
    ? events.slice(0, 60).map((e) => `- ${e.date} ${e.time ? e.time + (e.endTime ? "~" + e.endTime : "") : "종일"}: ${e.title}`).join("\n")
    : "(연결 안 됨 또는 일정 없음)";

// 할 일 하나에서 대화할 때도 사용자의 전체 일정을 함께 보도록 넘기는 내용
function worldText(w: World, exceptId: string) {
  const others = w.items.filter((i) => !i.done && i.id !== exceptId);
  const itemsText = others.map((i) => describeItem(i, { perChat: 2, maxLen: 200 })).join("\n\n") || "(없음)";
  const clip = (t: string) => (t.length > 200 ? t.slice(0, 200) + "…" : t).replace(/\s+/g, " ");
  const home = w.home.slice(-6).map((m) => `- ${m.role === "user" ? "사용자" : "클론"}: ${clip(m.text)}`).join("\n") || "(없음)";
  return `\n\n## 사용자의 다른 할 일\n${itemsText}\n\n## 앞으로의 구글 캘린더 일정\n${eventsText(w.events)}\n\n## 홈 비서와 최근 대화\n${home}`;
}

export async function streamChat(
  s: Settings,
  item: Item,
  onText: (textSoFar: string) => void,
  subId?: string,
  world?: World,
): Promise<{ text: string; suggestions: Suggestion[] }> {
  const sub = subId ? item.subtasks.find((x) => x.id === subId) : undefined;
  const history = (sub ? sub.chat ?? [] : item.chat).slice(-30).map((m) => ({ role: m.role, content: m.text }));
  const focus = sub
    ? "\n\n지금 대화는 이 할 일 전체가 아니라 그 안의 세부 업무 하나에 대한 것이다. " +
      "사용자와 함께 이 세부 업무를 어떻게, 언제, 무엇으로 할지 구체적으로 정해 준다. " +
      "더 잘게 나눌 일이 있으면 suggest_subtasks로 제안하면 같은 할 일의 세부 업무로 추가된다.\n" +
      `지금 다루는 세부 업무: ${sub.title}${sub.done ? " (완료됨)" : ""}`
    : "";
  const stream = client(s).messages.stream({
    model: s.model,
    max_tokens: 64000,
    output_config: { effort: "low" },
    system:
      "너는 사용자의 개인 비서이자 대화 상대다. 사용자는 앞으로 할 일 하나에 대해 너와 편하게 이야기한다. " +
      "너의 이름은 '클론'이다. 메신저에서 대화하듯 자연스럽고 친근한 한국어로 답하고, 필요하면 목록이나 굵은 글씨 같은 마크다운을 써도 된다. " +
      "그 일을 끝내는 데 필요한 구체적인 세부 업무가 정리되면 suggest_subtasks 도구로 제안한다. 도구를 쓸 때도 본문 답변은 먼저 쓴다.\n\n" +
      `지금: ${fmtNow()}\n\n이 항목의 현재 상태:\n${describeItem(item, { perChat: 8, maxLen: 600, skip: subId ?? "item" })}${focus}` +
      "\n\n위의 다른 대화 내용은 사용자와 이미 나눈 이야기다. 이어지는 맥락으로 자연스럽게 활용하고, 거기서 정한 내용과 어긋나지 않게 답한다. " +
      "아래 사용자의 전체 일정도 보고, 겹치는 약속이나 다른 할 일과의 우선순위를 고려해 현실적으로 답한다." +
      (world ? worldText(world, item.id) : ""),
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

/* ---------------- 홈 비서 대화: 말한 일정을 할 일/세부 업무로 정리 ---------------- */

export const ToolInputs = {
  add_item: z.object({
    title: z.string().min(1),
    due: z.string().optional(),
    time: z.string().optional(),
    note: z.string().optional(),
    subtasks: z.array(z.string()).optional(),
  }),
  add_subtasks: z.object({ item_id: z.string(), subtasks: z.array(z.string()).min(1) }),
  update_item: z.object({
    item_id: z.string(),
    title: z.string().optional(),
    due: z.string().optional(),
    time: z.string().optional(),
    done: z.boolean().optional(),
  }),
};
export type ToolName = keyof typeof ToolInputs;
export type ToolRunner = (name: ToolName, input: unknown) => Promise<{ result: string; action?: Action }>;

const homeTools = (): Anthropic.Tool[] => {
  const tools: Anthropic.Tool[] = [
    {
      name: "add_item",
      description:
        "새 할 일을 목록에 추가한다. 사용자가 말한 일정이나 해야 할 일이 기존 할 일과 관련이 없을 때 쓴다. " +
        "기존 할 일의 일부라면 이 도구 대신 add_subtasks를 쓴다.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "짧은 한국어 제목" },
          due: { type: "string", description: "일정 날짜(할 날, 약속 날, 마감일) YYYY-MM-DD. 말하지 않았으면 생략" },
          time: { type: "string", description: "정해진 시각이 있으면 24시간 HH:MM (예: 15:00). 없으면 생략" },
          note: { type: "string", description: "시간, 장소 같은 부가 정보. 없으면 생략" },
          subtasks: { type: "array", items: { type: "string" }, description: "처음부터 넣을 세부 업무. 사용자가 말한 것만" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      eager_input_streaming: true,
    },
    {
      name: "add_subtasks",
      description: "사용자가 말한 일이 기존 할 일의 일부(부가 업무)일 때, 그 할 일 아래에 세부 업무로 추가한다.",
      input_schema: {
        type: "object" as const,
        properties: {
          item_id: { type: "string", description: "기존 할 일의 id" },
          subtasks: { type: "array", items: { type: "string" }, description: "동사로 끝나는 짧은 세부 업무들" },
        },
        required: ["item_id", "subtasks"],
        additionalProperties: false,
      },
      eager_input_streaming: true,
    },
    {
      name: "update_item",
      description: "기존 할 일의 제목, 일정 날짜/시간을 바꾸거나 완료 처리한다. 일정을 없애려면 due를 빈 문자열로 준다.",
      input_schema: {
        type: "object" as const,
        properties: {
          item_id: { type: "string" },
          title: { type: "string" },
          due: { type: "string", description: "YYYY-MM-DD, 또는 일정 없애기는 빈 문자열" },
          time: { type: "string", description: "HH:MM, 또는 시간 없애기는 빈 문자열" },
          done: { type: "boolean" },
        },
        required: ["item_id"],
        additionalProperties: false,
      },
      eager_input_streaming: true,
    },
  ];
  return tools;
};

function historyFor(msgs: Msg[]) {
  return msgs.slice(-30).map((m) => ({
    role: m.role,
    content:
      m.role === "assistant" && m.actions?.length
        ? `${m.text}\n\n[이때 한 일: ${m.actions.map((a) => a.text + (a.undone ? " (사용자가 되돌림)" : "")).join(" / ")}]`
        : m.text || "(내용 없음)",
  }));
}

export async function homeChat(
  s: Settings,
  items: Item[],
  events: CalEvent[],
  calendar: boolean,
  past: Msg[],
  userText: string,
  onText: (textSoFar: string) => void,
  run: ToolRunner,
): Promise<{ text: string; actions: Action[] }> {
  const c = client(s);
  const open = items.filter((i) => !i.done);
  const itemsText = open.map((i) => `[id=${i.id}] ${describeItem(i, { perChat: 2, maxLen: 200 })}`).join("\n\n") || "(없음)";
  const evText = eventsText(events);
  const system =
    "너는 사용자의 개인 비서 '클론'이다. 메신저에서 대화하듯 자연스럽고 친근한 한국어로 짧게 답한다. 마크다운을 써도 된다.\n" +
    "사용자가 일정이나 해야 할 일을 말하면 묻지 말고 바로 도구로 정리한다:\n" +
    "- 기존 할 일의 일부나 준비 작업이면 add_subtasks로 그 할 일 아래에 넣는다.\n" +
    "- 관련된 할 일이 없으면 add_item으로 새로 만든다. '내일', '다음 주 금요일' 같은 말은 오늘 날짜 기준으로 YYYY-MM-DD로 바꾼다.\n" +
    "- 일정 변경, 완료 같은 말은 update_item을 쓴다.\n" +
    "- 약속처럼 정해진 시각이 있으면 time도 넣는다.\n" +
    (calendar ? "- 날짜가 있는 할 일은 앱이 구글 캘린더에 자동으로 올린다. 따로 캘린더에 넣을 필요 없다.\n" : "") +
    "도구를 쓴 뒤에는 무엇을 어디에 넣었는지 한두 문장으로 알려 준다. 그냥 질문이나 잡담이면 도구 없이 답한다. " +
    "지금 무엇을 해야 할지 물으면 일정과 캘린더를 보고 하나를 골라 준다.\n\n" +
    `지금: ${fmtNow()}\n\n## 할 일 목록\n${itemsText}\n\n## 앞으로의 구글 캘린더 일정\n${evText}`;

  const messages: Anthropic.MessageParam[] = [...historyFor(past), { role: "user", content: userText }];
  const actions: Action[] = [];
  let shown = "";
  for (let turn = 0; turn < 6; turn++) {
    const stream = c.messages.stream({
      model: s.model,
      max_tokens: 64000,
      output_config: { effort: "low" },
      system,
      tools: homeTools(),
      tool_choice: { type: "auto" },
      messages,
    });
    const base = shown ? shown + "\n\n" : "";
    let turnText = "";
    stream.on("text", (d) => {
      turnText += d;
      onText(base + turnText);
    });
    const final = await stream.finalMessage();
    if (turnText) shown = base + turnText;
    messages.push({ role: "assistant", content: final.content });
    if (final.stop_reason !== "tool_use") break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of final.content) {
      if (block.type !== "tool_use") continue;
      const name = block.name as ToolName;
      const schema = ToolInputs[name];
      const parsed = schema?.safeParse(block.input);
      if (!schema || !parsed?.success) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: "입력이 올바르지 않아요. 다시 시도해 주세요.", is_error: true });
        continue;
      }
      try {
        const r = await run(name, parsed.data);
        if (r.action) actions.push(r.action);
        results.push({ type: "tool_result", tool_use_id: block.id, content: r.result });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: `실패: ${(e as Error).message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  if (!shown && actions.length) shown = "정리해 뒀어요.";
  return { text: shown, actions };
}

// 저장한 API 키로 Claude에 닿는지 확인한다. 토큰을 쓰지 않는 모델 조회로 확인.
export async function checkKey(s: Settings): Promise<string> {
  const m = await client(s).models.retrieve(s.model);
  return m.display_name;
}

/* ---------------- 홈 첫 화면 제안: 지금 할 일, 놓친 것, 확인할 것 ---------------- */

const Briefing = z.object({
  now: z.object({ text: z.string().describe("지금 바로 하면 좋은 한 가지와 짧은 이유. 한 문장"), item_id: z.string().describe("관련 할 일 id, 없으면 빈 문자열") }),
  missed: z.array(z.object({ text: z.string(), item_id: z.string() })).describe("놓친 것: 날짜가 지났거나 오늘인데 안 한 일, 오래 손대지 않은 일. 없으면 빈 배열. 최대 3개"),
  check: z.array(z.object({ text: z.string(), item_id: z.string() })).describe("확인할 것: 다가오는 일정 준비, 날짜가 없어 정해야 할 일, 진행 상황 업데이트가 필요한 일. 최대 3개"),
});
export type Briefing = z.infer<typeof Briefing>;

export async function makeBriefing(s: Settings, items: Item[], events: CalEvent[]): Promise<Briefing> {
  const open = items.filter((i) => !i.done);
  const itemsText =
    open.map((i) => `[id=${i.id}] ${describeItem(i, { perChat: 2, maxLen: 200 })}\n마지막 수정: ${new Date(i.updatedAt).toLocaleDateString("ko-KR")}`).join("\n\n") || "(없음)";
  const evText = events.length
    ? events.slice(0, 40).map((e) => `- ${e.date} ${e.time || "종일"}: ${e.title}`).join("\n")
    : "(연결 안 됨 또는 일정 없음)";
  const res = await client(s).messages.parse({
    model: s.model,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(Briefing) },
    system:
      "너는 사용자의 개인 비서다. 할 일 목록과 캘린더를 보고 앱 첫 화면에 띄울 짧은 제안을 만든다. " +
      "지금 시각을 꼭 고려한다(새벽이면 쉬라고 하거나 아침에 할 일을 알려 주는 식). 각 문장은 짧고 친근한 한국어로. " +
      "할 일이 하나도 없으면 now에 할 일을 말해 달라는 안내를 넣고 나머지는 비운다.",
    messages: [{ role: "user", content: `지금: ${fmtNow()}\n\n## 할 일 목록\n${itemsText}\n\n## 앞으로의 구글 캘린더 일정\n${evText}` }],
  });
  if (!res.parsed_output) throw new Error("제안을 만들지 못했어요.");
  return res.parsed_output;
}

// API 키가 없거나 실패했을 때 쓰는 간단한 규칙 기반 제안
export function simpleBriefing(items: Item[]): Briefing {
  const open = items.filter((i) => !i.done);
  const today = new Date().toLocaleDateString("sv-SE");
  const byDue = [...open].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const first = byDue[0];
  const week = Date.now() - 7 * 86400000;
  return {
    now: first
      ? { text: `${first.title}${first.due ? ` (${first.due})` : ""}부터 해 보세요.`, item_id: first.id }
      : { text: "아직 할 일이 없어요. 앞으로 할 일을 말해 주세요.", item_id: "" },
    missed: open
      .filter((i) => i.due && i.due < today)
      .slice(0, 3)
      .map((i) => ({ text: `'${i.title}' 날짜가 지났어요.`, item_id: i.id })),
    check: [
      ...open.filter((i) => i.updatedAt < week).map((i) => ({ text: `'${i.title}' 진행 상황을 업데이트해 주세요.`, item_id: i.id })),
      ...open.filter((i) => !i.due).map((i) => ({ text: `'${i.title}' 언제 할지 정할까요?`, item_id: i.id })),
    ].slice(0, 3),
  };
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "늦은 밤이에요";
  if (h < 11) return "좋은 아침이에요";
  if (h < 17) return "좋은 오후예요";
  if (h < 22) return "좋은 저녁이에요";
  return "오늘 하루 수고했어요";
}
