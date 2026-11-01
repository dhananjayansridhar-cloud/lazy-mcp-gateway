#!/usr/bin/env node
// Lazy MCP gateway. Instead of handing the model every upstream tool schema
// (rea alone is ~200k tokens), it exposes five small tools:
//   find_tools / describe_tool / call_tool  -> upstream MCP servers, started on demand
//   find_skills / load_skill                -> SKILL.md folders, loaded on demand
// Configuration (first found wins): --config <file>, TOOL_GATEWAY_CONFIG, ./lazy-mcp.config.json,
// ~/.config/lazy-mcp-gateway/config.json. Format: { "servers": { name: { "command": [...] | "url": "..." , "env": {} } },
// "gateway": ["name", ...] }  ("gateway" optional: which servers to serve; default all). --servers a,b or TOOL_GATEWAY_SERVERS override it.
// Tool lists are cached in ./cache so searching does not start servers; a server is only launched when one of its tools is called.
//
// CLI (for testing / prebuilding the cache):
//   node gateway.mjs --index [--force] [server ...]
//   node gateway.mjs --search "query"      node gateway.mjs --skills "query"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const VERSION = "1.1.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const cacheDir = path.join(here, "cache");
// Sized for a 32k-token local context: 16000 chars is about 4k tokens per result.
const maxChars = Number(process.env.TOOL_GATEWAY_MAX_CHARS) || 16000;
const connectTimeoutMs = Number(process.env.TOOL_GATEWAY_CONNECT_TIMEOUT_MS) || 180000;
const skillDirs = (process.env.TOOL_GATEWAY_SKILL_DIRS || [path.join(home, ".claude", "skills"), path.join(home, ".agents", "skills")].join(path.delimiter))
  .split(path.delimiter).filter(Boolean);

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

// ---------- upstream servers ----------
const configCandidates = [flag("--config"), process.env.TOOL_GATEWAY_CONFIG, path.join(process.cwd(), "lazy-mcp.config.json"),
  path.join(here, "lazy-mcp.config.json"), path.join(home, ".config", "lazy-mcp-gateway", "config.json")].filter(Boolean);
const configPath = configCandidates.find((p) => fs.existsSync(p));
// Legacy layout (separate server list and selection files) is still read when no config file exists.
const legacyServers = path.join(home, ".agents", "mcp-servers.json"), legacySelect = path.join(home, ".agents", "dsh-tools.json");
const config = configPath ? readJson(configPath, {}) : { servers: readJson(legacyServers, { servers: {} }).servers, gateway: readJson(legacySelect, null)?.gateway };
if (!configPath && !fs.existsSync(legacyServers) && !args.some((a) => ["--import", "--init", "--help", "-h"].includes(a))) console.error("lazy-mcp-gateway: no config found. Copy lazy-mcp.config.example.json to lazy-mcp.config.json (see README).");
const master = config.servers ?? {};
const selected = (() => {
  const list = flag("--servers") ?? process.env.TOOL_GATEWAY_SERVERS;
  if (list) return list.split(",").map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(config.gateway)) return config.gateway;
  return Object.keys(master).filter((n) => !master[n].oauth); // the gateway has no OAuth login
})();
const servers = Object.fromEntries(selected.filter((n) => master[n]).map((n) => [n, master[n]]));

const clients = new Map(); // name -> Promise<Client>
const errors = {};

const withTimeout = (p, ms, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
]);

function connect(name) {
  if (clients.has(name)) return clients.get(name);
  const def = servers[name];
  if (!def) return Promise.reject(new Error(`unknown server "${name}". Known: ${Object.keys(servers).join(", ")}`));
  const p = (async () => {
    let transport;
    if (def.url) transport = new StreamableHTTPClientTransport(new URL(def.url));
    else {
      // npx and other .cmd shims cannot be spawned directly on Windows.
      const cmd = process.platform === "win32" && !/\.exe$/i.test(def.command[0]) && def.command[0] !== "node"
        ? ["cmd.exe", "/d", "/c", ...def.command] : def.command;
      transport = new StdioClientTransport({
        command: cmd[0], args: cmd.slice(1), env: { ...process.env, ...(def.env ?? {}) }, stderr: "ignore",
      });
    }
    const client = new Client({ name: "tool-gateway", version: VERSION });
    client.onclose = () => clients.delete(name);
    await withTimeout(client.connect(transport), connectTimeoutMs, `starting ${name}`);
    return client;
  })();
  clients.set(name, p);
  p.catch(() => clients.delete(name));
  return p;
}

