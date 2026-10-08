import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, dueLabel, daysUntil, uid, usePersisted } from "./store";
import type { Item, Settings } from "./store";
import { makeBriefing, simpleBriefing, streamChat } from "./ai";
import type { Briefing } from "./ai";
import { Markdown } from "./md";
import * as gcal from "./gcal";
import type { CalEvent } from "./gcal";
import { toast } from "./toast";
import { demoItems } from "./demo";

type View = { name: "home" } | { name: "list" } | { name: "item"; id: string } | { name: "chat"; id: string } | { name: "settings" };

export default function App() {
  const [items, setItems] = usePersisted<Item[]>("items", import.meta.env.VITE_DEMO ? demoItems() : []);
  const [settings, setSettings] = usePersisted<Settings>("settings", DEFAULT_SETTINGS);
  const [view, setView] = useState<View>({ name: "home" });
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [gToken, setGToken] = useState<string | null>(() => gcal.savedToken());

  const updateItem = useCallback(
    (id: string, fn: (it: Item) => Item) =>
      setItems((all) => all.map((it) => (it.id === id ? { ...fn(it), updatedAt: Date.now() } : it))),
    [setItems],
  );

  useEffect(() => {
    if (!gToken) return;
    gcal.upcoming(gToken).then(setEvents).catch(() => setGToken(null));
  }, [gToken]);

  const connectGoogle = async () => {
    try {
      setGToken(await gcal.connect(settings.googleClientId));
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const open = (id: string) => id && items.some((i) => i.id === id) && setView({ name: "item", id });
  const current = view.name === "item" || view.name === "chat" ? items.find((i) => i.id === view.id) : undefined;

  return (
    <div className={`app ${view.name === "chat" ? "in-chat" : ""}`}>
      <main>
        {view.name === "home" && (
          <Home items={items} events={events} settings={settings} gConnected={!!gToken} onConnect={connectGoogle} onOpen={open} onGoSettings={() => setView({ name: "settings" })} />
        )}
        {view.name === "list" && <List items={items} setItems={setItems} onOpen={open} />}
        {view.name === "item" && current && (
          <ItemView
            item={current}
            gToken={gToken}
            onChat={() => setView({ name: "chat", id: current.id })}
            update={(fn) => updateItem(current.id, fn)}
            onDelete={() => {
              setItems((all) => all.filter((i) => i.id !== current.id));
              setView({ name: "list" });
            }}
            onBack={() => setView({ name: "list" })}
          />
        )}
        {view.name === "chat" && current && (
          <ChatView item={current} settings={settings} update={(fn) => updateItem(current.id, fn)} onBack={() => setView({ name: "item", id: current.id })} />
        )}
        {view.name === "settings" && (
          <SettingsView settings={settings} setSettings={setSettings} gConnected={!!gToken} onConnect={connectGoogle} />
        )}
      </main>
      {view.name !== "chat" && (
      <nav className="tabs">
        <button className={view.name === "home" ? "on" : ""} onClick={() => setView({ name: "home" })}>
          <span>🏠</span>홈
        </button>
        <button className={view.name === "list" || view.name === "item" ? "on" : ""} onClick={() => setView({ name: "list" })}>
          <span>📋</span>할 일
        </button>
        <button className={view.name === "settings" ? "on" : ""} onClick={() => setView({ name: "settings" })}>
          <span>⚙️</span>설정
        </button>
      </nav>
      )}
    </div>
  );
}

/* ---------------- 홈: 비서 브리핑 ---------------- */

function Home(props: {
  items: Item[];
  events: CalEvent[];
  settings: Settings;
  gConnected: boolean;
  onConnect: () => void;
  onOpen: (id: string) => void;
  onGoSettings: () => void;
}) {
  const { items, events, settings } = props;
  const [brief, setBrief] = useState<Briefing>(() => simpleBriefing(items));
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [fromClaude, setFromClaude] = useState(false);

  const refresh = useCallback(async () => {
    if (!settings.apiKey) {
      setBrief(simpleBriefing(items));
      return;
    }
    setLoading(true);
    setErr("");
    try {
      setBrief(await makeBriefing(settings, items, events));
      setFromClaude(true);
    } catch (e) {
      setErr((e as Error).message);
      setBrief(simpleBriefing(items));
    } finally {
      setLoading(false);
    }
  }, [items, events, settings]);

  // 홈에 들어올 때마다 새로 브리핑
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      refresh();
    }
  }, [refresh]);

  const hour = new Date().getHours();
  const greet = hour < 12 ? "좋은 아침이에요" : hour < 18 ? "좋은 오후예요" : "오늘도 수고했어요";

  return (
    <section>
      <header className="page-head">
        <div>
          <p className="muted">{new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" })}</p>
          <h1>{greet}</h1>
        </div>
        <button className="ghost" onClick={refresh} disabled={loading}>
          {loading ? "생각 중…" : "새로고침"}
        </button>
      </header>

      <div className="card now" onClick={() => props.onOpen(brief.now.item_id)}>
        <p className="label">지금 할 일</p>
        <h2>{brief.now.title}</h2>
        <p>{brief.now.reason}</p>
      </div>

      {err && <p className="error">{err}</p>}
      {!settings.apiKey && (
        <p className="hint">
          지금은 마감일 순서로만 골라 드려요. <a onClick={props.onGoSettings}>API 키를 넣으면</a> Claude가 캘린더까지 보고 골라 줘요.
        </p>
      )}

      {brief.updates.length > 0 && (
        <>
          <h3>확인이 필요해요</h3>
          <ul className="rows">
            {brief.updates.map((u, i) => (
              <li key={i} onClick={() => props.onOpen(u.item_id)}>
                <span className="dot warn" />
                {u.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {brief.next.length > 0 && (
        <>
          <h3>그다음</h3>
          <ul className="rows">
            {brief.next.map((n, i) => (
              <li key={i} onClick={() => props.onOpen(n.item_id)}>
                <span className="dot" />
                {n.title}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>다가오는 일정</h3>
      {props.gConnected ? (
        events.length ? (
          <ul className="rows">
            {events.slice(0, 6).map((e) => (
              <li key={e.id}>
                <span className="time">{e.start}</span>
                {e.title}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">이번 주 캘린더 일정이 없어요.</p>
        )
      ) : (
        <button className="secondary" onClick={props.onConnect}>
          구글 캘린더 연결하기
        </button>
      )}
      {fromClaude && <p className="muted small">Claude가 정리한 브리핑이에요.</p>}
    </section>
  );
}

/* ---------------- 할 일 목록 ---------------- */

function List({ items, setItems, onOpen }: { items: Item[]; setItems: (fn: (a: Item[]) => Item[]) => void; onOpen: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [showDone, setShowDone] = useState(false);

  const add = () => {
    if (!title.trim()) return;
    const it: Item = {
      id: uid(),
      title: title.trim(),
      note: "",
      due,
      done: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      subtasks: [],
      chat: [],
    };
    setItems((a) => [it, ...a]);
    setTitle("");
    setDue("");
    onOpen(it.id);
  };

  const sorted = [...items].sort((a, b) => (daysUntil(a.due) ?? 9999) - (daysUntil(b.due) ?? 9999) || b.createdAt - a.createdAt);
  const open = sorted.filter((i) => !i.done);
  const done = sorted.filter((i) => i.done);

  return (
    <section>
      <header className="page-head">
        <h1>할 일</h1>
      </header>
      <div className="add">
        <input placeholder="앞으로 할 일을 적어 보세요" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
        <DateField value={due} onChange={setDue} />
        <button onClick={add}>추가</button>
      </div>
      {open.length === 0 && <p className="muted">아직 할 일이 없어요.</p>}
      <ul className="items">
        {open.map((i) => (
          <ItemRow key={i.id} it={i} onOpen={onOpen} />
        ))}
      </ul>
      {done.length > 0 && (
        <>
          <button className="link" onClick={() => setShowDone(!showDone)}>
            완료한 일 {done.length}개 {showDone ? "접기" : "보기"}
          </button>
          {showDone && (
            <ul className="items done">
              {done.map((i) => (
                <ItemRow key={i.id} it={i} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function ItemRow({ it, onOpen }: { it: Item; onOpen: (id: string) => void }) {
  const total = it.subtasks.length;
  const doneCount = it.subtasks.filter((s) => s.done).length;
  const n = daysUntil(it.due);
  return (
    <li onClick={() => onOpen(it.id)}>
      <div className="grow">
        <strong>{it.title}</strong>
        <div className="meta">
          {total > 0 && (
            <span>
              세부 업무 {doneCount}/{total}
            </span>
          )}
          {it.chat.length > 0 && <span>💬 {it.chat.length}</span>}
        </div>
        {total > 0 && (
          <div className="bar">
            <div style={{ width: `${(doneCount / total) * 100}%` }} />
          </div>
        )}
      </div>
      {it.due && <span className={`due ${n !== null && n <= 1 && !it.done ? "soon" : ""}`}>{dueLabel(it.due)}</span>}
    </li>
  );
}

/* ---------------- 마감 날짜 입력 ---------------- */

// 아이폰의 날짜 선택기에서 "재설정"을 누르면 기본값으로 돌아가는데,
// 그 기본값을 비워 두면 재설정이 곧 "마감 없음"이 된다.
function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  // 기본값("")은 그대로 두고 화면에 보이는 값만 직접 맞춘다.
  useLayoutEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  }, [value]);
  return (
    <span className="datefield">
      <input ref={ref} type="date" defaultValue="" onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button className="x" aria-label="마감 지우기" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </span>
  );
}

/* ---------------- 항목 상세: 세부 업무 ---------------- */

function ItemView(props: {
  item: Item;
  gToken: string | null;
  update: (fn: (it: Item) => Item) => void;
  onDelete: () => void;
  onBack: () => void;
  onChat: () => void;
}) {
  const { item, update } = props;
  const [newSub, setNewSub] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);

  const addSub = (title: string) =>
    update((it) => ({ ...it, subtasks: [...it.subtasks, { id: uid(), title, done: false, byClaude: false, createdAt: Date.now() }] }));

  const syncCalendar = async () => {
    if (!props.gToken || !item.due) return;
    try {
      const id = await gcal.upsertDueEvent(props.gToken, item.title, item.due, item.calendarEventId);
      update((it) => ({ ...it, calendarEventId: id }));
      toast("캘린더에 마감일을 넣었어요.");
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const last = item.chat[item.chat.length - 1];

  return (
    <section className="detail">
      <header className="page-head">
        <button className="ghost" onClick={props.onBack}>
          ← 목록
        </button>
        <button className="ghost danger" onClick={() => (confirmDel ? props.onDelete() : setConfirmDel(true))} onBlur={() => setConfirmDel(false)}>
          {confirmDel ? "한 번 더 누르면 삭제" : "삭제"}
        </button>
      </header>

      <input className="title-input" value={item.title} onChange={(e) => update((it) => ({ ...it, title: e.target.value }))} />
      <div className="row">
        <label>
          마감 <DateField value={item.due} onChange={(v) => update((it) => ({ ...it, due: v }))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={item.done} onChange={(e) => update((it) => ({ ...it, done: e.target.checked }))} /> 완료
        </label>
        {props.gToken && item.due && (
          <button className="secondary small" onClick={syncCalendar}>
            {item.calendarEventId ? "캘린더 갱신" : "캘린더에 넣기"}
          </button>
        )}
      </div>
      <textarea placeholder="메모" value={item.note} onChange={(e) => update((it) => ({ ...it, note: e.target.value }))} />

      <button className="chat-entry" onClick={props.onChat}>
        <span className="grow">
          <strong>Claude와 대화하기</strong>
          <span className="muted small preview">{last ? `${last.role === "user" ? "나: " : ""}${last.text}` : "이 일에 대해 편하게 이야기해 보세요"}</span>
        </span>
        <span className="chev">›</span>
      </button>

      <h3>세부 업무</h3>
      <ul className="subs">
        {item.subtasks.map((s) => (
          <li key={s.id} className={s.done ? "done" : ""}>
            <input type="checkbox" checked={s.done} onChange={() => update((it) => ({ ...it, subtasks: it.subtasks.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)) }))} />
            <span className="grow">{s.title}</span>
            {s.byClaude && <span className="badge">Claude</span>}
            <button className="x" onClick={() => update((it) => ({ ...it, subtasks: it.subtasks.filter((x) => x.id !== s.id) }))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="add">
        <input
          placeholder="세부 업무 직접 추가"
          value={newSub}
          onChange={(e) => setNewSub(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && newSub.trim()) {
              addSub(newSub.trim());
              setNewSub("");
            }
          }}
        />
      </div>
    </section>
  );
}

/* ---------------- Claude와 대화 ---------------- */

function ChatView(props: { item: Item; settings: Settings; update: (fn: (it: Item) => Item) => void; onBack: () => void }) {
  const { item, update, settings } = props;
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [item.chat.length, streaming]);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [msg]);

  const send = async (text: string) => {
    text = text.trim();
    if (!text || busy) return;
    setMsg("");
    setBusy(true);
    setStreaming("");
    const withUser: Item = { ...item, chat: [...item.chat, { role: "user", text, ts: Date.now() }] };
    update(() => withUser);
    try {
      const r = await streamChat(settings, withUser, setStreaming);
      update((it) => ({
        ...it,
        chat: [...it.chat, { role: "assistant", text: r.text, ts: Date.now(), suggestions: r.suggestions.length ? r.suggestions : undefined }],
      }));
    } catch (e) {
      update((it) => ({ ...it, chat: [...it.chat, { role: "assistant", text: `⚠️ ${(e as Error).message}`, ts: Date.now() }] }));
    } finally {
      setStreaming("");
      setBusy(false);
    }
  };

  const addSuggestion = (msgIdx: number, sIdx: number | "all") =>
    update((it) => {
      const m = it.chat[msgIdx];
      if (!m?.suggestions) return it;
      const picked = m.suggestions.filter((s, j) => !s.added && (sIdx === "all" || j === sIdx));
      return {
        ...it,
        subtasks: [...it.subtasks, ...picked.map((s) => ({ id: uid(), title: s.title, done: false, byClaude: true, createdAt: Date.now() }))],
        chat: it.chat.map((x, i) =>
          i === msgIdx ? { ...x, suggestions: x.suggestions!.map((s, j) => (sIdx === "all" || j === sIdx ? { ...s, added: true } : s)) } : x,
        ),
      };
    });

  const doneCount = item.subtasks.filter((s) => s.done).length;

  return (
    <section className="chatview">
      <header className="chat-head">
        <button className="ghost" onClick={props.onBack}>
          ←
        </button>
        <div className="grow">
          <strong>{item.title}</strong>
          <span className="muted small">
            {item.subtasks.length ? `세부 업무 ${doneCount}/${item.subtasks.length}` : "세부 업무 없음"}
            {item.due ? ` · ${dueLabel(item.due)}` : ""}
          </span>
        </div>
      </header>

      <div className="thread">
        {item.chat.length === 0 && !busy && (
          <div className="empty">
            <p>이 일에 대해 무엇이든 이야기해 보세요.</p>
            <div className="chips">
              {["이 일을 세부 업무로 나눠 줘", "어디서부터 시작하면 좋을까?", "이번 주 안에 끝내려면 어떻게 해야 해?"].map((t) => (
                <button key={t} className="chip" onClick={() => send(t)} disabled={!settings.apiKey}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}
        {item.chat.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg user">
              {m.text}
            </div>
          ) : (
            <div key={i} className="msg assistant">
              <Markdown text={m.text} />
              {m.suggestions && (
                <div className="suggest">
                  <p className="label">세부 업무 제안</p>
                  {m.suggestions.map((s, j) => (
                    <div key={j} className="sugg">
                      <div className="grow">
                        <strong>{s.title}</strong>
                        <p className="muted small">{s.why}</p>
                      </div>
                      <button className="small" disabled={s.added} onClick={() => addSuggestion(i, j)}>
                        {s.added ? "추가됨" : "추가"}
                      </button>
                    </div>
                  ))}
                  {m.suggestions.some((s) => !s.added) && (
                    <button className="link" onClick={() => addSuggestion(i, "all")}>
                      모두 추가
                    </button>
                  )}
                </div>
              )}
            </div>
          ),
        )}
        {busy && <div className="msg assistant">{streaming ? <Markdown text={streaming} /> : <span className="typing">●●●</span>}</div>}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <textarea
          ref={boxRef}
          rows={1}
          placeholder={settings.apiKey ? "Claude에게 메시지 보내기" : "설정에서 API 키를 넣어 주세요"}
          value={msg}
          disabled={!settings.apiKey}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            // 컴퓨터에서는 Enter로 보내고 Shift+Enter로 줄바꿈. 휴대폰에서는 보내기 버튼 사용.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
              e.preventDefault();
              send(msg);
            }
          }}
        />
        <button className="send" aria-label="보내기" onClick={() => send(msg)} disabled={busy || !msg.trim()}>
          ↑
        </button>
      </div>
    </section>
  );
}

/* ---------------- 설정 ---------------- */

function SettingsView(props: { settings: Settings; setSettings: (s: Settings) => void; gConnected: boolean; onConnect: () => void }) {
  const { settings, setSettings } = props;
  const set = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setSettings({ ...settings, [k]: e.target.value });
  return (
    <section className="settings">
      <header className="page-head">
        <h1>설정</h1>
      </header>

      <h3>Claude 연결</h3>
      <p className="muted small">
        console.anthropic.com 에서 만든 API 키를 넣어 주세요. 키는 이 기기에만 저장되고 다른 곳으로 보내지 않아요.
      </p>
      <input type="password" placeholder="sk-ant-..." value={settings.apiKey} onChange={set("apiKey")} />
      <label>
        모델
        <select value={settings.model} onChange={set("model")}>
          <option value="claude-opus-5-5">Claude Opus 5.5 (가장 똑똑함)</option>
          <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (빠르고 저렴)</option>
          <option value="claude-haiku-5-5">Claude Haiku 5.5 (가장 저렴)</option>
        </select>
      </label>

      <h3>구글 캘린더</h3>
      <p className="muted small">구글 클라우드 콘솔에서 만든 OAuth 클라이언트 ID를 넣고 연결해 주세요.</p>
      <input placeholder="xxxx.apps.googleusercontent.com" value={settings.googleClientId} onChange={set("googleClientId")} />
      <button className="secondary" onClick={props.onConnect}>
        {props.gConnected ? "연결됨 · 다시 연결" : "연결하기"}
      </button>

      <h3>데이터</h3>
      <p className="muted small">지금은 할 일이 이 기기의 브라우저에만 저장돼요.</p>
      <div className="row">
        <button
          className="secondary"
          onClick={() => {
            const blob = new Blob([localStorage.getItem("items") ?? "[]"], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `할일-백업-${new Date().toLocaleDateString("sv-SE")}.json`;
            a.click();
          }}
        >
          백업 내려받기
        </button>
        <label className="secondary filebtn">
          백업 불러오기
          <input
            type="file"
            accept="application/json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const data = JSON.parse(await f.text());
                if (!Array.isArray(data)) throw new Error();
                localStorage.setItem("items", JSON.stringify(data));
                location.reload();
              } catch {
                toast("백업 파일을 읽지 못했어요.");
              }
            }}
          />
        </label>
      </div>
    </section>
  );
}
