import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PLUGIN = path.resolve(process.argv[2] || "/home/box/grok-wechat-plugin");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "gw-home-"));
const stateHome = path.join(home, ".grok-wechat");
process.env.HOME = home;
process.env.GROK_WECHAT_HOME = stateHome;

const ilink = await import(path.join(PLUGIN, "server/ilink.js"));
const store = await import(path.join(PLUGIN, "server/store.js"));
const results = [];
const check = (name, fn) => { fn(); results.push(`PASS ${name}`); };

// 1. path traversal
check("safeFileName strips directories", () => {
  for (const evil of ["../../../../.bashrc", "..\\..\\x.sh", "/etc/passwd", "a/../../b", "....//....//c", "\u0000\n.."]) {
    const n = ilink.safeFileName(evil);
    assert.ok(!n.includes("/") && !n.includes("\\") && !n.startsWith("."), `${JSON.stringify(evil)} -> ${n}`);
  }
  assert.equal(ilink.safeFileName("报告.pdf"), "报告.pdf");
});

const key = crypto.randomBytes(16);
const payload = Buffer.from("PAYLOAD");
const c = crypto.createCipheriv("aes-128-ecb", key, null);
const cipher = Buffer.concat([c.update(payload), c.final()]);
globalThis.fetch = async () => new Response(cipher, { status: 200 });
const evilMsg = {
  from_user_id: "attacker@im.wechat",
  item_list: [{ type: 4, file_item: { file_name: "../../../../.bashrc", media: { full_url: "https://x", aes_key: key.toString("base64") } } }],
};
const norm = await ilink.normalizeInbound(evilMsg);
check("malicious file lands inside media dir", () => {
  const p = norm.items[0].path;
  assert.ok(p, "file saved");
  assert.equal(path.dirname(p), path.resolve(stateHome, "media"));
  assert.equal(fs.readFileSync(p, "utf8"), "PAYLOAD");
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(home, ".bashrc")));
});

// 2. default-deny allowlist
const owner = { ilinkUserId: "owner@im.wechat" };
check("allowlist default deny", () => {
  const s = store.emptyState();
  assert.equal(store.isAllowed(s, "owner@im.wechat", owner), true);
  assert.equal(store.isAllowed(s, "stranger@im.wechat", owner), false);
  assert.equal(store.isAllowed(s, "stranger@im.wechat", undefined), false);
  s.allowFrom = ["friend@im.wechat"];
  assert.equal(store.isAllowed(s, "friend@im.wechat", owner), true);
  assert.equal(store.isAllowed(s, "stranger@im.wechat", owner), false);
  s.allowFrom = ["*"];
  assert.equal(store.isAllowed(s, "stranger@im.wechat", owner), true);
});
check("rejected senders recorded with short preview", () => {
  const s = store.emptyState();
  store.recordPendingSender(s, { from_user_id: "x", text: "a".repeat(100) });
  store.recordPendingSender(s, { from_user_id: "x", text: "again" });
  assert.equal(s.pendingSenders.length, 1);
  assert.equal(s.pendingSenders[0].preview, "again");
  assert.ok(store.recordPendingSender(s, { from_user_id: "y", text: "b".repeat(100) }).pendingSenders[0].preview.length <= 30);
});

// 4. state file permissions on first write
store.updateState((s) => { s.accounts.push({ ...store.emptyAccount(), token: "SECRET_TOKEN" }); return s; });
store.saveGlobalWake("https://wake", "WAKE_KEY");
check("account.json and wake.json are 0600", () => {
  assert.equal(fs.statSync(path.join(stateHome, "account.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(stateHome, "wake.json")).mode & 0o777, 0o600);
});

// 3. MCP host log has metadata only (no accounts, so no monitor is spawned and nothing hits iLink)
store.updateState((s) => { s.accounts = []; return s; });
const rpc = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wechat_set_wake", arguments: { url: "https://127.0.0.1:1/wake", key: "LEAKME_KEY" } } },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wechat_status", arguments: {} } },
].map((m) => JSON.stringify(m)).join("\n") + "\n";
const before = fs.existsSync("/workspace/.grok-wechat");
spawnSync(process.execPath, [path.join(PLUGIN, "server/index.js")], {
  input: rpc, env: { ...process.env, GROK_WECHAT_NO_AUTO_UNINSTALL: "1" }, timeout: 8000,
});
check("no monitor spawned during verification", () => {
  assert.equal(store.monitorRunning(), 0);
});
check("host log contains no secrets or message content", () => {
  const log = fs.readFileSync(path.join(stateHome, "mcp-host.log"), "utf8");
  assert.ok(log.includes("tool=wechat_status"));
  for (const secret of ["LEAKME_KEY", "SECRET_TOKEN", "WAKE_KEY", "attacker"]) assert.ok(!log.includes(secret), secret);
  assert.equal(fs.existsSync("/workspace/.grok-wechat"), before, "must not create /workspace/.grok-wechat");
});

// 5. uninstall keeps unrelated shell lines
fs.writeFileSync(path.join(home, ".bashrc"), [
  "export MY_GROK_WECHAT_NOTES=1",
  "alias gw='echo grok-wechat fan'",
  `[ -x ${stateHome}/ensure-monitor.sh ] && ${stateHome}/ensure-monitor.sh`,
  "node /home/box/grok-wechat-plugin/server/index.js --ensure-monitor",
].join("\n") + "\n");
const un = await import(path.join(PLUGIN, "server/uninstall.js"));
un.removeAutostartEntries();
check("uninstall only strips plugin autostart lines", () => {
  const rc = fs.readFileSync(path.join(home, ".bashrc"), "utf8");
  assert.ok(rc.includes("MY_GROK_WECHAT_NOTES") && rc.includes("grok-wechat fan"));
  assert.ok(!rc.includes("ensure-monitor") && !rc.includes("grok-wechat-plugin/"));
  assert.ok(!un.knownStateHomes().includes("/workspace/.grok-wechat"));
});

check("verification leaves no deferred uninstall behind", () => {
  const ps = spawnSync("sh", ["-c", "ps -eo args | grep -c '[s]leep 3' || true"], { encoding: "utf8" });
  assert.equal(ps.stdout.trim(), "0");
});

check("uninstall also removes legacy /workspace/.grok-wechat", () => {
  const src = fs.readFileSync(path.join(PLUGIN, "server/uninstall.js"), "utf8");
  assert.ok(src.includes('LEGACY_STATE_DIRS = ["/workspace/.grok-wechat"]') && src.includes("...LEGACY_STATE_DIRS"));
});

fs.rmSync(home, { recursive: true, force: true });
console.log(results.join("\n"));
console.log(`ALL ${results.length} CHECKS PASSED`);