const cacheFile = (name) => path.join(cacheDir, `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
const cacheKey = (name) => JSON.stringify(servers[name]);

async function indexServer(name, force = false) {
  const cached = readJson(cacheFile(name), null);
  if (!force && cached?.key === cacheKey(name)) return cached.tools;
  const client = await connect(name);
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema })));
    cursor = page.nextCursor;
  } while (cursor);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile(name), JSON.stringify({ key: cacheKey(name), updated: new Date().toISOString(), tools }));
  return tools;
}

// Returns {server: tools[]} for every server that could be indexed.
async function catalog(only) {
  const names = only ? [only] : Object.keys(servers);
  const out = {};
  await Promise.all(names.map(async (n) => {
    try { out[n] = await indexServer(n); delete errors[n]; } catch (e) { errors[n] = e.message; }
  }));
  return out;
}

// ---------- search ----------
const STOP = new Set(["a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "from", "by", "is", "it", "my", "me", "i", "tool", "tools"]);
const terms = (q) => String(q ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
const has = (hay, t) => hay.includes(t) || (t.length > 6 && hay.includes(t.slice(0, 5)));

function score(q, name, text, extra = "") {
  const ts = terms(q);
  if (!ts.length) return 0;
  const n = name.toLowerCase().replace(/[_-]+/g, " ");
  const d = text.toLowerCase();
  let s = 0, hit = 0;
  for (const t of ts) {
    const inName = has(n, t), inText = has(d, t), inExtra = has(extra, t);
    if (inName || inText || inExtra) hit++;
    s += (inName ? 3 : 0) + (inText ? 1 : 0) + (inExtra ? 2 : 0);
  }
  if (n.includes(ts.join(" "))) s += 5;
  return s * (hit / ts.length); // favour results matching more of the query
}

// ---------- optional semantic ranking ----------
// Optional: embeddings from any OpenAI-compatible /v1/embeddings server (TOOL_GATEWAY_EMBED_URL, default http://127.0.0.1:8083/v1). Document vectors are cached on disk;
// a first fill of more than 40 documents runs in the background and that query is answered by keywords only. Without the embedder, nothing changes.
const EMB = process.env.TOOL_GATEWAY_EMBED_URL || "http://127.0.0.1:8083/v1";
const embCachePath = path.join(cacheDir, "embeddings.json");
let embCache = readJson(embCachePath, {}), embUpAt = 0, embUp = false, embFill = null;
async function embedderUp() {
  if (Date.now() - embUpAt < 10000) return embUp;
  embUpAt = Date.now();
  try { embUp = (await fetch(EMB + "/models", { signal: AbortSignal.timeout(800) })).ok; } catch { embUp = false; }
  return embUp;
}
const h16 = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const unit = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => Math.round((x / s) * 1e4) / 1e4); };
async function embedBatch(inputs) {
  const r = await fetch(EMB + "/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "embed", input: inputs }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("embedder HTTP " + r.status);
  return (await r.json()).data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
async function fillCache(need) {
  for (let i = 0; i < need.length; i += 32) {
    const part = need.slice(i, i + 32), vs = await embedBatch(part.map((d) => d.text.slice(0, 1200)));
    part.forEach((d, k) => { embCache[h16(d.text)] = unit(vs[k]); });
  }
  try { fs.writeFileSync(embCachePath, JSON.stringify(embCache)); } catch {}
}
// Returns Map(id -> cosine similarity) or null when semantic ranking is not available right now.
async function semanticScores(query, docs) {
  if (!(await embedderUp())) return null;
  try {
    const need = docs.filter((d) => !embCache[h16(d.text)]);
    if (need.length > 40) { if (!embFill) embFill = fillCache(need).catch(() => {}).finally(() => { embFill = null; }); return null; }
    if (need.length) await fillCache(need);
    const q = unit((await embedBatch(["Instruct: Given what an AI agent needs to do, retrieve the tool or skill that fits\nQuery:" + query]))[0]);
    const out = new Map();
    for (const d of docs) { const v = embCache[h16(d.text)]; if (!v) continue; let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * q[i]; out.set(d.id, s); }
    return out;
  } catch { return null; }
}
// Reciprocal-rank fusion of the keyword ranking and the semantic ranking; semantic hits the keywords missed are added (top 12 within 0.15 of the best).
async function fuse(query, kw, docs, idOf, build) {
  const sem = await semanticScores(query, docs);
  if (!sem) return kw;
  const sorted = [...sem.entries()].sort((a, b) => b[1] - a[1]);
  const floor = Math.max(0.3, (sorted[0] ? sorted[0][1] : 0) - 0.15);
  const semRank = new Map(sorted.filter(([, s]) => s >= floor).slice(0, 12).map(([id], i) => [id, i]));
  const kwRank = new Map(kw.map((r, i) => [idOf(r), i])), byId = new Map(kw.map((r) => [idOf(r), r]));
  const out = [];
  for (const id of new Set([...kwRank.keys(), ...semRank.keys()])) {
    const r = byId.get(id) ?? build(id); if (!r) continue;
    out.push({ ...r, s: (kwRank.has(id) ? 1 / (60 + kwRank.get(id)) : 0) + (semRank.has(id) ? 1 / (60 + semRank.get(id)) : 0) });
  }
  return out.sort((a, b) => b.s - a.s);
}

const oneLine = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const argSummary = (schema) => {
  const props = schema?.properties ?? {};
  const req = new Set(schema?.required ?? []);
  const list = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? "*" : ""}:${v?.type ?? (v?.enum ? "enum" : "any")}`);
  return list.length ? list.join(", ") : "(none)";
};

