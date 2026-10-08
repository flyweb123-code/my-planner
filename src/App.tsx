import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, dueLabel, daysUntil, uid, usePersisted } from "./store";
import type { Action, Item, Msg, Settings } from "./store";
import { checkKey, homeChat, streamChat } from "./ai";
import type { ToolRunner } from "./ai";
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
  const [gToken, setGToken] = useState<string | null>(() => gcal.savedToken());
  const [linked, setLinked] = useState(() => gcal.wasLinked());
  const calOn = !!gToken;

  // 구글 로그인 스크립트를 미리 불러 두어야 버튼을 눌렀을 때 바로 창이 뜬다.
  useEffect(() => {
    if (gcal.available()) gcal.preload().catch(() => {});
  }, []);

  const loadEvents = useCallback(() => {
    if (!gToken) return setEvents([]);
    gcal
      .upcoming(gToken)
      .then(setEvents)
      .catch((e) => {
        setGToken(gcal.savedToken());
        toast((e as Error).message);
      });
  }, [gToken]);
  useEffect(loadEvents, [loadEvents]);

  const connectCalendar = async () => {
    try {
      setGToken(await gcal.signIn());
      setLinked(true);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const disconnectCalendar = () => {
    gcal.signOut();
    setGToken(null);
    setLinked(false);
  };

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
    const token = gcal.savedToken();
    if (!token) {
      setGToken(null);
      throw new Error("캘린더 연결이 만료됐어요. 사용자가 '캘린더 다시 연결'을 눌러야 해요.");
    }
    await gcal.addEvent(token, x);
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
            calExpired={linked && !gToken && gcal.available()}
            onReconnect={connectCalendar}
            chat={homeChat}
            setChat={setHomeChat}
            runTool={runTool}
            onUndo={undo}
            onGoSettings={() => setView({ name: "settings" })}
          />
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
          <SettingsView settings={settings} setSettings={setSettings} calOn={calOn} linked={linked} eventsCount={events.length} onConnect={connectCalendar} onDisconnect={disconnectCalendar} />
        )}
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

