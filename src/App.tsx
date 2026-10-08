import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, dueLabel, daysUntil, uid, usePersisted } from "./store";
import type { Item, Settings } from "./store";
import { chatInItem, makeBriefing, simpleBriefing } from "./ai";
import type { Briefing, ChatReply } from "./ai";
import * as gcal from "./gcal";
import type { CalEvent } from "./gcal";
import { toast } from "./toast";
import { demoItems } from "./demo";

type View = { name: "home" } | { name: "list" } | { name: "item"; id: string } | { name: "settings" };

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
  const current = view.name === "item" ? items.find((i) => i.id === view.id) : undefined;

  return (
    <div className="app">
      <main>
        {view.name === "home" && (
          <Home items={items} events={events} settings={settings} gConnected={!!gToken} onConnect={connectGoogle} onOpen={open} onGoSettings={() => setView({ name: "settings" })} />
        )}
        {view.name === "list" && <List items={items} setItems={setItems} onOpen={open} />}
        {view.name === "item" && current && (
          <ItemView
            item={current}
            settings={settings}
            gToken={gToken}
            update={(fn) => updateItem(current.id, fn)}
            onDelete={() => {
              setItems((all) => all.filter((i) => i.id !== current.id));
              setView({ name: "list" });
            }}
            onBack={() => setView({ name: "list" })}
          />
        )}
        {view.name === "settings" && (
          <SettingsView settings={settings} setSettings={setSettings} gConnected={!!gToken} onConnect={connectGoogle} />
        )}
      </main>
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
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
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

/* ---------------- 항목 상세: 세부 업무 + Claude와 대화 ---------------- */

function ItemView(props: {
  item: Item;
  settings: Settings;
  gToken: string | null;
  update: (fn: (it: Item) => Item) => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const { item, update, settings } = props;
  const [newSub, setNewSub] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [suggestions, setSuggestions] = useState<ChatReply["suggested_subtasks"]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [item.chat.length]);

  const addSub = (title: string, byClaude = false) =>
    update((it) => ({ ...it, subtasks: [...it.subtasks, { id: uid(), title, done: false, byClaude, createdAt: Date.now() }] }));

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setMsg("");
    setBusy(true);
    const userMsg = { role: "user" as const, text: text.trim(), ts: Date.now() };
    update((it) => ({ ...it, chat: [...it.chat, userMsg] }));
    try {
      const r = await chatInItem(settings, item, text.trim());
      update((it) => ({ ...it, chat: [...it.chat, { role: "assistant", text: r.reply, ts: Date.now() }] }));
      setSuggestions(r.suggested_subtasks);
    } catch (e) {
      update((it) => ({ ...it, chat: [...it.chat, { role: "assistant", text: `⚠️ ${(e as Error).message}`, ts: Date.now() }] }));
    } finally {
      setBusy(false);
    }
  };

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
          마감 <input type="date" value={item.due} onChange={(e) => update((it) => ({ ...it, due: e.target.value }))} />
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

      <h3>Claude와 이야기하기</h3>
      <div className="chat">
        {item.chat.length === 0 && (
          <div className="starter">
            <p className="muted">이 일에 대해 이야기하면 Claude가 필요한 세부 업무를 정리해 줘요.</p>
            <button className="secondary" onClick={() => send("이 일을 끝내려면 뭘 해야 할지 세부 업무로 나눠 줘.")} disabled={busy}>
              세부 업무 나눠 줘
            </button>
          </div>
        )}
        {item.chat.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="bubble assistant typing">생각 중…</div>}
        {suggestions.length > 0 && (
          <div className="suggest">
            <p className="label">Claude가 제안한 세부 업무</p>
            {suggestions.map((s, i) => (
              <div key={i} className="sugg">
                <div className="grow">
                  <strong>{s.title}</strong>
                  <p className="muted small">{s.why}</p>
                </div>
                <button
                  className="small"
                  onClick={() => {
                    addSub(s.title, true);
                    setSuggestions((a) => a.filter((_, j) => j !== i));
                  }}
                >
                  추가
                </button>
              </div>
            ))}
            <button
              className="link"
              onClick={() => {
                suggestions.forEach((s) => addSub(s.title, true));
                setSuggestions([]);
              }}
            >
              모두 추가
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <textarea
          rows={1}
          placeholder={settings.apiKey ? "무엇이 필요한지 이야기해 보세요" : "설정에서 API 키를 넣어 주세요"}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(msg);
            }
          }}
        />
        <button onClick={() => send(msg)} disabled={busy || !msg.trim()}>
          보내기
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