// Shrinks huge schemas for describe_tool: long nested descriptions and examples
// are trimmed, structure (names, types, enums, required) is kept intact.
function compactSchema(v, depth = 0) {
  if (Array.isArray(v)) return v.map((x) => compactSchema(x, depth + 1));
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "$schema" || k === "examples") continue;
    if (k === "description" && typeof x === "string") out[k] = depth > 2 ? oneLine(x, 160) : oneLine(x, 600);
    else out[k] = compactSchema(x, depth + 1);
  }
  return out;
}

// ---------- skills ----------
function skillIndex() {
  const seen = new Map();
  for (const root of skillDirs) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const dir = path.join(root, e.name);
      const file = path.join(dir, "SKILL.md");
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const field = (k) => fm.match(new RegExp(`^${k}:\\s*(?:>-?|\\|-?)?\\s*["']?([\\s\\S]*?)["']?\\s*(?=^\\w[\\w-]*:|$(?![\\s\\S]))`, "m"))?.[1]?.replace(/\s+/g, " ").trim();
      const name = field("name") || e.name;
      if (!seen.has(name)) seen.set(name, { name, dir, description: field("description") ?? "" });
    }
  }
  return [...seen.values()];
}

function listFiles(dir, base = dir, out = [], depth = 0) {
  if (depth > 3 || out.length >= 60) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() || e.isSymbolicLink()) {
      try { if (fs.statSync(p).isDirectory()) { listFiles(p, base, out, depth + 1); continue; } } catch { continue; }
    }
    if (e.name !== "SKILL.md" || dir !== base) out.push(path.relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

// ---------- tool handlers ----------
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

// ---------- hierarchy: domains -> groups -> tools, skill categories ----------
const taxonomy = readJson(process.env.TOOL_GATEWAY_TAXONOMY || path.join(here, "taxonomy.json"), { domains: [], groups: {}, skillCategories: [], note: "" });
const compiled = {};
const rulesFor = (server) => (compiled[server] ??= (taxonomy.groups?.[server] ?? []).map((r) => ({ ...r, re: new RegExp(r.match, "i") })));
const groupIdOf = (server, toolName) => {
  const rules = rulesFor(server);
  if (!rules.length) return null;
  return rules.find((r) => r.re.test(toolName))?.id ?? "other";
};
function toolGroups(server, tools) {
  const rules = rulesFor(server);
  if (!rules.length) return null;
  const out = new Map(rules.map((r) => [r.id, { id: r.id, title: r.title, summary: r.summary ?? "", first: !!r.first, tools: [] }]));
  for (const t of tools) {
    const id = groupIdOf(server, t.name);
    if (!out.has(id)) out.set(id, { id, title: "Other", summary: "", tools: [] });
    out.get(id).tools.push(t);
  }
  return [...out.values()].filter((g) => g.tools.length).sort((a, b) => Number(b.first) - Number(a.first));
}
const toolRow = (t) => `- ${t.name}: ${oneLine(t.description, 150)}\n  args: ${argSummary(t.inputSchema)}`;

async function findTools({ query, server, group, limit }) {
  const cat = await catalog(server);
  const errs = Object.entries(errors).filter(([n]) => !server || n === server).map(([n, m]) => `  ${n}: unavailable (${m})`);
  const errText = errs.length ? "\n" + errs.join("\n") : "";
  if (!terms(query).length) {
    // Level 1: domains.
    if (!server) {
      const used = new Set();
      const lines = [];
      for (const d of taxonomy.domains ?? []) {
        const ss = d.servers.filter((n) => cat[n]);
        if (!ss.length) continue;
        ss.forEach((n) => used.add(n));
        lines.push(`- ${d.title} [${ss.map((n) => `${n}: ${cat[n].length} tools`).join(", ")}]\n  ${d.summary}`);
      }
      for (const n of Object.keys(cat)) if (!used.has(n)) lines.push(`- ${n}: ${cat[n].length} tools`);
      return text(`Tool domains:\n${lines.join("\n")}\n\nDrill down: find_tools(server) lists a server's groups, find_tools(server, group) lists tools. Or search directly: find_tools(query="...").${taxonomy.note ? `\n\nNot available here: ${taxonomy.note}` : ""}${errText}`);
    }
    const tools = cat[server];
    if (!tools) return text(`Server "${server}" is unavailable: ${errors[server] ?? "unknown server"}`, true);
    const groups = toolGroups(server, tools);
    // Level 2: groups of a big server (small servers list their tools directly).
    if (groups && !group) {
      const rows = groups.map((g) => `- ${g.id} (${g.tools.length}): ${g.title}. ${g.summary}\n  e.g. ${g.tools.slice(0, 4).map((t) => t.name).join(", ")}`);
      return text(`${server} groups:\n${rows.join("\n")}\n\nNext: find_tools(server="${server}", group="<id>") lists that group's tools.${errText}`);
    }
    // Level 3: tools.
    let list = tools;
    if (groups) {
      const g = groups.find((x) => x.id === String(group).toLowerCase());
      if (!g) return text(`No group "${group}" on ${server}. Groups: ${groups.map((x) => x.id).join(", ")}`, true);
      list = g.tools;
    }
    const shown = list.slice(0, 30).map(toolRow).join("\n");
    return text(`${shown}${list.length > 30 ? `\n…and ${list.length - 30} more; narrow with find_tools(query, server="${server}"${group ? `, group="${group}"` : ""}).` : ""}\n\nNext: call_tool(server, tool, arguments). describe_tool first if unsure of the arguments. (* = required)${errText}`);
  }
  const rows = [];
  for (const [srv, tools] of Object.entries(cat))
    for (const t of tools) {
      if (group && groupIdOf(srv, t.name) !== String(group).toLowerCase()) continue;
      const s = score(query, t.name, t.description, srv);
      if (s > 0) rows.push({ s, srv, t });
    }
  rows.sort((a, b) => b.s - a.s);
  const docs = [], lookup = new Map();
  for (const [srv, tools] of Object.entries(cat)) for (const t of tools) {
    if (group && groupIdOf(srv, t.name) !== String(group).toLowerCase()) continue;
    const id = srv + "/" + t.name; docs.push({ id, text: t.name + ": " + (t.description ?? "") }); lookup.set(id, { s: 0, srv, t });
  }
  const fused = await fuse(query, rows, docs, (r) => r.srv + "/" + r.t.name, (id) => lookup.get(id));
  rows.length = 0; rows.push(...fused);
  const top = rows.slice(0, Math.min(Math.max(Number(limit) || 8, 1), 25));
  if (!top.length) return text(`No tools matched "${query}". Try other words, or call find_tools with no query to list servers.${errs.length ? "\n" + errs.join("\n") : ""}`);
  const body = top.map(({ srv, t }) => `- server: ${srv}  tool: ${t.name}${groupIdOf(srv, t.name) ? `  [${groupIdOf(srv, t.name)}]` : ""}\n  ${oneLine(t.description, 240)}\n  args: ${argSummary(t.inputSchema)}`).join("\n");
  return text(`${body}\n\nNext: call_tool(server, tool, arguments). If unsure of the argument format, describe_tool(server, tool) first. (* = required)${errs.length ? "\n" + errs.join("\n") : ""}`);
}

async function describeTool({ server, tool }) {
  const tools = (await catalog(server))[server];
  if (!tools) return text(`Server "${server}" is unavailable: ${errors[server] ?? "unknown server"}`, true);
  const t = tools.find((x) => x.name === tool);
  if (!t) return text(`No tool "${tool}" on ${server}. Use find_tools to search.`, true);
  let schema = JSON.stringify(compactSchema(t.inputSchema), null, 1);
  if (schema.length > maxChars) schema = schema.slice(0, maxChars) + "\n…(schema truncated)";
  const sample = Object.fromEntries((t.inputSchema?.required ?? []).map((k) => [k, `<${t.inputSchema.properties?.[k]?.type ?? "value"}>`]));
  return text(`server: ${server}\ntool: ${t.name}\n\n${t.description}\n\ninput schema:\n${schema}\n\nexample: call_tool(server="${server}", tool="${t.name}", arguments=${JSON.stringify(sample)})`);
}

// server -> arguments of the last successful open_binary. Kept on disk so a gateway restart
// (crash, reboot, new agent session) can still reopen the file the model believes is open.
const lastOpenFile = path.join(here, "state", "last-open.json");
const lastOpen = readJson(lastOpenFile, {});
const saveLastOpen = () => {
  try { fs.mkdirSync(path.dirname(lastOpenFile), { recursive: true }); fs.writeFileSync(lastOpenFile, JSON.stringify(lastOpen)); } catch { /* best effort */ }
};
const rawCall = (client, name, args) => client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: 600000 });
const needsOpen = (r) => r.isError && /No app is open|target_unavailable/.test((r.content ?? []).map((c) => c.text ?? "").join("\n"));

