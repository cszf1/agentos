import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedFixtures, startHost, stopHost, type HostProc } from "../proc.js";

/**
 * Spec §17 M2 exit: the hand-written fixtures run in a real browser with NO model configured.
 * CRUD, search, filters, history switch, persistence across a host restart, and a stale page write answered by 409.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-e2e-m2-"));
const port = 4391;
const NO_MODEL = { AGENTOS_MODEL_MODE: "real", AGENTOS_MODEL_PROVIDER: "", AGENTOS_MODEL_ID: "" };
let host: HostProc;

async function login(page: Page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
  await page.getByLabel("auth-token").fill(token);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".brand")).toContainText("AgentOS");
}

function row(page: Page, title: string) {
  return page.locator("table.records tbody tr", { hasText: title });
}

async function addTask(page: Page, title: string) {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator(".record-form").getByLabel("任务").fill(title);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator("table.records")).toContainText(title);
}

test.afterAll(async () => {
  if (host) await stopHost(host);
});

test("M2: seeded fixtures run without a model; CRUD, search, filter, history, restart, stale write", async ({ page, context }) => {
  const seeded = await seedFixtures(dataDir, ["todo-v1.json"]);
  expect(seeded[0]!.appEpoch).toBe(1);
  host = await startHost(dataDir, NO_MODEL, { port });
  await login(page);
  await expect(page.locator(".status-box")).toContainText("模型 不可用");
  await expect(page.locator(".app-view h2")).toHaveText("待办清单");

  // CRUD + search + filter on v1
  await addTask(page, "买牛奶");
  await addTask(page, "写周报");
  await row(page, "写周报").getByRole("button", { name: "编辑" }).click();
  await page.locator(".record-form").getByLabel("已完成").check();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(row(page, "写周报")).toContainText("✓");
  await page.getByPlaceholder("搜索任务").fill("牛奶");
  await expect(page.locator("table.records tbody tr")).toHaveCount(1);
  await page.getByPlaceholder("搜索任务").fill("");
  await page.getByLabel("筛选已完成").selectOption("true");
  await expect(page.locator("table.records tbody tr")).toHaveCount(1);
  await page.getByLabel("筛选已完成").selectOption("");
  await addTask(page, "要删掉的");
  await row(page, "要删掉的").getByRole("button", { name: "删除" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.locator("table.records")).not.toContainText("要删掉的");

  // seed v2 into the stopped workspace, restart: data kept, old rows get priority=normal
  await stopHost(host);
  await seedFixtures(dataDir, ["todo-v2.json"]);
  host = await startHost(dataDir, NO_MODEL, { port });
  await page.reload();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单 · 优先级");
  await expect(row(page, "买牛奶")).toContainText("normal");
  await row(page, "买牛奶").getByRole("button", { name: "编辑" }).click();
  await page.locator(".record-form").getByLabel("优先级").selectOption("high");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(row(page, "买牛奶")).toContainText("high");

  // history: back to v1, edit and add, then v2 again
  await page.locator(".versions li", { hasText: "v1" }).getByRole("button", { name: "切换到此版本" }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单");
  await expect(page.locator("table.records thead")).not.toContainText("优先级");
  await row(page, "买牛奶").getByRole("button", { name: "编辑" }).click();
  await page.locator(".record-form").getByLabel("任务").fill("买牛奶和面包");
  await page.getByRole("button", { name: "保存" }).click();
  await addTask(page, "旧版新增");
  await page.locator(".versions li", { hasText: "v2" }).getByRole("button", { name: "切换到此版本" }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单 · 优先级");
  await expect(row(page, "买牛奶和面包")).toContainText("high");
  await expect(row(page, "旧版新增")).toContainText("normal");

  // stale page: page A holds an edit form, page B saves the same record first; A's save gets 409 and keeps input
  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${port}/`);
  await expect(other.locator("table.records")).toContainText("写周报");
  await row(page, "写周报").getByRole("button", { name: "编辑" }).click();
  await page.locator(".record-form").getByLabel("任务").fill("A 页的修改");
  await row(other, "写周报").getByRole("button", { name: "编辑" }).click();
  await other.locator(".record-form").getByLabel("任务").fill("B 页先保存");
  await other.getByRole("button", { name: "保存" }).click();
  await expect(other.locator("table.records")).toContainText("B 页先保存");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".record-form .banner.error")).toContainText("这条记录刚被修改过");
  await expect(page.locator(".record-form").getByLabel("任务")).toHaveValue("A 页的修改");
  await other.close();

  // archive is a user lifecycle action in the shell, then restore brings the same records back
  await page.getByRole("button", { name: "归档此应用" }).click();
  await expect(page.getByRole("button", { name: "恢复此应用" })).toBeVisible();
  await page.getByRole("button", { name: "恢复此应用" }).click();
  await expect(page.getByRole("button", { name: "归档此应用" })).toBeVisible();
  await expect(page.locator("table.records")).toContainText("买牛奶和面包");
  await page.screenshot({ path: path.join(import.meta.dirname, "../../test-results/m2-fixture-final.png"), fullPage: true });
  await stopHost(host);
});
