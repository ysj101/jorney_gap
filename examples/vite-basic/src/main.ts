import "./style.css";

// Optional discovery keeps this independent app buildable before installation
// and after uninstall. Only the documented public API is used when present.
type Observer = { trackStep(journey: string, step: string): void };
const modules = import.meta.glob<Observer>(
  "/node_modules/@journeygap/web/dist/index.js",
  { exhaustive: true },
);
const load = Object.values(modules)[0];
function observe(journey: string, step: string): void {
  if (load)
    void load()
      .then((module) => module.trackStep(journey, step))
      .catch(() => {});
}
const steps = ["started", "reviewed", "completed"];
const labels: Record<string, string[]> = {
  "first-task": ["持ち物を確認した", "装備をそろえた", "もう一度点検する"],
  "second-task": [
    "潮と天気を確認した",
    "出発の準備を終える",
    "もう一度準備する",
  ],
};
for (const journey of ["first-task", "second-task"]) {
  let position = 0;
  const button = document.querySelector<HTMLButtonElement>(
    `[data-action="${journey}"]`,
  );
  const status = document.querySelector<HTMLElement>(
    `[data-status="${journey}"]`,
  );
  button?.addEventListener("click", () => {
    const step = steps[position];
    if (!step || !status) return;
    observe(journey, step);
    location.hash = `/${journey}`;
    document
      .querySelectorAll(`[data-journey="${journey}"] li`)
      .forEach((item, index) => {
        item.classList.toggle("done", index <= position);
      });
    status.textContent =
      position === 2 ? "完了しました" : `${position + 1} / 3 ステップ完了`;
    button.textContent = labels[journey]?.[position] ?? "続ける";
    position = (position + 1) % 3;
  });
}
document.querySelector("#save-note")?.addEventListener("click", () => {
  const status = document.querySelector("#note-status");
  if (status)
    status.textContent = "メモを確定しました（ページを閉じると消えます）";
});