async function callTool({ server, tool, arguments: toolArgs }) {
  if (!servers[server]) return text(`Unknown server "${server}". Known: ${Object.keys(servers).join(", ")}`, true);
  let client;
  try { client = await connect(server); } catch (e) { return text(`Could not start ${server}: ${e.message}`, true); }
  let result;
  let note = "";
  try {
    result = await rawCall(client, tool, toolArgs);
    if (tool === "open_binary" && !result.isError && toolArgs?.path) { lastOpen[server] = toolArgs; saveLastOpen(); }
    else if (tool === "close_binary" && !result.isError && lastOpen[server]) { delete lastOpen[server]; saveLastOpen(); } // closed on purpose
    else if (tool !== "open_binary" && lastOpen[server] && fs.existsSync(String(lastOpen[server].path)) && needsOpen(result)) {
      // rea holds the opened file in process memory; it was lost (restart or crash). Reopen once and retry.
      const reopened = await rawCall(client, "open_binary", lastOpen[server]);
      if (!reopened.isError) {
        result = await rawCall(client, tool, toolArgs);
        note = `(gateway reopened ${lastOpen[server].path}: rea had lost its open file)\n`;
      }
    }
  } catch (e) {
    return text(`${server}/${tool} failed: ${e.message}\nCheck the arguments with describe_tool("${server}", "${tool}").`, true);
  }
  const content = Array.isArray(result.content) ? [...result.content] : [];
  if (note) content.unshift({ type: "text", text: note });
  if (result.isError && tool !== "open_binary") {
    // Small models often mangle arguments for tools whose schema they never saw: say what is expected.
    const def = (await catalog(server))[server]?.find((x) => x.name === tool);
    if (def) content.push({ type: "text", text: `\n(expected arguments for ${tool}: ${argSummary(def.inputSchema)}; * = required)` });
  }
  if (!content.length && result.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 1) });
  // Keep huge results from flooding a small context window.
  let budget = maxChars;
  const out = [];
  for (const c of content) {
    if (c.type !== "text") { out.push(c); continue; }
    if (budget <= 0) continue;
    out.push(c.text.length > budget ? { type: "text", text: c.text.slice(0, budget) + `\n…(truncated ${c.text.length - budget} chars; ask for a narrower result)` } : c);
    budget -= c.text.length;
  }
  return { content: out.length ? out : [{ type: "text", text: "(no output)" }], ...(result.isError ? { isError: true } : {}) };
}