function HomeChat(props: {
  items: Item[];
  events: CalEvent[];
  settings: Settings;
  calOn: boolean;
  calExpired: boolean;
  onReconnect: () => void;
  chat: Msg[];
  setChat: (fn: (m: Msg[]) => Msg[]) => void;
  runTool: ToolRunner;
  onUndo: (a: Action) => void;
  onGoSettings: () => void;
}) {
  const { items, events, settings, chat, setChat } = props;
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

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
      {props.calExpired && (
        <button className="reconnect" onClick={props.onReconnect}>
          캘린더 연결이 끝났어요 · 다시 연결
        </button>
      )}

      <div className="thread">
        {chat.length === 0 && !busy && (
          <div className="empty">
            <h2>{greet}</h2>
            <p>일정이나 할 일을 그냥 말해 주세요. 알아서 할 일 목록에 정리할게요.</p>
            <div className="chips">
              {["지금 뭐 하면 좋을까?", "내일 오후 3시 치과 예약", "이번 주 일정 알려 줘"].map((t) => (
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
                      <span className="grow">
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

  const addToCalendar = async () => {
    if (!item.due) return;
    if (!props.gToken) {
      window.open(gcal.addLink(item.title, item.due), "_blank");
      return;
    }
    try {
      const id = await gcal.addEvent(props.gToken, { title: `⏰ ${item.title}`, date: item.due });
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

type SettingsPage = "main" | "claude" | "calendar" | "data";

function SettingsView(props: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  calOn: boolean;
  linked: boolean;
  eventsCount: number;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>("main");
  const { settings } = props;
  const keyTail = settings.apiKey ? `…${settings.apiKey.slice(-4)}` : "";

  if (page === "main")
    return (
      <section className="settings">
        <header className="page-head">
          <h1>설정</h1>
        </header>
        <ul className="menu">
          <li onClick={() => setPage("claude")}>
            <span className="grow">
              <strong>Claude 연결</strong>
              <span className={`status ${settings.apiKey ? "on" : ""}`}>{settings.apiKey ? `API 키 저장됨 ${keyTail}` : "API 키 없음"}</span>
            </span>
            <span className="chev">›</span>
          </li>
          <li onClick={() => setPage("calendar")}>
            <span className="grow">
              <strong>구글 캘린더</strong>
              <span className={`status ${props.calOn ? "on" : ""}`}>{props.calOn ? "연결됨" : props.linked ? "다시 연결 필요" : "연결 안 됨"}</span>
            </span>
            <span className="chev">›</span>
          </li>
          <li onClick={() => setPage("data")}>
            <span className="grow">
              <strong>데이터 백업</strong>
              <span className="status">내려받기, 불러오기</span>
            </span>
            <span className="chev">›</span>
          </li>
        </ul>
      </section>
    );

  const titles = { claude: "Claude 연결", calendar: "구글 캘린더", data: "데이터 백업" };
  return (
    <section className="settings">
      <header className="sub-head">
        <button className="ghost" onClick={() => setPage("main")}>
          ← 설정
        </button>
        <h1>{titles[page]}</h1>
      </header>
      {page === "claude" && <ClaudeSettings settings={settings} setSettings={props.setSettings} />}
      {page === "calendar" && <CalendarSettings {...props} />}
      {page === "data" && <DataSettings />}
    </section>
  );
}

function ClaudeSettings({ settings, setSettings }: { settings: Settings; setSettings: (s: Settings) => void }) {
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "fail"; text: string }>({ state: "idle", text: "" });

  const runCheck = async (s: Settings) => {
    setCheck({ state: "checking", text: "확인하는 중…" });
    try {
      const name = await checkKey(s);
      setCheck({ state: "ok", text: `Claude와 연결됐어요 (${name})` });
    } catch (e) {
      const msg = (e as { status?: number }).status === 401 ? "키가 올바르지 않아요. 다시 복사해 넣어 주세요." : (e as Error).message;
      setCheck({ state: "fail", text: msg });
    }
  };

  const save = () => {
    const key = draft.trim();
    if (!key) return;
    const next = { ...settings, apiKey: key };
    setSettings(next);
    setDraft("");
    toast("API 키를 저장했어요.");
    runCheck(next);
  };

  return (
    <div className="panel">
      <div className={`keybox ${settings.apiKey ? "on" : ""}`}>
        <span className="dot-big" />
        <div className="grow">
          <strong>{settings.apiKey ? "API 키가 저장돼 있어요" : "저장된 API 키가 없어요"}</strong>
          {settings.apiKey && <span className="muted small">sk-ant-…{settings.apiKey.slice(-4)} · 이 기기에만 저장</span>}
        </div>
      </div>
      {settings.apiKey && (
        <div className="row">
          <button className="secondary" onClick={() => runCheck(settings)} disabled={check.state === "checking"}>
            연결 확인
          </button>
          <button
            className="secondary danger-text"
            onClick={() => {
              setSettings({ ...settings, apiKey: "" });
              setCheck({ state: "idle", text: "" });
            }}
          >
            키 지우기
          </button>
        </div>
      )}
      {check.state !== "idle" && <p className={`check ${check.state}`}>{check.state === "ok" ? "✓ " : check.state === "fail" ? "✕ " : ""}{check.text}</p>}

      <label htmlFor="apikey">{settings.apiKey ? "새 키로 바꾸기" : "API 키 넣기"}</label>
      <div className="add">
        <input id="apikey" type="password" placeholder="sk-ant-..." value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <button onClick={save} disabled={!draft.trim()}>
          저장
        </button>
      </div>
      <p className="muted small">
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          console.anthropic.com
        </a>
        에서 키를 만들 수 있어요. 키는 이 기기에만 저장되고 Anthropic 말고는 어디에도 보내지 않아요.
      </p>

      <label htmlFor="model">모델</label>
      <select id="model" value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })}>
        <option value="claude-opus-5-5">Claude Opus 5.5 (가장 똑똑함)</option>
        <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (빠르고 저렴)</option>
        <option value="claude-haiku-5-5">Claude Haiku 5.5 (가장 저렴)</option>
      </select>
    </div>
  );
}

function CalendarSettings(props: { calOn: boolean; linked: boolean; eventsCount: number; onConnect: () => void; onDisconnect: () => void }) {
  if (!gcal.available())
    return (
      <div className="panel">
        <p>구글 로그인 버튼을 쓰려면 앱을 구글에 한 번 등록해야 해요. 등록이 끝나면 여기서 "구글로 연결" 버튼 하나로 연결돼요.</p>
        <p className="muted small">지금도 할 일 화면의 "캘린더에 넣기"를 누르면 구글 캘린더 일정 추가 화면이 열려요.</p>
      </div>
    );
  return (
    <div className="panel">
      <div className={`keybox ${props.calOn ? "on" : ""}`}>
        <span className="dot-big" />
        <div className="grow">
          <strong>{props.calOn ? "구글 캘린더에 연결돼 있어요" : props.linked ? "연결 시간이 끝났어요" : "연결 안 됨"}</strong>
          {props.calOn && <span className="muted small">앞으로 7일 일정 {props.eventsCount}개</span>}
        </div>
      </div>
      {props.calOn ? (
        <button className="secondary danger-text" onClick={props.onDisconnect}>
          연결 끊기
        </button>
      ) : (
        <button className="google" onClick={props.onConnect}>
          <span className="g">G</span> 구글로 연결
        </button>
      )}
      <p className="muted small">서버 없이 이 기기에서만 연결하기 때문에 연결은 1시간마다 끝나요. 그때 비서 화면 위에 뜨는 "다시 연결"을 한 번 누르면 돼요.</p>
    </div>
  );
}

function DataSettings() {
  return (
    <div className="panel">
      <p className="muted small">지금은 할 일이 이 기기의 브라우저에만 저장돼요. 기기를 바꾸거나 다른 기기로 옮길 때 백업을 쓰세요.</p>
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
    </div>
  );
}
