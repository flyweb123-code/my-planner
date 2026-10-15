import { useEffect, useState } from "react";
import { toast } from "./toast";

export type Subtask = { id: string; title: string; done: boolean; byClaude: boolean; createdAt: number; chat?: Msg[]; note?: string; due?: string; time?: string; endDate?: string; endTime?: string };
// prevEvent: 클론이 고치거나 지운 캘린더 일정의 원래 모습 (되돌리기용, gcal.EventEdit 모양)
export type PrevEvent = { title: string; due: string; time?: string; endDate?: string; endTime?: string; location: string; description: string; colorId?: string; calendarId?: string };
export type Action = { kind: "item" | "subtasks" | "update" | "event" | "event_update" | "event_delete"; text: string; undo?: { itemId: string; eventId?: string; calendarId?: string; subtaskIds?: string[]; prev?: Partial<Item>; prevEvent?: PrevEvent } ; undone?: boolean };
export type Msg = {
  role: "user" | "assistant";
  text: string;
  ts: number;
  suggestions?: { title: string; why: string; added?: boolean }[];
  actions?: Action[];
  images?: string[]; // 보낸 사진의 작은 미리보기 (data URL)
  imageKeys?: string[]; // 전체 화면용 큰 사진이 들어 있는 기기 저장소(files) 이름, images와 같은 순서
};
export type Item = {
  id: string;
  title: string;
  note: string;
  due: string; // YYYY-MM-DD 또는 빈 문자열
  done: boolean;
  createdAt: number;
  updatedAt: number;
  subtasks: Subtask[];
  chat: Msg[];
  time?: string; // 시작 시각 "HH:MM", 없으면 종일
  endDate?: string; // 끝나는 날 (없으면 due와 같은 날)
  endTime?: string; // 끝나는 시각 (없으면 시작 1시간 뒤)
  calendarEventId?: string;
  calendarId?: string; // 일정이 들어 있는 구글 캘린더(그룹). 없으면 기본 캘린더
  calSynced?: string; // 마지막으로 캘린더에 반영한 제목/날짜/시간
  pinned?: boolean; // 아이폰 잠금 화면 위젯에 띄울 할 일
  colorId?: string; // 캘린더 일정 색 (구글 colorId). ""이면 기본 색으로 되돌림, 없으면 건드리지 않음
};
// 홈(비서) 대화 하나. Claude 앱처럼 여러 개를 두고 왼쪽 목록에서 고른다.
export type HomeThread = { id: string; title: string; createdAt: number; updatedAt: number; msgs: Msg[] };
export type Settings = { apiKey: string; model: string };

export const DEFAULT_SETTINGS: Settings = { apiKey: "", model: "claude-opus-5-5" };

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function usePersisted<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() =>
    Array.isArray(fallback) ? (loadArray(key) as T) : load(key, fallback),
  );
  useEffect(() => {
    const json = JSON.stringify(value);
    if (localStorage.getItem(key) === json) return;
    try {
      localStorage.setItem(key, json);
    } catch {
      // 저장 공간이 꽉 찼으면 다시 받을 수 있는 캘린더 임시 저장본을 비우고 한 번 더 저장한다.
      try {
        localStorage.removeItem("gcal_cache");
        localStorage.setItem(key, json);
      } catch {
        if (!warned) toast("저장 공간이 부족해서 이 기기에 저장하지 못했어요. 설정 → 데이터 백업에서 백업을 내려받아 주세요.");
        warned = true;
      }
    }
  }, [key, value]);
  // 같은 기기에서 앱이 두 군데(홈 화면 앱과 사파리 탭 등) 열려 있으면, 다른 쪽에서 바꾼 내용을 받아 온다.
  // 이렇게 하지 않으면 예전 목록을 들고 있던 쪽이 저장하면서 새로 추가한 할 일을 덮어쓴다.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key || e.newValue === null) return;
      try {
        const next = JSON.parse(e.newValue);
        if (Array.isArray(fallback) !== Array.isArray(next)) return;
        setValue(Array.isArray(next) ? next : { ...fallback, ...next });
      } catch {
        /* 무시 */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [value, setValue] as const;
}
let warned = false;

// 사용자가 직접 지운 할 일. 이렇게 지운 할 일만 구글 캘린더 일정도 같이 지운다.
// (다른 이유로 목록에서 빠진 할 일 때문에 캘린더 일정까지 사라지지 않게)
const deletedByUser = new Set<string>();
export const markDeleted = (id: string) => void deletedByUser.add(id);
export const wasDeletedByUser = (id: string) => deletedByUser.delete(id);

function loadArray(key: string): unknown[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function daysUntil(due: string, now = new Date()): number | null {
  if (!due) return null;
  const d = new Date(due + "T00:00:00");
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

export function dueLabel(due: string): string {
  const n = daysUntil(due);
  if (n === null) return "";
  if (n < 0) return `${-n}일 지남`;
  if (n === 0) return "오늘";
  if (n === 1) return "내일";
  return `${n}일 후`;
}

// 시작 시각에 분을 더한 "HH:MM" (하루를 넘기면 다음 날로 넘어간 날짜도 함께)
export function addMinutes(date: string, time: string, min: number): { date: string; time: string } {
  const d = new Date(`${date}T${time}:00`);
  d.setMinutes(d.getMinutes() + min);
  return { date: d.toLocaleDateString("sv-SE"), time: d.toTimeString().slice(0, 5) };
}
// 일정의 끝 (종일이면 time 없음)
export function itemEnd(it: Pick<Item, "due" | "time" | "endDate" | "endTime">): { date: string; time?: string } {
  if (!it.time) return { date: it.endDate && it.endDate >= it.due ? it.endDate : it.due };
  if (it.endTime) {
    const date = it.endDate ?? it.due;
    if (`${date}T${it.endTime}` > `${it.due}T${it.time}`) return { date, time: it.endTime };
  }
  return addMinutes(it.due, it.time, 60);
}

// 대화별로 마지막으로 본 메시지 수 (말풍선 아이콘의 숫자 = 아직 안 본 메시지)
const SEEN_KEY = "chatSeen";
const seenMap = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
};
export const seenCount = (chatKey: string) => seenMap()[chatKey] ?? 0;
export function markSeen(chatKey: string, n: number) {
  const m = seenMap();
  if (m[chatKey] === n) return;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...m, [chatKey]: n }));
  } catch {
    /* 무시 */
  }
}
