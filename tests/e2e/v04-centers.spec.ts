import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, startHost, stopHost, type HostProc } from "../proc.js";

/**
 * v0.4 spec §22.2 in a real browser: the task center shows two foreground slots, the queue, per-task budget and an
 * independent cancel; the maintenance center shows a prominent pause and keeps "paused here" apart from "confirmed by
 * the system executor" (no broker in this run, so the root side stays unconfirmed). Formal faux model with slow steps.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-e2e-v4-"));
const port = 4395;
let host: HostProc;

async function login(page: Page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
  await page.getByLabel("auth-token").fill(token);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".brand")).toContainText("AgentOS");
}

test.afterAll(async () => {
  if (host) await stopHost(host);
});

test("V4 task center and maintenance center", async ({ page }) => {
  test.setTimeout(180_000);
  host = await startHost(dataDir, { AGENTOS_MODEL_MODE: "faux", AGENTOS_RUNTIME: "off" }, { port });
  const c = new Client(host);
  await c.login(dataDir);
  await login(page);

  // three independent create tasks: two take the foreground slots, the third queues
  const ids: string[] = [];
  for (const name of ["待办", "记账", "读书"]) {
    const r = await c.req("POST", "/api/runs", { intent: `做一个${name}应用 [faux:slow:4000]`, targetAppId: null });
    expect(r.status, JSON.stringify(r)).toBe(202);
    ids.push(r.data.runId);
  }
  await page.getByRole("button", { name: /任务中心/ }).click();
  const center = page.getByRole("region", { name: "任务中心" });
  await expect(center.locator(".slot")).toHaveCount(2);
  await expect(center.locator(".slot.busy")).toHaveCount(2, { timeout: 20_000 });
  const queued = center.getByRole("list", { name: "排队任务" });
  await expect(queued.locator("li.task")).toHaveCount(1);
  await expect(queued).toContainText("排队：等待空闲任务槽");
  await expect(queued).toContainText("第 1 位");
  // each task shows its own budget
  await expect(center.locator(".slot.busy .budget").first()).toContainText("请求");

  // cancel only the queued one; the two running tasks are untouched
  const queuedId = await queued.locator("li.task").getAttribute("data-run-id");
  await queued.getByRole("button", { name: /取消任务/ }).click();
  await expect(queued.locator("li.task")).toHaveCount(0, { timeout: 15_000 });
  const cancelled = await c.get(`/api/runs/${queuedId}`);
  expect(["cancelled", "cancel_requested"]).toContain(cancelled.data.status);
  for (const id of ids.filter((x) => x !== queuedId)) {
    const r = await c.get(`/api/runs/${id}`);
    expect(["running", "queued", "succeeded"]).toContain(r.data.status);
  }

  // U03: an accepted (202) task is shown as queued/running, never as a success
  await expect(center.locator(".slot.busy").first()).not.toContainText("已完成");
  await expect(center.locator(".slot.busy").first()).not.toContainText("成功");


  // maintenance center: prominent pause, local vs executor confirmation shown separately
  await page.getByRole("button", { name: /维护中心/ }).click();
  const mc = page.getByRole("region", { name: "维护中心" });
  await expect(mc).toContainText("自动维护");
  const pauseBtn = mc.getByRole("button", { name: /暂停全部自动维护/ });
  if (await pauseBtn.count()) {
    await pauseBtn.click();
  }
  await expect(mc.locator(".maint-switch")).toContainText("自动维护已暂停");
  await expect(mc.getByTestId("maint-root")).toContainText("本地：已暂停");
  await expect(mc.getByTestId("maint-root")).toContainText("等待确认");
  await expect(mc.getByTestId("maint-budget")).toContainText("后台请求");
  const st = await c.get("/api/maintenance/state");
  expect(st.data.state).toBe("paused");
  expect(st.data.root).not.toBe("synced");
  await mc.getByRole("button", { name: "恢复自动维护" }).click();
  await expect(mc.locator(".maint-switch")).toContainText("自动维护运行中");
  expect((await c.get("/api/maintenance/state")).data.state).toBe("running");


  // the two remaining tasks finish on their own
  for (const id of ids.filter((x) => x !== queuedId)) await c.waitRun(id, 120_000);

  // U02: a policy waiting for approval shows its real target, automatic actions, frequency, limits and expiry
  const created = await c.req("POST", "/api/maintenance/policies", { templateId: "app-recovery", target: { kind: "app", id: (await c.get(`/api/runs/${ids[0]}`)).data.targetAppId }, mode: "automatic", trigger: { kind: "interval", intervalSeconds: 900 } });
  expect(created.status, JSON.stringify(created)).toBe(201);
  const card = mc.getByRole("list", { name: "待批准策略" }).locator(`li[data-policy-id="${created.data.policyId}"]`);
  await expect(card).toContainText("目标：待办", { timeout: 15_000 });
  await expect(card).toContainText("自动执行的动作");
  await expect(card).toContainText("每 15 分钟检查");
  await expect(card).toContainText("每小时最多");
  await expect(card).toContainText("不自动续期");
  await card.getByRole("button", { name: "批准此范围" }).click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  const pol = (await c.get("/api/maintenance/policies")).data.items.find((p: { policyId: string }) => p.policyId === created.data.policyId);
  expect(["enabled", "syncing"]).toContain(pol.state);
  expect(pol.approval.approvedAt).toBeTruthy();
});
