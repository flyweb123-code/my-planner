import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, dueLabel, daysUntil, uid, usePersisted } from "./store";
import type { Action, Item, Msg, Settings } from "./store";
import { type World, checkKey, greeting, homeChat, makeBriefing, simpleBriefing, streamChat } from "./ai";
import type { Briefing, ToolRunner } from "./ai";
import { Markdown } from "./md";
import * as gcal from "./gcal";
import type { CalEvent } from "./gcal";
import { toast } from "./toast";
import { IconBack, IconCalendar, IconChat, IconCheck, IconLeft, IconList, IconMore, IconPlus, IconRight, IconSettings, IconUp } from "./icons";
import { demoItems } from "./demo";

type View = { name: "home" } | { name: "list" } | { name: "item"; id: string } | { name: "chat"; id: string; sub?: string; initial?: string } | { name: "calendar" } | { name: "settings" };

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

  // 날짜가 있는 할 일은 구글 캘린더에 자동으로 올리고, 바뀌면 고치고, 지우면 같이 지운다.
  // 제목을 타이핑하는 중에 계속 부르지 않도록 잠깐 기다렸다가 한 번에 반영한다.
  const syncPrev = useRef(items);
  const toDelete = useRef<string[]>([]);
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    for (const p of syncPrev.current) if (!ids.has(p.id) && p.calendarEventId) toDelete.current.push(p.calendarEventId);
    syncPrev.current = items;
    if (!gToken) return;
    const timer = setTimeout(async () => {
      const token = gcal.savedToken();
      if (!token) return setGToken(null);
      let changed = false;
      for (const eid of toDelete.current.splice(0)) {
        await gcal.deleteEvent(token, eid).catch(() => {});
        changed = true;
      }
      for (const it of items) {
        if (inFlight.current.has(it.id)) continue;
        const want = it.due ? `${it.title}|${it.due}|${it.time ?? ""}` : "";
        if (want === (it.calSynced ?? "") && (!!it.calendarEventId === !!want)) continue;
        inFlight.current.add(it.id);
        try {
          if (!want && it.calendarEventId) {
            await gcal.deleteEvent(token, it.calendarEventId);
            setItems((all) => all.map((x) => (x.id === it.id ? { ...x, calendarEventId: undefined, calSynced: "" } : x)));
          } else if (want && !it.calendarEventId) {
            const eid = await gcal.createForItem(token, it);
            setItems((all) => all.map((x) => (x.id === it.id ? { ...x, calendarEventId: eid, calSynced: want } : x)));
          } else if (want) {
            await gcal.updateForItem(token, it.calendarEventId!, it);
            setItems((all) => all.map((x) => (x.id === it.id ? { ...x, calSynced: want } : x)));
          }
          changed = true;
        } catch (e) {
          toast(`캘린더에 반영하지 못했어요: ${(e as Error).message}`);
          if (!gcal.savedToken()) setGToken(null);
          break;
        } finally {
          inFlight.current.delete(it.id);
        }
      }
      if (changed) loadEvents();
    }, 1200);
    return () => clearTimeout(timer);
  }, [items, gToken, setItems, loadEvents]);

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
      const x = input as { title: string; due?: string; time?: string; note?: string; subtasks?: string[] };
      const it: Item = {
        id: uid(),
        title: x.title,
        note: x.note ?? "",
        due: x.due ?? "",
        time: x.time || undefined,
        done: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        subtasks: (x.subtasks ?? []).map((t) => ({ id: uid(), title: t, done: false, byClaude: true, createdAt: Date.now() })),
        chat: [],
      };
      commit([it, ...all]);
      return {
        result: `추가함. id=${it.id}`,
        action: {
          kind: "item",
          text: `할 일 추가: ${it.title}${it.due ? ` (${it.due}${it.time ? " " + it.time : ""})` : ""}${it.due && calOn ? " · 캘린더에도 올림" : ""}`,
          undo: { itemId: it.id },
        },
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
      const x = input as { item_id: string; title?: string; due?: string; time?: string; done?: boolean };
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
      if (x.time !== undefined) {
        change.time = x.time || undefined;
        prev.time = target.time;
        words.push(x.time ? `시간 → ${x.time}` : "시간 없앰");
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
    throw new Error(`모르는 도구: ${name}`);
  };

  const undo = (a: Action) => {
    const u = a.undo;
    if (!u) return;
    if (a.kind === "item") setItems((all) => all.filter((i) => i.id !== u.itemId));
    if (a.kind === "subtasks") updateItem(u.itemId, (it) => ({ ...it, subtasks: it.subtasks.filter((s) => !u.subtaskIds?.includes(s.id)) }));
    if (a.kind === "update") updateItem(u.itemId, (it) => ({ ...it, ...u.prev }));
  };

  const open = (id: string) => id && setView({ name: "item", id });
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
            onChat={(sub, initial) => setView({ name: "chat", id: current.id, sub, initial })}
            update={(fn) => updateItem(current.id, fn)}
            onDelete={() => {
              setItems((all) => all.filter((i) => i.id !== current.id));
              setView({ name: "list" });
            }}
            onBack={() => setView({ name: "list" })}
          />
        )}
        {view.name === "chat" && current && (
          <ChatView key={view.sub ?? "item"} world={{ items, events, home: homeChat }} item={current} subId={view.sub} initial={view.initial} settings={settings} update={(fn) => updateItem(current.id, fn)} onBack={() => setView({ name: "item", id: current.id })} />
        )}
        {view.name === "calendar" && (
          <CalendarView items={items} gToken={gToken} calOn={calOn} linked={linked} onConnect={connectCalendar} onOpen={open} onGoSettings={() => setView({ name: "settings" })} />
        )}
        {view.name === "settings" && (
          <SettingsView settings={settings} setSettings={setSettings} calOn={calOn} linked={linked} eventsCount={events.length} onConnect={connectCalendar} onDisconnect={disconnectCalendar} />
        )}
      </main>
      {view.name !== "chat" && (
        <nav className="tabs">
          <button className={view.name === "home" ? "on" : ""} onClick={() => setView({ name: "home" })}>
            <IconChat />
            비서
          </button>
          <button className={view.name === "list" || view.name === "item" ? "on" : ""} onClick={() => setView({ name: "list" })}>
            <IconList />
            할 일
          </button>
          <button className={view.name === "calendar" ? "on" : ""} onClick={() => setView({ name: "calendar" })}>
            <IconCalendar />
            캘린더
          </button>
          <button className={view.name === "settings" ? "on" : ""} onClick={() => setView({ name: "settings" })}>
            <IconSettings />
            설정
          </button>
        </nav>
      )}
    </div>
  );
}

