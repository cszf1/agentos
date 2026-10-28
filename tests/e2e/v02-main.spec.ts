import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedFixtures, startHost, stopHost, type HostProc } from "../proc.js";

/**
 * v0.2 M3 exit (spec §23) and V2-U01/U03/U04/U05 in a real browser against the same-origin production build, real
 * Podman, NO model: kanban grouping, statistics, chart, batch completion, the estimate field upgrade, switching between
 * declarative and code versions, and partial failures that keep the Shell usable.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-e2e-"));
const port = 4393;
const NO_MODEL = { AGENTOS_MODEL_MODE: "real", AGENTOS_MODEL_PROVIDER: "", AGENTOS_MODEL_ID: "" };
let host: HostProc;

async function login(page: Page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
  await page.getByLabel("auth-token").fill(token);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".brand")).toContainText("AgentOS");
}

const col = (page: Page, name: string) => page.locator(`.kanban-col[aria-label="${name}"]`);
const card = (page: Page, title: string) => page.locator(".card", { hasText: title });
const metric = (page: Page, label: string) => page.locator(".metric", { hasText: label }).locator(".metric-value");

async function addTask(page: Page, title: string, minutes?: number) {
  const form = page.locator('form[aria-label="新建任务"]');
  await form.getByLabel("任务").fill(title);
  if (minutes !== undefined) await form.getByLabel("预计工时（分钟）").fill(String(minutes));
  await form.getByRole("button", { name: "添加" }).click();
  await expect(page.locator(".banner.ok")).toContainText("添加：完成");
  await expect(card(page, title)).toBeVisible();
}

async function switchTo(page: Page, version: string) {
  await page.locator(".versions li", { hasText: version }).getByRole("button", { name: "切换到此版本" }).click();
  await expect(page.locator(".deploy-committed")).toBeVisible({ timeout: 120_000 });
}

test.afterAll(async () => {
  if (host) await stopHost(host);
});

test("v0.2 main path in the browser: kanban, stats, batch, hours upgrade, version round trip, no model", async ({ page }) => {
  await seedFixtures(dataDir, ["todo-v1.json", "todo-v2.json", "v0.2/todo-kanban", "v0.2/todo-kanban-hours"]);
  host = await startHost(dataDir, NO_MODEL, { port });
  await login(page);
  await expect(page.locator(".status-box")).toContainText("代码运行环境 就绪");
  await expect(page.locator(".status-box")).toContainText("模型 不可用");
  await expect(page.locator(".app-view h2")).toHaveText("待办看板 · 工时");
  await expect(page.locator(".runtime-panel")).toContainText("运行中", { timeout: 120_000 });

  // V2-U01 new renderer: kanban, metrics, chart, forms.
  await addTask(page, "买牛奶", 30);
  await addTask(page, "写周报", 90);
  await addTask(page, "订机票");
  await expect(col(page, "未完成").locator(".card")).toHaveCount(3);
  await expect(metric(page, "剩余工时")).toContainText("120");
  await expect(page.locator(".chart svg rect")).not.toHaveCount(0);

  // Batch completion: one atomic command.
  await card(page, "买牛奶").locator("input[type=checkbox]").check();
  await card(page, "订机票").locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "批量完成" }).click();
  await expect(page.locator(".banner.ok")).toContainText("2 条记录已原子提交");
  await expect(col(page, "已完成").locator(".card")).toHaveCount(2);
  await expect(metric(page, "剩余工时")).toContainText("90");

  // Hours on a selected task.
  await card(page, "写周报").locator("input[type=checkbox]").check();
  await page.locator('form[aria-label="设置所选任务的工时"]').getByLabel("预计工时（分钟）").fill("45");
  await page.getByRole("button", { name: "设置工时" }).click();
  await expect(page.locator(".banner.ok")).toContainText("设置工时：完成");
  await expect(metric(page, "剩余工时")).toContainText("45");

  // Round trip: declarative v1 → edit and create there.
  await switchTo(page, "v1");
  await expect(page.locator(".app-view h2")).toHaveText("待办清单");
  await expect(page.locator("table.records thead")).not.toContainText("工时");
  const r = page.locator("table.records tbody tr", { hasText: "写周报" });
  await r.getByRole("button", { name: "编辑" }).click();
  await page.locator(".record-form").getByLabel("任务").fill("写周报（改）");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator("table.records")).toContainText("写周报（改）");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator(".record-form").getByLabel("任务").fill("旧版新建");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator("table.records")).toContainText("旧版新建");

  // Back to the code version: estimates kept, the new record got the default 0.
  await switchTo(page, "v4");
  await expect(page.locator(".app-view h2")).toHaveText("待办看板 · 工时");
  await expect(page.locator(".runtime-panel")).toContainText("运行中", { timeout: 120_000 });
  await expect(card(page, "写周报（改）")).toContainText("45");
  await expect(card(page, "旧版新建")).toContainText("0");
  await expect(metric(page, "剩余工时")).toContainText("45");

  // V2-U03: dirty input survives a code→code version change but is not submitted until confirmed.
  await page.locator('form[aria-label="新建任务"]').getByLabel("任务").fill("没提交的输入");
  // The kanban v3 code version (built on demand) also serves the same data.
  await switchTo(page, "v3");
  await expect(page.locator(".app-view h2")).toHaveText("待办看板", { timeout: 60_000 });
  await expect(page.locator(".banner.warn")).toContainText("暂停提交");
  await expect(page.getByRole("button", { name: "添加" })).toBeDisabled();
  await page.getByRole("button", { name: "按新版本确认" }).click();
  await expect(page.locator('form[aria-label="新建任务"]').getByLabel("任务")).toHaveValue("没提交的输入");
  await expect(col(page, "已完成").locator(".card")).toHaveCount(2, { timeout: 60_000 });
  await switchTo(page, "v4");
  await expect(page.locator(".runtime-panel")).toContainText("运行中", { timeout: 120_000 });
});

test("V2-U04: a failing code app keeps the Shell, navigation and version history usable", async ({ page }) => {
  await stopHost(host);
  await seedFixtures(dataDir, ["v0.2/fault-lab"]);
  host = await startHost(dataDir, NO_MODEL, { port });
  await login(page);
  await page.getByRole("button", { name: /故障实验室/ }).click();
  await expect(page.locator(".runtime-panel")).toContainText("运行中", { timeout: 120_000 });
  // Stop the runtime: the app answers RUNTIME_STOPPED, the Shell and the other app keep working.
  await page.locator(".runtime-panel").getByRole("button", { name: "停止" }).click();
  await expect(page.locator(".runtime-panel")).toContainText("已停止");
  await page.reload();
  await page.getByRole("button", { name: /故障实验室/ }).click();
  await expect(page.locator(".banner.error")).toContainText("应用已停止");
  await page.getByRole("button", { name: /待办看板/ }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办看板 · 工时");
  await expect(page.locator(".versions li")).toHaveCount(4);
  await page.getByRole("button", { name: /故障实验室/ }).click();
  await page.locator(".runtime-panel").getByRole("button", { name: "启动" }).click();
  await expect(page.locator(".runtime-panel")).toContainText("运行中", { timeout: 120_000 });
});
