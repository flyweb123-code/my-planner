import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type HomeThread, DEFAULT_SETTINGS, addMinutes, dueLabel, daysUntil, itemEnd, uid, usePersisted } from "./store";
import type { Action, Item, Msg, Settings } from "./store";
import { type World, checkKey, greeting, homeChat, makeBriefing, simpleBriefing, streamChat } from "./ai";
import type { Briefing, ToolRunner } from "./ai";
import { Markdown } from "./md";
import * as gcal from "./gcal";
import type { CalEvent } from "./gcal";
import { toast } from "./toast";
import { IconBack, IconCalendar, IconChat, IconCheck, IconClock, IconCompose, IconLeft, IconList, IconMenu, IconMore, IconPlus, IconRefresh, IconRight, IconSettings, IconUp } from "./icons";
import { demoItems } from "./demo";

type View = { name: "home" } | { name: "list" } | { name: "item"; id: string } | { name: "chat"; id: string; sub?: string; initial?: string } | { name: "calendar" } | { name: "settings" };

export default function App() {
  const [items, setItems] = usePersisted<Item[]>("items", import.meta.env.VITE_DEMO ? demoItems() : []);
  const [settings, setSettings] = usePersisted<Settings>("settings", DEFAULT_SETTINGS);
  // 홈 대화: 여러 채팅으로 나눠 저장한다. 앱을 열면 항상 새 채팅으로 시작한다.
  const [threads, setThreads] = usePersisted<HomeThread[]>("homeChats", []);
  const [activeId, setActiveId] = useState(() => uid());
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    // 예전 한 줄짜리 홈 대화가 있으면 채팅 하나로 옮긴다
    try {
      const old = JSON.parse(localStorage.getItem("homeChat") ?? "[]") as Msg[];
      if (Array.isArray(old) && old.length) {
        const first = old[0].ts || Date.now();
        setThreads((ts) => [{ id: uid(), title: threadTitle(old), createdAt: first, updatedAt: old[old.length - 1].ts || first, msgs: old }, ...ts]);
      }
      localStorage.removeItem("homeChat");
    } catch {
      /* 무시 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const homeChat = threads.find((t) => t.id === activeId)?.msgs ?? [];
  const setHomeChat = useCallback(
    (fn: (m: Msg[]) => Msg[]) =>
      setThreads((ts) => {
        const now = Date.now();
        const t = ts.find((x) => x.id === activeId);
        const msgs = fn(t?.msgs ?? []);
        if (!t) return msgs.length ? [{ id: activeId, title: threadTitle(msgs), createdAt: now, updatedAt: now, msgs }, ...ts] : ts;
        return ts.map((x) => (x.id === activeId ? { ...x, msgs, updatedAt: now, title: x.title || threadTitle(msgs) } : x));
      }),
    [activeId, setThreads],
  );
  // 다른 화면의 클론이 참고할 최근 홈 대화 (모든 채팅에서 최근 것)
  const recentHome = threads
    .flatMap((t) => t.msgs)
    .sort((a, b) => a.ts - b.ts)
    .slice(-6);
  const [view, setView] = useState<View>({ name: "home" });
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [gToken, setGToken] = useState<string | null>(() => gcal.savedToken());
  const [linked, setLinked] = useState(() => gcal.wasLinked());
  const calOn = !!gToken;

  // 대화 화면은 실제로 보이는 영역(키보드를 뺀 높이)에 딱 맞춰 고정한다.
  // 아이폰은 키보드가 올라올 때 화면 전체를 위로 밀어 올리는데, 그러면 입력창이 가려진다.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
      document.documentElement.style.setProperty("--vvtop", `${vv.offsetTop}px`);
    };
    // 일반 화면의 입력칸은 키보드가 올라온 뒤에도 보이도록 가운데로 옮긴다.
    const keepFocusVisible = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.matches("input, textarea") || el.closest(".homechat, .chatview")) return;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > vv.height) el.scrollIntoView({ block: "center" });
    };
    const onResize = () => {
      apply();
      setTimeout(keepFocusVisible, 50);
    };
    apply();
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", apply);
    };
  }, []);

  // 아이폰에서 키보드가 올라오면 화면 아래에 붙은 탭 바도 키보드 위로 같이 올라온다.
  // 글자를 입력하는 동안에는 탭 바를 숨기고, 입력창이 키보드 바로 위에 붙게 한다.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "file", "date", "time"].includes(el.type));
    const onIn = (e: FocusEvent) => isField(e.target) && setTyping(true);
    const onOut = () => setTimeout(() => setTyping(isField(document.activeElement)), 0);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  const [, bump] = useState(0);
  const calExpired = linked && !gToken && gcal.available() && !gcal.hasSession();

  // 연결 유지 서버가 있으면 1시간짜리 권한이 끝날 때마다 조용히 새로 받아 온다.
  const refreshToken = useCallback(async () => {
    const t = gcal.savedToken() ?? (await gcal.renew());
    setGToken((cur) => (cur === t ? cur : t));
    bump((n) => n + 1);
    return t;
  }, []);
  useEffect(() => {
    refreshToken();
    const iv = setInterval(refreshToken, 60_000);
    const onVis = () => document.visibilityState === "visible" && refreshToken();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshToken]);

  // 구글 로그인 스크립트를 미리 불러 두어야 버튼을 눌렀을 때 바로 창이 뜬다.
  useEffect(() => {
    if (gcal.available()) gcal.preload().catch(() => {});
  }, []);

  const loadEvents = useCallback(() => {
    if (!gToken) return setEvents([]);
    gcal
      .upcoming(gToken)
      .then(setEvents)
      .catch(async (e) => {
        if (!gcal.savedToken() && gcal.hasSession() && (await refreshToken())) return;
        setGToken(gcal.savedToken());
        toast((e as Error).message);
      });
  }, [gToken, refreshToken]);
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
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (!token) return setGToken(null);
      let changed = false;
      for (const eid of toDelete.current.splice(0)) {
        await gcal.deleteEvent(token, eid).catch(() => {});
        changed = true;
      }
      for (const it of items) {
        if (inFlight.current.has(it.id)) continue;
        const want = it.due ? `${it.title}|${it.due}|${it.time ?? ""}|${it.endDate ?? ""}|${it.endTime ?? ""}` : "";
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
          if (!gcal.savedToken()) refreshToken();
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
        words.push(x.due ? `일정 → ${x.due}` : "일정 없앰");
      }
      if (x.time !== undefined) {
        change.time = x.time || undefined;
        prev.time = target.time;
        words.push(x.time ? `시간 → ${x.time}` : "시간 없앰");
      }
      // 날짜나 시작 시각이 바뀌면 끝나는 시각은 기본값(1시간 뒤 / 같은 날)으로 되돌린다.
      if (x.due !== undefined || x.time !== undefined) {
        change.endDate = undefined;
        change.endTime = undefined;
        prev.endDate = target.endDate;
        prev.endTime = target.endTime;
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
    <div className={`app ${view.name === "chat" ? "in-chat" : ""} ${view.name === "home" ? "in-home" : ""} ${typing ? "kb-open" : ""}`}>
      <main>
        {view.name === "home" && (
          <HomeChat
            key={activeId}
            onMenu={() => setDrawer(true)}
            onNewChat={() => setActiveId(uid())}
            items={items}
            events={events}
            settings={settings}
            calOn={calOn}
            calExpired={calExpired}
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
          <ChatView key={view.sub ?? "item"} world={{ items, events, home: recentHome }} item={current} subId={view.sub} initial={view.initial} settings={settings} update={(fn) => updateItem(current.id, fn)} onBack={() => setView({ name: "item", id: current.id })} />
        )}
        {view.name === "calendar" && (
          <CalendarView items={items} gToken={gToken} calOn={calOn} linked={linked} onConnect={connectCalendar} onOpen={open} onGoSettings={() => setView({ name: "settings" })} />
        )}
        {view.name === "settings" && (
          <SettingsView settings={settings} setSettings={setSettings} calOn={calOn} linked={linked} eventsCount={events.length} onConnect={connectCalendar} onDisconnect={disconnectCalendar} />
        )}
      </main>
      <PullToRefresh />
      {drawer && (
        <ChatDrawer
          threads={threads}
          activeId={activeId}
          onPick={(id) => {
            setActiveId(id);
            setView({ name: "home" });
            setDrawer(false);
          }}
          onNew={() => {
            setActiveId(uid());
            setView({ name: "home" });
            setDrawer(false);
          }}
          onDelete={(id) => {
            setThreads((ts) => ts.filter((t) => t.id !== id));
            if (id === activeId) setActiveId(uid());
          }}
          onClose={() => setDrawer(false)}
        />
      )}
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
  onMenu: () => void;
  onNewChat: () => void;
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

  useStickToBottom(endRef, [chat.length, streaming]);
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

  // 새 채팅에서는 비서가 먼저 말을 건다: 지금 할 일, 놓친 것, 확인할 것. 30분 동안은 다시 묻지 않는다.
  const [fresh] = useState(chat.length === 0);
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

  // '확인할 것'을 밀어서 숨기면 6시간 동안만 안 보인다. 영영 사라지지 않고 그 뒤 브리핑에 다시 나올 수 있다.
  const [snooze, setSnooze] = useState<Record<string, number>>(() => {
    try {
      const all = JSON.parse(localStorage.getItem("briefSnooze") ?? "{}") as Record<string, number>;
      return Object.fromEntries(Object.entries(all).filter(([, until]) => until > Date.now()));
    } catch {
      return {};
    }
  });
  const snoozeKey = (m: { text: string; item_id: string }) => m.item_id || m.text;
  const hide = (m: { text: string; item_id: string }) => {
    const next = { ...snooze, [snoozeKey(m)]: Date.now() + 6 * 3600000 };
    setSnooze(next);
    try {
      localStorage.setItem("briefSnooze", JSON.stringify(next));
    } catch {
      /* 무시 */
    }
    toast("6시간 동안 숨겼어요");
  };
  const [swipedBrief, setSwipedBrief] = useState<string | null>(null);
  const checks = brief ? brief.check.filter((m) => !(snooze[snoozeKey(m)] > Date.now())) : [];

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
          {checks.length > 0 && (
            <div className="bgroup">
              <p className="label">
                확인할 것 <span className="label-hint">왼쪽으로 밀면 잠시 숨겨요</span>
              </p>
              <ul className="blist">
                {checks.map((m, i) => (
                  <SwipeRow
                    key={`${i}-${m.text}`}
                    open={swipedBrief === `${i}-${m.text}`}
                    onOpenChange={(o) => setSwipedBrief(o ? `${i}-${m.text}` : null)}
                    onTap={() => settings.apiKey && ask(m.text)}
                    actions={[{ label: "나중에", cls: "later", run: () => hide(m) }]}
                  >
                    <span className="grow">{m.text}</span>
                  </SwipeRow>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {!settings.apiKey && (
        <p className="hint">
          <a onClick={props.onGoSettings}>설정에서 API 키를 넣으면</a> 클론이 직접 살펴보고 대화도 할 수 있어요.
        </p>
      )}
    </div>
  );

  return (
    <section className="homechat">
      <header className="home-head">
        <button className="icon-btn" aria-label="채팅 목록" onClick={props.onMenu}>
          <IconMenu />
        </button>
        <strong>클론</strong>
        <button className="icon-btn" aria-label="새 채팅" onClick={props.onNewChat} disabled={chat.length === 0 && !busy}>
          <IconCompose />
        </button>
      </header>
      {props.calExpired && (
        <button className="reconnect" onClick={props.onReconnect}>
          캘린더 연결이 끝났어요 · 다시 연결
        </button>
      )}

      <div className="thread">
        {fresh && briefing}
        {chat.map((m, i) => [
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

/* ---------------- 왼쪽 채팅 목록 ---------------- */

const threadTitle = (msgs: Msg[]) => {
  const first = msgs.find((m) => m.role === "user")?.text ?? "새 채팅";
  return first.length > 30 ? first.slice(0, 30) + "…" : first;
};

function ChatDrawer(props: {
  threads: HomeThread[];
  activeId: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [swiped, setSwiped] = useState<string | null>(null);
  const sorted = [...props.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups: [string, HomeThread[]][] = [
    ["오늘", sorted.filter((t) => t.updatedAt >= startOfToday)],
    ["이전 7일", sorted.filter((t) => t.updatedAt < startOfToday && t.updatedAt >= startOfToday - 7 * 864e5)],
    ["그 이전", sorted.filter((t) => t.updatedAt < startOfToday - 7 * 864e5)],
  ];
  return (
    <div className="drawer-wrap" onClick={props.onClose}>
      <aside className="drawer" onClick={(e) => (e.stopPropagation(), setSwiped(null))}>
        <div className="drawer-head">
          <strong>채팅</strong>
          <button className="icon-btn" aria-label="닫기" onClick={props.onClose}>
            <IconLeft />
          </button>
        </div>
        <button className="new-chat" onClick={props.onNew}>
          <IconCompose /> 새 채팅
        </button>
        <div className="drawer-list">
          {sorted.length === 0 && <p className="muted small">아직 지난 채팅이 없어요.</p>}
          {groups.map(([label, list]) =>
            list.length ? (
              <div key={label}>
                <p className="drawer-label">{label}</p>
                <ul className="threads-list">
                  {list.map((t) => (
                    <SwipeRow
                      key={t.id}
                      open={swiped === t.id}
                      onOpenChange={(o) => setSwiped(o ? t.id : null)}
                      onTap={() => props.onPick(t.id)}
                      actions={[{ label: "삭제", cls: "danger", run: () => props.onDelete(t.id) }]}
                    >
                      <span className={`grow ${t.id === props.activeId ? "on" : ""}`}>{t.title}</span>
                    </SwipeRow>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      </aside>
    </div>
  );
}

/* ---------------- 할 일 목록 ---------------- */

function List({ items, setItems, onOpen }: { items: Item[]; setItems: (fn: (a: Item[]) => Item[]) => void; onOpen: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [swiped, setSwiped] = useState<string | null>(null);

  const remove = (id: string) => {
    setItems((a) => a.filter((x) => x.id !== id));
    toast("할 일을 삭제했어요");
  };
  const toggleDone = (id: string) => setItems((a) => a.map((x) => (x.id === id ? { ...x, done: !x.done, updatedAt: Date.now() } : x)));
  const row = (i: Item) => (
    <ItemRow
      key={i.id}
      it={i}
      open={swiped === i.id}
      onOpenChange={(o) => setSwiped(o ? i.id : null)}
      onOpen={onOpen}
      onToggle={() => toggleDone(i.id)}
      onDelete={() => remove(i.id)}
    />
  );

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
    setAdding(false);
    onOpen(it.id);
  };

  const sorted = [...items].sort((a, b) => (daysUntil(a.due) ?? 9999) - (daysUntil(b.due) ?? 9999) || b.createdAt - a.createdAt);
  const open = sorted.filter((i) => !i.done);
  const done = sorted.filter((i) => i.done);

  return (
    <section onClick={() => setSwiped(null)}>
      <header className="page-head">
        <h1>할 일</h1>
        <button className={`icon-btn add-btn ${adding ? "on" : ""}`} aria-label={adding ? "닫기" : "할 일 추가"} onClick={() => setAdding(!adding)}>
          <IconPlus />
        </button>
      </header>
      {adding && (
      <div className="add add-card">
        <input autoFocus placeholder="앞으로 할 일을 적어 보세요" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
        <DateField value={due} onChange={setDue} />
        <button onClick={add} disabled={!title.trim()}>추가</button>
      </div>
      )}
      {open.length === 0 && !adding && <p className="muted">아직 할 일이 없어요. 오른쪽 위 + 를 눌러 추가해 보세요.</p>}
      <ul className="items">{open.map(row)}</ul>
      {done.length > 0 && (
        <>
          <button className="link" onClick={() => setShowDone(!showDone)}>
            완료한 일 {done.length}개 {showDone ? "접기" : "보기"}
          </button>
          {showDone && (
            <ul className="items done">{done.map(row)}</ul>
          )}
        </>
      )}
    </section>
  );
}

function ItemRow(props: {
  it: Item;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onOpen: (id: string) => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { it } = props;
  const total = it.subtasks.length;
  const doneCount = it.subtasks.filter((s) => s.done).length;
  const n = daysUntil(it.due);
  return (
    <SwipeRow
      open={props.open}
      onOpenChange={props.onOpenChange}
      onTap={() => props.onOpen(it.id)}
      actions={[
        { label: it.done ? "되돌리기" : "완료", cls: "ok", run: props.onToggle },
        { label: "삭제", cls: "danger", run: props.onDelete },
      ]}
    >
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
    </SwipeRow>
  );
}

/* ---------------- 대화창: 맨 아래에 붙어 있기 ---------------- */

// 대화 목록(.thread)만 스크롤된다. 새 메시지가 오거나 키보드가 올라와 높이가 줄면
// 원래 맨 아래를 보고 있었을 때만 다시 맨 아래로 붙인다.
function useStickToBottom(endRef: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const atBottom = useRef(true);
  useEffect(() => {
    const box = endRef.current?.parentElement;
    if (!box) return;
    const toEnd = () => (box.scrollTop = box.scrollHeight);
    const onScroll = () => (atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60);
    const ro = new ResizeObserver(() => atBottom.current && toEnd());
    ro.observe(box);
    box.addEventListener("scroll", onScroll, { passive: true });
    toEnd();
    return () => {
      ro.disconnect();
      box.removeEventListener("scroll", onScroll);
    };
  }, [endRef]);
  useEffect(() => {
    const box = endRef.current?.parentElement;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* ---------------- 아래로 당겨서 새로고침 ---------------- */

// 화면 맨 위에서 아래로 끌어내리면 숨어 있던 새로고침 버튼이 따라 내려오고,
// 충분히 당긴 뒤 놓으면 앱을 새로 불러온다 (새 버전과 최신 일정을 받는다).
function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const pullRef = useRef(0);
  const TRIGGER = 72;
  useEffect(() => {
    let startY: number | null = null;
    let startX = 0;
    let vertical: boolean | null = null;
    const set = (v: number) => {
      pullRef.current = v;
      setPull(v);
    };
    const onStart = (e: TouchEvent) => {
      const t = e.target as HTMLElement;
      const box = t.closest(".thread, .drawer-list");
      if (window.scrollY > 0 || (box && box.scrollTop > 0) || t.closest("textarea, input, select, .popover, .composer")) return (startY = null);
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      vertical = null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (vertical === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) vertical = Math.abs(dy) > Math.abs(dx);
      if (!vertical || dy <= 0 || window.scrollY > 0) return set(0);
      set(Math.min(120, dy * 0.5)); // 손가락보다 천천히 따라오게
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      if (pullRef.current >= TRIGGER) {
        setSpinning(true);
        set(TRIGGER);
        setTimeout(() => location.reload(), 350);
      } else set(0);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, []);
  if (!pull && !spinning) return null;
  const ready = pull >= TRIGGER;
  return (
    <div className="ptr" style={{ transform: `translate(-50%, ${pull - 52}px)`, opacity: Math.min(1, pull / 40) }} aria-hidden="true">
      <span className={`ptr-btn ${ready ? "ready" : ""} ${spinning ? "spin" : ""}`} style={spinning ? undefined : { transform: `rotate(${pull * 4}deg)` }}>
        <IconRefresh />
      </span>
    </div>
  );
}

/* ---------------- 날짜 입력 ---------------- */

// 아이폰의 날짜 선택기에서 "재설정"을 누르면 기본값으로 돌아가는데,
// 그 기본값을 비워 두면 재설정이 곧 "날짜 없음"이 된다.
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
        <button className="x" aria-label="날짜 지우기" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </span>
  );
}

/* ---------------- 일정: 구글 캘린더 일정 편집 화면과 같은 모양 ---------------- */

const fmtDay = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" }).replace(/\((.)\)/, "($1)");
const fmtTime = (t: string) => new Date(`2000-01-01T${t}:00`).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
const today = () => new Date().toLocaleDateString("sv-SE");

// 글자를 누르면 그 자리에 숨겨 둔 날짜/시간 선택기가 열린다.
function PickText(props: { type: "date" | "time"; value: string; text: string; onChange: (v: string) => void; className?: string }) {
  return (
    <label className={`pick ${props.className ?? ""}`}>
      {props.text}
      <input
        type={props.type}
        value={props.value}
        onClick={(e) => {
          try {
            (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
          } catch {
            /* 지원 안 하는 브라우저는 기본 동작 */
          }
        }}
        onChange={(e) => e.target.value && props.onChange(e.target.value)}
      />
    </label>
  );
}

type Sched = Pick<Item, "due" | "time" | "endDate" | "endTime">;

function ScheduleEditor<T extends Sched>({ item, update, noClear }: { item: T; update: (fn: (it: T) => T) => void; noClear?: boolean }) {
  if (!item.due)
    return (
      <button className="field sched-add" onClick={() => update((it) => ({ ...it, due: today() }))}>
        <span className="sched-icon"><IconClock /></span>
        <span className="grow">일정 추가</span>
        <span className="chev"><IconPlus /></span>
      </button>
    );
  const allDay = !item.time;
  const end = itemEnd(item);
  const set = (patch: Partial<Sched>) => update((it) => ({ ...it, ...patch }));

  // 구글 캘린더처럼 시작을 옮기면 길이를 유지한 채 끝도 같이 옮긴다.
  const moveStart = (date: string, time?: string) => {
    const s0 = new Date(`${item.due}T${item.time ?? "00:00"}:00`).getTime();
    const e0 = new Date(`${end.date}T${end.time ?? "00:00"}:00`).getTime();
    const len = Math.max(0, Math.round((e0 - s0) / 60000));
    const t = time ?? item.time;
    if (!t) return set({ due: date, endDate: len ? addMinutes(date, "00:00", len).date : undefined });
    const e = addMinutes(date, t, len || 60);
    set({ due: date, time: t, endDate: e.date, endTime: e.time });
  };
  const setEnd = (date: string, time?: string) => {
    if (allDay) return set({ endDate: date < item.due ? item.due : date });
    const t = time ?? end.time!;
    if (`${date}T${t}` <= `${item.due}T${item.time}`) {
      const e = addMinutes(item.due, item.time!, 60);
      return set({ endDate: e.date, endTime: e.time });
    }
    set({ endDate: date, endTime: t });
  };
  const toggleAllDay = () => {
    if (allDay) {
      const h = Math.min(new Date().getHours() + 1, 23);
      const t = `${String(h).padStart(2, "0")}:00`;
      const e = addMinutes(item.due, t, 60);
      set({ time: t, endDate: e.date, endTime: e.time });
    } else set({ time: undefined, endTime: undefined, endDate: end.date !== item.due ? end.date : undefined });
  };

  return (
    <div className="sched">
      <label className="field">
        <span className="sched-icon"><IconClock /></span>
        <span className="grow">종일</span>
        <input type="checkbox" className="switch" checked={allDay} onChange={toggleAllDay} />
      </label>
      <div className="sched-row">
        <span className="sched-tag">시작</span>
        <PickText type="date" value={item.due} text={fmtDay(item.due)} onChange={(d) => moveStart(d)} className="day" />
        {!allDay && <PickText type="time" value={item.time!} text={fmtTime(item.time!)} onChange={(t) => moveStart(item.due, t)} className="time" />}
      </div>
      <div className="sched-row">
        <span className="sched-tag">종료</span>
        <PickText type="date" value={end.date} text={fmtDay(end.date)} onChange={(d) => setEnd(d)} className="day" />
        {!allDay && <PickText type="time" value={end.time!} text={fmtTime(end.time!)} onChange={(t) => setEnd(end.date, t)} className="time" />}
      </div>
      {!noClear && (
        <button className="sched-clear" onClick={() => set({ due: "", time: undefined, endDate: undefined, endTime: undefined })}>
          일정 지우기
        </button>
      )}
    </div>
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
    item.due ? `${fmtDay(item.due)}${item.time ? " " + fmtTime(item.time) : ""}` : "일정 없음",
    item.subtasks.length ? `세부 업무 ${doneCount}/${item.subtasks.length}` : "",
    item.due && props.gToken && item.calendarEventId ? "캘린더에 있음" : "",
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
          <ScheduleEditor item={item} update={update} />
          {item.due && !props.gToken && (
            <div className="field">
              <span className="field-label">구글 캘린더</span>
              <a className="secondary small btnlink" href={gcal.addLink(item.title, item.due)} target="_blank" rel="noreferrer">
                캘린더에 넣기
              </a>
            </div>
          )}
          <div className="field memo">
            <textarea placeholder="메모 (클론도 같이 봐요)" value={item.note} onChange={(e) => update((it) => ({ ...it, note: e.target.value }))} />
          </div>
        </div>
      )}

      <div className="ask">
        <textarea
          rows={1}
          placeholder="이 일에 대해 클론에게 물어보기"
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
                <span className="preview">{lm ? plain(lm.text) : s.done ? "완료" : "눌러서 클론과 정하기"}</span>
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
      {item.subtasks.length === 0 && <p className="muted small hint">클론에게 물어보면 필요한 세부 업무를 나눠 줘요.</p>}
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
      <div className="swipe-actions" style={{ width: W, visibility: offset < 0 ? "visible" : "hidden" }}>
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

/* ---------------- 클론과 대화 ---------------- */

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

  useStickToBottom(endRef, [chat.length, streaming]);
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
            <p>{sub ? "이 세부 업무를 어떻게 할지 클론과 정해 보세요." : "이 일에 대해 무엇이든 이야기해 보세요."}</p>
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
          placeholder={settings.apiKey ? "클론에게 메시지 보내기" : "설정에서 API 키를 넣어 주세요"}
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
              <strong>클론 연결</strong>
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

  const titles = { claude: "클론 연결", calendar: "구글 캘린더", data: "데이터 백업" };
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
      setCheck({ state: "ok", text: `클론과 연결됐어요 (${name})` });
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
  const [server, setServer] = useState(gcal.serverUrl());
  const [check, setCheck] = useState<"" | "checking" | "ok" | "fail">("");
  const saved = gcal.serverUrl();
  const keep = props.calOn && gcal.hasSession();

  const saveServer = async () => {
    gcal.setServerUrl(server);
    if (!server.trim()) return setCheck("");
    setCheck("checking");
    try {
      const r = await fetch(gcal.serverUrl() + "/").then((x) => x.json());
      setCheck(r.ready ? "ok" : "fail");
    } catch {
      setCheck("fail");
    }
  };

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
          {props.calOn && (
            <span className="muted small">
              {keep ? "계속 연결 유지 중" : "1시간 동안 연결"} · 앞으로 30일 일정 {props.eventsCount}개
            </span>
          )}
        </div>
      </div>
      {props.calOn && saved && !keep && <p className="muted small">연결 유지 서버를 쓰려면 연결을 끊고 한 번 다시 연결해 주세요.</p>}
      {props.calOn ? (
        <button className="secondary danger-text" onClick={props.onDisconnect}>
          연결 끊기
        </button>
      ) : (
        <button className="google" onClick={props.onConnect}>
          <span className="g">G</span> 구글로 연결
        </button>
      )}

      <h3>연결 유지 서버</h3>
      <p className="muted small">
        {saved
          ? "서버가 1시간마다 연결을 새로 받아 와서 계속 연결된 채로 있어요."
          : "비워 두면 연결이 1시간마다 끝나요. 서버 주소를 넣으면 계속 연결돼요."}
      </p>
      <input placeholder="https://….workers.dev" value={server} onChange={(e) => (setServer(e.target.value), setCheck(""))} inputMode="url" autoCapitalize="off" autoCorrect="off" />
      <div className="row">
        <button className="secondary" onClick={saveServer} disabled={server.trim() === saved && check !== ""}>
          저장하고 확인
        </button>
        {check === "checking" && <span className="check checking">확인 중…</span>}
        {check === "ok" && <span className="check ok">서버 준비됐어요</span>}
        {check === "fail" && <span className="check fail">서버에 접속이 안 되거나 비밀 값이 빠졌어요</span>}
      </div>
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

type DayEntry = { key: string; title: string; time: string; endTime: string; kind: "google" | "todo"; itemId?: string; ev?: CalEvent };

/* 구글 일정 편집: 구글 캘린더 앱의 편집 화면과 같은 항목(제목, 종일, 시작/종료, 위치, 설명) */
function EventEditor({ ev, onClose, onSaved }: { ev: CalEvent; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<gcal.EventEdit>({
    title: ev.title,
    due: ev.date,
    time: ev.time || undefined,
    endDate: ev.endDate,
    endTime: ev.endTime || undefined,
    location: ev.location,
    description: ev.description,
  });
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const run = async (fn: (token: string) => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (!token) throw new Error("구글 캘린더 연결이 끝났어요. 다시 연결해 주세요.");
      await fn(token);
      toast(done);
      onSaved();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="detail event-edit">
      <header className="page-head">
        <button className="back" onClick={onClose}>
          <IconBack />
          캘린더
        </button>
        <button onClick={() => run((t) => gcal.updateEvent(t, ev.id, d), "구글 캘린더에 저장했어요")} disabled={busy || !d.title.trim()}>
          저장
        </button>
      </header>
      <input className="title-input" placeholder="제목 추가" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
      <div className="fields">
        <ScheduleEditor item={d} update={(fn) => setD(fn)} noClear />
        <div className="field memo">
          <input placeholder="위치 추가" value={d.location} onChange={(e) => setD({ ...d, location: e.target.value })} />
        </div>
        <div className="field memo">
          <textarea placeholder="설명 추가" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </div>
      </div>
      <button
        className="secondary danger-text wide"
        disabled={busy}
        onClick={() => (confirmDel ? run((t) => gcal.deleteEvent(t, ev.id), "일정을 삭제했어요") : setConfirmDel(true))}
        onBlur={() => setConfirmDel(false)}
      >
        {confirmDel ? "한 번 더 누르면 삭제" : "일정 삭제"}
      </button>
      <p className="muted small hint">저장하면 구글 캘린더에도 바로 바뀌어요.</p>
    </section>
  );
}

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
  const [editing, setEditing] = useState<CalEvent | null>(null);

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
  for (const e of events) push(e.date, { key: e.id, title: e.title, time: e.time, endTime: e.endTime, kind: e.itemId ? "todo" : "google", itemId: e.itemId, ev: e });
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
    <li className={`ev ${e.kind}`} onClick={() => (e.itemId ? props.onOpen(e.itemId) : e.ev && setEditing(e.ev))}>
      <span className="ev-bar" />
      <span className="ev-time">
        {e.time ? e.time : "종일"}
        {e.time && e.endTime && <small>{e.endTime}</small>}
      </span>
      <span className="ev-title">{e.title}</span>
      {e.kind === "todo" && <span className="tag">할 일</span>}
    </li>
  );

  if (editing)
    return (
      <EventEditor
        ev={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
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