// A skill's category: the first rule matching its name.
let skillCats;
function categorise(skills) {
  skillCats ??= (taxonomy.skillCategories ?? []).map((c) => ({ ...c, re: new RegExp(c.match, "i") }));
  for (const s of skills) {
    s.category = skillCats.find((c) => c.re.test(s.name))?.id ?? "other";
  }
  return skills;
}

async function findSkills({ query, category, limit }) {
  const all = categorise(skillIndex());
  const hasQuery = terms(query).length > 0;
  const cat = category ? String(category).toLowerCase() : null;
  if (!hasQuery && !cat) {
    const titles = Object.fromEntries((taxonomy.skillCategories ?? []).map((c) => [c.id, c.title]));
    const groups = new Map();
    for (const s of all) (groups.get(s.category) ?? groups.set(s.category, []).get(s.category)).push(s);
    const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
      .map(([id, list]) => `- ${id} (${list.length}): ${titles[id] ?? "Other"}\n  e.g. ${list.slice(0, 4).map((s) => s.name).join(", ")}`);
    return text(`${all.length} skills in ${groups.size} categories:\n${rows.join("\n")}\n\nNext: find_skills(category="<id>") lists a category, or find_skills(query="...") searches all. Then load_skill(name).`);
  }
  const pool = cat ? all.filter((s) => s.category === cat) : all;
  if (cat && !pool.length) return text(`No category "${category}". Call find_skills with no arguments to list categories.`, true);
  const cap = Math.min(Math.max(Number(limit) || (hasQuery ? 8 : 40), 1), 40);
  let ranked = hasQuery
    ? pool.map((k) => ({ s: score(query, k.name, k.description), k })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s)
    : pool.map((k) => ({ s: 1, k })).sort((a, b) => a.k.name.localeCompare(b.k.name));
  if (hasQuery) ranked = await fuse(query, ranked, pool.map((k) => ({ id: k.name, text: k.name + ": " + (k.description ?? "") })), (r) => r.k.name, (id) => { const k = pool.find((x) => x.name === id); return k ? { s: 0, k } : null; });
  if (!ranked.length) return text(`No skills matched "${query}" (${pool.length} skills searched).`);
  const more = ranked.length > cap ? `\n…and ${ranked.length - cap} more; add a query to narrow.` : "";
  return text(ranked.slice(0, cap).map(({ k }) => `- ${k.name}${hasQuery ? ` [${k.category}]` : ""}: ${oneLine(k.description, hasQuery ? 260 : 110)}`).join("\n") + more + "\n\nNext: load_skill(name) to read one.");
}

