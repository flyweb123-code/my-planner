import { createPortal } from "react-dom";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type HomeThread, DEFAULT_SETTINGS, addMinutes, dueLabel, daysUntil, itemEnd, markDeleted, markSeen, seenCount, uid, usePersisted, wasDeletedByUser } from "./store";
import * as backup from "./backup";
import type { Action, Item, Msg, Settings, Subtask } from "./store";
import { type World, checkKey, greeting, homeChat, makeBriefing, simpleBriefing, streamChat, summarizeTitle } from "./ai";
import type { Briefing, ToolRunner } from "./ai";
import { Markdown } from "./md";
import * as gcal from "./gcal";
import * as drive from "./drive";
import { GOOGLE_CLIENT_ID } from "./config";
import { holidayName } from "./holidays";
import * as widget from "./widget";
import type { CalEvent } from "./gcal";
import { toast } from "./toast";
import { IconBack, IconCalendar, IconChat, IconCheck, IconClock, IconCompose, IconLeft, IconList, IconMenu, IconMore, IconPin, IconPlus, IconRefresh, IconRight, IconSettings, IconUp, IconTrash, IconClip, IconClose, IconLayers, IconImage } from "./icons";
import * as files from "./files";
import { demoItems } from "./demo";

// from: 캘린더에서 연 일정 화면에서 들어왔으면 그 일정 (뒤로 가면 캘린더의 그 일정으로)
type View = { name: "home" } | { name: "list" } | { name: "item"; id: string } | { name: "chat"; id: string; sub?: string; initial?: string; from?: CalEvent } | { name: "sub"; id: string; sub: string; from?: CalEvent } | { name: "calendar" } | { name: "evchat"; ev: CalEvent; sub?: string; initial?: string } | { name: "evsub"; ev: CalEvent; sub: string } | { name: "settings" };

