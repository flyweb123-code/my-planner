// 앱 전체에서 쓰는 선 아이콘. 글자색(currentColor)을 따라간다.
const base = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const IconChat = () => (
  <svg {...base} aria-hidden="true">
    <path d="M4 12a8 8 0 1 1 3.5 6.6L4 20l1.3-3.6A7.9 7.9 0 0 1 4 12Z" />
  </svg>
);
export const IconList = () => (
  <svg {...base} aria-hidden="true">
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="m3.5 6 1.2 1.2L6.8 5M3.5 12l1.2 1.2 2.1-2.2M3.5 18l1.2 1.2 2.1-2.2" />
  </svg>
);
export const IconCalendar = () => (
  <svg {...base} aria-hidden="true">
    <rect x="3.5" y="5" width="17" height="15" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);
export const IconSettings = () => (
  <svg {...base} aria-hidden="true">
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </svg>
);
export const IconUp = () => (
  <svg {...base} strokeWidth={2.2} aria-hidden="true">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
export const IconBack = () => (
  <svg {...base} strokeWidth={2} aria-hidden="true">
    <path d="m15 5-7 7 7 7" />
  </svg>
);
export const IconLeft = IconBack;
export const IconRight = () => (
  <svg {...base} strokeWidth={2} aria-hidden="true">
    <path d="m9 5 7 7-7 7" />
  </svg>
);
export const IconPlus = () => (
  <svg {...base} strokeWidth={2} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconRefresh = () => (
  <svg {...base} aria-hidden="true">
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5" />
  </svg>
);
export const IconMore = () => (
  <svg {...base} aria-hidden="true">
    <circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);
export const IconCheck = () => (
  <svg {...base} strokeWidth={2.4} aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
