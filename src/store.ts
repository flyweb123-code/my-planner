import { useEffect, useState } from "react";

export type Subtask = { id: string; title: string; done: boolean; byClaude: boolean; createdAt: number; chat?: Msg[]; note?: string };
export type Action = { kind: "item" | "subtasks" | "update" | "event"; text: string; undo?: { itemId: string; subtaskIds?: string[]; prev?: Partial<Item> } ; undone?: boolean };
export type Msg = {
  role: "user" | "assistant";
  text: string;
  ts: number;
  suggestions?: { title: string; why: string; added?: boolean }[];
  actions?: Action[];
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
  calSynced?: string; // 마지막으로 캘린더에 반영한 제목/날짜/시간
};
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
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 저장 공간이 없을 때는 조용히 넘어감 */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

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
