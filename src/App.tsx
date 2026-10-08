import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, dueLabel, daysUntil, uid, usePersisted } from "./store";
import type { Action, Item, Msg, Settings } from "./store";
import { homeChat, makeBriefing, simpleBriefing, streamChat } from "./ai";
import type { Briefing, ToolRunner } from "./ai";
import { Markdown } from "./md";
import * as gcal from "./gcal";
import type { CalEvent } from "./gcal";
import { toast } from "./toast";
import { demoItems } from "./demo";

type View = { name: "home" } | { name: "list" } | { name: "item"; id: string } | { name: "chat"; id: string } | { name: "settings" };

export default function App() {
  const [items, setItems] = usePersisted<Item[]>("items", import.meta.env.VITE_DEMO ? demoItems() : []);
  const [settings, setSettings] = usePersisted<Settings>("settings", DEFAULT_SETTINGS);
  const [homeChat, setHomeChat] = usePersisted<Msg[]>("homeChat", []);
  const [view, setView] = useState<View>({ name: "home" });
  const [events, setEvents] = useState<CalEvent[]>([]);
  const cal: gcal.CalConfig = { url: settings.calendarUrl, key: settings.calendarKey };
  const calOn = !!settings.calendarUrl;

  // 캘린더 연결용 키는 처음 한 번 만들어 둔다.
  useEffect(() => {
    if (!settings.calendarKey) setSettings((s) => ({ ...s, calendarKey: gcal.newKey() }));
  }, [settings.calendarKey, setSettings]);

  const loadEvents = useCallback(() => {
    if (!settings.calendarUrl) return setEvents([]);
    gcal
      .upcoming({ url: settings.calendarUrl, key: settings.calendarKey })
      .then(setEvents)
      .catch((e) => toast((e as Error).message));
  }, [settings.calendarUrl, settings.calendarKey]);
  useEffect(loadEvents, [loadEvents]);

  // 대화 중 도구가 연달아 실행될 때 최신 목록을 바로 보도록 ref에도 들고 있는다.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const commit = useCallback(
    (next: Item[]) => {
      itemsRef.current = next;
      setItems(next);
    },
    [setItems],
  );

  const updateItem = useCallback(
    (id: string, fn: (it: Item) => Item) =>
      setItems((all) => all.map((it) => (it.id === id ? { ...fn(it), updatedAt: Date.now() } : it))),
    [setItems],
  );

  const runTool: ToolRunner = async (name, input) => {
    const all = itemsRef.current;
    if (name === "add_item") {
      const x = input as { title: string; due?: string; note?: string; subtasks?: string[] };
      const it: Item = {
        id: uid(),
        title: x.title,
        note: x.note ?? "",
        due: x.due ?? "",
        done: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        subtasks: (x.subtasks ?? []).map((t) => ({ id: uid(), title: t, done: false, byClaude: true, createdAt: Date.now() })),
        chat: [],
      };
      commit([it, ...all]);
      return {
        result: `추가함. id=${it.id}`,
        action: { kind: "item", text: `할 일 추가: ${it.title}${it.due ? ` (${it.due})` : ""}`, undo: { itemId: it.id } },
      };
    }
    if (name === "add_subtasks") {
      const x = input as { item_id: string; subtasks: string[] };
      const target = all.find((i) => i.id === x.item_id);
      if (!target) throw new Error("그 id의 할 일이 없어요.");
      const subs = x.subtasks.map((t) => ({ id: uid(), title: t, done: false, byClaude: true, createdAt: Date.now() }));
      commit(all.map((i) => (i.id === target.id ? { ...i, subtasks: [...i.subtasks, ...subs], updatedAt: Date.now() } : i)));
      return {
        result: `'${target.title}'에 ${subs.length}개 추가함.`,
        action: { kind: "subtasks", text: `'${target.title}'에 세부 업무 추가: ${x.subtasks.join(", ")}`, undo: { itemId: target.id, subtaskIds: subs.map((s) => s.id) } },
      };
    }
    if (name === "update_item") {
      const x = input as { item_id: string; title?: string; due?: string; done?: boolean };
      const target = all.find((i) => i.id === x.item_id);
      if (!target) throw new Error("그 id의 할 일이 없어요.");
      const change: Partial<Item> = {};
      const prev: Partial<Item> = {};
      const words: string[] = [];
      if (x.title !== undefined) {
        change.title = x.title;
        prev.title = target.title;
        words.push(`제목 → ${x.title}`);
      }
      if (x.due !== undefined) {
        change.due = x.due;
        prev.due = target.due;
        words.push(x.due ? `마감 → ${x.due}` : "마감 없앰");
      }
      if (x.done !== undefined) {
        change.done = x.done;
        prev.done = target.done;
        words.push(x.done ? "완료 처리" : "다시 진행 중");
      }
      commit(all.map((i) => (i.id === target.id ? { ...i, ...change, updatedAt: Date.now() } : i)));
      return {
        result: "바꿈.",
        action: { kind: "update", text: `'${target.title}' ${words.join(", ")}`, undo: { itemId: target.id, prev } },
      };
    }
    const x = input as { title: string; date?: string; start?: string; end?: string };
    await gcal.addEvent(cal, x);
    loadEvents();
    const when = x.start ? new Date(x.start).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : x.date;
    return { result: "캘린더에 넣음.", action: { kind: "event", text: `캘린더에 추가: ${x.title} (${when})` } };
  };

  const undo = (a: Action) => {
    const u = a.undo;
    if (!u) return;
    if (a.kind === "item") setItems((all) => all.filter((i) => i.id !== u.itemId));
    if (a.kind === "subtasks") updateItem(u.itemId, (it) => ({ ...it, subtasks: it.subtasks.filter((s) => !u.subtaskIds?.includes(s.id)) }));
    if (a.kind === "update") updateItem(u.itemId, (it) => ({ ...it, ...u.prev }));
  };

  const open = (id: string) => id && items.some((i) => i.id === id) && setView({ name: "item", id });
  const current = view.name === "item" || view.name === "chat" ? items.find((i) => i.id === view.id) : undefined;

  return (
    <div className={`app ${view.name === "chat" ? "in-chat" : ""} ${view.name === "home" ? "in-home" : ""}`}>
      <main>
        {view.name === "home" && (
          <HomeChat
            items={items}
            events={events}
            settings={settings}
            calOn={calOn}
            chat={homeChat}
            setChat={setHomeChat}
            runTool={runTool}
            onUndo={undo}
            onOpen={open}
            onGoSettings={() => setView({ name: "settings" })}
          />
        )}
        {view.name === "list" && <List items={items} setItems={setItems} onOpen={open} />}
        {view.name === "item" && current && (
          <ItemView
            item={current}
            cal={calOn ? cal : null}
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
        {view.name === "settings" && <SettingsView settings={settings} setSettings={setSettings} calOn={calOn} eventsCount={events.length} onTest={loadEvents} />}
      </main>
      {view.name !== "chat" && (
        <nav className="tabs">
          <button className={view.name === "home" ? "on" : ""} onClick={() => setView({ name: "home" })}>
            <span>💬</span>비서
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

/* ---------------- 홈: 비서와 대화 ---------------- */

let briefingCache: { at: number; brief: Briefing } | null = null;

function HomeChat(props: {
  items: Item[];
  events: CalEvent[];
  settings: Settings;
  calOn: boolean;
  chat: Msg[];
  setChat: (fn: (m: Msg[]) => Msg[]) => void;
  runTool: ToolRunner;
  onUndo: (a: Action) => void;
  onOpen: (id: string) => void;
  onGoSettings: () => void;
}) {
  const { items, events, settings, chat, setChat } = props;
  const [brief, setBrief] = useState<Briefing>(() => briefingCache?.brief ?? simpleBriefing(items));
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // 30분에 한 번만 Claude에게 "지금 할 일"을 다시 물어본다.
  useEffect(() => {
    if (!settings.apiKey) return setBrief(simpleBriefing(items));
    if (briefingCache && Date.now() - briefingCache.at < 30 * 60000) return;
    makeBriefing(settings, items, events)
      .then((b) => {
        briefingCache = { at: Date.now(), brief: b };
        setBrief(b);
      })
      .catch(() => setBrief(simpleBriefing(items)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKey, events.length]);

  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [chat.length, streaming]);
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
    const past = chat;
    setChat((c) => [...c, { role: "user", text, ts: Date.now() }]);
    try {
      const r = await homeChat(settings, items, events, props.calOn, past, text, setStreaming, props.runTool);
      briefingCache = null;
      setChat((c) => [...c, { role: "assistant", text: r.text, ts: Date.now(), actions: r.actions.length ? r.actions : undefined }]);
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", text: `⚠️ ${(e as Error).message}`, ts: Date.now() }]);
    } finally {
      setStreaming("");
      setBusy(false);
    }
  };

  const undo = (mi: number, ai: number) => {
    const a = chat[mi]?.actions?.[ai];
    if (!a || a.undone) return;
    props.onUndo(a);
    setChat((c) => c.map((m, i) => (i === mi ? { ...m, actions: m.actions!.map((x, j) => (j === ai ? { ...x, undone: true } : x)) } : m)));
  };

  const hour = new Date().getHours();
  const greet = hour < 12 ? "좋은 아침이에요" : hour < 18 ? "좋은 오후예요" : "오늘도 수고했어요";

  return (
    <section className="homechat">
      <header className="home-head">
        <p className="muted small">{new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" })}</p>
        <h1>{greet}</h1>
      </header>

      <div className="now-strip" onClick={() => props.onOpen(brief.now.item_id)}>
        <p className="label">지금 할 일</p>
        <strong>{brief.now.title}</strong>
        <p className="muted small">{brief.now.reason}</p>
        {brief.updates.length > 0 && (
          <ul>
            {brief.updates.slice(0, 2).map((u, i) => (
              <li
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onOpen(u.item_id);
                }}
              >
                {u.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="thread">
        {chat.length === 0 && !busy && (
          <div className="empty">
            <p>일정이나 할 일을 그냥 말해 주세요. 알아서 할 일 목록에 정리할게요.</p>
            <div className="chips">
              {["내일 오후 3시 치과 예약", "지금 뭐 하면 좋을까?", "이번 주 할 일 정리해 줘"].map((t) => (
                <button key={t} className="chip" onClick={() => send(t)} disabled={!settings.apiKey}>
                  {t}
                </button>
              ))}
            </div>
            {!settings.apiKey && (
              <p className="hint">
                <a onClick={props.onGoSettings}>설정에서 API 키를 넣으면</a> 대화할 수 있어요.
              </p>
            )}
          </div>
        )}
        {chat.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg user">
              {m.text}
            </div>
          ) : (
            <div key={i} className="msg assistant">
              <Markdown text={m.text} />
              {m.actions && (
                <div className="actions">
                  {m.actions.map((a, j) => (
                    <div key={j} className={`act ${a.undone ? "undone" : ""}`}>
                      <span className="tick">{a.undone ? "↩" : "✓"}</span>
                      <span className="grow" onClick={() => !a.undone && a.undo && props.onOpen(a.undo.itemId)}>
                        {a.text}
                      </span>
                      {a.undo && !a.undone && (
                        <button className="link small" onClick={() => undo(i, j)}>
                          되돌리기
                        </button>
                      )}
                    </div>
                  ))}
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
          placeholder={settings.apiKey ? "일정이나 할 일을 말해 주세요" : "설정에서 API 키를 넣어 주세요"}
          value={msg}
          disabled={!settings.apiKey}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
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
  cal: gcal.CalConfig | null;
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

  const addToCalendar = async () => {
    if (!item.due) return;
    if (!props.cal) {
      window.open(gcal.addLink(item.title, item.due), "_blank");
      return;
    }
    try {
      const id = await gcal.addEvent(props.cal, { title: `⏰ ${item.title}`, date: item.due });
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
        {item.due && !item.calendarEventId && (
          <button className="secondary small" onClick={addToCalendar}>
            캘린더에 넣기
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

function SettingsView(props: { settings: Settings; setSettings: (s: Settings) => void; calOn: boolean; eventsCount: number; onTest: () => void }) {
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
      <CalendarSetup settings={settings} setSettings={setSettings} calOn={props.calOn} eventsCount={props.eventsCount} onTest={props.onTest} />

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

function CalendarSetup(props: { settings: Settings; setSettings: (s: Settings) => void; calOn: boolean; eventsCount: number; onTest: () => void }) {
  const { settings, setSettings } = props;
  const [open, setOpen] = useState(!props.calOn);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(gcal.SCRIPT(settings.calendarKey));
      toast("스크립트를 복사했어요.");
    } catch {
      toast("복사하지 못했어요. 아래 글상자에서 직접 복사해 주세요.");
    }
  };
  return (
    <div className="calsetup">
      {props.calOn && (
        <p className="ok">
          연결됨 · 앞으로 7일 일정 {props.eventsCount}개{" "}
          <button className="link small" onClick={props.onTest}>
            다시 불러오기
          </button>
        </p>
      )}
      <p className="muted small">구글 클라우드 설정 없이, 내 구글 계정에 작은 스크립트를 하나 붙여서 연결해요. 처음 한 번만 하면 돼요.</p>
      {props.calOn && !open ? (
        <button className="link" onClick={() => setOpen(true)}>
          연결 방법 다시 보기
        </button>
      ) : (
        <ol className="steps">
          <li>
            컴퓨터에서 <a href="https://script.google.com/home/projects/create" target="_blank" rel="noreferrer">script.google.com 새 프로젝트</a>를 열어요.
          </li>
          <li>
            안에 있는 코드를 모두 지우고 아래 스크립트를 붙여 넣은 뒤 저장해요.
            <div className="row">
              <button className="secondary small" onClick={copy}>
                스크립트 복사
              </button>
            </div>
            <textarea readOnly className="code" rows={4} value={gcal.SCRIPT(settings.calendarKey)} onFocus={(e) => e.target.select()} />
          </li>
          <li>
            오른쪽 위 <b>배포 → 새 배포</b> → 유형 <b>웹 앱</b>, 실행 사용자 <b>나</b>, 액세스 권한 <b>모든 사용자</b>로 배포해요. 권한 확인 창이 뜨면 허용해요.
          </li>
          <li>나온 웹 앱 URL(…/exec로 끝나는 주소)을 아래에 붙여 넣어요.</li>
        </ol>
      )}
      <input
        placeholder="https://script.google.com/macros/s/…/exec"
        value={settings.calendarUrl}
        onChange={(e) => setSettings({ ...settings, calendarUrl: e.target.value.trim() })}
      />
      <p className="muted small">스크립트 안의 비밀 키가 이 기기 앱과 맞아야만 캘린더가 열려요. 다른 기기에서 쓸 때는 같은 주소와 함께 아래 키도 똑같이 맞춰 주세요.</p>
      <input value={settings.calendarKey} onChange={(e) => setSettings({ ...settings, calendarKey: e.target.value.trim() })} aria-label="캘린더 비밀 키" />
    </div>
  );
}
