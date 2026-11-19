// Cloudflare Worker: runs the two-way sync on a cron schedule.
// GET /status?key=<STATUS_KEY> shows the last runs (handy from a phone).
// /<STATUS_KEY>/manifest.json is a Stremio stream add-on that plays from kinopub.
import { KVStore } from "./store.ts";
import { Kinopub } from "./kinopub.ts";
import { Stremio } from "./stremio.ts";
import { runSync } from "./sync.ts";
import { MANIFEST, streamsFor } from "./streams.ts";

interface Env {
  STATE: KVNamespace;
  STATUS_KEY: string;
}

interface RunLog {
  at: string;
  lines: string[];
  error?: string;
}

// The cron refreshes the kinopub token well before it expires, so stream requests never
// need to: refresh tokens rotate, and two concurrent refreshes would log the worker out.
const REFRESH_AHEAD = 2 * 3600;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const json = (body: unknown, maxAge = 0) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `max-age=${maxAge}`, ...CORS },
  });

async function addon(env: Env, path: string): Promise<Response> {
  if (path === "manifest.json") return json(MANIFEST, 3600);
  const m = path.match(/^stream\/(movie|series)\/([^/]+)\.json$/);
  if (!m) return new Response("Not found", { status: 404, headers: CORS });
  try {
    const streams = await streamsFor(new Kinopub(new KVStore(env.STATE)), env.STATE, m[1], decodeURIComponent(m[2]));
    return json({ streams, cacheMaxAge: streams.length ? 3600 : 600 });
  } catch (e: any) {
    console.error("stream", m[2], e?.message ?? e);
    return json({ streams: [] });
  }
}

async function sync(env: Env): Promise<void> {
  const store = new KVStore(env.STATE);
  const authKey = await store.get<string>("stremio_auth");
  let entry: RunLog;
  try {
    if (!authKey) throw new Error("Stremio не подключён");
    const lines = await runSync(store, new Kinopub(store, REFRESH_AHEAD), new Stremio(authKey), { budget: 45 });
    entry = { at: new Date().toISOString(), lines };
  } catch (e: any) {
    entry = { at: new Date().toISOString(), lines: [], error: String(e?.message ?? e) };
  }
  // keep a short log of runs that did something or failed (saves KV writes)
  if (entry.lines.length || entry.error) {
    const log = (await store.get<RunLog[]>("log")) ?? [];
    log.unshift(entry);
    await store.put("log", log.slice(0, 50));
  }
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        // heartbeat for the status page; at most one KV write per hour
        const last = Number((await env.STATE.get("cron_at")) ?? 0);
        if (Date.now() - last > 3600_000) await env.STATE.put("cron_at", String(Date.now()));
        await sync(env);
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const prefix = `/${env.STATUS_KEY}/`;
    if (env.STATUS_KEY && url.pathname.startsWith(prefix)) {
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      return addon(env, url.pathname.slice(prefix.length));
    }
    if (!env.STATUS_KEY || url.searchParams.get("key") !== env.STATUS_KEY) return new Response("Not found", { status: 404 });
    if (url.pathname === "/run" && req.method === "POST") {
      await sync(env);
      return Response.redirect(`${url.origin}/status?key=${env.STATUS_KEY}`, 303);
    }
    const log = (await new KVStore(env.STATE).get<RunLog[]>("log")) ?? [];
    const cronAt = Number((await env.STATE.get("cron_at")) ?? 0);
    const cronLine = cronAt
      ? `Автоматические запуски работают (отметка от ${new Date(cronAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}).`
      : "Автоматических запусков пока не было.";
    const rows = log
      .map((r) => {
        const when = new Date(r.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
        const body = r.error ? `<b class="err">Ошибка: ${esc(r.error)}</b>` : r.lines.map((l) => `<div>${esc(l)}</div>`).join("");
        return `<section><time>${when}</time>${body}</section>`;
      })
      .join("");
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Синхронизация</title><style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#222;--card:#fff;--muted:#777;--err:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--card:#1e1e1e;--muted:#999;--err:#ef9a9a}}
body{margin:0;padding:16px;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:20px;margin:0 0 12px}section{background:var(--card);border-radius:10px;padding:10px 12px;margin:0 0 10px}
time{display:block;color:var(--muted);font-size:13px;margin-bottom:4px}.err{color:var(--err)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:0;background:#2e7dff;color:#fff;margin-bottom:14px}
</style></head><body><h1>Кинопаб ⇄ Stremio</h1>
<p>${cronLine}</p>
<form method="post" action="/run?key=${encodeURIComponent(env.STATUS_KEY)}"><button>Синхронизировать сейчас</button></form>
${rows || "<p>Пока ничего не менялось. Синхронизация идёт каждые 5 минут.</p>"}</body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
