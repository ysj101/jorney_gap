import { expect, test } from "./fixture.js";

async function complete(
  page: import("@playwright/test").Page,
  journey: string,
) {
  for (let i = 0; i < 3; i++)
    await page.locator(`[data-action="${journey}"]`).click();
  await expect(page.locator(`[data-status="${journey}"]`)).toHaveText(
    "完了しました",
  );
}
test("no transmission before consent or after refusal; keyboard-accessible equal choices", async ({
  page,
  lab,
}) => {
  lab.setMode("on");
  const before = lab.requests();
  await page.goto(`${lab.origin}/field/`);
  await expect(
    page.getByRole("button", { name: "許可", exact: true }),
  ).toBeVisible();
  await complete(page, "first-task");
  await page.waitForTimeout(5500);
  expect(lab.requests()).toBe(before);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  await page.getByRole("button", { name: "拒否", exact: true }).focus();
  await page.keyboard.press("Enter");
  await complete(page, "second-task");
  await page.waitForTimeout(5500);
  expect(lab.requests()).toBe(before);
  await page.screenshot({
    path: "test-results/field-station-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/field-station-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("parallel journeys and hash navigation work under strict CSP on a subpath without recording private text", async ({
  page,
  lab,
}) => {
  lab.setMode("on");
  const before = lab.payloads.length;
  const violations: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Content Security Policy")
    )
      violations.push(message.text());
  });
  await page.goto(
    `${lab.origin}/field/?email=synthetic-person%40example.test#/private-fragment`,
  );
  await page.getByRole("button", { name: "許可", exact: true }).click();
  await page
    .locator("#note")
    .fill(
      "synthetic-private-note@example.test https://private.example.test/record?token=synthetic",
    );
  await page.locator("#save-note").click();
  for (let i = 0; i < 3; i++) {
    await page.locator('[data-action="first-task"]').click();
    await page.locator('[data-action="second-task"]').click();
  }
  await expect
    .poll(() => lab.relay.store.count(), { timeout: 12000 })
    .toBeGreaterThanOrEqual(6);
  const data = lab.payloads.slice(before).join("\n");
  expect(data).toContain("journeygap.navigation");
  expect(data).toContain("first-task");
  expect(data).toContain("second-task");
  for (const forbidden of [
    "synthetic-person",
    "private-fragment",
    "synthetic-private-note",
    "private.example.test",
    "email=",
  ])
    expect(data).not.toContain(forbidden);
  const events = [
    ...lab.relay.store.list("sample-web", "first-task"),
    ...lab.relay.store.list("sample-web", "second-task"),
  ];
  const recent = events.slice(-6);
  expect(new Set(recent.map((event) => event.instanceId)).size).toBe(2);
  expect(violations).toEqual([]);
  const sent = lab.requests();
  await page.getByRole("button", { name: "拒否", exact: true }).click();
  await complete(page, "first-task");
  await page.waitForTimeout(5500);
  expect(lab.requests()).toBe(sent);
  expect(
    await page.evaluate(() => sessionStorage.getItem("journeygap.session.v1")),
  ).toBeNull();
});
test("a blocked SDK chunk leaves rendering, input and app actions intact", async ({
  page,
  lab,
}) => {
  lab.setMode("on");
  const manifest = JSON.parse(
    await import("node:fs").then((fs) =>
      fs.readFileSync(`${lab.root}/on/.vite/manifest.json`, "utf8"),
    ),
  );
  const chunk = Object.values(manifest).find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "src" in entry &&
      String(entry.src).includes("@journeygap/web"),
  ) as { file: string } | undefined;
  expect(chunk).toBeDefined();
  if (!chunk) throw new Error("Missing SDK dynamic entry");
  await page.route(`**/${chunk.file}`, (route) => route.abort());
  await page.goto(`${lab.origin}/field/`);
  await complete(page, "first-task");
  await page.locator("#note").fill("Local input works");
  await page.locator("#save-note").click();
  await expect(page.locator("#note-status")).toContainText("確定しました");
});
test("CORS refusal preserves app operation", async ({ page, lab }) => {
  lab.setMode("denied");
  let failures = 0;
  page.on("requestfailed", (request) => {
    if (request.url() === `${lab.deniedOrigin}/v1/traces`) failures++;
  });
  await page.goto(`${lab.origin}/field/`);
  await page.getByRole("button", { name: "許可", exact: true }).click();
  await complete(page, "first-task");
  await expect.poll(() => failures, { timeout: 12000 }).toBeGreaterThan(0);
  await complete(page, "second-task");
});
test("disabled and enabled app response times stay bounded, and uninstall rebuild remains usable", async ({
  page,
  lab,
}) => {
  const samples: number[] = [];
  for (const mode of ["off", "on"]) {
    lab.setMode(mode);
    await page.goto(`${lab.origin}/field/`);
    if (mode === "on")
      await page.getByRole("button", { name: "許可", exact: true }).click();
    const elapsed = await page.evaluate(() => {
      const start = performance.now();
      const button = document.querySelector<HTMLButtonElement>(
        '[data-action="first-task"]',
      );
      for (let i = 0; i < 30; i++) button?.click();
      return performance.now() - start;
    });
    samples.push(elapsed);
    expect(elapsed).toBeLessThan(500);
  }
  expect(Math.abs((samples[1] ?? 0) - (samples[0] ?? 0))).toBeLessThan(250);
  lab.setMode("removed");
  await page.goto(`${lab.origin}/field/`);
  await complete(page, "first-task");
  await expect(
    page.getByRole("button", { name: "許可", exact: true }),
  ).toHaveCount(0);
});
test("a stopped Relay cannot prevent subsequent host operations", async ({
  page,
  lab,
}) => {
  lab.setMode("on");
  await page.goto(`${lab.origin}/field/`);
  await page.getByRole("button", { name: "許可", exact: true }).click();
  await lab.stopRelay();
  await complete(page, "first-task");
  await page.waitForTimeout(6000);
  await complete(page, "second-task");
});