// Long skills are read in pieces (offset) so one load cannot fill a small context window.
const slicePage = (body, offset) => {
  const start = Math.max(Number(offset) || 0, 0);
  const page = body.slice(start, start + maxChars);
  const end = start + page.length;
  const note = end < body.length ? `\n…(chars ${start}-${end} of ${body.length}; continue with offset=${end})` : "";
  return (start > 0 ? `(continuing at char ${start})\n` : "") + page + note;
};

function loadSkill({ name, file, offset }) {
  const skill = skillIndex().find((s) => s.name === name) ?? skillIndex().find((s) => path.basename(s.dir) === name);
  if (!skill) return text(`No skill named "${name}". Use find_skills to search.`, true);
  const root = fs.realpathSync(skill.dir);
  if (file) {
    const target = path.resolve(root, file);
    let real;
    try { real = fs.realpathSync(target); } catch { return text(`File not found in skill ${name}: ${file}`, true); }
    if (real !== root && !real.startsWith(root + path.sep)) return text("File must be inside the skill folder.", true);
    return text(slicePage(fs.readFileSync(real, "utf8"), offset));
  }
  const body = slicePage(fs.readFileSync(path.join(root, "SKILL.md"), "utf8"), offset);
  if (Number(offset) > 0) return text(body);
  const files = listFiles(root);
  const extra = files.length ? `\n\n---\nSkill folder: ${root}\nOther files (read with load_skill("${name}", file)):\n${files.map((f) => "  " + f).join("\n")}` : "";
  return text(body + extra);
}

// ---------- MCP server ----------
// A one-line outline in the tool descriptions tells the model what exists without a call.
const toolOutline = (taxonomy.domains ?? []).filter((d) => d.servers.some((n) => servers[n]))
  .map((d) => `${d.title.toLowerCase()} (${d.servers.filter((n) => servers[n]).join("/")})`).join("; ");
const skillOutline = (taxonomy.skillCategories ?? []).map((c) => c.id).join(", ");
const TOOLS = [
  {
    name: "find_tools",
    description: "Find external MCP tools that are NOT loaded directly (each server's tools are loaded on demand). Browse in levels: no arguments = domains; server = its groups; server+group = tools. Or search with query keywords. Returns server/tool names, a short description and argument names. Available: " + (toolOutline || Object.keys(servers).join(", ")) + ".",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "What you want to do, in a few keywords, e.g. 'decompile function'" },
      server: { type: "string", description: "Server to browse or search, e.g. rea" },
      group: { type: "string", description: "Group id inside the server, from find_tools(server)" },
      limit: { type: "number", description: "Max search results (default 8)" },
    } },
  },
  {
    name: "describe_tool",
    description: "Get the full description and input JSON schema of one tool found with find_tools.",
    inputSchema: { type: "object", properties: { server: { type: "string" }, tool: { type: "string" } }, required: ["server", "tool"] },
  },
  {
    name: "call_tool",
    description: "Run a tool found with find_tools. The server is started on first use (may take a while).",
    inputSchema: { type: "object", properties: {
      server: { type: "string" }, tool: { type: "string" },
      arguments: { type: "object", description: "Arguments for the tool, matching its input schema" },
    }, required: ["server", "tool"] },
  },
  {
    name: "find_skills",
    description: "Browse or search the skill library (SKILL.md playbooks, loaded on demand). No arguments = categories; category = its skills; query = keyword search. Use before starting a specialised task." + (skillOutline ? " Categories: " + skillOutline + "." : ""),
    inputSchema: { type: "object", properties: {
      query: { type: "string" }, category: { type: "string", description: "Category id from find_skills()" }, limit: { type: "number" },
    } },
  },
  {
    name: "load_skill",
    description: "Read a skill's instructions (SKILL.md), or one of its reference files via 'file'. Long files come in pieces: pass offset to continue. Follow the instructions it returns.",
    inputSchema: { type: "object", properties: {
      name: { type: "string" }, file: { type: "string", description: "Optional relative path of a file listed by load_skill" },
      offset: { type: "number", description: "Character offset to continue a long file" },
    }, required: ["name"] },
  },
];