export default function App() {
  const [items, setItems] = usePersisted<Item[]>("items", import.meta.env.VITE_DEMO ? demoItems() : []);
  // 고정한 할 일을 잠금 화면 위젯용 저장소에 올린다.
  useEffect(() => widget.syncPins(items), [items]);
  // 할 일 목록이 바뀔 때마다 이 기기에 자동 백업을 남긴다 (설정 → 데이터 백업에서 되살리기)
  useEffect(() => void backup.save(items), [items]);
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
  // 채팅 제목을 대화 내용 요약으로 짓는다. 답이 끝나고 잠시 뒤, 한 번에 하나씩 (기존 채팅도 차례로)
  const titleFailed = useRef(new Set<string>());
  useEffect(() => {
    if (!settings.apiKey) return;
    const need = threads.find(
      (t) =>
        !titleFailed.current.has(t.id) &&
        t.msgs.length >= 2 &&
        t.msgs[t.msgs.length - 1].role === "assistant" &&
        t.msgs[t.msgs.length - 1].text.trim() !== "" &&
        (t.titledN === undefined || t.msgs.length >= t.titledN + 6),
    );
    if (!need) return;
    const timer = setTimeout(async () => {
      try {
        const title = await summarizeTitle(settings, need.msgs);
        const n = need.msgs.length;
        setThreads((ts) => ts.map((x) => (x.id === need.id ? { ...x, title: title || x.title || threadTitle(x.msgs), titledN: n } : x)));
      } catch {
        titleFailed.current.add(need.id);
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [threads, settings, setThreads]);
  // 다른 화면의 클론이 참고할 최근 홈 대화 (모든 채팅에서 최근 것)
  const recentHome = threads
    .flatMap((t) => t.msgs)
    .sort((a, b) => a.ts - b.ts)
    .slice(-20);
  const [view, setView] = useState<View>({ name: "home" });
  // 지난번에 받아 둔 일정을 먼저 보여 주고, 구글에서 새로 받아 오면 바꾼다.
  const [events, setEvents] = useState<CalEvent[]>(() => (gcal.wasLinked() ? (gcal.cachedUpcoming(60) ?? []) : []));
  // 캘린더 일정마다 클론과 나눈 대화 (구글 일정 id → 대화용 항목). 할 일 목록과는 따로 둔다.
  const [eventChats, setEventChats] = usePersisted<Record<string, Item>>("eventChats", {});
  // 클론이 보는 일정에는 일정별 대화도 붙여서 넘긴다
  // 일정 대화에서 돌아오면 그 일정 편집 화면을 다시 연다
  const [reopenEvent, setReopenEvent] = useState<CalEvent | null>(null);
  useEffect(() => {
    if (view.name === "calendar" && reopenEvent) setReopenEvent(null);
  }, [view.name, reopenEvent]);
  const aiEvents = events.map((e) => {
    const c = eventChats[e.id];
    return c && (c.chat.length || c.subtasks.length) ? { ...e, chat: c.chat, subtasks: c.subtasks } : e;
  });
  const [gToken, setGToken] = useState<string | null>(() => gcal.savedToken());
  const [linked, setLinked] = useState(() => gcal.wasLinked());
  const calOn = !!gToken;
  // 대화 기록을 구글 드라이브 문서에 저장 (대화가 바뀌고 15초 조용하면)
  useEffect(() => {
    if (!linked && !gToken) return;
    const t = setTimeout(async () => {
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (token) drive.save(token, drive.buildText(threads, items, eventChats));
    }, 15000);
    return () => clearTimeout(t);
  }, [threads, items, eventChats, gToken, linked]);

  // 대화 화면은 실제로 보이는 영역(키보드를 뺀 높이)에 딱 맞춰 고정한다.
  // 아이폰은 키보드가 올라올 때 화면 전체를 위로 밀어 올리는데, 그러면 입력창이 가려진다.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // 키보드가 실제로 올라왔는지는 보이는 높이로 판단하고, 높이와 같은 순간에 입력창 아래 여백을 줄인다.
    // (포커스만 보고 여백을 먼저 줄이면 키보드가 올라오기 전에 입력창이 한 번 내려갔다가 다시 올라간다.)
    let full = vv.height;
    let lastW = vv.width;
    const apply = () => {
      if (vv.width !== lastW) { lastW = vv.width; full = vv.height; }
      full = Math.max(full, vv.height);
      document.documentElement.classList.toggle("kb-up", full - vv.height > 120);
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
    // 대화 화면에서는 문서가 밀려 올라가지 않게 맨 위로 되돌린다.
    const pinTop = () => {
      if (document.documentElement.classList.contains("chat-lock") && window.scrollY !== 0) window.scrollTo(0, 0);
    };
    const onResize = () => {
      pinTop();
      apply();
      setTimeout(keepFocusVisible, 50);
    };
    // 아이폰은 키보드가 다 올라온 뒤에 크기 알림이 늦게 오거나 빠지기도 해서, 입력칸을 누르고 닫을 때 몇 번 더 맞춘다.
    const settle = () => [0, 120, 300, 600].forEach((ms) => setTimeout(() => { pinTop(); apply(); }, ms));
    // 고정된 대화 화면에서 스크롤 영역 밖을 끌면 아이폰이 화면 전체를 끌어 버리므로 막는다.
    const onTouchMove = (e: TouchEvent) => {
      if (!document.documentElement.classList.contains("chat-lock")) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest(".thread, .drawer-list, textarea")) return;
      if (e.cancelable) e.preventDefault();
    };
    // 아이폰은 키보드에 가려질 입력칸을 누르면 화면 전체를 끌어올리는 움직임을 넣는데,
    // 대화 화면은 이미 키보드 위로 줄어들기 때문에 그 움직임이 '내려갔다 올라가는' 출렁임으로 보인다.
    // 그래서 입력칸을 누르는 순간 잠깐 화면 위쪽으로 옮겨서 포커스를 주고, 키보드가 뜨면 제자리로 돌린다.
    let lifted: HTMLElement | null = null;
    let liftTimer = 0;
    const drop = () => {
      if (!lifted) return;
      lifted.style.transform = "";
      lifted.style.opacity = "";
      lifted = null;
      clearTimeout(liftTimer);
    };
    const onTouchEnd = (e: TouchEvent) => {
      const el = e.target as HTMLElement | null;
      if (!(el instanceof HTMLTextAreaElement) || el.disabled || document.activeElement === el) return;
      if (!el.closest(".homechat .composer, .chatview .composer")) return;
      const r = el.getBoundingClientRect();
      if (r.top < vv.height * 0.4) return;
      e.preventDefault();
      lifted = el;
      el.style.transform = `translateY(${Math.round(80 - r.top)}px)`;
      el.style.opacity = "0";
      el.focus({ preventScroll: true });
      const end = el.value.length;
      el.setSelectionRange(end, end);
      liftTimer = window.setTimeout(drop, 700);
    };
    document.addEventListener("touchend", onTouchEnd, { passive: false, capture: true });
    const onLiftResize = () => lifted && requestAnimationFrame(drop);
    vv.addEventListener("resize", onLiftResize);
    document.addEventListener("focusin", settle);
    document.addEventListener("focusout", settle);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("scroll", pinTop);
    apply();
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", apply);
      document.removeEventListener("touchend", onTouchEnd, { capture: true });
      vv.removeEventListener("resize", onLiftResize);
      drop();
      document.removeEventListener("focusin", settle);
      document.removeEventListener("focusout", settle);
      document.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("scroll", pinTop);
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
    // 포커스 알림이 빠지는 경우가 있어서, 보이는 높이가 확 줄어든 것도 키보드가 올라온 것으로 본다.
    const vv = window.visualViewport;
    let full = vv?.height ?? 0;
    let lastW = vv?.width ?? 0;
    const onVV = () => {
      if (!vv) return;
      if (vv.width !== lastW) { lastW = vv.width; full = vv.height; }
      full = Math.max(full, vv.height);
      if (full - vv.height > 120) setTyping(true);
      else if (!isField(document.activeElement)) setTyping(false);
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    vv?.addEventListener("resize", onVV);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      vv?.removeEventListener("resize", onVV);
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
    // 권한을 새로 받는 중일 때는 저장해 둔 일정을 그대로 둔다. (연결을 끊으면 disconnectCalendar가 비운다)
    if (!gToken) return;
    gcal
      .upcoming(gToken, 60)
      .then((evs) => {
        // 할 일 표시가 빠진 일정(예전에 다른 캘린더로 옮긴 일정)은 할 일 쪽 기록으로 다시 이어 준다
        const byEvent = new Map(itemsRef.current.filter((i) => i.calendarEventId).map((i) => [i.calendarEventId!, i.id]));
        const fixed = evs.map((e) => (!e.itemId && byEvent.has(e.id) ? { ...e, itemId: byEvent.get(e.id) } : e));
        for (const e of fixed) if (e.itemId && !evs.find((x) => x.id === e.id)?.itemId && !relinked.has(e.id) && relinked.add(e.id)) gcal.linkEvent(gToken, e.id, e.itemId, e.calendarId).catch(() => {});
        setEvents(fixed);
      })
      .catch(async (e) => {
        if (!gcal.savedToken() && gcal.hasSession() && (await refreshToken())) return;
        setGToken(gcal.savedToken());
        toast((e as Error).message);
      });
  }, [gToken, refreshToken]);
  useEffect(loadEvents, [loadEvents]);

  const connectCalendar = async () => {
    try {
      const t = await gcal.signIn();
      setGToken(t);
      setLinked(true);
      // 다시 연결하면 바로 대화 기록 저장을 시도해 결과(권한 안내)를 곧장 보여 준다
      drive.save(t, drive.buildText(threads, items, eventChats), true);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const disconnectCalendar = () => {
    gcal.signOut();
    setGToken(null);
    setLinked(false);
    setEvents([]);
  };

  // 날짜가 있는 할 일은 구글 캘린더에 자동으로 올리고, 바뀌면 고치고, 지우면 같이 지운다.
  // 제목을 타이핑하는 중에 계속 부르지 않도록 잠깐 기다렸다가 한 번에 반영한다.
  const syncPrev = useRef(items);
  const toDelete = useRef<{ eid: string; cal?: string }[]>([]);
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    // 사용자가 직접 지운 할 일만 캘린더 일정도 지운다. 다른 이유로 목록에서 빠졌으면 일정은 남겨 둔다.
    for (const p of syncPrev.current) if (!ids.has(p.id) && p.calendarEventId && wasDeletedByUser(p.id)) toDelete.current.push({ eid: p.calendarEventId, cal: p.calendarId });
    syncPrev.current = items;
    if (!gToken) return;
    const timer = setTimeout(async () => {
      // 앱이 두 군데 열려 있을 때 같은 일정을 두 번 만들지 않도록, 보이는 쪽에서만 반영한다.
      if (document.hidden) return;
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (!token) return setGToken(null);
      let changed = false;
      for (const { eid, cal } of toDelete.current.splice(0)) {
        await gcal.deleteEvent(token, eid, cal).catch(() => {});
        changed = true;
      }
      for (const it of items) {
        if (inFlight.current.has(it.id)) continue;
        const want = syncKey(it);
        if (want === (it.calSynced ?? "") && (!!it.calendarEventId === !!want)) continue;
        inFlight.current.add(it.id);
        try {
          if (!want && it.calendarEventId) {
            await gcal.deleteEvent(token, it.calendarEventId, it.calendarId);
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

  // 캘린더에 원래 있던 일정을 할 일로 가져온다. 일정은 새로 만들지 않고 그 일정과 이어 둔다.
  // 비서가 이번 대화에서 막 만든 일정 (목록을 새로 받아 오기 전에 할 일로 이을 때 쓴다)
  const createdEvents = useRef(new Map<string, CalEvent>());
  const eventToItem = (ev: CalEvent): Item => {
    const it: Item = {
      id: uid(),
      title: ev.title,
      note: [ev.location && `장소: ${ev.location}`, ev.description].filter(Boolean).join("\n"),
      due: ev.date,
      time: ev.time || undefined,
      endDate: ev.endDate && ev.endDate !== ev.date ? ev.endDate : undefined,
      endTime: ev.time && ev.endTime ? ev.endTime : undefined,
      done: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      subtasks: eventChats[ev.id]?.subtasks ?? [],
      chat: eventChats[ev.id]?.chat ?? [],
      calendarEventId: ev.id,
      calendarId: ev.calendarId,
      colorId: ev.colorId,
    };
    it.calSynced = syncKey(it);
    files.moveOwner(ev.id, it.id).catch(() => {});
    return it;
  };
  const addEventAsTodo = async (ev: CalEvent) => {
    const existing = itemsRef.current.find((i) => i.calendarEventId === ev.id);
    if (existing) return open(existing.id);
    const it = eventToItem(ev);
    commit([it, ...itemsRef.current]);
    if (briefCache) briefCache = { ...briefCache, at: 0 }; // 다음에 새로 만들되, 그동안은 지난 브리핑을 보여 준다
    open(it.id);
    toast("할 일에 추가했어요");
    try {
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (token) await gcal.linkEvent(token, ev.id, it.id, ev.calendarId);
      loadEvents();
    } catch {
      /* 표시만 못 붙인 것이라 할 일은 그대로 둔다 */
    }
  };

  const runTool: ToolRunner = async (name, input) => {
    const all = itemsRef.current;
    if (name === "add_item") {
      const x = input as { title: string; due?: string; time?: string; note?: string; subtasks?: string[]; event_id?: string };
      // 캘린더에 이미 있는 일정을 할 일로 넣는 것이면 새 일정을 만들지 않고 그 일정과 이어 둔다
      const ev = x.event_id ? events.find((e) => e.id === x.event_id) ?? createdEvents.current.get(x.event_id) : undefined;
      if (x.event_id && !ev) throw new Error("그 event_id의 캘린더 일정을 찾지 못했어요.");
      if (ev) {
        const linked = all.find((i) => i.calendarEventId === ev.id);
        if (linked) return { result: `이미 할 일 목록에 있음. id=${linked.id}` };
        const it = eventToItem(ev);
        if (x.subtasks?.length) it.subtasks = x.subtasks.map((t) => ({ id: uid(), title: t, done: false, byClaude: true, createdAt: Date.now() }));
        commit([it, ...itemsRef.current]);
        gcal.savedToken() && gcal.linkEvent(gcal.savedToken()!, ev.id, it.id, ev.calendarId).then(loadEvents, () => {});
        return { result: `캘린더 일정과 이어서 할 일로 추가함. id=${it.id}`, action: { kind: "item", text: `할 일 추가: ${it.title} (캘린더 일정과 이어 둠)`, undo: { itemId: it.id } } };
      }
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
    if (name === "add_event") {
      const x = input as { title: string; date: string; time?: string; end_time?: string; end_date?: string; location?: string; description?: string; calendar?: string };
      const cal = x.calendar ? gcal.cachedCalendars().find((c) => c.writable && c.name === x.calendar) : undefined;
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (!token) throw new Error("구글 캘린더 연결이 끝났어요. 설정에서 다시 연결해 주세요.");
      const end = x.time ? (x.end_time ? { date: x.end_date ?? x.date, time: x.end_time } : addMinutes(x.date, x.time, 60)) : { date: x.end_date ?? x.date, time: undefined };
      const d: gcal.EventEdit = { title: x.title, due: x.date, time: x.time || undefined, endDate: end.date, endTime: end.time, location: x.location ?? "", description: x.description ?? "", calendarId: cal?.id };
      const id = await gcal.createEvent(token, d);
      createdEvents.current.set(id, { id, title: d.title, date: d.due, time: d.time ?? "", endDate: d.endDate ?? d.due, endTime: d.endTime ?? "", location: d.location, description: d.description, calendarId: cal?.id } as CalEvent);
      loadEvents();
      return {
        result: `캘린더에 추가함. event_id=${id}`,
        action: { kind: "event", text: `캘린더에 일정 추가: ${d.title} (${d.due}${d.time ? " " + d.time : ""})${cal && !cal.primary ? ` · ${cal.name}` : ""}`, undo: { itemId: "", eventId: id, calendarId: cal?.id } },
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
    if (name === "update_event" || name === "delete_event") {
      const x = input as { event_id: string; title?: string; date?: string; time?: string; end_time?: string; end_date?: string; location?: string; description?: string; add_note?: string };
      const ev = events.find((e) => e.id === x.event_id) ?? createdEvents.current.get(x.event_id);
      if (!ev) throw new Error("그 event_id의 캘린더 일정을 찾지 못했어요.");
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (!token) throw new Error("구글 캘린더 연결이 끝났어요. 설정에서 다시 연결해 주세요.");
      const prev: gcal.EventEdit = { title: ev.title, due: ev.date, time: ev.time || undefined, endDate: ev.endDate || ev.date, endTime: ev.endTime || undefined, location: ev.location, description: ev.description, colorId: ev.colorId, calendarId: ev.calendarId };
      const when = `${ev.date}${ev.time ? " " + ev.time : ""}`;
      if (name === "delete_event") {
        if (itemsRef.current.some((i) => i.calendarEventId === ev.id)) throw new Error("할 일 목록과 이어진 일정이라 여기서 지우지 않았어요. 할 일 화면에서 지우도록 안내해 주세요.");
        await gcal.deleteEvent(token, ev.id, ev.calendarId);
        createdEvents.current.delete(ev.id);
        loadEvents();
        return { result: "지움.", action: { kind: "event_delete", text: `캘린더 일정 삭제: ${ev.title} (${when})`, undo: { itemId: "", prevEvent: prev } } };
      }
      const d: gcal.EventEdit = { ...prev };
      const words: string[] = [];
      if (x.title !== undefined) {
        d.title = x.title;
        words.push(`제목 → ${x.title}`);
      }
      if (x.date !== undefined || x.time !== undefined) {
        d.due = x.date ?? prev.due;
        d.time = x.time === undefined ? prev.time : x.time || undefined;
        // 끝을 말하지 않았으면 원래 길이를 그대로 옮긴다
        const days = Math.round((new Date(prev.endDate + "T00:00:00").getTime() - new Date(prev.due + "T00:00:00").getTime()) / 86400000);
        if (d.time) {
          const mins = prev.time && prev.endTime ? Math.max(15, (new Date(`${prev.endDate}T${prev.endTime}:00`).getTime() - new Date(`${prev.due}T${prev.time}:00`).getTime()) / 60000) : 60;
          const e = addMinutes(d.due, d.time, mins);
          d.endDate = e.date;
          d.endTime = e.time;
        } else {
          const e = new Date(d.due + "T00:00:00");
          e.setDate(e.getDate() + Math.max(0, days));
          d.endDate = e.toLocaleDateString("sv-SE");
          d.endTime = undefined;
        }
        words.push(`일정 → ${d.due}${d.time ? " " + d.time : " 종일"}`);
      }
      if (x.end_date !== undefined) {
        d.endDate = x.end_date || d.due;
        words.push(`끝나는 날 → ${d.endDate}`);
      }
      if (x.end_time !== undefined) {
        d.endTime = x.end_time || undefined;
        words.push(`끝 → ${x.end_time}`);
      }
      if (x.location !== undefined) {
        d.location = x.location;
        words.push(x.location ? `장소 → ${x.location}` : "장소 지움");
      }
      if (x.description !== undefined) {
        d.description = x.description;
        words.push("메모 바꿈");
      }
      const fieldsChanged = words.length > 0;
      if (x.add_note) {
        // 다른 기기에서 고친 설명을 지우지 않도록 최신 설명 끝에 붙인다
        d.description = await gcal.appendDescription(token, ev.id, x.add_note, ev.calendarId);
        prev.description = d.description.slice(0, Math.max(0, d.description.length - x.add_note.length)).trimEnd();
        words.push(`메모 추가: ${x.add_note.length > 40 ? x.add_note.slice(0, 40) + "…" : x.add_note}`);
      }
      if (!words.length) return { result: "바꿀 내용이 없어요." };
      if (fieldsChanged) await gcal.updateEvent(token, ev.id, d, ev.calendarId);
      syncTodoFromEvent(ev, d);
      loadEvents();
      return {
        result: "고침.",
        action: { kind: "event_update", text: `'${ev.title}' 일정 ${words.join(", ")}`, undo: { itemId: "", eventId: ev.id, calendarId: ev.calendarId, prevEvent: prev } },
      };
    }
    throw new Error(`모르는 도구: ${name}`);
  };

  const undo = (a: Action) => {
    const u = a.undo;
    if (!u) return;
    if (a.kind === "item") {
      markDeleted(u.itemId);
      setItems((all) => all.filter((i) => i.id !== u.itemId));
    }
    if (a.kind === "event" && u.eventId) {
      const eid = u.eventId;
      (async () => {
        const token = gcal.savedToken() ?? (await gcal.renew());
        if (!token) return toast("구글 캘린더 연결이 끝났어요. 다시 연결해 주세요.");
        await gcal.deleteEvent(token, eid, u.calendarId).then(loadEvents, (e) => toast((e as Error).message));
      })();
    }
    if ((a.kind === "event_update" || a.kind === "event_delete") && u.prevEvent) {
      const p = u.prevEvent;
      const eid = u.eventId;
      (async () => {
        const token = gcal.savedToken() ?? (await gcal.renew());
        if (!token) return toast("구글 캘린더 연결이 끝났어요. 다시 연결해 주세요.");
        try {
          if (eid) {
            await gcal.updateEvent(token, eid, p, p.calendarId);
            const ev = events.find((e) => e.id === eid);
            if (ev) syncTodoFromEvent(ev, p);
          } else await gcal.createEvent(token, p);
          loadEvents();
        } catch (e) {
          toast((e as Error).message);
        }
      })();
    }
    if (a.kind === "subtasks") updateItem(u.itemId, (it) => ({ ...it, subtasks: it.subtasks.filter((s) => !u.subtaskIds?.includes(s.id)) }));
    if (a.kind === "update") updateItem(u.itemId, (it) => ({ ...it, ...u.prev }));
  };

  // 할 일을 지운다. 캘린더 일정은 지우지 않고 남겨 두며(할 일 표시만 뗌), 나눈 대화·세부 업무·첨부 파일은 그 일정 쪽으로 옮긴다.
  const removeTodo = (id: string) => {
    const it = itemsRef.current.find((i) => i.id === id);
    if (!it) return;
    const eid = it.calendarEventId;
    setItems((all) => all.filter((i) => i.id !== id));
    if (!eid) {
      files.removeOwner(id).catch(() => {});
      return toast("할 일을 삭제했어요");
    }
    setEventChats((m) => ({ ...m, [eid]: { ...it, id: "ev_" + eid, calendarEventId: undefined } }));
    files.moveOwner(id, eid).catch(() => {});
    toast("할 일에서 뺐어요. 캘린더 일정은 그대로 있어요");
    (async () => {
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (token) await gcal.unlinkEvent(token, eid, it.calendarId).then(loadEvents, () => {});
    })();
  };

  const open = (id: string) => id && setView({ name: "item", id });

  // 할 일과 이어진 일정을 고쳤으면 할 일도 같은 날짜·시간·색으로 맞춘다 (다시 덮어쓰지 않게)
  const syncTodoFromEvent = (ev: CalEvent, d: gcal.EventEdit) => {
    const it = itemsRef.current.find((i) => i.calendarEventId === ev.id);
    if (!it) return;
    updateItem(it.id, (x) => {
      const next = { ...x, calendarId: d.calendarId ?? x.calendarId, title: d.title, due: d.due, time: d.time, endDate: d.endDate, endTime: d.endTime, colorId: d.colorId ?? (x.colorId === undefined ? undefined : "") };
      return { ...next, calSynced: syncKey(next) };
    });
  };
  // 일정 화면의 세부 업무·대화: 할 일과 이어졌으면 그 할 일 것(할 일 탭과 똑같이), 아니면 일정 대화용 항목
  // from: 캘린더에서 열었으면 그 일정 → 세부 업무·대화에서 뒤로 가면 캘린더로 돌아온다
  const eventHost = (ev: CalEvent, from?: CalEvent): EventHost => {
    const todo = items.find((i) => i.calendarEventId === ev.id) ?? (ev.itemId ? items.find((i) => i.id === ev.itemId) : undefined);
    if (todo)
      return {
        item: todo,
        linked: true,
        update: (fn) => updateItem(todo.id, fn),
        onOpenSub: (sub) => setView({ name: "sub", id: todo.id, sub, from }),
        onChat: (initial) => setView({ name: "chat", id: todo.id, initial, from }),
      };
    return {
      item: eventChatItem(ev, eventChats[ev.id]),
      linked: false,
      update: (fn) => setEventChats((m) => ({ ...m, [ev.id]: fn(eventChatItem(ev, m[ev.id])) })),
      onOpenSub: (sub) => setView({ name: "evsub", ev, sub }),
      onChat: (initial) => setView({ name: "evchat", ev, initial }),
    };
  };
  // 홈 브리핑 줄 → 할 일 화면 또는 캘린더 일정 화면
  const openBrief = (m: { item_id?: string; event_id?: string }) => {
    const it = m.item_id ? items.find((i) => i.id === m.item_id) : undefined;
    const ev = !it && m.event_id ? events.find((e) => e.id === m.event_id) ?? createdEvents.current.get(m.event_id) : undefined;
    if (!it && !ev) return false;
    // 밀어서 돌아갈 때 뒤에 보여 줄 홈 화면을 지금 모습 그대로 복사해 둔다
    homeSnap = snapScreen(mainRef.current);
    const linked = it ?? (ev!.itemId ? items.find((i) => i.id === ev!.itemId) : items.find((i) => i.calendarEventId === ev!.id));
    if (linked) open(linked.id);
    else backToEvent(ev!);
    setFromHome(linked ? "item" : "calendar");
    return true;
  };
  // 홈 브리핑에서 연 화면이면 밀어서 돌아갈 곳이 '홈'이다 (그 화면에서 다른 곳으로 옮기면 풀림)
  const [fromHome, setFromHome] = useState<"item" | "calendar" | null>(null);
  useEffect(() => {
    if (fromHome && view.name !== fromHome) setFromHome(null);
  }, [view.name, fromHome]);
  const fromHomeRef = useRef(fromHome);
  fromHomeRef.current = fromHome;
  const goHomeRef = useRef(() => setView({ name: "home" }));
  const mainRef = useRef<HTMLElement>(null);
  // 뒤로 갈 수 있는 화면(왼쪽 위 뒤로 버튼이 있는 화면)은 왼쪽 가장자리에서 오른쪽으로 밀어 뒤로 간다.
  // 지금 화면이 오른쪽으로 밀려나고, 이전 화면이 왼쪽에서 따라 들어온다.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const W = () => window.innerWidth;
    let sx = 0, sy = 0, dx = 0, on = false, decided = false;
    let go: (() => void) | null = null;
    let under: HTMLDivElement | null = null;
    const showUnder = (snap: ScreenSnap | null | undefined) => {
      main.classList.add("swiping");
      if (!snap) return;
      under = document.createElement("div");
      under.className = "swipe-under";
      const copy = snap.node.cloneNode(true) as HTMLElement;
      copy.inert = true;
      copy.style.marginTop = `${-snap.scrollY}px`;
      under.appendChild(copy);
      document.body.appendChild(under);
      copy.querySelectorAll<HTMLElement>(SCROLLERS).forEach((el, i) => (el.scrollTop = snap.scrolls[i] ?? 0));
    };
    const hideUnder = () => {
      under?.remove();
      under = null;
      main.classList.remove("swiping");
      main.style.transition = "";
      main.style.transform = "";
    };
    const paint = (x: number, anim: boolean) => {
      const t = anim ? "transform .24s cubic-bezier(.2,.8,.2,1)" : "none";
      main.style.transition = t;
      main.style.transform = `translateX(${x}px)`;
      if (under) {
        under.style.transition = t;
        under.style.transform = `translateX(${x - W()}px)`;
      }
    };
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      on = false;
      if (e.touches.length !== 1 || t.clientX > 28) return;
      if (fromHomeRef.current) go = () => goHomeRef.current();
      else {
        const btn = visibleBack();
        go = btn ? () => btn.click() : null;
      }
      on = !!go;
      decided = false;
      dx = 0;
      sx = t.clientX;
      sy = t.clientY;
    };
    const touchMove = (e: TouchEvent) => {
      if (!on) return;
      const t = e.touches[0];
      const x = t.clientX - sx, y = t.clientY - sy;
      if (!decided) {
        if (Math.abs(x) < 8 && Math.abs(y) < 8) return;
        decided = true;
        if (Math.abs(y) > Math.abs(x) || x < 0) return void (on = false);
        showUnder(fromHomeRef.current ? homeSnap : snapFor(visibleBack()));
      }
      if (e.cancelable) e.preventDefault();
      dx = Math.max(0, x);
      paint(dx, false);
    };
    const end = () => {
      if (!on) return;
      on = false;
      if (!decided) return;
      if (dx > Math.min(110, W() * 0.3)) {
        paint(W(), true);
        const run = go;
        setTimeout(() => {
          run?.();
          requestAnimationFrame(() => requestAnimationFrame(hideUnder));
        }, 240);
      } else {
        paint(0, true);
        setTimeout(hideUnder, 250);
      }
    };
    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", touchMove, { passive: false });
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", end);
    const stopTracking = trackScreens(main);
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", touchMove);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
      stopTracking();
      hideUnder();
    };
  }, []);
  const backToEvent = (ev: CalEvent) => {
    setReopenEvent(ev);
    setView({ name: "calendar" });
  };
  // 할 일 탭에서 연 할 일이 캘린더 일정과 이어져 있으면 일정 화면을 그대로 보여 준다
  const linkedEvent = (it: Item): CalEvent | undefined => {
    if (!calOn || !it.calendarEventId || !it.due) return undefined;
    return (
      events.find((e) => e.id === it.calendarEventId) ??
      ({ id: it.calendarEventId, title: it.title, date: it.due, time: it.time ?? "", endDate: it.endDate ?? it.due, endTime: it.endTime ?? "", location: "", description: "", calendarId: it.calendarId, colorId: it.colorId || undefined, itemId: it.id } as CalEvent)
    );
  };
  const current = view.name === "item" || view.name === "chat" || view.name === "sub" ? items.find((i) => i.id === view.id) : undefined;

  // 대화 화면이 떠 있는 동안에는 뒤쪽 문서가 스크롤되지 않게 잠근다.
  const chatScreen = view.name === "home" || view.name === "chat" || view.name === "evchat";
  useEffect(() => {
    document.documentElement.classList.toggle("chat-lock", chatScreen);
    if (chatScreen) window.scrollTo(0, 0);
  }, [chatScreen]);

  return (
    <div className={`app ${view.name === "chat" || view.name === "evchat" ? "in-chat" : ""} ${view.name === "home" ? "in-home" : ""} ${typing ? "kb-open" : ""}`}>
      <main ref={mainRef}>
        {view.name === "home" && (
          <HomeChat
            key={activeId}
            onMenu={() => setDrawer(true)}
            onNewChat={() => setActiveId(uid())}
            items={items}
            events={aiEvents}
            settings={settings}
            calOn={calOn}
            calExpired={calExpired}
            onReconnect={connectCalendar}
            chat={homeChat}
            otherChats={threads.filter((t) => t.id !== activeId)}
            setChat={setHomeChat}
            runTool={runTool}
            onUndo={undo}
            onGoSettings={() => setView({ name: "settings" })}
            onOpenBrief={openBrief}
          />
        )}
        {view.name === "list" && <List items={items} setItems={setItems} onOpen={open} onRemove={removeTodo} />}
        {view.name === "item" && current && linkedEvent(current) && (() => {
          const ev = linkedEvent(current)!;
          const host = eventHost(ev);
          return (
            <EventEditor
              key={ev.id}
              ev={ev}
              host={host}
              todoId={current.id}
              chat={current.chat}
              onChat={host.onChat}
              onClose={() => setView({ name: "list" })}
              onAddTodo={() => {}}
              onSavedEdit={(d) => syncTodoFromEvent(ev, d)}
              onChanged={loadEvents}
              onSaved={() => {
                loadEvents();
                setView({ name: "list" });
              }}
              backLabel="할 일"
            />
          );
        })()}
        {view.name === "item" && current && !linkedEvent(current) && (
          <ItemView
            item={current}
            gToken={gToken}
            onChat={(sub, initial) => setView({ name: "chat", id: current.id, sub, initial })}
            onOpenSub={(sub) => setView({ name: "sub", id: current.id, sub })}
            update={(fn) => updateItem(current.id, fn)}
            onDelete={() => {
              removeTodo(current.id);
              setView({ name: "list" });
            }}
            onBack={() => setView({ name: "list" })}
          />
        )}
        {view.name === "chat" && current && (
          <ChatView key={view.sub ?? "item"} world={{ items, events: aiEvents, home: recentHome }} item={current} subId={view.sub} initial={view.initial} settings={settings} update={(fn) => updateItem(current.id, fn)} onBack={() => (view.sub ? setView({ name: "sub", id: current.id, sub: view.sub, from: view.from }) : view.from ? backToEvent(view.from) : setView({ name: "item", id: current.id }))} />
        )}
        {view.name === "sub" && current && current.subtasks.some((s) => s.id === view.sub) && (
          <SubtaskView
            item={current}
            sub={current.subtasks.find((s) => s.id === view.sub)!}
            update={(fn) => updateItem(current.id, fn)}
            onChat={() => setView({ name: "chat", id: current.id, sub: view.sub, from: view.from })}
            onBack={() => (view.from ? backToEvent(view.from) : setView({ name: "item", id: current.id }))}
          />
        )}
        {view.name === "evsub" && (eventChats[view.ev.id]?.subtasks ?? []).some((s) => s.id === view.sub) && (
          <SubtaskView
            item={eventChatItem(view.ev, eventChats[view.ev.id])}
            sub={eventChats[view.ev.id]!.subtasks.find((s) => s.id === view.sub)!}
            update={(fn) => setEventChats((m) => ({ ...m, [view.ev.id]: fn(eventChatItem(view.ev, m[view.ev.id])) }))}
            onChat={() => setView({ name: "evchat", ev: view.ev, sub: view.sub })}
            onBack={() => backToEvent(view.ev)}
          />
        )}
        {view.name === "calendar" && (
          <CalendarView
            items={items}
            gToken={gToken}
            calOn={calOn}
            linked={linked}
            eventChats={eventChats}
            reopen={reopenEvent}
            onConnect={connectCalendar}
            onOpen={open}
            onAddTodo={addEventAsTodo}
            onCalendarsChanged={loadEvents}
            onEventSaved={syncTodoFromEvent}
            onMoveTodo={(id, n) => updateItem(id, (it) => ({ ...it, due: addDay(it.due, n), endDate: it.endDate ? addDay(it.endDate, n) : it.endDate }))}
            hostFor={(ev) => eventHost(ev, ev)}
            onChat={(ev, initial) => setView({ name: "evchat", ev, initial })}
            onGoSettings={() => setView({ name: "settings" })}
          />
        )}
        {view.name === "evchat" && (
          <ChatView
            key={view.ev.id + (view.sub ?? "")}
            world={{ items, events: aiEvents, home: recentHome }}
            item={eventChatItem(view.ev, eventChats[view.ev.id])}
            subId={view.sub}
            initial={view.initial}
            settings={settings}
            update={(fn) => setEventChats((m) => ({ ...m, [view.ev.id]: fn(eventChatItem(view.ev, m[view.ev.id])) }))}
            onMemo={async (memo) => {
              // 일정의 메모 = 구글 캘린더 일정 설명. 다른 기기에서도 보이도록 구글에 바로 적는다.
              const token = gcal.savedToken() ?? (await gcal.renew());
              if (!token) throw new Error("구글 캘린더 연결이 끝났어요");
              const description = await gcal.appendDescription(token, view.ev.id, memo, view.ev.calendarId);
              setView((v) => (v.name === "evchat" && v.ev.id === view.ev.id ? { ...v, ev: { ...v.ev, description }, initial: undefined } : v));
              loadEvents();
            }}
            onBack={() => (view.sub ? setView({ name: "evsub", ev: view.ev, sub: view.sub }) : backToEvent(view.ev))}
          />
        )}
        {view.name === "settings" && (
          <SettingsView settings={settings} setSettings={setSettings} calOn={calOn} linked={linked} eventsCount={events.length} pinnedCount={items.filter((i) => i.pinned && !i.done).length} items={items} setItems={setItems} onConnect={connectCalendar} onDisconnect={disconnectCalendar} onCalendarsChanged={loadEvents} onBack={() => setView({ name: "home" })} />
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
          onSettings={() => {
            setView({ name: "settings" });
            setDrawer(false);
          }}
          onClose={() => setDrawer(false)}
        />
      )}
      {view.name !== "chat" && view.name !== "evchat" && (
        <nav className="tabs">
          <button className={view.name === "home" || view.name === "settings" ? "on" : ""} onClick={() => setView({ name: "home" })}>
            <IconChat />
            클론
          </button>
          <button className={view.name === "list" || view.name === "item" ? "on" : ""} onClick={() => setView({ name: "list" })}>
            <IconList />
            할 일
          </button>
          <button className={view.name === "calendar" ? "on" : ""} onClick={() => setView({ name: "calendar" })}>
            <IconCalendar />
            캘린더
          </button>
        </nav>
      )}
    </div>
  );
}

/* ---------------- 밀어서 뒤로 가기: 이전 화면 복사본 ---------------- */
// 화면을 옮기기 직전 모습을 복사해 두었다가, 밀어서 돌아갈 때 뒤에 깔아 보여 준다.
type ScreenSnap = { node: HTMLElement; scrollY: number; scrolls: number[] };
const SCROLLERS = ".thread, .drawer-list";
const BACK_SEL = ".back, [aria-label='뒤로']";
function snapScreen(main: HTMLElement | null): ScreenSnap | null {
  if (!main) return null;
  const app = main.closest(".app");
  const wrap = document.createElement("div");
  wrap.className = (app?.className ?? "app").replace(/\bswiping\b/, "");
  const copy = main.cloneNode(true) as HTMLElement;
  copy.classList.remove("swiping");
  copy.removeAttribute("style");
  wrap.appendChild(copy);
  return { node: wrap, scrollY: window.scrollY, scrolls: [...main.querySelectorAll<HTMLElement>(SCROLLERS)].map((el) => el.scrollTop) };
}
// 지금 화면에서 보이는 뒤로 버튼
function visibleBack(): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(BACK_SEL)].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.top < 140 && !b.closest(".swipe-under");
  });
  return all[all.length - 1] ?? null;
}
// 뒤로 버튼마다 '그 화면으로 오기 직전 화면'을 기억한다
const snaps = new WeakMap<HTMLElement, ScreenSnap>();
const snapFor = (btn: HTMLElement | null) => (btn ? snaps.get(btn) : undefined);
let homeSnap: ScreenSnap | null = null;
function trackScreens(main: HTMLElement) {
  const onTap = (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (!t || t.closest(".swipe-under")) return;
    const before = visibleBack();
    const snap = snapScreen(main);
    // 화면이 바뀌어 새 뒤로 버튼이 생겼으면 그 버튼에 직전 화면을 붙여 둔다 (뒤로 가는 길이면 붙이지 않음)
    setTimeout(() => {
      const after = visibleBack();
      if (snap && after && after !== before && !snaps.has(after) && !(before && t.closest(BACK_SEL) === before)) snaps.set(after, snap);
    }, 80);
  };
  document.addEventListener("click", onTap, true);
  return () => document.removeEventListener("click", onTap, true);
}


/* ---------------- 홈: 비서와 대화 ---------------- */

// 할 일 표시를 다시 붙인 일정 (한 번만 시도)
const relinked = new Set<string>();

// 마지막 브리핑. 앱을 다시 열면 이걸 바로 보여 주고 뒤에서 새로 만든다 (기다리는 화면 없이).
type BriefCache = { at: number; brief: Briefing; evKey: string; v?: number };
const BRIEF_V = 2; // 브리핑 모양(문장 길이 등)을 바꾸면 올린다 → 예전 브리핑은 보여 주되 바로 새로 만든다
let briefCache: BriefCache | null = (() => {
  try {
    const c = JSON.parse(localStorage.getItem("briefCache") ?? "null") as BriefCache | null;
    // 다른 날 만든 브리핑은 '지금'이 틀릴 수 있어서 쓰지 않는다
    if (!c || new Date(c.at).toDateString() !== new Date().toDateString()) return null;
    return c.v === BRIEF_V ? c : { ...c, at: 0 };
  } catch {
    return null;
  }
})();
const saveBrief = (c: BriefCache) => {
  c = { ...c, v: BRIEF_V };
  briefCache = c;
  try {
    localStorage.setItem("briefCache", JSON.stringify(c));
  } catch {
    /* 무시 */
  }
};

// 브리핑 한 줄의 날짜는 글 앞에 쓰지 않고 색 박스로 따로 보여 준다.
// 예전에 만든 브리핑처럼 글 앞에 날짜가 붙어 있으면 떼어 내서 박스로 옮긴다.
function briefDate(m: { text: string; date?: string }): { date: string; text: string } {
  const now = new Date();
  const y = now.getFullYear();
  const lead = /^\s*(오늘|내일|모레|(\d{1,2})\s*(?:\/|\.|월\s*)(\d{1,2})일?)(?:\s*\([월화수목금토일]\))?\s*[,:·-]?\s*/;
  const hit = m.text.match(lead);
  let date = m.date && /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : "";
  let text = m.text;
  if (hit && hit[0].length < m.text.length) {
    text = m.text.slice(hit[0].length);
    if (!date) {
      const add = { 오늘: 0, 내일: 1, 모레: 2 }[hit[1] as "오늘"];
      if (add !== undefined) date = ymd(new Date(y, now.getMonth(), now.getDate() + add));
      else {
        const mo = +hit[2], d = +hit[3];
        // 지금보다 몇 달 이상 앞선 날짜면 내년으로 본다 (12월에 1월 일정을 말할 때)
        const guess = new Date(mo < now.getMonth() - 5 ? y + 1 : y, mo - 1, d);
        date = ymd(guess);
      }
    }
  }
  return { date, text };
}

function BriefText({ m, pad }: { m: { text: string; date?: string }; pad?: boolean }) {
  const { date, text } = briefDate(m);
  // pad: 같은 묶음에 날짜 칩이 있는 줄이 있으면, 날짜 없는 줄도 같은 자리에서 글자가 시작하게 빈 칸을 둔다.
  if (!date)
    return pad ? (
      <span className="grow brief-row">
        <span className="date-chip spacer" aria-hidden="true" />
        <span>{m.text}</span>
      </span>
    ) : (
      <span className="grow">{m.text}</span>
    );
  const n = daysUntil(date) ?? 99;
  const label = n === 0 ? "오늘" : n === 1 ? "내일" : `${+date.slice(5, 7)}/${+date.slice(8, 10)}`;
  return (
    <span className="grow brief-row">
      <span className={`date-chip ${n <= 0 ? "due" : n <= 3 ? "soon" : ""}`}>{label}</span>
      <span>{text}</span>
    </span>
  );
}

function HomeChat(props: {
  otherChats: HomeThread[];
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
  onOpenBrief: (m: { item_id?: string; event_id?: string }) => boolean;
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

  // 보낸 사진을 누르면 전체 화면으로 본다
  const [viewer, setViewer] = useState<{ thumb: string; key?: string } | null>(null);
  // 보낼 사진: 클론에게 보낼 원본(줄인 것)과 대화에 남길 작은 미리보기
  const [pics, setPics] = useState<{ full: string; thumb: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const addPics = async (files: FileList | null) => {
    if (!files) return;
    const list = [...files].filter((f) => f.type.startsWith("image/")).slice(0, 5 - pics.length);
    try {
      const done = await Promise.all(list.map(async (f) => ({ full: await shrinkImage(f, 1568, 0.85), thumb: await shrinkImage(f, 360, 0.7) })));
      setPics((p) => [...p, ...done].slice(0, 5));
    } catch {
      toast("사진을 열지 못했어요");
    }
  };

  const send = async (text: string) => {
    text = text.trim();
    if ((!text && !pics.length) || busy) return;
    const sent = pics;
    setPics([]);
    setMsg("");
    setBusy(true);
    setStreaming("");
    const past = chat;
    // 전체 화면으로 다시 볼 수 있게 큰 사진은 이 기기 저장소에 따로 둔다 (대화 기록에는 작은 미리보기만)
    const keys = sent.map(() => "chatpic_" + uid());
    sent.forEach((p, i) =>
      fetch(p.full)
        .then((r) => r.blob())
        .then((b) => files.add(keys[i], new File([b], "photo.jpg", { type: "image/jpeg" })))
        .catch(() => {}),
    );
    setChat((c) => [...c, { role: "user", text, ts: Date.now(), images: sent.length ? sent.map((p) => p.thumb) : undefined, imageKeys: sent.length ? keys : undefined }]);
    try {
      // 사진을 보내 클론이 일정이나 할 일을 만들면, 그 사진을 새 일정(할 일) 카드의 첨부 파일로 남긴다
      const photoOwners = new Set<string>();
      const attachPhotos = async (owner: string) => {
        if (!sent.length || photoOwners.has(owner)) return;
        photoOwners.add(owner);
        const blobs = await Promise.all(sent.map((p) => fetch(p.full).then((r) => r.blob())));
        for (const [i, b] of blobs.entries()) await files.add(owner, new File([b], `사진${blobs.length > 1 ? ` ${i + 1}` : ""}.jpg`, { type: "image/jpeg" }));
      };
      const runTool: ToolRunner = async (name, input) => {
        const r = await props.runTool(name, input);
        const u = r.action?.undo;
        if (sent.length && u)
          try {
            if (name === "add_event" && u.eventId) await attachPhotos(u.eventId);
            if (name === "add_item" && u.itemId) {
              // 방금 사진을 붙인 일정을 할 일로 이은 것이면 사진을 할 일 쪽으로 옮긴다 (이어진 일정은 할 일의 첨부를 보여 준다)
              const evId = (input as { event_id?: string }).event_id;
              if (evId && photoOwners.has(evId)) {
                await files.moveOwner(evId, u.itemId);
                photoOwners.add(u.itemId);
              } else await attachPhotos(u.itemId);
            }
          } catch {
            toast("사진을 일정에 첨부하지 못했어요");
          }
        return r;
      };
      const r = await homeChat(settings, items, events, props.calOn, past, text, setStreaming, runTool, props.otherChats, sent.map((p) => p.full));
      if (r.actions.length && briefCache) briefCache = { ...briefCache, at: 0 };
      setChat((c) => [...c, { role: "assistant", text: r.text, ts: Date.now(), actions: r.actions.length ? r.actions : undefined }]);
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", text: `⚠️ ${(e as Error).message}`, ts: Date.now() }]);
    } finally {
      setStreaming("");
      setBusy(false);
    }
  };

  // 클론이 한 일 칩을 누르면 그 할 일 / 캘린더 일정 화면으로 간다 (지운 것·되돌린 것은 제외)
  const actTarget = (a: Action): { item_id?: string; event_id?: string } | null => {
    if (a.undone || !a.undo || a.kind === "event_delete") return null;
    if (a.kind === "event" || a.kind === "event_update") return a.undo.eventId ? { event_id: a.undo.eventId } : null;
    return a.undo.itemId ? { item_id: a.undo.itemId } : null;
  };

  const undo = (mi: number, ai: number) => {
    const a = chat[mi]?.actions?.[ai];
    if (!a || a.undone) return;
    props.onUndo(a);
    setChat((c) => c.map((m, i) => (i === mi ? { ...m, actions: m.actions!.map((x, j) => (j === ai ? { ...x, undone: true } : x)) } : m)));
  };

  // 새 채팅에서는 비서가 먼저 말을 건다: 지금 할 일, 놓친 것, 확인할 것. 30분 동안은 다시 묻지 않는다.
  const [fresh] = useState(chat.length === 0);
  // 저장해 둔 브리핑이 없으면 이 기기에서 바로 만들 수 있는 간단한 브리핑부터 보여 준다.
  const [brief, setBrief] = useState<Briefing>(() => briefCache?.brief ?? simpleBriefing(items, events));
  // 일정이나 할 일(세부 업무 포함)이 바뀌면 브리핑을 새로 만든다
  const evKey =
    events.map((e) => `${e.id}|${e.title}|${e.date}|${e.time}|${e.subtasks?.length ?? 0}|${e.chat?.length ?? 0}`).join(",") +
    "#" +
    items.map((i) => `${i.id}:${i.updatedAt}`).join(",");
  useEffect(() => {
    if (!settings.apiKey) return setBrief(simpleBriefing(items, events));
    // 같은 내용이면 30분 동안, 내용이 바뀌었어도 마지막으로 만든 지 5분이 안 됐으면 다시 만들지 않는다 (API 아끼기)
    if (briefCache) {
      const age = Date.now() - briefCache.at;
      if (age < (briefCache.evKey === evKey ? 30 : 5) * 60000) return;
    }
    if (document.hidden) return;
    let alive = true;
    makeBriefing(settings, items, events)
      .then((b) => {
        saveBrief({ at: Date.now(), brief: b, evKey });
        if (alive) setBrief(b);
      })
      .catch(() => alive && !briefCache && setBrief(simpleBriefing(items, events)));
    return () => {
      alive = false;
    };
    // 처음 열 때와 캘린더 일정이 들어오거나 바뀌었을 때만 다시 만든다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKey, evKey]);

  const ask = (text: string) => send(`${text} 이거 어떻게 하면 좋을까?`);
  // 브리핑 줄을 누르면 그 할 일이나 일정 화면을 연다. 이어진 곳을 못 찾으면 클론에게 물어본다.
  const tapBrief = (m: { text: string; item_id?: string; event_id?: string }) => {
    if (props.onOpenBrief(m)) return;
    if (settings.apiKey) ask(m.text);
  };

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
      {(
        <>
          <button className="now-line" onClick={() => tapBrief(brief.now)}>
            <span className="grow now-body">
              <span className="label">지금</span>
              <span>{brief.now.text}</span>
            </span>
            <span className="chev"><IconRight /></span>
          </button>
          {brief.missed.length > 0 && (
            <div className="bgroup">
              <p className="label warn">놓친 것</p>
              {brief.missed.map((m, i) => (
                <button key={i} className="bline" onClick={() => tapBrief(m)}>
                  <BriefText m={m} pad={brief.missed.some((x) => briefDate(x).date)} />
                  <span className="chev"><IconRight /></span>
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
                    onTap={() => tapBrief(m)}
                    actions={[{ label: "나중에", cls: "later", run: () => hide(m) }]}
                  >
                    <BriefText m={m} pad={checks.some((x) => briefDate(x).date)} />
                    <span className="chev"><IconRight /></span>
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
        <strong onClick={tapTitle}>클론</strong>
        <VersionBubble />
        <span className="head-right">
          <button className="icon-btn" aria-label="새 채팅" onClick={props.onNewChat} disabled={chat.length === 0 && !busy}>
            <IconCompose />
          </button>
        </span>
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
            <Fragment key={i}>
              {m.images?.length ? (
                <div className="msg-pics">
                  {m.images.map((src, j) => (
                    <img key={j} src={src} alt="보낸 사진" onClick={() => setViewer({ thumb: src, key: m.imageKeys?.[j] })} />
                  ))}
                </div>
              ) : null}
              {m.text && <div className="msg user">{m.text}</div>}
            </Fragment>
          ) : (
            <div key={i} className="msg assistant">
              <Markdown text={m.text} />
              {m.actions && (
                <div className="actions">
                  {m.actions.map((a, j) => (
                    <div
                      key={j}
                      className={`act ${a.undone ? "undone" : ""}${actTarget(a) ? " tappable" : ""}`}
                      onClick={() => {
                        const t = actTarget(a);
                        if (t && !props.onOpenBrief(t)) toast("그 항목을 찾지 못했어요");
                      }}
                    >
                      <span className="tick">{a.undone ? "↩" : "✓"}</span>
                      <span className="grow">
                        {a.text}
                      </span>
                      {actTarget(a) && <span className="chev"><IconRight /></span>}
                      {a.undo && !a.undone && (
                        <button className="link small" onClick={(e) => (e.stopPropagation(), undo(i, j))}>
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

      {viewer && <PhotoViewer thumb={viewer.thumb} fileKey={viewer.key} onClose={() => setViewer(null)} />}
      {pics.length > 0 && (
        <div className="pic-tray">
          {pics.map((p, i) => (
            <span key={i} className="pic">
              <img src={p.thumb} alt="첨부할 사진" />
              <button aria-label="사진 빼기" onClick={() => setPics((all) => all.filter((_, j) => j !== i))}>
                <IconClose />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addPics(e.target.files); e.target.value = ""; }} />
        <button className="attach" aria-label="사진 첨부" onClick={() => fileRef.current?.click()} disabled={!settings.apiKey || busy || pics.length >= 5}>
          <IconImage />
        </button>
        <textarea
          ref={boxRef}
          rows={1}
          placeholder={settings.apiKey ? (pics.length ? "덧붙일 말 (안 써도 돼요)" : "일정이나 할 일을 말해 주세요") : "설정에서 API 키를 넣어 주세요"}
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
        <button className="send" aria-label="보내기" onClick={() => send(msg)} disabled={busy || (!msg.trim() && !pics.length)}>
          <IconUp />
        </button>
      </div>
    </section>
  );
}

// 보낸 사진 전체 화면 보기: 저장해 둔 큰 사진이 있으면 그것을, 없으면 미리보기를 보여 준다. 아무 곳이나 누르면 닫힌다.
function PhotoViewer({ thumb, fileKey, onClose }: { thumb: string; fileKey?: string; onClose: () => void }) {
  const [src, setSrc] = useState(thumb);
  useEffect(() => {
    if (!fileKey) return;
    let url = "";
    files
      .list(fileKey)
      .then((a) => {
        if (!a[0]) return;
        url = URL.createObjectURL(a[0].blob);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileKey]);
  return createPortal(
    <div className="photo-viewer" onClick={onClose}>
      <img src={src} alt="보낸 사진" />
      <button className="pv-close" aria-label="닫기">
        <IconClose />
      </button>
    </div>,
    document.body,
  );
}

// 사진을 긴 쪽 max 픽셀 이하 JPEG로 줄인다 (클론에게 보내는 크기와 저장 공간을 줄이기 위해)
function shrinkImage(file: File, max: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext("2d")!;
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 열지 못했어요"));
    };
    img.src = url;
  });
}

/* ---------------- 왼쪽 채팅 목록 ---------------- */

// 클론이 요약한 제목이 생기기 전까지 쓰는 임시 제목 (사진만 보낸 채팅도 빈 줄이 되지 않게)
const threadTitle = (msgs: Msg[]) => {
  const u = msgs.find((m) => m.role === "user");
  const first = u?.text.replace(/\s+/g, " ").trim() || (u?.images?.length ? "사진" : "") || "새 채팅";
  return first.length > 30 ? first.slice(0, 30) + "…" : first;
};

function ChatDrawer(props: {
  threads: HomeThread[];
  activeId: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
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
                      <span className={`grow ${t.id === props.activeId ? "on" : ""}`}>{t.title.trim() || threadTitle(t.msgs)}</span>
                    </SwipeRow>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
        <button className="drawer-foot" onClick={props.onSettings}>
          <IconSettings /> 설정
        </button>
      </aside>
    </div>
  );
}

/* ---------------- 할 일 목록 ---------------- */

function List({ items, setItems, onOpen, onRemove }: { items: Item[]; setItems: (fn: (a: Item[]) => Item[]) => void; onOpen: (id: string) => void; onRemove: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [swiped, setSwiped] = useState<string | null>(null);

  const remove = onRemove;
  const toggleDone = (id: string) => setItems((a) => a.map((x) => (x.id === id ? { ...x, done: !x.done, updatedAt: Date.now() } : x)));
  const togglePin = (id: string) => {
    const it = items.find((x) => x.id === id);
    setItems((a) => a.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x)));
    if (it && !it.pinned) toast(gcal.serverUrl() ? "잠금 화면에 고정했어요" : "고정했어요. 위젯은 설정에서 연결해요");
  };
  const row = (i: Item) => (
    <ItemRow
      key={i.id}
      it={i}
      open={swiped === i.id}
      onOpenChange={(o) => setSwiped(o ? i.id : null)}
      onOpen={onOpen}
      onToggle={() => toggleDone(i.id)}
      onPin={() => togglePin(i.id)}
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
      </header>
      {open.length === 0 && !adding && <p className="muted">아직 할 일이 없어요. 아래 + 를 눌러 추가해 보세요.</p>}
      <ul className="items">{open.map(row)}</ul>
      {adding && (
      <div className="add add-card">
        <input autoFocus placeholder="앞으로 할 일을 적어 보세요" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
        <DateField value={due} onChange={setDue} />
        <button onClick={add} disabled={!title.trim()}>추가</button>
      </div>
      )}
      <button className={`sub-add list-add ${adding ? "on" : ""}`} aria-label={adding ? "닫기" : "할 일 추가"} onClick={(e) => (e.stopPropagation(), setAdding(!adding))}>
        <IconPlus />
      </button>
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
  onPin: () => void;
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
      {it.due && (
        <span className="due-wrap">
          <span className={`due ${n !== null && n <= 1 && !it.done ? "soon" : ""}`}>{dueLabel(it.due)}</span>
          <span className="due-date">{dueDay(it.due)}</span>
        </span>
      )}
      {!it.done && (
        <button
          className={`pin-btn ${it.pinned ? "on" : ""}`}
          aria-label={it.pinned ? "잠금 화면 고정 해제" : "잠금 화면에 고정"}
          aria-pressed={!!it.pinned}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => (e.stopPropagation(), props.onPin())}
        >
          <IconPin on={it.pinned} />
        </button>
      )}
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
    const vv = window.visualViewport;
    const toEnd = () => (box.scrollTop = box.scrollHeight);
    // 입력칸을 누른 뒤 키보드가 다 올라올 때까지는 무조건 맨 아래에 붙여 둔다.
    // (키보드가 올라오며 높이가 줄어드는 동안 생기는 스크롤 알림 때문에 '맨 아래가 아님'으로 잘못 판단하지 않게)
    let pinUntil = 0;
    const pinned = () => Date.now() < pinUntil;
    const onScroll = () => {
      if (pinned()) return;
      atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    };
    const follow = () => (pinned() || atBottom.current) && toEnd();
    const ro = new ResizeObserver(follow);
    ro.observe(box);
    box.addEventListener("scroll", onScroll, { passive: true });
    vv?.addEventListener("resize", follow);
    vv?.addEventListener("scroll", follow);
    // 사용자가 직접 대화를 끌어 올리면 그때부터는 붙잡지 않는다.
    const release = () => (pinUntil = 0);
    box.addEventListener("touchstart", release, { passive: true });
    box.addEventListener("wheel", release, { passive: true });
    // 입력칸을 누르면 맨 아래 대화가 입력칸 바로 위에 오도록 내려간다.
    const root = box.closest(".homechat, .chatview");
    const onFocus = (e: Event) => {
      if (!(e.target instanceof HTMLTextAreaElement)) return;
      atBottom.current = true;
      pinUntil = Date.now() + 1500;
      toEnd();
      requestAnimationFrame(toEnd);
      [60, 160, 320, 500, 800, 1100, 1500].forEach((ms) => setTimeout(follow, ms));
    };
    root?.addEventListener("focusin", onFocus);
    toEnd();
    return () => {
      ro.disconnect();
      box.removeEventListener("scroll", onScroll);
      vv?.removeEventListener("resize", follow);
      vv?.removeEventListener("scroll", follow);
      box.removeEventListener("touchstart", release);
      box.removeEventListener("wheel", release);
      root?.removeEventListener("focusin", onFocus);
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
// 홈 제목 '클론'을 빠르게 세 번 누르면 지금 앱 버전이 작은 말풍선으로 잠깐 뜬다.
let titleTaps: number[] = [];
function tapTitle() {
  const now = Date.now();
  titleTaps = [...titleTaps.filter((t) => now - t < 800), now];
  if (titleTaps.length >= 3) {
    titleTaps = [];
    window.dispatchEvent(new Event("show-version"));
  }
}

const buildTime = new Date(__BUILD_TIME__).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function VersionBubble() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer = 0;
    const show = () => {
      setOn(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setOn(false), 3000);
    };
    window.addEventListener("show-version", show);
    return () => {
      window.removeEventListener("show-version", show);
      clearTimeout(timer);
    };
  }, []);
  if (!on) return null;
  return (
    <div className="version-bubble" onClick={() => setOn(false)}>
      v{__APP_VERSION__}
      <small>{buildTime}</small>
    </div>
  );
}

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
      if (!vertical || dy <= 0 || window.scrollY > 0 || document.body.classList.contains("ev-drag")) return set(0);
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
// 할 일 카드의 마감일: "10/18 (토)"
const dueDay = (d: string) => {
  const x = new Date(d + "T00:00:00");
  return `${x.getMonth() + 1}/${x.getDate()} (${"일월화수목금토"[x.getDay()]})`;
};
const fmtTime = (t: string) => new Date(`2000-01-01T${t}:00`).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
const today = () => new Date().toLocaleDateString("sv-SE");
// 일정 화면에서 보여 주는 날짜·시간 한 줄
const schedText = (d: Pick<Item, "due" | "time" | "endDate" | "endTime">) => {
  const end = itemEnd(d);
  // 시작일과 끝나는 날이 다르면 두 줄로 나눠 칸 밖으로 넘치지 않게 한다
  if (!d.time) return end.date !== d.due ? `${fmtDay(d.due)} ~\n${fmtDay(end.date)} · 종일` : `${fmtDay(d.due)} · 종일`;
  return end.date !== d.due ? `${fmtDay(d.due)} ${fmtTime(d.time)} ~\n${fmtDay(end.date)} ${fmtTime(end.time!)}` : `${fmtDay(d.due)} · ${fmtTime(d.time)} ~ ${fmtTime(end.time!)}`;
};

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
  onOpenSub: (subId: string) => void;
}) {
  const { item, update } = props;
  const [ask, setAsk] = useState("");
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [editing, setEditing] = useState(false);

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
    <section className="detail" onClick={() => setMenu(false)}>
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
              <button onClick={() => (setEditing(!editing), setMenu(false))}>{editing ? "수정 끝내기" : "수정"}</button>
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
        </div>
      )}

      <MemoField value={item.note} onChange={(note) => update((it) => ({ ...it, note }))} />

      {editing && (
        <EditPanel onDone={() => setEditing(false)}>
          <div className="fields">
            <ColorField value={item.colorId || undefined} onChange={(c) => update((it) => ({ ...it, colorId: c ?? "" }))} />
          </div>
          <EventFiles owner={item.id} editable />
        </EditPanel>
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
      {!editing && <EventFiles owner={item.id} />}

      <SubtaskSection item={item} update={update} onOpenSub={props.onOpenSub} />
    </section>
  );
}

/* 할 일 화면의 메모: 평소엔 읽기만, 누르면 그 자리에서 바로 고친다. 다른 곳을 누르면 끝. */
function MemoField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="fields event-info memo-card">
      <InlineText label="메모" value={value} onChange={onChange} multiline placeholder="메모 (클론도 같이 봐요)" empty="메모 추가" />
    </div>
  );
}

/* 누르면 그 자리에서 고치는 한 줄(위치·메모 등). 다른 곳을 누르면 끝나고 onDone이 불린다. readOnly면 보기만. */
function InlineText(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onDone?: () => void;
  multiline?: boolean;
  placeholder?: string;
  empty: string;
  readOnly?: boolean;
}) {
  const { value, multiline } = props;
  const [edit, setEdit] = useState(false);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    const t = ref.current;
    if (!edit || !t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, [edit]);
  useEffect(() => {
    const t = ref.current;
    if (!t || !multiline) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  }, [edit, value, multiline]);
  const finish = () => (setEdit(false), props.onDone?.());
  if (edit)
    return (
      <div className={`field memo-edit${multiline ? " info-desc" : ""}`} onClick={(e) => e.stopPropagation()}>
        <span className="info-label">{props.label}</span>
        {multiline ? (
          <textarea ref={ref} rows={1} className="grow" placeholder={props.placeholder} value={value} onChange={(e) => props.onChange(e.target.value)} onBlur={finish} />
        ) : (
          <input
            ref={ref}
            className="grow"
            placeholder={props.placeholder}
            value={value}
            onChange={(e) => props.onChange(e.target.value)}
            onBlur={finish}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()}
          />
        )}
        <span className="chev ghost-chev" aria-hidden="true"><IconRight /></span>
      </div>
    );
  if (props.readOnly)
    return value.trim() ? (
      <div className={`field${multiline ? " info-desc" : ""}`}>
        <span className="info-label">{props.label}</span>
        <span className="grow">{value}</span>
      </div>
    ) : null;
  return (
    <button className={`field tap-field${multiline ? " info-desc" : ""}`} onClick={(e) => (e.stopPropagation(), setEdit(true))} aria-label={`${props.label} 수정`}>
      <span className="info-label">{props.label}</span>
      <span className={`grow ${value.trim() ? "" : "muted"}`}>{value.trim() ? value : props.empty}</span>
      <span className="chev"><IconRight /></span>
    </button>
  );
}

/* 누르면 그 자리에서 고치는 큰 제목 */
function InlineTitle(props: { value: string; onChange: (v: string) => void; onDone?: () => void; readOnly?: boolean; placeholder: string; className?: string; children?: React.ReactNode }) {
  const [edit, setEdit] = useState(false);
  if (edit)
    return (
      <input
        className="title-input title-edit"
        autoFocus
        placeholder={props.placeholder}
        value={props.value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={() => (setEdit(false), props.onDone?.())}
        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()}
      />
    );
  return (
    <h1 className={`title-view ${props.className ?? ""}`} onClick={() => !props.readOnly && setEdit(true)}>
      {props.children}
    </h1>
  );
}

/* 세부 업무 목록: 할 일 화면과 일정 화면이 같이 쓴다. item은 할 일이거나, 할 일과 안 이어진 일정의 대화용 항목.
   세부 업무마다 따로 박스, 누르면 세부 업무 화면. 왼쪽으로 밀면 완료/삭제. 아래 ⊕ 버튼으로 추가. */
function SubtaskSection({ item, update, onOpenSub }: { item: Item; update: (fn: (it: Item) => Item) => void; onOpenSub: (subId: string) => void }) {
  const [newSub, setNewSub] = useState("");
  const [adding, setAdding] = useState(false);
  const [swiped, setSwiped] = useState<string | null>(null);
  const addSub = (title: string) =>
    update((it) => ({ ...it, subtasks: [...it.subtasks, { id: uid(), title, done: false, byClaude: false, createdAt: Date.now() }] }));
  const toggleSub = (id: string) => update((it) => ({ ...it, subtasks: it.subtasks.map((x) => (x.id === id ? { ...x, done: !x.done } : x)) }));
  const removeSub = (id: string) => update((it) => ({ ...it, subtasks: it.subtasks.filter((x) => x.id !== id) }));
  const submit = () => {
    const t = newSub.trim();
    if (t) addSub(t);
    setNewSub("");
    setAdding(false);
  };
  return (
    <div className="subtask-section" onClick={() => setSwiped(null)}>
      <div className="section-head">
        <h3>세부 업무</h3>
      </div>
      <ul className="sub-cards">
        {item.subtasks.map((s) => (
          <SwipeRow
            key={s.id}
            open={swiped === s.id}
            onOpenChange={(o) => setSwiped(o ? s.id : null)}
            onTap={() => onOpenSub(s.id)}
            actions={[
              { label: s.done ? "되돌리기" : "완료", cls: "ok", run: () => toggleSub(s.id) },
              { label: "삭제", cls: "danger", run: () => removeSub(s.id) },
            ]}
          >
            <span className={`tick ${s.done ? "on" : ""}`}>{s.done && <IconCheck />}</span>
            <span className="grow">
              <span className={`t ${s.done ? "done" : ""}`}>{s.title}</span>
              {s.due && <span className="preview">{schedText(s as Sched)}</span>}
            </span>
            <span className="chev"><IconRight /></span>
          </SwipeRow>
        ))}
        {adding && (
          <li className="sub-new">
            <input
              autoFocus
              placeholder="세부 업무 이름"
              value={newSub}
              onChange={(e) => setNewSub(e.target.value)}
              onBlur={submit}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
                if (e.key === "Escape") (setNewSub(""), setAdding(false));
              }}
            />
          </li>
        )}
      </ul>
      {!adding && (
        <button className="sub-add" aria-label="세부 업무 추가" onClick={(e) => (e.stopPropagation(), setAdding(true))}>
          <IconPlus />
        </button>
      )}
    </div>
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
  // 클론이 남긴 메모를 어디에 적을지. 없으면 이 할 일의 메모 칸에 덧붙인다.
  onMemo?: (text: string) => Promise<void>;
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
  // 이 화면에 떠 있는 메시지는 본 것으로 친다 (일정·세부 업무 화면의 말풍선 숫자가 사라지게)
  useEffect(() => markSeen(subId ?? item.id, chat.length), [subId, item.id, chat.length]);
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
      let saved = "";
      if (r.memos.length) {
        const memo = r.memos.map((m) => `• ${m}`).join("\n");
        try {
          if (props.onMemo) await props.onMemo(memo);
          else update((it) => ({ ...it, note: it.note.trim() ? `${it.note.trimEnd()}\n${memo}` : memo }));
          saved = `\n\n📝 메모에 남겼어요\n${memo}`;
        } catch (e) {
          toast(`메모를 남기지 못했어요: ${(e as Error).message}`);
        }
      }
      update((it) =>
        setChat(it, (c) => [...c, { role: "assistant", text: r.text + saved, ts: Date.now(), suggestions: r.suggestions.length ? r.suggestions : undefined }]),
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

type SettingsPage = "main" | "claude" | "calendar" | "widget" | "data";

function SettingsView(props: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  calOn: boolean;
  linked: boolean;
  eventsCount: number;
  pinnedCount: number;
  items: Item[];
  setItems: (fn: (a: Item[]) => Item[]) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onCalendarsChanged: () => void;
  onBack: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>("main");
  const { settings } = props;
  const keyTail = settings.apiKey ? `…${settings.apiKey.slice(-4)}` : "";

  if (page === "main")
    return (
      <section className="settings">
        <header className="page-head">
          <button className="back" onClick={props.onBack}>
            <IconBack />
            클론
          </button>
        </header>
        <h1 className="settings-title">설정</h1>
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
          <li onClick={() => setPage("widget")}>
            <span className="grow">
              <strong>잠금 화면 위젯</strong>
              <span className="status">고정한 할 일 {props.pinnedCount}개</span>
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

  const titles = { claude: "클론 연결", calendar: "구글 캘린더", widget: "잠금 화면 위젯", data: "데이터 백업" };
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
      {page === "widget" && <WidgetSettings items={props.items} onGoCalendar={() => setPage("calendar")} />}
      {page === "data" && <DataSettings items={props.items} setItems={props.setItems} />}
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

function DriveStatus(props: { onConnect: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    window.addEventListener("drive-saved", on);
    return () => window.removeEventListener("drive-saved", on);
  }, []);
  if (drive.driveApiOff())
    return (
      <div className="banner">
        <span className="grow">구글 클라우드에서 드라이브 기능이 꺼져 있어서 대화 기록을 저장하지 못했어요. 오른쪽 버튼으로 들어가 "사용"을 누른 뒤 앱을 다시 열어 주세요.</span>
        <a className="btn small" href={drive.enableUrl(GOOGLE_CLIENT_ID)} target="_blank" rel="noreferrer">드라이브 켜기</a>
      </div>
    );
  if (drive.needsDriveScope())
    return (
      <div className="banner">
        <span className="grow">대화 기록을 드라이브에 저장할 권한이 없어요. 다시 연결할 때 구글 화면에서 "Google Drive" 항목에도 체크해 주세요.</span>
        <button className="btn small" onClick={props.onConnect}>다시 연결</button>
      </div>
    );
  const at = drive.lastSaved();
  return (
    <p className="muted small">
      대화 기록은 구글 드라이브 문서 "클론 대화 기록"에 자동 저장돼요
      {at ? ` · 마지막 저장 ${new Date(at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : " · 아직 저장 전"}
      {drive.docUrl() && (
        <>
          {" · "}
          <a href={drive.docUrl()} target="_blank" rel="noreferrer">문서 열기</a>
        </>
      )}
    </p>
  );
}

function CalendarSettings(props: { calOn: boolean; linked: boolean; eventsCount: number; onConnect: () => void; onDisconnect: () => void; onCalendarsChanged: () => void }) {
  const [cals, setCals] = useState(gcal.cachedCalendars());
  useEffect(() => {
    if (!props.calOn) return;
    const t = gcal.savedToken();
    if (t) gcal.calendars(t, true).then(setCals);
  }, [props.calOn]);
  const toggleCal = (id: string, shown: boolean) => {
    gcal.setShown(id, shown);
    setCals(gcal.cachedCalendars());
    props.onCalendarsChanged();
  };
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
              {keep ? "계속 연결 유지 중" : "1시간 동안 연결"} · 앞으로 60일 일정 {props.eventsCount}개
            </span>
          )}
        </div>
      </div>
      {props.calOn && saved && !keep && <p className="muted small">연결 유지 서버를 쓰려면 연결을 끊고 한 번 다시 연결해 주세요.</p>}
      {props.calOn && gcal.needsCalendarScope() && (
        <div className="banner">
          <span className="grow">개인·업무 같은 캘린더 그룹을 쓰려면 구글 연결을 한 번 다시 해 주세요.</span>
          <button className="btn small" onClick={props.onConnect}>다시 연결</button>
        </div>
      )}
      {props.calOn && <DriveStatus onConnect={props.onConnect} />}
      {props.calOn && cals.length > 1 && (
        <>
          <label>보여 줄 캘린더</label>
          <ul className="menu cal-list">
            {cals.map((c) => (
              <li key={c.id}>
                <span className="swatch tiny" style={{ background: c.color }} />
                <span className="grow">
                  {c.name}
                  {!c.writable && <span className="muted small"> · 읽기 전용</span>}
                </span>
                <input type="checkbox" className="switch" aria-label={`${c.name} 보이기`} checked={c.shown} onChange={(e) => toggleCal(c.id, e.target.checked)} />
              </li>
            ))}
          </ul>
          <p className="muted small">구글 캘린더에 있는 캘린더(그룹)를 그대로 가져와요. 일정 화면의 ⋯ → 수정에서 일정을 다른 캘린더로 옮길 수 있어요.</p>
        </>
      )}
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

function WidgetSettings({ items, onGoCalendar }: { items: Item[]; onGoCalendar: () => void }) {
  const pinnedCount = items.filter((i) => i.pinned && !i.done).length;
  const server = gcal.serverUrl();
  const [kv, setKv] = useState<"" | "checking" | "ok" | "nokv" | "fail">("");
  const [copied, setCopied] = useState<"" | "ok" | "show">("");
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener("pins-synced", on);
    return () => window.removeEventListener("pins-synced", on);
  }, []);
  useEffect(() => {
    if (!server) return;
    setKv("checking");
    fetch(server + "/")
      .then((r) => r.json())
      .then((r) => setKv(r.pins ? "ok" : "nokv"))
      .catch(() => setKv("fail"));
  }, [server]);
  const st = widget.syncStatus();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(widget.scriptableCode());
      setCopied("ok");
    } catch {
      setCopied("show");
    }
  };

  return (
    <div className="panel">
      <p className="muted small">할 일 목록에서 압정 버튼을 누른 할 일이 아이폰 잠금 화면 위젯에 떠요. 지금 고정한 할 일은 {pinnedCount}개예요.</p>
      {!server ? (
        <>
          <p>먼저 구글 캘린더 설정에서 연결 유지 서버 주소를 넣어 주세요. 위젯도 같은 서버를 써요.</p>
          <button className="secondary" onClick={onGoCalendar}>구글 캘린더 설정으로</button>
        </>
      ) : (
        <>
          <div className={`keybox ${kv === "ok" && st.state !== "fail" ? "on" : ""}`}>
            <span className="dot-big" />
            <div className="grow">
              <strong>
                {kv === "checking"
                  ? "서버 확인 중…"
                  : kv === "nokv"
                    ? "서버 코드가 예전 버전이거나 저장소(PINS)가 연결되지 않았어요"
                    : kv === "fail"
                      ? "서버에 접속이 안 돼요"
                      : st.state === "fail"
                        ? `목록을 올리지 못했어요 (${st.code === 0 ? "접속 실패" : `오류 ${st.code}`})`
                        : st.state === "ok"
                          ? "고정 목록을 서버에 올렸어요"
                          : "위젯에 보낼 준비가 됐어요"}
              </strong>
              {st.at && <span className="muted small">마지막으로 올린 시각 {new Date(st.at).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}</span>}
            </div>
          </div>
          <h3>설치 순서</h3>
          <ol className="steps">
            <li>Cloudflare에서 서버 코드를 새 버전으로 바꾸고, 저장소(KV)를 <b>PINS</b>라는 이름으로 연결해요. 자세한 순서는 안내 문서에 있어요.</li>
            <li>앱 스토어에서 무료 앱 <b>Scriptable</b>을 설치해요.</li>
            <li>아래 버튼으로 위젯 코드를 복사하고, Scriptable에서 + 를 눌러 붙여 넣은 뒤 이름을 "클론"으로 저장해요.</li>
            <li>잠금 화면을 길게 눌러 <b>사용자화 → 잠금 화면 → 위젯 추가 → Scriptable</b>을 고르고, 위젯을 눌러 Script를 "클론"으로 골라요.</li>
          </ol>
          <button className="secondary" onClick={() => widget.resendPins(items)}>고정 목록 지금 다시 보내기</button>
          <button onClick={copy}>위젯 코드 복사</button>
          {copied === "ok" && <p className="check ok">복사했어요. Scriptable에 붙여 넣어 주세요.</p>}
          {copied === "show" && <textarea className="code" readOnly value={widget.scriptableCode()} onFocus={(e) => e.currentTarget.select()} />}
          <p className="muted small">잠금 화면 위젯은 아이폰이 정한 때에 새로 고쳐져서, 고정을 바꾸고 위젯에 반영되기까지 몇 분에서 길게는 십여 분 걸릴 수 있어요. 위젯 코드에는 내 목록을 여는 비밀 주소가 들어 있으니 다른 사람에게 보내지 마세요.</p>
        </>
      )}
    </div>
  );
}

function DataSettings({ items, setItems }: { items: Item[]; setItems: (fn: (a: Item[]) => Item[]) => void }) {
  const [lost, setLost] = useState<(Item & { seenAt: number })[] | null>(null);
  useEffect(() => {
    backup.missing(items).then(setLost, () => setLost([]));
  }, [items]);
  const restore = (it: Item & { seenAt: number }) => {
    const { seenAt: _, ...item } = it;
    void _;
    // 캘린더 일정이 지워졌을 수 있으니 다시 만들도록 연결 표시는 지운다
    setItems((a) => (a.some((x) => x.id === item.id) ? a : [{ ...item, calendarEventId: undefined, calSynced: "", updatedAt: Date.now() }, ...a]));
    toast(`'${item.title}' 할 일을 되살렸어요`);
  };
  const when = (t: number) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <>
    <div className="panel">
      <strong>목록에서 빠진 할 일</strong>
      <p className="muted small">이 기기에 자동으로 남겨 둔 백업에 있는데 지금 목록에는 없는 할 일이에요. 직접 지운 할 일도 여기 보여요.</p>
      {lost === null ? (
        <p className="muted small">찾는 중…</p>
      ) : lost.length === 0 ? (
        <p className="muted small">빠진 할 일이 없어요.</p>
      ) : (
        <ul className="restore-list">
          {lost.map((it) => (
            <li key={it.id}>
              <span className="grow">
                <strong>{it.title}</strong>
                <span className="muted small">{[it.due && dueLabel(it.due), `${when(it.seenAt)}까지 있었음`].filter(Boolean).join(" · ")}</span>
              </span>
              <button className="secondary" onClick={() => restore(it)}>되살리기</button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
    </>
  );
}

/* ---------------- 캘린더 ---------------- */

// 캘린더 일정 하나를 클론과 대화할 수 있는 항목 모양으로 만든다. 제목·시간은 항상 구글 일정 기준.
function eventChatItem(ev: CalEvent, saved?: Item): Item {
  const note = ["[구글 캘린더 일정]", ev.location && `장소: ${ev.location}`, ev.description && ev.description !== "클론 앱에서 추가한 할 일" ? ev.description : ""].filter(Boolean).join("\n");
  return {
    id: "ev_" + ev.id,
    title: ev.title,
    note,
    due: ev.date,
    time: ev.time || undefined,
    endDate: ev.endDate && ev.endDate !== ev.date ? ev.endDate : undefined,
    endTime: ev.time && ev.endTime ? ev.endTime : undefined,
    done: false,
    createdAt: saved?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    subtasks: saved?.subtasks ?? [],
    chat: saved?.chat ?? [],
    calendarEventId: ev.id,
  };
}

// 일정 화면의 세부 업무·대화가 들어 있는 곳
type EventHost = { item: Item; linked: boolean; update: (fn: (it: Item) => Item) => void; onOpenSub: (subId: string) => void; onChat: (initial?: string) => void };

type DayEntry = { key: string; title: string; time: string; endTime: string; kind: "google" | "todo"; itemId?: string; ev?: CalEvent; color?: string; start: string; end: string };
// 날짜 문자열(YYYY-MM-DD) 하루씩 더하기
const addDay = (d: string, n: number) => {
  const x = new Date(d + "T00:00:00");
  x.setDate(x.getDate() + n);
  return ymd(x);
};
const shortDay = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
// 구글에서 색을 정한 일정은 그 색으로 칠한다
// 일정 색을 따로 안 고른 일정은 그 캘린더(그룹) 색으로. 기본 캘린더는 앱 기본 색 그대로.
const calColor = (calId?: string) => {
  const c = gcal.calendarOf(calId);
  return c && !c.primary ? c.color : undefined;
};
const evColor = (e: DayEntry) => (e.color ? ({ "--ev": e.color } as React.CSSProperties) : undefined);

/* 구글 일정 편집: 구글 캘린더 앱의 편집 화면과 같은 항목(제목, 종일, 시작/종료, 위치, 설명) */
function EventEditor({
  ev,
  chat,
  onClose,
  onSaved,
  onAddTodo,
  onChat,
  todoId,
  onSavedEdit,
  isNew,
  onChanged,
  host,
  backLabel = "캘린더",
}: {
  ev: CalEvent;
  chat: Msg[];
  onClose: () => void;
  onSaved: () => void;
  onAddTodo: () => void;
  onChat: (initial?: string) => void;
  todoId?: string; // 이 일정과 이어진 할 일 (이 기기에 있을 때)
  onSavedEdit: (d: gcal.EventEdit) => void;
  isNew?: boolean; // 달력에서 날짜를 눌러 새 일정을 만드는 중
  onChanged?: () => void; // 화면을 닫지 않고 바로 바꾼 내용이 있을 때 (캘린더 옮기기)
  host?: EventHost; // 세부 업무를 담는 쪽 (이어진 할 일, 아니면 일정 대화용 항목)
  backLabel?: string;
}) {
  const [original, setOriginal] = useState<gcal.EventEdit>(() => ({
    title: ev.title,
    due: ev.date,
    time: ev.time || undefined,
    endDate: ev.endDate,
    endTime: ev.endTime || undefined,
    location: ev.location,
    description: ev.description,
    colorId: ev.colorId,
    calendarId: ev.calendarId ?? gcal.calendarOf()?.id,
  }));
  const [d, setD] = useState<gcal.EventEdit>({
    title: ev.title,
    due: ev.date,
    time: ev.time || undefined,
    endDate: ev.endDate,
    endTime: ev.endTime || undefined,
    location: ev.location,
    description: ev.description,
    colorId: ev.colorId,
    calendarId: ev.calendarId ?? gcal.calendarOf()?.id,
  });
  const cal = gcal.calendarOf(d.calendarId);
  // 할 일과 이어진 일정의 첨부 파일은 할 일 쪽에 들어 있다 (할 일에 추가할 때 옮겨 둠)
  const filesOwner = host?.linked ? host.item.id : ev.id;
  // 휴일 캘린더처럼 읽기만 되는 캘린더의 일정은 고칠 수 없다
  const readOnly = !isNew && !!gcal.calendarOf(ev.calendarId) && !gcal.calendarOf(ev.calendarId)!.writable;
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(!!isNew);
  const [confirmDel, setConfirmDel] = useState(false);
  // 수정 화면에서 뒤로 가면 고친 내용은 버리고 원래 일정 화면으로 돌아간다
  const cancelEdit = () => {
    setEditing(false);
    setD(original);
  };
  // 휴대폰 뒤로가기(제스처)도 수정만 끝내고 일정 화면에 머물게 기록을 하나 쌓아 둔다
  useEffect(() => {
    if (!editing || isNew) return;
    history.pushState({ evEdit: true }, "");
    const onPop = () => cancelEdit();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (history.state?.evEdit) history.back();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  // 일정 화면에서 캘린더 줄을 눌러 바로 다른 캘린더로 옮긴다
  const [pickCal, setPickCal] = useState(false);
  const moveTo = async (calId: string) => {
    setPickCal(false);
    const from = d.calendarId ?? gcal.calendarOf()?.id;
    if (!from || calId === from) return;
    // 화면은 바로 바꾸고 구글에는 뒤에서 옮긴다. 실패하면 되돌린다.
    const prev = d;
    const next = { ...d, calendarId: calId };
    setD(next);
    setOriginal(next);
    try {
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (!token) throw new Error("구글 캘린더 연결이 끝났어요. 다시 연결해 주세요.");
      await gcal.moveEvent(token, ev.id, from, calId, ev.itemId ?? todoId);
      onSavedEdit(next);
      onChanged?.();
    } catch (e) {
      setD(prev);
      setOriginal(prev);
      toast(`캘린더를 옮기지 못했어요: ${(e as Error).message}`);
    }
  };
  // 일정 화면에서 항목을 눌러 바로 고친 내용은 잠깐 뒤(또는 칸을 벗어날 때) 구글 캘린더에 저장한다
  const [pickTime, setPickTime] = useState(false);
  const quick = !editing && !isNew && !readOnly;
  const same = (a: gcal.EventEdit, b: gcal.EventEdit) => JSON.stringify(a) === JSON.stringify(b);
  const savedRef = useRef(original);
  savedRef.current = original;
  const pending = useRef<gcal.EventEdit | null>(null);
  const quickSave = async (next: gcal.EventEdit) => {
    pending.current = null;
    const prev = savedRef.current;
    if (!next.title.trim() || same(next, prev)) return;
    savedRef.current = next;
    setOriginal(next);
    try {
      const token = gcal.savedToken() ?? (await gcal.renew());
      if (!token) throw new Error("구글 캘린더 연결이 끝났어요. 다시 연결해 주세요.");
      await gcal.updateEvent(token, ev.id, next, next.calendarId ?? ev.calendarId);
      onSavedEdit(next);
      onChanged?.();
    } catch (e) {
      savedRef.current = prev;
      setOriginal(prev);
      toast(`구글 캘린더에 저장하지 못했어요: ${(e as Error).message}`);
    }
  };
  const flush = () => pending.current && quickSave(pending.current);
  useEffect(() => {
    if (!quick || same(d, original)) return void (pending.current = null);
    pending.current = d;
    const t = setTimeout(() => quickSave(d), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, quick]);
  // 저장 전에 화면을 닫으면 그때 저장
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => void flush(), []);
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
    <section className="detail event-edit" onClick={() => (setMenu(false), setConfirmDel(false))}>
      <header className="page-head">
        {editing && !isNew ? (
          <button className="back" onClick={cancelEdit}>
            <IconBack />
            일정
          </button>
        ) : (
          <button className="back" onClick={onClose}>
            <IconBack />
            {backLabel}
          </button>
        )}
        <div className="head-actions">
          {!editing && <ChatIconButton count={Math.max(0, chat.length - seenCount(host?.item.id ?? "ev_" + ev.id))} onClick={() => onChat()} label="이 일정에 대해 클론과 대화" />}
          {!isNew && !readOnly && (
          <div className="menu-wrap">
            <button className="icon-btn" aria-label="더 보기" onClick={(e) => (e.stopPropagation(), setMenu(!menu), setConfirmDel(false))}>
              <IconMore />
            </button>
            {menu && (
              <div className="popover" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => (setEditing(!editing), setMenu(false))}>{editing ? "수정 끝내기" : "수정"}</button>
                {host?.linked && (
                  <button onClick={() => (host.update((it) => ({ ...it, done: !it.done })), setMenu(false))}>{host.item.done ? "완료 취소" : "완료로 표시"}</button>
                )}
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    if (!confirmDel) return setConfirmDel(true);
                    setMenu(false);
                    run(async (t) => {
                      await gcal.deleteEvent(t, ev.id, ev.calendarId);
                      await files.removeOwner(ev.id).catch(() => {});
                    }, "일정을 삭제했어요");
                  }}
                >
                  {confirmDel ? "한 번 더 누르면 삭제" : "일정 삭제"}
                </button>
              </div>
            )}
          </div>
          )}
          {editing && (
            <button
              onClick={() =>
                isNew
                  ? run((t) => gcal.createEvent(t, d), "캘린더에 일정을 추가했어요")
                  : run(async (t) => {
                      // 다른 캘린더(그룹)를 골랐으면 먼저 그 캘린더로 옮기고 내용을 고친다
                      const from = ev.calendarId ?? gcal.calendarOf()?.id;
                      if (d.calendarId && from && d.calendarId !== from) await gcal.moveEvent(t, ev.id, from, d.calendarId, ev.itemId ?? todoId);
                      await gcal.updateEvent(t, ev.id, d, d.calendarId ?? ev.calendarId);
                      onSavedEdit(d);
                    }, "구글 캘린더에 저장했어요")
              }
              disabled={busy || !d.title.trim()}
            >
              저장
            </button>
          )}
        </div>
      </header>
      {editing ? (
        <>
          <input className="title-input" placeholder="제목 추가" autoFocus={isNew} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
          <div className="fields">
            <ScheduleEditor item={d} update={(fn) => setD(fn)} noClear />
            <div className="field memo">
              <input placeholder="위치 추가" value={d.location} onChange={(e) => setD({ ...d, location: e.target.value })} />
            </div>
            <div className="field memo">
              <textarea placeholder="메모 추가" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
            </div>
          </div>
          <EditPanel
            onDone={() => {
              if (isNew) return onClose();
              cancelEdit();
            }}
            doneLabel="취소"
            title={isNew ? "새 일정" : "수정"}
            hint={isNew ? "오른쪽 위 저장을 누르면 구글 캘린더에 추가돼요. 첨부 파일은 저장한 뒤 넣을 수 있어요." : "바꾼 내용은 오른쪽 위 저장을 눌러야 구글 캘린더에 반영돼요."}
          >
            <div className="fields">
              <CalendarField value={d.calendarId} onChange={(c) => setD({ ...d, calendarId: c })} />
              <ColorField value={d.colorId} onChange={(c) => setD({ ...d, colorId: c })} />
            </div>
            {!isNew && <EventFiles owner={filesOwner} editable />}
          </EditPanel>
        </>
      ) : (
        <>
          <InlineTitle value={d.title} onChange={(title) => setD({ ...d, title })} onDone={flush} readOnly={readOnly} placeholder="제목 추가">
            {todoId && <span className="todo-dot" aria-label="할 일" />}
            {d.title || "(제목 없음)"}
            {host?.linked && host.item.done && <span className="pill-done">완료</span>}
          </InlineTitle>
          <div className="fields event-info">
            <button className="field tap-field" onClick={(e) => (e.stopPropagation(), !readOnly && (pickTime && flush(), setPickTime(!pickTime)))} aria-label="시간 수정" aria-expanded={pickTime}>
              <span className="info-label">일정</span>
              <span className="grow">{schedText(d)}</span>
              {!readOnly && <span className={`chev${pickTime ? " open" : ""}`}><IconRight /></span>}
            </button>
            {pickTime && (
              <div className="inline-sched" onClick={(e) => e.stopPropagation()}>
                <ScheduleEditor item={d} update={(fn) => setD(fn)} noClear />
              </div>
            )}
            {cal && gcal.cachedCalendars().length > 1 && (
              <>
                <button className="field tap-field" disabled={busy} onClick={(e) => (e.stopPropagation(), !readOnly && setPickCal(!pickCal))} aria-label="캘린더 바꾸기" aria-expanded={pickCal}>
                  <span className="info-label">캘린더</span>
                  <span className="grow cal-name">
                    <span className="swatch tiny" style={{ background: cal.color }} />
                    {cal.name}
                    {readOnly && <span className="muted small"> · 읽기 전용</span>}
                  </span>
                  {!readOnly && <span className={`chev${pickCal ? " open" : ""}`}><IconRight /></span>}
                </button>
                {pickCal && (
                  <div className="field cal-pick">
                    <div className="cal-chips" role="radiogroup" aria-label="캘린더">
                      {gcal.cachedCalendars().filter((c) => c.writable).map((c) => (
                        <button type="button" role="radio" key={c.id} aria-checked={cal.id === c.id} className={`cal-chip${cal.id === c.id ? " on" : ""}`} onClick={(e) => (e.stopPropagation(), moveTo(c.id))}>
                          <span className="swatch tiny" style={{ background: c.color }} />
                          {c.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            <InlineText label="위치" value={d.location} onChange={(location) => setD({ ...d, location })} onDone={flush} placeholder="위치 추가" empty="위치 추가" readOnly={readOnly} />
            <InlineText label="메모" value={d.description} onChange={(description) => setD({ ...d, description })} onDone={flush} multiline placeholder="메모 추가" empty="메모 추가" readOnly={readOnly} />
          </div>
        </>
      )}
      {!editing && !isNew && host && (host.linked || host.item.subtasks.length > 0) && <SubtaskSection item={host.item} update={host.update} onOpenSub={host.onOpenSub} />}
      {!editing && <EventFiles owner={filesOwner} />}
      {!isNew && !todoId && (
        <button className="wide add-todo" disabled={busy} onClick={onAddTodo}>
          할 일에 추가
        </button>
      )}
    </section>
  );
}

/* 일정·세부 업무 화면 위쪽의 클론 대화 버튼. 아직 안 본 메시지 수를 작은 숫자로 보여 준다. */
function ChatIconButton({ count, onClick, label }: { count: number; onClick: () => void; label: string }) {
  return (
    <button className="icon-btn chat-icon" aria-label={label} onClick={(e) => (e.stopPropagation(), onClick())}>
      <IconChat />
      {count > 0 && <span className="badge">{count > 99 ? "99+" : count}</span>}
    </button>
  );
}

/* 세부 업무 화면: 일정 화면과 같은 구성. 평소엔 보기만, ⋯ → 수정에서 제목·메모·첨부를 바꾼다. */
function SubtaskView(props: { item: Item; sub: Subtask; update: (fn: (it: Item) => Item) => void; onChat: () => void; onBack: () => void }) {
  const { item, sub } = props;
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [pickTime, setPickTime] = useState(false);
  const set = (patch: Partial<Subtask>) =>
    props.update((it) => ({ ...it, subtasks: it.subtasks.map((x) => (x.id === sub.id ? { ...x, ...patch } : x)) }));
  const toggle = () => set({ done: !sub.done });
  const remove = () => {
    files.removeOwner(sub.id).catch(() => {});
    props.update((it) => ({ ...it, subtasks: it.subtasks.filter((x) => x.id !== sub.id) }));
    props.onBack();
  };
  const chat = sub.chat ?? [];
  return (
    <section className="detail event-edit" onClick={() => (setMenu(false), setConfirmDel(false))}>
      <header className="page-head">
        <button className="back" onClick={props.onBack}>
          <IconBack />
          {item.title.length > 12 ? item.title.slice(0, 12) + "…" : item.title}
        </button>
        <div className="head-actions">
          {!editing && <ChatIconButton count={Math.max(0, chat.length - seenCount(sub.id))} onClick={props.onChat} label="이 세부 업무에 대해 클론과 대화" />}
          <div className="menu-wrap">
            <button className="icon-btn" aria-label="더 보기" onClick={(e) => (e.stopPropagation(), setMenu(!menu), setConfirmDel(false))}>
              <IconMore />
            </button>
            {menu && (
              <div className="popover" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => (setEditing(!editing), setMenu(false))}>{editing ? "수정 끝내기" : "수정"}</button>
                <button onClick={() => (toggle(), setMenu(false))}>{sub.done ? "완료 취소" : "완료로 표시"}</button>
                <button className="danger" onClick={() => (confirmDel ? remove() : setConfirmDel(true))}>
                  {confirmDel ? "한 번 더 누르면 삭제" : "세부 업무 삭제"}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {editing ? (
        <>
          <input className="title-input" placeholder="세부 업무 이름" value={sub.title} onChange={(e) => set({ title: e.target.value })} />
          <div className="fields">
            <ScheduleEditor item={{ due: sub.due ?? "", time: sub.time, endDate: sub.endDate, endTime: sub.endTime }} update={(fn) => set(fn({ due: sub.due ?? "", time: sub.time, endDate: sub.endDate, endTime: sub.endTime }))} />
            <div className="field memo">
              <textarea placeholder="메모 추가" value={sub.note ?? ""} onChange={(e) => set({ note: e.target.value })} />
            </div>
          </div>
          <EditPanel onDone={() => setEditing(false)}>
            <EventFiles owner={sub.id} editable />
          </EditPanel>
        </>
      ) : (
        <>
          <InlineTitle value={sub.title} onChange={(title) => set({ title })} placeholder="세부 업무 이름" className={sub.done ? "is-done" : ""}>
            {sub.title || "(이름 없음)"}
            {sub.done && <span className="pill-done">완료</span>}
          </InlineTitle>
          <div className="fields event-info">
            <button className="field tap-field" onClick={(e) => (e.stopPropagation(), setPickTime(!pickTime))} aria-label="일정 수정" aria-expanded={pickTime}>
              <span className="info-label">일정</span>
              <span className={`grow ${sub.due ? "" : "muted"}`}>{sub.due ? schedText(sub as Sched) : "일정 추가"}</span>
              <span className={`chev${pickTime ? " open" : ""}`}><IconRight /></span>
            </button>
            {pickTime && (
              <div className="inline-sched" onClick={(e) => e.stopPropagation()}>
                <ScheduleEditor item={{ due: sub.due ?? "", time: sub.time, endDate: sub.endDate, endTime: sub.endTime }} update={(fn) => set(fn({ due: sub.due ?? "", time: sub.time, endDate: sub.endDate, endTime: sub.endTime }))} />
              </div>
            )}
            <InlineText label="메모" value={sub.note ?? ""} onChange={(note) => set({ note })} multiline placeholder="메모 추가" empty="메모 추가" />
          </div>
          <EventFiles owner={sub.id} />
        </>
      )}
    </section>
  );
}

/* ⋯ → 수정을 눌렀을 때만 보이는 칸 (색, 첨부 파일) */
function EditPanel({ children, onDone, hint, doneLabel = "완료", title = "수정" }: { children: React.ReactNode; onDone: () => void; hint?: string; doneLabel?: string; title?: string }) {
  return (
    <div className="edit-panel">
      <div className="section-head">
        <h3>{title}</h3>
        <button className="btn small tonal" onClick={onDone}>
          {doneLabel}
        </button>
      </div>
      {children}
      {hint && <p className="muted small hint">{hint}</p>}
    </div>
  );
}

/* 일정이 들어갈 구글 캘린더(그룹) 고르기. 쓸 수 있는 캘린더만 */
function CalendarField({ value, onChange }: { value?: string; onChange: (calId: string) => void }) {
  const list = gcal.cachedCalendars().filter((c) => c.writable);
  if (list.length < 2) return null;
  return (
    <div className="field cal-field">
      <span className="color-label">캘린더</span>
      <div className="cal-chips" role="radiogroup" aria-label="캘린더">
        {list.map((c) => (
          <button type="button" role="radio" key={c.id} aria-checked={value === c.id} className={`cal-chip${value === c.id ? " on" : ""}`} onClick={() => onChange(c.id)}>
            <span className="swatch tiny" style={{ background: c.color }} />
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/* 캘린더 일정 색 고르기 (구글 캘린더 색과 같음). undefined = 캘린더 기본 색 */
function ColorField({ value, onChange }: { value?: string; onChange: (colorId: string | undefined) => void }) {
  return (
    <div className="field color-field">
      <span className="color-label">
        <span className="swatch" style={{ background: gcal.colorHex(value) ?? "var(--accent)" }} />
        {gcal.EVENT_COLORS.find((c) => c.id === value)?.name ?? "캘린더 기본 색"}
      </span>
      <div className="swatches" role="radiogroup" aria-label="일정 색">
        <button type="button" role="radio" aria-checked={!value} aria-label="캘린더 기본 색" className={`swatch default${!value ? " on" : ""}`} onClick={() => onChange(undefined)} />
        {gcal.EVENT_COLORS.map((c) => (
          <button type="button" role="radio" key={c.id} aria-checked={value === c.id} aria-label={c.name} title={c.name} className={`swatch${value === c.id ? " on" : ""}`} style={{ background: c.hex }} onClick={() => onChange(c.id)} />
        ))}
      </div>
    </div>
  );
}

/* 일정별 첨부 파일: 이 기기에 보관하고 눌러서 연다 */
function EventFiles({ owner, editable }: { owner: string; editable?: boolean }) {
  const [list, setList] = useState<(files.Attachment & { url: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // 파일을 여는 임시 주소(blob:)는 목록을 새로 읽거나 화면을 떠날 때 정리
  const listRef = useRef(list);
  const reload = useCallback(() => {
    files
      .list(owner)
      .then((all) => {
        listRef.current.forEach((a) => URL.revokeObjectURL(a.url));
        listRef.current = all.map((a) => ({ ...a, url: URL.createObjectURL(a.blob) }));
        setList(listRef.current);
      })
      .catch((e) => toast((e as Error).message));
  }, [owner]);
  useEffect(reload, [reload]);
  useEffect(() => () => listRef.current.forEach((a) => URL.revokeObjectURL(a.url)), []);

  const addFiles = async (fl: FileList | null) => {
    if (!fl?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(fl)) await files.add(owner, f);
      toast(fl.length > 1 ? `파일 ${fl.length}개를 첨부했어요` : "파일을 첨부했어요");
    } catch (e) {
      toast((e as Error).message || "파일을 저장하지 못했어요.");
    } finally {
      setBusy(false);
      reload();
    }
  };

  // 수정 중이 아니면 첨부된 파일을 열어 보기만 한다 (없으면 칸도 숨김)
  if (!editable && list.length === 0) return null;
  return (
    <div className="ev-files">
      <div className="section-head">
        <h3>첨부 파일</h3>
        {editable && <label className={`filebtn small-btn${busy ? " busy" : ""}`}>
          <IconClip />
          {busy ? "올리는 중" : "파일 추가"}
          <input
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>}
      </div>
      {list.length === 0 ? (
        <p className="muted small empty-files">관련 문서나 사진을 올려 두면 여기서 바로 열어볼 수 있어요.</p>
      ) : (
        <ul className="threads file-list">
          {list.map((a) => (
            <li key={a.id}>
              <a className="file-open" href={a.url} target="_blank" rel="noopener" download={/^(image|video|audio|text)\/|pdf$/.test(a.type) ? undefined : a.name}>
                <span className="file-ico">
                  {a.type.startsWith("image/") ? <img src={a.url} alt="" /> : <span>{(a.name.split(".").pop() || "파일").slice(0, 4).toUpperCase()}</span>}
                </span>
                <span className="grow">
                  <strong>{a.name}</strong>
                  <span className="preview">
                    {files.sizeLabel(a.size)} · {new Date(a.added).toLocaleDateString("ko-KR")}
                  </span>
                </span>
              </a>
              {editable && <button
                className={`icon-btn file-del${confirmId === a.id ? " confirm" : ""}`}
                aria-label={confirmId === a.id ? "한 번 더 누르면 삭제" : "첨부 파일 삭제"}
                onClick={() => {
                  if (confirmId !== a.id) return setConfirmId(a.id);
                  files
                    .remove(a.id)
                    .then(() => toast("첨부 파일을 지웠어요"))
                    .catch((e) => toast((e as Error).message))
                    .finally(reload);
                }}
                onBlur={() => setConfirmId(null)}
              >
                {confirmId === a.id ? <IconTrash /> : <IconClose />}
              </button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ymd = (d: Date) => d.toLocaleDateString("sv-SE");
// 할 일이 캘린더에 마지막으로 반영된 모양 (바뀌었는지 비교용)
const syncKey = (it: Item) =>
  it.due ? `${it.title}|${it.due}|${it.time ?? ""}|${it.endDate ?? ""}|${it.endTime ?? ""}${it.colorId !== undefined ? `|c${it.colorId}` : ""}` : "";
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

// 달력에 보이는 6주(앞뒤 달 일부 포함) 칸
function monthCells(month: Date): Date[] {
  const gridStart = new Date(month);
  gridStart.setDate(1 - month.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}
const monthRangeEnd = (cells: Date[]) => new Date(cells[41].getTime() + 86400000);

function CalendarView(props: {
  items: Item[];
  gToken: string | null;
  calOn: boolean;
  linked: boolean;
  onConnect: () => void;
  eventChats: Record<string, Item>;
  reopen: CalEvent | null;
  onOpen: (id: string) => void;
  onAddTodo: (ev: CalEvent) => void;
  onChat: (ev: CalEvent, initial?: string) => void;
  onEventSaved: (ev: CalEvent, d: gcal.EventEdit) => void;
  onGoSettings: () => void;
  onCalendarsChanged: () => void;
  hostFor: (ev: CalEvent) => EventHost;
  onMoveTodo: (itemId: string, days: number) => void;
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
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<CalEvent | null>(props.reopen);
  // 날짜를 골라 새 일정을 만드는 중이면 그 날짜
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("calMode", mode);
    } catch {
      /* 무시 */
    }
  }, [mode]);

  const cells = monthCells(month);
  const rangeFrom = mode === "month" ? cells[0] : new Date(new Date().setHours(0, 0, 0, 0));
  const rangeTo = mode === "month" ? monthRangeEnd(cells) : new Date(rangeFrom.getTime() + 30 * 86400000);
  const rangeKey = `${ymd(rangeFrom)}~${ymd(rangeTo)}`;

  // 이 기기에 저장해 둔 일정을 바로 보여 주고, 구글에서 새로 받아 오면 바꾼다.
  // (예전에는 탭을 열 때마다 빈 달력으로 시작해서 받아 올 때까지 일정이 안 보였다.)
  const fromCache = () => gcal.cached(rangeFrom, rangeTo) ?? [];
  const [shown, setShown] = useState(() => ({ key: rangeKey, events: fromCache() }));
  // 달을 넘기면 그 달의 저장본으로 즉시 바꾼다 (그리는 중에 바로 바꿔서 빈 화면이 한 번도 안 보이게).
  if (shown.key !== rangeKey) setShown({ key: rangeKey, events: fromCache() });
  // 구글 캘린더 목록(그룹)별로 달력에서 바로 켜고 끈다. 끈 캘린더 일정은 바로 숨긴다.
  const [cals, setCals] = useState(gcal.cachedCalendars());
  const [pickCals, setPickCals] = useState(false); // 캘린더 목록 칩은 버튼을 눌렀을 때만 펼친다
  const hidden = new Set(cals.filter((c) => !c.shown).map((c) => c.id));
  const events = shown.events.filter((e) => !e.calendarId || !hidden.has(e.calendarId));

  const latest = useRef(rangeKey);
  latest.current = rangeKey;
  const load = useCallback(() => {
    if (!props.gToken) return;
    const key = rangeKey;
    const token = props.gToken;
    setLoading(true);
    gcal
      .range(token, rangeFrom, rangeTo)
      .then((evs) => {
        // 받아 오는 사이에 다른 달로 넘어갔으면 이 결과는 저장만 하고 화면에는 안 쓴다.
        if (latest.current === key) setShown({ key, events: evs });
        setCals(gcal.cachedCalendars());
      })
      .catch((e) => toast((e as Error).message))
      .finally(() => latest.current === key && setLoading(false));
    // 앞뒤 달도 미리 받아 둬서 달을 넘길 때 바로 보이게 한다.
    if (mode === "month")
      for (const n of [-1, 1]) {
        const c = monthCells(new Date(month.getFullYear(), month.getMonth() + n, 1));
        const to = monthRangeEnd(c);
        if (!gcal.isFresh(c[0], to, 5 * 60_000)) gcal.range(token, c[0], to).catch(() => {});
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.gToken, rangeKey]);
  useEffect(load, [load]);
  const toggleCal = (id: string, on: boolean) => {
    gcal.setShown(id, on);
    setCals(gcal.cachedCalendars());
    load(); // 켠 캘린더 일정을 받아 온다
    props.onCalendarsChanged();
  };

  // 구글 일정 + 아직 캘린더에 안 올라간 할 일(연결 전이거나 올리는 중)
  const byDay = new Map<string, DayEntry[]>();
  // 여러 날에 걸친 일정은 걸친 날마다 넣는다 (아래 날짜별 목록용). 달력에서는 한 줄로 이어 그린다.
  const push = (_d: string, e: DayEntry) => {
    for (let d = e.start, n = 0; d <= e.end && n < 62; d = addDay(d, 1), n++) byDay.set(d, [...(byDay.get(d) ?? []), e]);
  };
  const entries: DayEntry[] = [];
  // 일정에 할 일 표시가 빠져 있어도(다른 캘린더로 옮긴 직후 등) 할 일 쪽에 적힌 일정 id로 이어 준다 → 같은 일정이 두 번 안 보이게
  const itemOfEvent = new Map(props.items.filter((i) => i.calendarEventId).map((i) => [i.calendarEventId!, i.id]));
  for (const e of events) {
    const itemId = e.itemId ?? itemOfEvent.get(e.id);
    const en: DayEntry = { key: e.id, title: e.title, time: e.time, endTime: e.endTime, kind: itemId ? "todo" : "google", itemId, ev: itemId && !e.itemId ? { ...e, itemId } : e, color: gcal.colorHex(e.colorId) ?? calColor(e.calendarId), start: e.date, end: e.endDate && e.endDate > e.date ? e.endDate : e.date };
    entries.push(en);
    push(e.date, en);
  }
  const synced = new Set(events.map((e) => e.itemId ?? itemOfEvent.get(e.id)).filter(Boolean));
  for (const it of props.items)
    if (it.due && !it.done && !synced.has(it.id)) {
      const end = itemEnd(it).date;
      const en: DayEntry = { key: it.id, title: it.title, time: it.time ?? "", endTime: "", kind: "todo", itemId: it.id, color: gcal.colorHex(it.colorId), start: it.due, end: end > it.due ? end : it.due };
      entries.push(en);
      push(it.due, en);
    }
  // 여러 날 일정을 먼저(길수록 위), 그다음 시간 순
  const order = (a: DayEntry, b: DayEntry) => {
    const la = a.end > a.start ? 1 : 0, lb = b.end > b.start ? 1 : 0;
    return lb - la || a.start.localeCompare(b.start) || b.end.localeCompare(a.end) || (a.time || "00:00").localeCompare(b.time || "00:00");
  };
  // 목록에서 꾹 눌러 끌어 바꾼 같은 날 안의 순서 (이 기기에만 저장). 달력 칸의 하루짜리 일정도 이 순서를 따른다.
  const [dayOrder, setDayOrder] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem("evOrder") ?? "{}");
    } catch {
      return {};
    }
  });
  const saveOrder = (day: string, keys: string[]) => {
    // 지난 날 순서는 버려서 저장 크기가 계속 늘지 않게 한다
    const next = Object.fromEntries(Object.entries({ ...dayOrder, [day]: keys }).filter(([d]) => d >= addDay(today, -31)));
    setDayOrder(next);
    try {
      localStorage.setItem("evOrder", JSON.stringify(next));
    } catch {
      /* 무시 */
    }
  };
  const rankOf = (day: string, key: string) => dayOrder[day]?.indexOf(key) ?? -1;
  const orderIn = (a: DayEntry, b: DayEntry) => {
    if (a.start === a.end && b.start === b.end && a.start === b.start) {
      const ra = rankOf(a.start, a.key), rb = rankOf(b.start, b.key);
      if (ra >= 0 && rb >= 0) return ra - rb;
    }
    return order(a, b);
  };
  for (const [d, list] of byDay) {
    list.sort(order);
    const custom = dayOrder[d];
    if (!custom) continue;
    const def = new Map(list.map((e, i) => [e.key, i]));
    const rk = (e: DayEntry) => (custom.includes(e.key) ? custom.indexOf(e.key) : custom.length + def.get(e.key)!);
    list.sort((a, b) => rk(a) - rk(b));
  }

  // 목록 칩을 꾹 눌러(0.45초) 위아래로 끌기: 같은 날 안이면 순서만, 다른 날에 놓으면 그만큼 날짜를 옮긴다.
  // gy: 칩 안에서 잡은 높이, left/width: 칩 원래 가로 위치 (끄는 동안 칩은 화면에 고정해 손가락을 따라간다)
  type Drag = { key: string; day: string; gy: number; left: number; width: number; y: number; x: number; target: { day: string; index: number } | null };
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
  const justDragged = useRef(false);
  const byDayRef = useRef(byDay);
  byDayRef.current = byDay;
  const findTarget = (x: number, y: number): Drag["target"] => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".day-panel[data-day]");
    if (!el) return dragRef.current?.target ?? null;
    const lis = [...el.querySelectorAll<HTMLElement>(".ev[data-key]")].filter((li) => !li.classList.contains("dragging"));
    const index = lis.filter((li) => {
      const r = li.getBoundingClientRect();
      return r.top + r.height / 2 < y;
    }).length;
    return { day: el.dataset.day!, index };
  };
  const startPress = (e: DayEntry, day: string, x: number, y: number) => {
    if (mode !== "list") return;
    const li = document.elementFromPoint(x, y)?.closest<HTMLElement>(".ev");
    const t = window.setTimeout(() => {
      press.current = null;
      if (!li) return;
      const r = li.getBoundingClientRect();
      keepPanel(day);
      const d: Drag = { key: e.key, day, gy: y - r.top, left: r.left, width: r.width, y, x, target: { day, index: (byDayRef.current.get(day) ?? []).findIndex((v) => v.key === e.key) } };
      dragRef.current = d;
      setDrag(d);
      document.body.classList.add("ev-drag");
      navigator.vibrate?.(12);
    }, 450);
    press.current = { t, x, y };
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  const dropDrag = async (d: Drag) => {
    const t = d.target;
    if (!t) return;
    const list = (byDayRef.current.get(t.day) ?? []).map((v) => v.key).filter((k) => k !== d.key);
    // 같은 날: 원래 자리보다 아래로 옮기면 빠진 칸만큼 하나 당겨진다 → filter 뒤 목록 기준이라 그대로 넣으면 된다
    list.splice(Math.min(t.index, list.length), 0, d.key);
    saveOrder(t.day, list);
    if (t.day === d.day) return;
    const en = (byDayRef.current.get(d.day) ?? []).find((v) => v.key === d.key);
    if (!en) return;
    const n = Math.round((new Date(t.day + "T00:00:00").getTime() - new Date(d.day + "T00:00:00").getTime()) / 86400000);
    if (!en.ev) {
      props.onMoveTodo(en.itemId!, n);
      toast(`${shortDay(addDay(en.start, n))}로 옮겼어요`);
      return;
    }
    const ev = en.ev;
    if (gcal.calendarOf(ev.calendarId)?.writable === false) return toast("읽기 전용 캘린더라 날짜를 바꿀 수 없어요");
    const edit: gcal.EventEdit = {
      title: ev.title,
      due: addDay(ev.date, n),
      time: ev.time || undefined,
      endDate: addDay(ev.endDate || ev.date, n),
      endTime: ev.endTime || undefined,
      location: ev.location,
      description: ev.description,
      colorId: ev.colorId,
      calendarId: ev.calendarId,
    };
    // 화면에는 바로 옮겨 보이고, 구글 캘린더에는 뒤에서 저장
    setShown((s) => ({ ...s, events: s.events.map((x) => (x.id === ev.id ? { ...x, date: edit.due, endDate: edit.endDate! } : x)) }));
    try {
      const token = props.gToken ?? gcal.savedToken() ?? (await gcal.renew());
      if (!token) throw new Error("구글 캘린더 연결이 끝났어요. 다시 연결해 주세요.");
      await gcal.updateEvent(token, ev.id, edit, ev.calendarId);
      props.onEventSaved(ev, edit);
      toast(`${shortDay(edit.due)}로 옮겼어요`);
    } catch (err) {
      toast(`날짜를 옮기지 못했어요: ${(err as Error).message}`);
    }
    load();
  };
  const dropRef = useRef(dropDrag);
  dropRef.current = dropDrag;
  useEffect(() => {
    let raf = 0;
    const move = (x: number, y: number, ev?: Event) => {
      const p = press.current;
      if (p && Math.hypot(x - p.x, y - p.y) > 8) cancelPress();
      const d = dragRef.current;
      if (!d) return;
      ev?.preventDefault();
      const next = { ...d, x, y, target: findTarget(x, y) };
      dragRef.current = next;
      setDrag(next);
    };
    const end = () => {
      cancelPress();
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDrag(null);
      document.body.classList.remove("ev-drag");
      if (d.target) keepPanel(d.target.day);
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 300);
      void dropRef.current(d);
    };
    // 화면 위·아래 끝에 가까이 끌면 저절로 스크롤
    const tick = () => {
      const d = dragRef.current;
      if (d) {
        const v = d.y < 110 ? -(110 - d.y) / 5 : d.y > window.innerHeight - 150 ? (d.y - (window.innerHeight - 150)) / 5 : 0;
        if (v) {
          window.scrollBy(0, v);
          const next = { ...d, target: findTarget(d.x, d.y) };
          dragRef.current = next;
          setDrag(next);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const tm = (e: TouchEvent) => move(e.touches[0].clientX, e.touches[0].clientY, e);
    const mm = (e: MouseEvent) => move(e.clientX, e.clientY, e);
    document.addEventListener("touchmove", tm, { passive: false });
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", end);
    document.addEventListener("mousemove", mm);
    document.addEventListener("mouseup", end);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("touchmove", tm);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
      document.removeEventListener("mousemove", mm);
      document.removeEventListener("mouseup", end);
      document.body.classList.remove("ev-drag");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [slide, setSlide] = useState<"" | "next" | "prev">("");
  const shift = (n: number) => {
    setSlide(n > 0 ? "next" : "prev");
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  };
  // 달력을 손가락으로 좌우로 쓸면 다음/이전 달로 넘어간다. 쓸고 난 뒤의 탭은 날짜 선택으로 치지 않는다.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const swipeStart = (x: number, y: number) => {
    swipe.current = { x, y };
    swiped.current = false;
  };
  const swipeEnd = (x: number, y: number) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = x - s.x;
    const dy = y - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped.current = true;
      shift(dx < 0 ? 1 : -1);
    }
  };
  // 날짜를 눌렀을 때 아래 일정 목록 첫 줄까지 스크롤 없이 보이도록 달력 칸 높이를 화면에 맞춘다.
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(74);
  useLayoutEffect(() => {
    const fit = () => {
      const g = gridRef.current;
      if (!g) return;
      const top = g.getBoundingClientRect().top + window.scrollY;
      const tabs = document.querySelector(".tabs")?.getBoundingClientRect();
      const bottom = tabs ? tabs.top - 8 : window.innerHeight - 96;
      // 달력 아래: 날짜 제목과 일정 추가 버튼(약 60px) + 일정 한 줄(약 50px)
      const avail = bottom - top - 2 - 60 - 50;
      setRowH(Math.max(44, Math.min(74, Math.floor(avail / 6))));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });
  // 달력 칩 배치: 주(7칸)마다 일정을 줄(lane)에 차례로 넣는다. 칸 높이에 들어가는 줄 수만 그리고 나머지는 '+n'
  const chipCount = rowH >= 68 ? 2 : rowH >= 48 ? 1 : 0;
  const hiddenByDay = new Map<string, number>();
  const weekBars: { e: DayEntry; from: number; to: number; lane: number; contL: boolean; contR: boolean }[][] = [];
  for (let w = 0; w < cells.length / 7; w++) {
    const days = cells.slice(w * 7, w * 7 + 7).map(ymd);
    const first = days[0], last = days[6];
    const inWeek = entries.filter((e) => e.start <= last && e.end >= first).sort(orderIn);
    const used: boolean[][] = [];
    const bars: (typeof weekBars)[number] = [];
    for (const e of inWeek) {
      const from = Math.max(0, days.indexOf(e.start < first ? first : e.start));
      const to = Math.min(6, e.end > last ? 6 : days.indexOf(e.end));
      let lane = 0;
      while (used[lane]?.slice(from, to + 1).some(Boolean)) lane++;
      used[lane] ??= Array(7).fill(false);
      for (let i = from; i <= to; i++) used[lane][i] = true;
      if (lane < chipCount) bars.push({ e, from, to, lane, contL: e.start < first, contR: e.end > last });
      else for (let i = from; i <= to; i++) hiddenByDay.set(days[i], (hiddenByDay.get(days[i]) ?? 0) + 1);
    }
    weekBars.push(bars);
  }
  const goToday = () => {
    const d = new Date();
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelected(today);
  };
  const dayLabel = (d: string) => {
    const w = new Date(d + "T00:00:00").toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" });
    const tomorrow = ymd(new Date(Date.now() + 86400000));
    const h = holidayName(d);
    const label = h ? `${w} · ${h}` : w;
    return d === today ? `오늘 · ${label}` : d === tomorrow ? `내일 · ${label}` : label;
  };

  // 컴포넌트가 아니라 함수로 그린다: 그릴 때마다 새 컴포넌트가 되면 칩이 다시 만들어져 끄는 중 손가락 이벤트가 끊긴다
  const entry = (e: DayEntry, day: string) => {
    const dragging = drag && drag.key === e.key && drag.day === day;
    const style = { ...evColor(e), ...(dragging ? { position: "fixed" as const, top: drag.y - drag.gy, left: drag.left, width: drag.width } : {}) };
    return (
    <li
      key={e.key}
      data-key={e.key}
      className={`ev ${e.kind}${e.color ? " colored" : ""}${dragging ? " dragging" : ""}`}
      style={style}
      onClick={() => !justDragged.current && (e.ev ? setEditing(e.ev) : e.itemId && props.onOpen(e.itemId))}
      onTouchStart={(t) => startPress(e, day, t.touches[0].clientX, t.touches[0].clientY)}
      onMouseDown={(m) => m.button === 0 && startPress(e, day, m.clientX, m.clientY)}
      onContextMenu={(c) => mode === "list" && c.preventDefault()}
    >
      <span className="ev-bar" />
      <span className="ev-time">
        {e.end > e.start ? (
          <>
            {shortDay(e.start)}
            <small>~{shortDay(e.end)}</small>
          </>
        ) : (
          <>
            {e.time ? e.time : "종일"}
            {e.time && e.endTime && <small>{e.endTime}</small>}
          </>
        )}
      </span>
      <span className="ev-title">
        {e.kind === "todo" && <span className="todo-dot" aria-label="할 일" />}
        {e.title}
      </span>
    </li>
    );
  };
  // 끄는 동안에는 일정 없는 날도 보여서 그날로 옮길 수 있게 한다
  const agendaDays = () => {
    const out: string[] = [];
    for (let d = today; d < ymd(rangeTo) && out.length < 62; d = addDay(d, 1)) out.push(d);
    return out;
  };
  // 끌기 시작·끝에 빈 날이 생기거나 사라져 목록이 밀려도, 그날 묶음이 화면에서 같은 높이에 있게 스크롤을 맞춘다
  const anchor = useRef<{ day: string; top: number } | null>(null);
  const keepPanel = (day: string) => {
    const el = document.querySelector<HTMLElement>(`.day-panel[data-day="${day}"]`);
    anchor.current = el ? { day, top: el.getBoundingClientRect().top } : null;
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    const el = document.querySelector<HTMLElement>(`.day-panel[data-day="${a.day}"]`);
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - a.top);
  });
  // 끄는 중에 놓일 자리 표시선
  const withMark = (day: string, list: DayEntry[]) => {
    const t = drag?.target;
    const items = list.map((e) => entry(e, day));
    if (!t || t.day !== day) return items;
    // index는 끄는 칩을 뺀 목록 기준 → 화면 목록(끄는 칩 포함)에서의 자리로 바꾼다
    const self = drag.day === day ? list.findIndex((e) => e.key === drag.key) : -1;
    const at = self >= 0 && t.index >= self ? t.index + 1 : t.index;
    items.splice(at, 0, <li key="__mark" className="drop-mark" aria-hidden="true" />);
    return items;
  };

  if (creating)
    return (
      <EventEditor
        isNew
        ev={{ id: "", title: "", date: creating, time: "", endDate: creating, endTime: "", location: "", description: "" } as CalEvent}
        chat={[]}
        onClose={() => setCreating(null)}
        onAddTodo={() => {}}
        onSavedEdit={() => {}}
        onChat={() => {}}
        onSaved={() => {
          setCreating(null);
          load();
        }}
      />
    );
  if (editing) {
    const host = props.hostFor(editing);
    return (
      <EventEditor
        key={editing.id}
        host={host}
        ev={editing}
        onClose={() => setEditing(null)}
        onAddTodo={() => props.onAddTodo(editing)}
        todoId={host.linked ? host.item.id : undefined}
        onSavedEdit={(d) => props.onEventSaved(editing, d)}
        onChanged={load}
        chat={host.item.chat}
        onChat={host.onChat}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    );
  }

  return (
    <section className="calendar">
      <header className="page-head">
        <h1>캘린더</h1>
        <div className="head-actions">
        {props.calOn && cals.length > 1 && (
          <button className={`icon-btn cal-toggle${pickCals ? " on" : ""}`} aria-label="보일 캘린더 고르기" aria-expanded={pickCals} onClick={() => setPickCals(!pickCals)}>
            <IconLayers />
          </button>
        )}
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={mode === "month"} className={mode === "month" ? "on" : ""} onClick={() => setMode("month")}>
            월
          </button>
          <button role="tab" aria-selected={mode === "list"} className={mode === "list" ? "on" : ""} onClick={() => setMode("list")}>
            목록
          </button>
        </div>
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
      {props.calOn && gcal.needsCalendarScope() && (
        <div className="banner">
          <span className="grow">개인·업무 같은 캘린더 그룹도 보려면 구글 연결을 한 번 다시 해 주세요.</span>
          <button className="btn small" onClick={props.onConnect}>
            다시 연결
          </button>
        </div>
      )}

      {props.calOn && cals.length > 1 && pickCals && (
        <div className="cal-chips cal-filter" role="group" aria-label="보이는 캘린더">
          {cals.map((c) => (
            <button key={c.id} className={`cal-chip ${c.shown ? "on" : ""}`} aria-pressed={c.shown} onClick={() => toggleCal(c.id, !c.shown)}>
              <span className="swatch tiny" style={{ background: c.shown ? c.color : "transparent", boxShadow: `inset 0 0 0 1.5px ${c.color}` }} />
              {c.name}
            </button>
          ))}
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
          <div
            ref={gridRef}
            key={ymd(month)}
            className={`grid ${slide ? "slide-" + slide : ""}`}
            style={{ gridAutoRows: `${rowH}px` }}
            onTouchStart={(e) => swipeStart(e.touches[0].clientX, e.touches[0].clientY)}
            onTouchEnd={(e) => swipeEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY)}
            onPointerDown={(e) => e.pointerType === "mouse" && swipeStart(e.clientX, e.clientY)}
            onPointerUp={(e) => e.pointerType === "mouse" && swipeEnd(e.clientX, e.clientY)}
          >
            {cells.map((d, ci) => {
              const k = ymd(d);
              const hidden = hiddenByDay.get(k) ?? 0;
              const out = d.getMonth() !== month.getMonth();
              return (
                <button
                  key={k}
                  style={{ gridRow: Math.floor(ci / 7) + 1, gridColumn: (ci % 7) + 1 }}
                  className={`cell ${out ? "out" : ""} ${k === selected ? "sel" : ""} ${k === today ? "today" : ""} ${d.getDay() === 0 || holidayName(k) ? "sun" : d.getDay() === 6 ? "sat" : ""}`}
                  title={holidayName(k)}
                  onClick={() => {
                    if (swiped.current) return void (swiped.current = false);
                    setSelected(k);
                    if (out) setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
                  }}
                >
                  <span className="num">{d.getDate()}</span>
                  {hidden > 0 && (chipCount === 2 ? <span className="more">+{hidden}</span> : <span className="more-dot" aria-label={`일정 ${hidden}개 더`} />)}
                </button>
              );
            })}
            {/* 일정 칩: 주마다 한 줄씩 덮어 그리고, 여러 날 일정은 그 날짜들만큼 길게 잇는다 */}
            {weekBars.map((bars, w) => (
              <div key={"w" + w} className="week-bars" style={{ gridRow: w + 1, gridColumn: "1 / -1" }}>
                {bars.map((b) => (
                  <span
                    key={b.e.key}
                    className={`chip-ev ${b.e.kind}${b.e.color ? " colored" : ""}${b.contL ? " cont-l" : ""}${b.contR ? " cont-r" : ""}`}
                    style={{ ...evColor(b.e), gridColumn: `${b.from + 1} / ${b.to + 2}`, gridRow: b.lane + 1 }}
                  >
                    {b.e.kind === "todo" && !b.contL && <span className="todo-dot" />}
                    {b.e.title}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="day-panel">
            <div className="day-head">
              <h3>{dayLabel(selected)}</h3>
              {(props.calOn || props.linked) && (
                <button className="btn small tonal" onClick={() => setCreating(selected)}>
                  <IconPlus /> 일정 추가
                </button>
              )}
            </div>
            {(byDay.get(selected) ?? []).length ? (
              <ul className="evlist">
                {byDay.get(selected)!.map((e) => entry(e, selected))}
              </ul>
            ) : (
              <p className="muted small">일정이 없어요.</p>
            )}
          </div>
        </>
      ) : (
        <div className="agenda">
          {(drag ? agendaDays().map((d) => [d, byDay.get(d) ?? []] as [string, DayEntry[]]) : [...byDay.entries()])
            .filter(([d]) => d >= today && d < ymd(rangeTo))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([d, list], i, all) => {
              // 이번 주(일~토) / 다음 주 / 그 후로 나눠 구분선을 넣는다
              const week = (x: string) => {
                const t = new Date(today + "T00:00:00");
                const thisEnd = ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 6 - t.getDay()));
                const nextEnd = ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 13 - t.getDay()));
                return x <= thisEnd ? "이번 주" : x <= nextEnd ? "다음 주" : "그 후";
              };
              const g = week(d);
              return (
              <Fragment key={d}>
              {(i === 0 || week(all[i - 1][0]) !== g) && <div className="week-divider"><span>{g}</span></div>}
              <div className={`day-panel${list.length ? "" : " empty-day"}${drag?.target?.day === d ? " drop-on" : ""}`} data-day={d}>
                <h3 className={d === today ? "is-today" : ""}>{dayLabel(d)}</h3>
                <ul className="evlist">{withMark(d, list)}</ul>
              </div>
              </Fragment>
              );
            })}
          {byDay.size === 0 && <p className="muted">앞으로 30일 동안 일정이 없어요.</p>}
        </div>
      )}
    </section>
  );
}
