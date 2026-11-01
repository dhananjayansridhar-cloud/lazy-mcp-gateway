// Smoke test: no network, no real MCP servers. Starts the gateway as an MCP server over stdio with a throwaway config and checks the five tools,
// then checks --import and --doctor. Run with:  npm test
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const gw = path.join(root, "gateway.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-mcp-test-"));
let failed = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + extra)); if (!cond) failed++; };

// 1. --import converts a client's mcpServers (and skips the gateway itself)
const client = path.join(tmp, "client.json");
fs.writeFileSync(client, JSON.stringify({ mcpServers: { files: { command: "node", args: ["server.js"], env: { A: "1" } }, docs: { type: "http", url: "https://example.invalid/mcp" }, "lazy-mcp-gateway": { command: "node", args: ["gateway.mjs"] } } }));
const cfgFile = path.join(tmp, "lazy-mcp.config.json");
const imp = spawnSync(process.execPath, [gw, "--import", client, "--out", cfgFile], { encoding: "utf8" });
const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
check("--import writes the servers", imp.status === 0 && cfg.servers.files.command.join(" ") === "node server.js" && cfg.servers.docs.url.includes("example.invalid"), imp.stdout + imp.stderr);
check("--import skips the gateway itself", !("lazy-mcp-gateway" in cfg.servers));
check("--import refuses to overwrite without --force", spawnSync(process.execPath, [gw, "--import", client, "--out", cfgFile], { encoding: "utf8" }).status === 1);

// 2. --doctor reports a missing command
const doc = spawnSync(process.execPath, [gw, "--doctor", "--config", cfgFile], { encoding: "utf8", env: { ...process.env, PATH: "" } });
check("--doctor flags what to fix", doc.status === 1 && /FIX/.test(doc.stdout), doc.stdout);

// 3. MCP over stdio: initialize, tools/list -> exactly the five tools; find_tools answers without starting any server
const p = spawn(process.execPath, [gw, "--config", cfgFile], { stdio: ["pipe", "pipe", "ignore"] });
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
let buf = ""; const waiters = new Map();
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch { /* not json */ } } });
const rpc = (id, method, params) => new Promise((ok, bad) => { waiters.set(id, ok); send({ jsonrpc: "2.0", id, method, params }); setTimeout(() => bad(new Error("timeout " + method)), 15000); });
try {
  await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tl = await rpc(2, "tools/list");
  const names = tl.result.tools.map((t) => t.name).sort().join(",");
  check("exposes exactly the five tools", names === "call_tool,describe_tool,find_skills,find_tools,load_skill", names);
  const size = JSON.stringify(tl.result.tools).length;
  check("tool list stays small (< 6 KB)", size < 6000, size + " bytes");
  const ft = await rpc(3, "tools/call", { name: "find_skills", arguments: { query: "anything" } });
  check("find_skills answers", Array.isArray(ft.result?.content));
} catch (e) { check("MCP session", false, String(e.message)); }
p.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "\n" + failed + " failed" : "\nall passed");
process.exit(failed ? 1 : 0);