const handlers = { find_tools: findTools, describe_tool: describeTool, call_tool: callTool, find_skills: findSkills, load_skill: loadSkill };

async function serve() {
  const server = new Server({ name: "tool-gateway", version: VERSION }, {
    capabilities: { tools: {} },
    instructions: "Extra tools and skills are available on demand, in levels. Tools: find_tools() lists domains, find_tools(server) its groups, find_tools(server, group) the tools, or find_tools(query) searches; then call_tool. Skills: find_skills() lists categories, find_skills(category) the skills, then load_skill. Start narrow and drill down; do not load more than you need.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const h = handlers[req.params.name];
    if (!h) return text(`Unknown tool ${req.params.name}`, true);
    try { return await h(req.params.arguments ?? {}); } catch (e) { return text(`gateway error: ${e.message}`, true); }
  });
  const shutdown = async () => {
    await Promise.allSettled([...clients.values()].map(async (p) => (await p).close()));
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await server.connect(new StdioServerTransport());
}

const HELP = `lazy-mcp-gateway __VERSION__: five small tools instead of every MCP tool schema and skill listing.

Run as an MCP server (what your AI client starts):   node gateway.mjs [--config file] [--servers a,b]
Set up (by hand, no AI needed):
  node gateway.mjs --import ~/.claude.json            copy the MCP servers you already use (Claude Code / Claude Desktop / Cursor / VS Code format) into lazy-mcp.config.json
  node gateway.mjs --init                             write a starter lazy-mcp.config.json
  node gateway.mjs --doctor                           check the config, the servers, the skills folders
  node gateway.mjs --index [--force] [server ...]     start the servers once and cache their tool lists (searching then never needs to start them)
Try it:
  node gateway.mjs --search "take a screenshot"       node gateway.mjs --skills "pdf"
Options: --config <file>  (or TOOL_GATEWAY_CONFIG)   --servers a,b  (or TOOL_GATEWAY_SERVERS)   --out <file> and --force for --import / --init
Env: TOOL_GATEWAY_SKILL_DIRS, TOOL_GATEWAY_MAX_CHARS, TOOL_GATEWAY_CONNECT_TIMEOUT_MS, TOOL_GATEWAY_EMBED_URL, TOOL_GATEWAY_TAXONOMY`.replace("__VERSION__", VERSION);

function writeConfig(cfg, force) {
  const out = path.resolve(flag("--out") ?? "lazy-mcp.config.json");
  if (fs.existsSync(out) && !force) { console.log("Not overwriting " + out + " (use --force)."); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
  return out;
}
function importServers() {
  const file = path.resolve(flag("--import") ?? "");
  const j = readJson(file, null);
  if (!j) { console.log("Cannot read " + file + " as JSON."); process.exit(1); }
  const found = { ...(j.mcpServers ?? j.servers ?? {}) };
  for (const p of Object.values(j.projects ?? {})) for (const [k, v] of Object.entries(p?.mcpServers ?? {})) found[k] ??= v;   // ~/.claude.json keeps project-scoped servers per project
  const out = {}, notes = [];
  for (const [name, d] of Object.entries(found)) {
    if (/gateway/i.test(name)) continue;   // never import a gateway into itself
    if (d.command) out[name] = { command: [d.command, ...(d.args ?? [])], ...(d.env && Object.keys(d.env).length ? { env: d.env } : {}) };
    else if (d.url) { out[name] = { url: d.url }; if (d.headers) notes.push(name + ": its custom headers (logins) cannot be passed by the gateway; add them via a local proxy or keep this server in your client directly"); }
    else notes.push(name + ": skipped (no command or url)");
  }
  const target = writeConfig({ servers: out, gateway: Object.keys(out) }, args.includes("--force"));
  console.log("Imported " + Object.keys(out).length + " server(s) into " + target + ": " + Object.keys(out).join(", "));
  for (const n of notes) console.log("  note: " + n);
  console.log("Next: node gateway.mjs --doctor   then add the gateway to your client (see README), and remove the imported servers from the client so only the gateway is listed.");
  process.exit(0);
}
function whichCmd(c) {
  if (path.isAbsolute(c)) return fs.existsSync(c);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return (process.env.PATH ?? "").split(path.delimiter).some((d) => exts.some((e) => fs.existsSync(path.join(d, c + e))));
}
function doctor() {
  let bad = 0; const ok = (m) => console.log("  ok    " + m), no = (m) => { bad++; console.log("  FIX   " + m); };
  console.log("lazy-mcp-gateway " + VERSION + "   node " + process.version);
  configPath ? ok("config: " + configPath) : (fs.existsSync(legacyServers) ? ok("legacy config: " + legacyServers) : no("no config found: run  node gateway.mjs --init  or  --import <your client's json>"));
  const names = Object.keys(servers);
  names.length ? ok(names.length + " server(s) served: " + names.join(", ")) : no("no servers selected");
  for (const n of names) {
    const d = servers[n], cache = readJson(cacheFile(n), null);
    if (d.command && !whichCmd(d.command[0])) no(n + ": command \"" + d.command[0] + "\" not found on PATH");
    else ok(n + ": " + (d.url ? "remote " + d.url : "local " + d.command.join(" ").slice(0, 60)) + (cache?.tools ? ", " + cache.tools.length + " tools cached" : ", not indexed yet (node gateway.mjs --index)"));
  }
  for (const n of selected) if (!master[n]) no("\"" + n + "\" is selected but not defined under \"servers\"");
  let skills = 0; for (const d of skillDirs) { if (!fs.existsSync(d)) continue; try { skills += listSkillNames(d); } catch { /* ignore */ } }
  ok(skillDirs.filter((d) => fs.existsSync(d)).length + " skills folder(s) found (" + skills + " skills): " + skillDirs.join(", "));
  console.log(bad ? "\n" + bad + " thing(s) to fix." : "\nAll good. Next: add the gateway to your client (README, step 3).");
  process.exit(bad ? 1 : 0);
}
function listSkillNames(dir, depth = 0) {
  let n = 0; let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of es) { if (e.name.startsWith(".") || e.name === "node_modules") continue; const p = path.join(dir, e.name); if (e.isFile() && e.name === "SKILL.md") n++; else if ((e.isDirectory() || e.isSymbolicLink()) && depth < 3) n += listSkillNames(p, depth + 1); }
  return n;
}

async function cli() {
  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }
  if (flag("--import") !== undefined) importServers();
  if (args.includes("--init")) { const t = writeConfig(JSON.parse(fs.readFileSync(path.join(here, "lazy-mcp.config.example.json"), "utf8")), args.includes("--force")); console.log("Wrote " + t + ". Edit it, then run:  node gateway.mjs --doctor"); process.exit(0); }
  if (args.includes("--doctor")) doctor();
  const print = (r) => console.log(r.content.map((c) => c.text ?? `[${c.type}]`).join("\n"));
  if (args.includes("--index")) {
    const names = args.filter((a) => !a.startsWith("--") && a !== flag("--servers"));
    for (const n of names.length ? names : Object.keys(servers)) {
      try { console.log(`${n}: ${(await indexServer(n, args.includes("--force"))).length} tools`); }
      catch (e) { console.log(`${n}: FAILED ${e.message}`); }
    }
  } else if (args.includes("--browse")) {
    const [server, group] = args.filter((a) => !a.startsWith("--"));
    print(await findTools({ server, group }));
  } else if (args.includes("--skillcats")) {
    print(await findSkills({ category: args.filter((a) => !a.startsWith("--"))[0] }));
  } else if (flag("--search") !== undefined) print(await findTools({ query: flag("--search") }));
  else if (flag("--skills") !== undefined) print(await findSkills({ query: flag("--skills") }));
  else if (args.includes("--tools-json")) console.log(JSON.stringify(TOOLS));
  if (embFill) await embFill;   // let a first embedding fill finish before the CLI exits
  await Promise.allSettled([...clients.values()].map(async (p) => (await p).close()));
  process.exit(0);
}

if (args.some((a) => ["--index", "--search", "--skills", "--tools-json", "--browse", "--skillcats", "--import", "--init", "--doctor", "--help", "-h"].includes(a))) cli();
else serve();
