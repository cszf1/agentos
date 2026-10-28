import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHost, stopHost, type HostProc } from "../proc.js";

/**
 * Same-origin production build, faux model mode. Follows the main acceptance path of spec §1 in a real browser,
 * restarting the real host process in between.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-e2e-"));
let host: HostProc;
const port = 4390;

async function login(page: Page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
  await page.getByLabel("auth-token").fill(token);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".brand")).toContainText("AgentOS");
}

async function addTask(page: Page, title: string) {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("任务").fill(title);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator("table.records")).toContainText(title);
}

function row(page: Page, title: string) {
  return page.locator("table.records tbody tr", { hasText: title });
}

test.afterAll(async () => {
  if (host) await stopHost(host);
});

test("main path: create, persist, upgrade, switch back and forth, restart, model off", async ({ page }) => {
  host = await startHost(dataDir, {}, { port });
  await login(page);

  // 1. create the app
  await page.getByLabel("需求").fill("做一个待办应用");
  await page.getByRole("button", { name: "生成应用" }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单", { timeout: 30_000 });
  await expect(page.locator(".run")).toContainText("已完成");

  // 2. two tasks survive refresh and host restart
  await addTask(page, "买牛奶");
  await addTask(page, "写周报");
  await row(page, "写周报").getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("已完成").check();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(row(page, "写周报")).toContainText("✓");
  await page.getByPlaceholder("搜索任务").fill("牛奶");
  await expect(page.locator("table.records tbody tr")).toHaveCount(1);
  await page.getByPlaceholder("搜索任务").fill("");
  await page.getByLabel("筛选已完成").selectOption("true");
  await expect(page.locator("table.records tbody tr")).toHaveCount(1);
  await page.getByLabel("筛选已完成").selectOption("");
  await page.reload();
  await expect(page.locator("table.records")).toContainText("买牛奶");
  await stopHost(host);
  host = await startHost(dataDir, {}, { port });
  await page.reload();
  await expect(page.locator("table.records")).toContainText("写周报");

  // 3. upgrade with priority; old rows default to normal
  await page.getByRole("button", { name: /修改“待办清单”/ }).click();
  await page.getByLabel("需求").fill("增加优先级和优先级筛选");
  await page.getByRole("button", { name: "修改应用" }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单 · 优先级", { timeout: 30_000 });
  await expect(row(page, "买牛奶")).toContainText("normal");

  // 4. set one to high, switch to v1, rename it and add a row
  await row(page, "买牛奶").getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("优先级", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(row(page, "买牛奶")).toContainText("high");
  await page.locator(".versions li", { hasText: "v1" }).getByRole("button", { name: "切换到此版本" }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单");
  await expect(page.locator("table.records thead")).not.toContainText("优先级");
  await row(page, "买牛奶").getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("任务").fill("买牛奶和面包");
  await page.getByRole("button", { name: "保存" }).click();
  await addTask(page, "旧版新增");

  // 5. back to v2: high kept, new row normal
  await page.locator(".versions li", { hasText: "v2" }).getByRole("button", { name: "切换到此版本" }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单 · 优先级");
  await expect(row(page, "买牛奶和面包")).toContainText("high");
  await expect(row(page, "旧版新增")).toContainText("normal");
  await page.getByLabel("筛选优先级").selectOption("high");
  await expect(page.locator("table.records tbody tr")).toHaveCount(1);
  await page.getByLabel("筛选优先级").selectOption("");

  // 7. model connection off: CRUD still works, generation entry disabled
  await stopHost(host);
  host = await startHost(dataDir, { AGENTOS_MODEL_MODE: "real", AGENTOS_MODEL_PROVIDER: "", AGENTOS_MODEL_ID: "" }, { port });
  await page.reload();
  await expect(page.locator(".status-box")).toContainText("模型 不可用");
  await expect(page.getByRole("button", { name: /修改应用|生成应用/ })).toBeDisabled();
  await addTask(page, "离线也能加");
  await row(page, "离线也能加").getByRole("button", { name: "删除" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.locator("table.records")).not.toContainText("离线也能加");
  await page.screenshot({ path: path.join(import.meta.dirname, "../../test-results/main-path-final.png"), fullPage: true });
  await stopHost(host);
});

test("U02 a renderer crash stays inside the error boundary; shell and versions keep working", async ({ page }) => {
  host = await startHost(dataDir, {}, { port });
  await login(page);
  await expect(page.locator(".app-view h2")).toBeVisible();
  // Corrupt the app payload in transit so the trusted renderer throws while rendering.
  await page.route(/\/api\/apps\/[0-9a-f-]+$/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.data.bundle.data.fields = {};
    await route.fulfill({ response: res, json });
  });
  await page.reload();
  await expect(page.locator(".banner.error", { hasText: "渲染失败" })).toBeVisible();
  await expect(page.getByRole("button", { name: "＋ 创建应用" })).toBeVisible();
  await expect(page.locator(".versions li").first()).toBeVisible();
  await page.unroute(/\/api\/apps\/[0-9a-f-]+$/);
  await page.locator(".versions li", { hasText: "v1" }).getByRole("button", { name: "切换到此版本" }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单");
  await stopHost(host);
});
