import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedFixtures, startHost, stopHost, type HostProc } from "../proc.js";
import { Broker, hasBroker, installed, simCtl, storeUUID, systemctl } from "../v03.js";

/**
 * v0.3 e2e (spec §24.2 test:e2e): resource connection, the Shell's trusted confirmation, an unknown result and its
 * handling, revocation, the global operation center, a faux system_plan run, the old declarative app still working,
 * and the out-of-order app switch from the review of main@79377eb (#4). Real broker, real sandbox, real browser.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-e2e-v03-"));
const port = 4393;
let host: HostProc;

test.skip(!hasBroker(), "needs the installed broker (deploy/v0.3/agentos-system-admin install --test-mode)");

async function login(page: Page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
  await page.getByLabel("auth-token").fill(token);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".brand")).toContainText("AgentOS");
}

const cpuMax = () => fs.readFileSync(`/sys/fs/cgroup/system.slice/${installed()!.units[0]!.unit}/cpu.max`, "utf8").trim();

test.afterAll(async () => {
  if (host) await stopHost(host);
});

test("v0.3: connect, confirm, unknown, revoke, operation center, system_plan, old app, ordered switch", async ({ page }) => {
  test.setTimeout(600_000);
  const seeded = await seedFixtures(dataDir, ["todo-v1.json"]);
  const db = new DatabaseSync(path.join(dataDir, "os.sqlite"));
  db.prepare("UPDATE meta SET store_uuid = ? WHERE id = 1").run(storeUUID());
  db.close();
  systemctl("start", installed()!.units[0]!.unit);
  // test hygiene: unknown results left by earlier runs keep their facts but release their quarantine
  const b = await new Broker().open();
  await b.releaseQuarantines();
  b.close();
  host = await startHost(dataDir, {}, { port });
  await login(page);
  await expect(page.locator(".status-box")).toContainText("系统执行服务 就绪");
  // telemetry is reported on its own line (this kernel has no BTF/tracepoints)
  await expect(page.locator(".status-box")).toContainText("遥测");

  // 1. generate the v3 system console (faux model, real tools, real ABI-2 sandbox)
  await page.getByRole("button", { name: "＋ 创建应用" }).click();
  await page.getByLabel("需求描述").fill("做一个系统控制台，查看演示服务状态并能设置 CPU 上限");
  await page.getByRole("button", { name: "生成应用" }).click();
  await expect(page.locator(".app-view h2")).toHaveText("系统控制台", { timeout: 300_000 });
  await expect(page.locator(".app-view")).toContainText("需要连接资源");

  // 2. connect the service binding through the Shell (trusted resource list, real identity)
  const panel = page.locator(".app-system");
  await panel.getByLabel("为 svc 选择资源").selectOption({ label: "演示服务" });
  await panel.locator(".binding", { hasText: "svc" }).getByRole("button", { name: "连接" }).click();
  await expect(panel.locator(".binding", { hasText: "svc" })).toContainText("已连接", { timeout: 20_000 });
  await page.reload();
  await page.getByRole("navigation", { name: "应用" }).getByRole("button", { name: /系统控制台/ }).click();
  await expect(page.locator(".app-view")).toContainText("active", { timeout: 20_000 });

  // 3. the app only asks; the Shell shows the provider's preview and the user confirms
  await page.locator(".app-view").getByLabel("上限（单个逻辑 CPU 的百分比）").fill("50");
  await page.getByRole("button", { name: "⚙ 生成 CPU 上限计划" }).click();
  const dlg = page.getByRole("dialog", { name: "AgentOS 系统动作确认" });
  await expect(dlg).toContainText("AgentOS 系统确认 · 不是应用界面");
  await expect(dlg).toContainText("agentos-demo.service");
  await expect(dlg).toContainText("50%");
  await expect(dlg).toContainText("计划已生成，等待确认（尚未执行）");
  await dlg.getByRole("button", { name: "确认执行这一计划" }).click();
  await expect(dlg).toContainText("已核实完成", { timeout: 30_000 });
  expect(cpuMax()).toBe("50000 100000");
  await dlg.getByRole("button", { name: "关闭" }).click();

  // 4. an unknown serial result: shown as "结果待确认", no plain retry; handled in the operation center
  await panel.getByLabel("为 dev 选择资源").selectOption({ index: 1 });
  await panel.locator(".binding", { hasText: "dev" }).getByRole("button", { name: "连接" }).click();
  await expect(panel.locator(".binding", { hasText: "dev" })).toContainText("已连接", { timeout: 20_000 });
  simCtl("drop-next");
  await page.getByRole("button", { name: "⚙ 串口采样" }).click();
  await dlg.getByRole("button", { name: "确认执行这一计划" }).click();
  await expect(dlg).toContainText("结果待确认", { timeout: 30_000 });
  await expect(dlg).not.toContainText("再试一次");
  await dlg.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "⚙ 系统与操作中心" }).click();
  const center = page.locator(".system-center");
  const unknownRow = center.locator(".op-row", { hasText: "结果待确认" }).first();
  await expect(unknownRow).toBeVisible();
  await unknownRow.getByRole("button", { name: "核对并处置" }).click();
  await unknownRow.getByLabel("处置说明").fill("已核对设备，接受未知结果");
  await unknownRow.getByRole("button", { name: "接受未知" }).click();
  await expect(center.locator(".op-row", { hasText: "已核对设备" }).or(center.locator(".op-row", { hasText: "处置" })).first()).toBeVisible({ timeout: 10_000 });
  await expect(center.locator(".op-row", { hasText: "已核实完成" }).first()).toBeVisible();

  // 5. revoke: the app immediately loses the connection
  await panel.locator(".binding", { hasText: "svc" }).getByRole("button", { name: "撤销" }).click();
  await page.reload();
  await page.getByRole("navigation", { name: "应用" }).getByRole("button", { name: /系统控制台/ }).click();
  await expect(page.locator(".app-view")).toContainText(/需要连接资源|授权已撤销|授权撤销中/, { timeout: 20_000 });

  // 6. system_plan run: resources and allowed actions chosen by the user; the plan waits for the Shell
  await page.getByRole("button", { name: "⚙ 系统与操作中心" }).click();
  await center.getByRole("tab", { name: "系统计划" }).click();
  await center.locator("fieldset", { hasText: "资源" }).getByLabel("演示服务").check();
  await center.locator("fieldset", { hasText: "允许提议的动作" }).getByLabel("service.set_limit").check();
  await center.getByLabel("系统计划需求").fill("将演示服务 CPU 上限设为 30%");
  await center.getByRole("button", { name: "生成系统计划" }).click();
  await expect(dlg).toContainText("30%", { timeout: 120_000 });
  await expect(dlg).toContainText("Pi 系统计划");
  expect(cpuMax()).toBe("50000 100000"); // nothing ran yet
  await dlg.getByRole("button", { name: "确认执行这一计划" }).click();
  await expect(dlg).toContainText("已核实完成", { timeout: 30_000 });
  expect(cpuMax()).toBe("30000 100000");
  await dlg.getByRole("button", { name: "关闭" }).click();

  // 7. the old declarative app still works unchanged
  const todoId = seeded[0]!.appId;
  await page.getByRole("navigation", { name: "应用" }).getByRole("button", { name: /待办清单/ }).click();
  await expect(page.locator(".app-view h2")).toHaveText("待办清单");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator(".record-form").getByLabel("任务").fill("v0.3 兼容检查");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator("table.records")).toContainText("v0.3 兼容检查");

  // 8. review #4: a late answer for the previously selected app never replaces the current one
  await page.route(`**/api/apps/${todoId}`, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.getByRole("navigation", { name: "应用" }).getByRole("button", { name: /系统控制台/ }).click();
  await expect(page.locator(".app-view h2")).toHaveText("系统控制台");
  await page.getByRole("navigation", { name: "应用" }).getByRole("button", { name: /待办清单/ }).click(); // slow
  await page.getByRole("navigation", { name: "应用" }).getByRole("button", { name: /系统控制台/ }).click(); // fast
  await page.waitForTimeout(3500);
  await expect(page.locator(".app-view h2")).toHaveText("系统控制台");
  await page.unroute(`**/api/apps/${todoId}`);
});
