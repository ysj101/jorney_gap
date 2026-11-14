export const CONSENT_KEY = "journeygap.consent.v1";
export const SESSION_KEY = "journeygap.session.v1";

export function readConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "true";
  } catch {
    return false;
  }
}
export function persistConsent(value: boolean): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, String(value));
  } catch {
    /* Memory-only consent still works. */
  }
}
export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* Storage can be disabled. */
  }
}

/** Native controls, equal choices, no modal, focus capture or inline CSP exception. */
export function compactConsent(
  onChange: (value: boolean) => void,
  initial: boolean,
) {
  const region = document.createElement("aside");
  region.setAttribute("aria-label", "JourneyGap 計測の設定");
  region.className = "journeygap-consent";
  const description = document.createElement("p");
  description.textContent =
    "操作ステップの計測を許可しますか？入力内容は記録しません。タブ単位のランダムなIDを使います。";
  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  const allow = document.createElement("button");
  allow.type = "button";
  allow.textContent = "許可";
  const refuse = document.createElement("button");
  refuse.type = "button";
  refuse.textContent = "拒否";
  const yes = () => onChange(true);
  const no = () => onChange(false);
  allow.addEventListener("click", yes);
  refuse.addEventListener("click", no);
  region.append(description, allow, refuse, status);
  const mount = () => {
    document.body?.append(region);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
  const update = (value: boolean) => {
    status.textContent = value
      ? "計測は許可されています。いつでも拒否できます。"
      : "計測は停止しています。";
  };
  update(initial);
  return {
    update,
    remove() {
      document.removeEventListener("DOMContentLoaded", mount);
      allow.removeEventListener("click", yes);
      refuse.removeEventListener("click", no);
      region.remove();
    },
  };
}
