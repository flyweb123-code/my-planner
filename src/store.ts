import { useEffect, useState } from "react";

export type Subtask = { id: string; title: string; done: boolean; byClaude: boolean; createdAt: number };
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
  calendarEventId?: string;
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
  if (n === 0) return "오늘까지";
  if (n === 1) return "내일까지";
  return `${n}일 남음`;
}