/* ---------------- 홈: 비서와 대화 ---------------- */

let briefCache: { at: number; brief: Briefing } | null = null;

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
      if (r.actions.length) briefCache = null;
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

  // 홈을 열 때마다 비서가 먼저 말을 건다: 지금 할 일, 놓친 것, 확인할 것. 30분 동안은 다시 묻지 않는다.
  const [sessionStart] = useState(chat.length);
  const [brief, setBrief] = useState<Briefing | null>(() => briefCache?.brief ?? null);
  const [briefLoading, setBriefLoading] = useState(false);
  useEffect(() => {
    if (!settings.apiKey) return setBrief(simpleBriefing(items));
    if (briefCache && Date.now() - briefCache.at < 30 * 60000) return;
    setBriefLoading(true);
    makeBriefing(settings, items, events)
      .then((b) => {
        briefCache = { at: Date.now(), brief: b };
        setBrief(b);
      })
      .catch(() => setBrief(simpleBriefing(items)))
      .finally(() => setBriefLoading(false));
    // 처음 열 때와 캘린더 일정이 들어왔을 때만 다시 만든다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKey, events.length]);

  const ask = (text: string) => send(`${text} 이거 어떻게 하면 좋을까?`);
  const briefing = (
    <div className="msg assistant brief">
      <h2>{greeting()}</h2>
      {!brief || briefLoading ? (
        <p className="muted">할 일과 일정을 살펴보는 중…</p>
      ) : (
        <>
          <button className="now-line" onClick={() => settings.apiKey && ask(brief.now.text)}>
            <span className="label">지금</span>
            <span>{brief.now.text}</span>
          </button>
          {brief.missed.length > 0 && (
            <div className="bgroup">
              <p className="label warn">놓친 것</p>
              {brief.missed.map((m, i) => (
                <button key={i} className="bline" onClick={() => settings.apiKey && ask(m.text)}>
                  {m.text}
                </button>
              ))}
            </div>
          )}
          {brief.check.length > 0 && (
            <div className="bgroup">
              <p className="label">확인할 것</p>
              {brief.check.map((m, i) => (
                <button key={i} className="bline" onClick={() => settings.apiKey && ask(m.text)}>
                  {m.text}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {!settings.apiKey && (
        <p className="hint">
          <a onClick={props.onGoSettings}>설정에서 API 키를 넣으면</a> Claude가 직접 살펴보고 대화도 할 수 있어요.
        </p>
      )}
    </div>
  );

  return (
    <section className="homechat">
      {props.calExpired && (
        <button className="reconnect" onClick={props.onReconnect}>
          캘린더 연결이 끝났어요 · 다시 연결
        </button>
      )}

      <div className="thread">
        {chat.slice(0, sessionStart).length === 0 && briefing}
        {chat.map((m, i) => [
          i === sessionStart && sessionStart > 0 ? <div key="brief">{briefing}</div> : null,
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
        ])}
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
          <IconUp />
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
      <div className="add add-card">
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
          {it.chat.length > 0 && <span className="chatcount"><IconChat /> {it.chat.length}</span>}
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
  onChat: (subId?: string, initial?: string) => void;
}) {
  const { item, update } = props;
  const [newSub, setNewSub] = useState("");
  const [ask, setAsk] = useState("");
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [swiped, setSwiped] = useState<string | null>(null);

  const addSub = (title: string) =>
    update((it) => ({ ...it, subtasks: [...it.subtasks, { id: uid(), title, done: false, byClaude: false, createdAt: Date.now() }] }));
  const toggleSub = (id: string) => update((it) => ({ ...it, subtasks: it.subtasks.map((x) => (x.id === id ? { ...x, done: !x.done } : x)) }));
  const removeSub = (id: string) => update((it) => ({ ...it, subtasks: it.subtasks.filter((x) => x.id !== id) }));

  const doneCount = item.subtasks.filter((s) => s.done).length;
  const last = item.chat[item.chat.length - 1];
  const plain = (t: string) => t.replace(/[*`#]/g, "");
  const metaBits = [
    item.due ? dueLabel(item.due) + (item.time ? ` ${item.time}` : "") : "마감 없음",
    item.subtasks.length ? `세부 업무 ${doneCount}/${item.subtasks.length}` : "",
    item.due && props.gToken ? (item.calendarEventId ? "캘린더에 있음" : "캘린더에 올리는 중") : "",
  ].filter(Boolean);

  const startAsk = () => {
    const t = ask.trim();
    if (!t) return;
    setAsk("");
    props.onChat(undefined, t);
  };

  return (
    <section className="detail" onClick={() => (setSwiped(null), setMenu(false))}>
      <header className="page-head">
        <button className="back" onClick={props.onBack}>
          <IconBack />
          할 일
        </button>
        <div className="menu-wrap">
          <button className="icon-btn" aria-label="더 보기" onClick={(e) => (e.stopPropagation(), setMenu(!menu), setConfirmDel(false))}>
            <IconMore />
          </button>
          {menu && (
            <div className="popover" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => (update((it) => ({ ...it, done: !it.done })), setMenu(false))}>{item.done ? "완료 취소" : "완료로 표시"}</button>
              <button className="danger" onClick={() => (confirmDel ? props.onDelete() : setConfirmDel(true))}>
                {confirmDel ? "한 번 더 누르면 삭제" : "할 일 삭제"}
              </button>
            </div>
          )}
        </div>
      </header>

      <input className="title-input" value={item.title} onChange={(e) => update((it) => ({ ...it, title: e.target.value }))} />
      <button className={`meta-line ${item.done ? "is-done" : ""}`} onClick={() => setShowInfo(!showInfo)}>
        {item.done && <span className="pill-done">완료</span>}
        {metaBits.join(" · ")}
        <span className={`chev small ${showInfo ? "up" : ""}`}><IconRight /></span>
      </button>

      {showInfo && (
        <div className="fields">
          <div className="field">
            <span>마감</span>
            <DateField value={item.due} onChange={(v) => update((it) => ({ ...it, due: v, time: v ? it.time : undefined }))} />
          </div>
          {item.due && (
            <div className="field">
              <span>시간</span>
              <input type="time" className="timefield" value={item.time ?? ""} onChange={(e) => update((it) => ({ ...it, time: e.target.value || undefined }))} />
            </div>
          )}
          {item.due && !props.gToken && (
            <div className="field">
              <span>구글 캘린더</span>
              <a className="secondary small btnlink" href={gcal.addLink(item.title, item.due)} target="_blank" rel="noreferrer">
                캘린더에 넣기
              </a>
            </div>
          )}
          <div className="field memo">
            <textarea placeholder="메모 (Claude도 같이 봐요)" value={item.note} onChange={(e) => update((it) => ({ ...it, note: e.target.value }))} />
          </div>
        </div>
      )}

      <div className="ask">
        <textarea
          rows={1}
          placeholder="이 일에 대해 Claude에게 물어보기"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              startAsk();
            }
          }}
        />
        <button className="send" aria-label="보내기" onClick={startAsk} disabled={!ask.trim()}>
          <IconUp />
        </button>
      </div>
      {last && (
        <button className="resume" onClick={() => props.onChat()}>
          <IconChat />
          <span className="grow">
            <strong>이 일 전체 대화</strong>
            <span className="preview">{plain(last.text)}</span>
          </span>
          <span className="chev"><IconRight /></span>
        </button>
      )}

      <div className="section-head">
        <h3>세부 업무</h3>
        {item.subtasks.length > 0 && <span className="muted small">왼쪽으로 밀면 완료, 삭제</span>}
      </div>
      <ul className="threads">
        {item.subtasks.map((s) => {
          const lm = s.chat?.[s.chat.length - 1];
          return (
            <SwipeRow
              key={s.id}
              open={swiped === s.id}
              onOpenChange={(o) => setSwiped(o ? s.id : null)}
              onTap={() => props.onChat(s.id)}
              actions={[
                { label: s.done ? "되돌리기" : "완료", cls: "ok", run: () => toggleSub(s.id) },
                { label: "삭제", cls: "danger", run: () => removeSub(s.id) },
              ]}
            >
              <span className={`tick ${s.done ? "on" : ""}`}>{s.done && <IconCheck />}</span>
              <span className="grow">
                <span className={`t ${s.done ? "done" : ""}`}>{s.title}</span>
                <span className="preview">{lm ? plain(lm.text) : s.done ? "완료" : "눌러서 Claude와 정하기"}</span>
              </span>
              {s.chat && s.chat.length > 0 && <span className="count">{s.chat.length}</span>}
            </SwipeRow>
          );
        })}
        <li className="add-row">
          <IconPlus />
          <input
            placeholder="세부 업무 추가"
            value={newSub}
            onChange={(e) => setNewSub(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && newSub.trim()) {
                addSub(newSub.trim());
                setNewSub("");
              }
            }}
          />
        </li>
      </ul>
      {item.subtasks.length === 0 && <p className="muted small hint">Claude에게 물어보면 필요한 세부 업무를 나눠 줘요.</p>}
    </section>
  );
}

/* 왼쪽으로 밀면 뒤에 숨은 버튼이 드러나는 줄 */
function SwipeRow(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTap: () => void;
  actions: { label: string; cls: string; run: () => void }[];
  children: React.ReactNode;
}) {
  const W = 76 * props.actions.length;
  const [dx, setDx] = useState<number | null>(null);
  const start = useRef<{ x: number; y: number; base: number; dir?: "h" | "v" } | null>(null);
  const moved = useRef(false);
  const offset = dx ?? (props.open ? -W : 0);

  return (
    <li className="swipe" onClick={(e) => e.stopPropagation()}>
      <div className="swipe-actions" style={{ width: W }}>
        {props.actions.map((a) => (
          <button key={a.label} className={a.cls} onClick={() => (a.run(), props.onOpenChange(false))}>
            {a.label}
          </button>
        ))}
      </div>
      <div
        className="swipe-body"
        style={{ transform: `translateX(${offset}px)`, transition: dx === null ? "transform .22s ease" : "none" }}
        onPointerDown={(e) => {
          start.current = { x: e.clientX, y: e.clientY, base: props.open ? -W : 0 };
          moved.current = false;
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const mx = e.clientX - s.x;
          const my = e.clientY - s.y;
          if (!s.dir) {
            if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
            s.dir = Math.abs(mx) > Math.abs(my) ? "h" : "v";
            if (s.dir === "h") (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }
          if (s.dir !== "h") return;
          moved.current = true;
          setDx(Math.max(-W - 30, Math.min(0, s.base + mx)));
        }}
        onPointerUp={() => {
          const s = start.current;
          start.current = null;
          if (moved.current && dx !== null) {
            props.onOpenChange(dx < -W / 2);
            setDx(null);
            return;
          }
          setDx(null);
          if (s?.dir === "v") return;
          if (props.open) props.onOpenChange(false);
          else props.onTap();
        }}
        onPointerCancel={() => {
          start.current = null;
          setDx(null);
        }}
      >
        {props.children}
      </div>
    </li>
  );
}

/* ---------------- Claude와 대화 ---------------- */

function ChatView(props: {
  item: Item;
  subId?: string;
  initial?: string;
  world: World;
  settings: Settings;
  update: (fn: (it: Item) => Item) => void;
  onBack: () => void;
}) {
  const { item, update, settings, subId } = props;
  const sub = subId ? item.subtasks.find((s) => s.id === subId) : undefined;
  const chat = (sub ? sub.chat : item.chat) ?? [];
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const sentInitial = useRef(false);

  // 이 대화(할 일 전체 또는 세부 업무 하나)의 메시지만 바꾼다.
  const setChat = (it: Item, fn: (c: Msg[]) => Msg[]): Item =>
    subId ? { ...it, subtasks: it.subtasks.map((s) => (s.id === subId ? { ...s, chat: fn(s.chat ?? []) } : s)) } : { ...it, chat: fn(it.chat) };

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
    const withUser = setChat(item, (c) => [...c, { role: "user", text, ts: Date.now() }]);
    update(() => withUser);
    try {
      const r = await streamChat(settings, withUser, setStreaming, subId, props.world);
      update((it) =>
        setChat(it, (c) => [...c, { role: "assistant", text: r.text, ts: Date.now(), suggestions: r.suggestions.length ? r.suggestions : undefined }]),
      );
    } catch (e) {
      update((it) => setChat(it, (c) => [...c, { role: "assistant", text: `⚠️ ${(e as Error).message}`, ts: Date.now() }]));
    } finally {
      setStreaming("");
      setBusy(false);
    }
  };

  useEffect(() => {
    if (props.initial && !sentInitial.current && settings.apiKey) {
      sentInitial.current = true;
      send(props.initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addSuggestion = (msgIdx: number, sIdx: number | "all") =>
    update((it) => {
      const m = ((subId ? it.subtasks.find((s) => s.id === subId)?.chat : it.chat) ?? [])[msgIdx];
      if (!m?.suggestions) return it;
      const picked = m.suggestions.filter((s, j) => !s.added && (sIdx === "all" || j === sIdx));
      const fresh = picked.map((s) => ({ id: uid(), title: s.title, done: false, byClaude: true, createdAt: Date.now() }));
      // 세부 업무 대화에서 나온 제안은 그 업무 바로 뒤에 넣는다.
      const at = subId ? it.subtasks.findIndex((s) => s.id === subId) + 1 : it.subtasks.length;
      const next = { ...it, subtasks: [...it.subtasks.slice(0, at), ...fresh, ...it.subtasks.slice(at)] };
      return setChat(next, (c) =>
        c.map((x, i) => (i === msgIdx ? { ...x, suggestions: x.suggestions!.map((s, j) => (sIdx === "all" || j === sIdx ? { ...s, added: true } : s)) } : x)),
      );
    });

  const doneCount = item.subtasks.filter((s) => s.done).length;
  const chips = sub
    ? ["이거 어떻게 하면 좋을까?", "언제 하는 게 좋을까?", "더 잘게 나눠 줘"]
    : ["이 일을 세부 업무로 나눠 줘", "어디서부터 시작하면 좋을까?", "이번 주 안에 끝내려면 어떻게 해야 해?"];

  return (
    <section className="chatview">
      <header className="chat-head">
        <button className="icon-btn" aria-label="뒤로" onClick={props.onBack}>
          <IconBack />
        </button>
        <div className="grow">
          <strong>{sub ? sub.title : item.title}</strong>
          <span className="muted small">
            {sub
              ? `${item.title}${sub.done ? " · 완료" : ""}`
              : `${item.subtasks.length ? `세부 업무 ${doneCount}/${item.subtasks.length}` : "세부 업무 없음"}${item.due ? ` · ${dueLabel(item.due)}` : ""}`}
          </span>
        </div>
        {sub && (
          <button className={`pill-toggle ${sub.done ? "on" : ""}`} onClick={() => update((it) => ({ ...it, subtasks: it.subtasks.map((s) => (s.id === subId ? { ...s, done: !s.done } : s)) }))}>
            {sub.done ? <><IconCheck /> 완료</> : "완료하기"}
          </button>
        )}
      </header>

      <div className="thread">
        {chat.length === 0 && !busy && (
          <div className="empty">
            <p>{sub ? "이 세부 업무를 어떻게 할지 Claude와 정해 보세요." : "이 일에 대해 무엇이든 이야기해 보세요."}</p>
            <div className="chips">
              {chips.map((t) => (
                <button key={t} className="chip" onClick={() => send(t)} disabled={!settings.apiKey}>
                  {t}
                </button>
              ))}
            </div>
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
          <IconUp />
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
            <span className="chev"><IconRight /></span>
          </li>
          <li onClick={() => setPage("calendar")}>
            <span className="grow">
              <strong>구글 캘린더</strong>
              <span className={`status ${props.calOn ? "on" : ""}`}>{props.calOn ? "연결됨" : props.linked ? "다시 연결 필요" : "연결 안 됨"}</span>
            </span>
            <span className="chev"><IconRight /></span>
          </li>
          <li onClick={() => setPage("data")}>
            <span className="grow">
              <strong>데이터 백업</strong>
              <span className="status">내려받기, 불러오기</span>
            </span>
            <span className="chev"><IconRight /></span>
          </li>
        </ul>
      </section>
    );

  const titles = { claude: "Claude 연결", calendar: "구글 캘린더", data: "데이터 백업" };
  return (
    <section className="settings">
      <header className="sub-head">
        <button className="back" onClick={() => setPage("main")}>
          <IconBack />
          설정
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
          {props.calOn && <span className="muted small">앞으로 30일 일정 {props.eventsCount}개 · 날짜가 있는 할 일은 자동으로 올라가요</span>}
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

/* ---------------- 캘린더 ---------------- */

type DayEntry = { key: string; title: string; time: string; endTime: string; kind: "google" | "todo"; itemId?: string };

const ymd = (d: Date) => d.toLocaleDateString("sv-SE");
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

function CalendarView(props: {
  items: Item[];
  gToken: string | null;
  calOn: boolean;
  linked: boolean;
  onConnect: () => void;
  onOpen: (id: string) => void;
  onGoSettings: () => void;
}) {
  const today = ymd(new Date());
  const [mode, setMode] = useState<"month" | "list">(() => {
    try {
      return (localStorage.getItem("calMode") as "month" | "list") || "month";
    } catch {
      return "month";
    }
  });
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selected, setSelected] = useState(today);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem("calMode", mode);
    } catch {
      /* 무시 */
    }
  }, [mode]);

  // 달력에 보이는 6주(앞뒤 달 일부 포함) 범위
  const gridStart = new Date(month);
  gridStart.setDate(1 - month.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const rangeFrom = mode === "month" ? cells[0] : new Date(new Date().setHours(0, 0, 0, 0));
  const rangeTo = mode === "month" ? new Date(cells[41].getTime() + 86400000) : new Date(rangeFrom.getTime() + 30 * 86400000);
  const rangeKey = `${ymd(rangeFrom)}~${ymd(rangeTo)}`;

  const load = useCallback(() => {
    if (!props.gToken) return setEvents([]);
    setLoading(true);
    gcal
      .range(props.gToken, rangeFrom, rangeTo)
      .then(setEvents)
      .catch((e) => toast((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.gToken, rangeKey]);
  useEffect(load, [load]);

  // 구글 일정 + 아직 캘린더에 안 올라간 할 일(연결 전이거나 올리는 중)
  const byDay = new Map<string, DayEntry[]>();
  const push = (d: string, e: DayEntry) => byDay.set(d, [...(byDay.get(d) ?? []), e]);
  for (const e of events) push(e.date, { key: e.id, title: e.title, time: e.time, endTime: e.endTime, kind: e.itemId ? "todo" : "google", itemId: e.itemId });
  const synced = new Set(events.map((e) => e.itemId).filter(Boolean));
  for (const it of props.items) if (it.due && !it.done && !synced.has(it.id)) push(it.due, { key: it.id, title: it.title, time: it.time ?? "", endTime: "", kind: "todo", itemId: it.id });
  for (const list of byDay.values()) list.sort((a, b) => (a.time || "00:00").localeCompare(b.time || "00:00"));

  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const goToday = () => {
    const d = new Date();
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelected(today);
  };
  const dayLabel = (d: string) => {
    const w = new Date(d + "T00:00:00").toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" });
    const tomorrow = ymd(new Date(Date.now() + 86400000));
    return d === today ? `오늘 · ${w}` : d === tomorrow ? `내일 · ${w}` : w;
  };

  const Entry = ({ e }: { e: DayEntry }) => (
    <li className={`ev ${e.kind}`} onClick={() => e.itemId && props.onOpen(e.itemId)}>
      <span className="ev-bar" />
      <span className="ev-time">{e.time ? e.time : "종일"}</span>
      <span className="ev-title">{e.title}</span>
      {e.kind === "todo" && <span className="tag">할 일</span>}
    </li>
  );

  return (
    <section className="calendar">
      <header className="page-head">
        <h1>캘린더</h1>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={mode === "month"} className={mode === "month" ? "on" : ""} onClick={() => setMode("month")}>
            월
          </button>
          <button role="tab" aria-selected={mode === "list"} className={mode === "list" ? "on" : ""} onClick={() => setMode("list")}>
            목록
          </button>
        </div>
      </header>

      {!props.calOn && (
        <div className="banner">
          <span className="grow">{props.linked ? "구글 캘린더 연결 시간이 끝났어요." : "지금은 할 일만 보여요. 구글 캘린더를 연결하면 일정도 함께 보여요."}</span>
          {gcal.available() ? (
            <button className="btn small" onClick={props.onConnect}>
              {props.linked ? "다시 연결" : "연결"}
            </button>
          ) : (
            <button className="btn small tonal" onClick={props.onGoSettings}>
              설정
            </button>
          )}
        </div>
      )}

      {mode === "month" ? (
        <>
          <div className="month-nav">
            <h2>
              {month.getFullYear()}년 {month.getMonth() + 1}월
            </h2>
            <div className="month-btns">
              {loading && <span className="spinner" aria-label="불러오는 중" />}
              <button className="btn small tonal" onClick={goToday}>
                오늘
              </button>
              <button className="icon-btn" aria-label="이전 달" onClick={() => shift(-1)}>
                <IconLeft />
              </button>
              <button className="icon-btn" aria-label="다음 달" onClick={() => shift(1)}>
                <IconRight />
              </button>
            </div>
          </div>
          <div className="grid-head">
            {WEEK.map((w, i) => (
              <span key={w} className={i === 0 ? "sun" : i === 6 ? "sat" : ""}>
                {w}
              </span>
            ))}
          </div>
          <div className="grid">
            {cells.map((d) => {
              const k = ymd(d);
              const list = byDay.get(k) ?? [];
              const out = d.getMonth() !== month.getMonth();
              return (
                <button
                  key={k}
                  className={`cell ${out ? "out" : ""} ${k === selected ? "sel" : ""} ${k === today ? "today" : ""} ${d.getDay() === 0 ? "sun" : d.getDay() === 6 ? "sat" : ""}`}
                  onClick={() => {
                    setSelected(k);
                    if (out) setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
                  }}
                >
                  <span className="num">{d.getDate()}</span>
                  {list.slice(0, 2).map((e) => (
                    <span key={e.key} className={`chip-ev ${e.kind}`}>
                      {e.title}
                    </span>
                  ))}
                  {list.length > 2 && <span className="more">+{list.length - 2}</span>}
                </button>
              );
            })}
          </div>
          <div className="day-panel">
            <h3>{dayLabel(selected)}</h3>
            {(byDay.get(selected) ?? []).length ? (
              <ul className="evlist">
                {byDay.get(selected)!.map((e) => (
                  <Entry key={e.key} e={e} />
                ))}
              </ul>
            ) : (
              <p className="muted small">일정이 없어요.</p>
            )}
          </div>
        </>
      ) : (
        <div className="agenda">
          {[...byDay.entries()]
            .filter(([d]) => d >= today && d < ymd(rangeTo))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([d, list]) => (
              <div key={d} className="day-panel">
                <h3 className={d === today ? "is-today" : ""}>{dayLabel(d)}</h3>
                <ul className="evlist">
                  {list.map((e) => (
                    <Entry key={e.key} e={e} />
                  ))}
                </ul>
              </div>
            ))}
          {byDay.size === 0 && <p className="muted">앞으로 30일 동안 일정이 없어요.</p>}
        </div>
      )}
    </section>
  );
}
