// 브라우저 알림창 대신 화면 아래에 잠깐 뜨는 안내 문구
export function toast(text: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
