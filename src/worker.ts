// Cloudflare Worker: runs the two-way sync on a cron schedule.
// GET /setup?key=<STATUS_KEY> connects kinopub and Stremio from the browser.
// GET /status?key=<STATUS_KEY> shows the last runs (handy from a phone).
// /<STATUS_KEY>/manifest.json is a Stremio stream add-on that plays from kinopub.
import { KVStore } from "./store.ts";
import { Kinopub, notifyDevice, pollDeviceAuth, startDeviceAuth, type KpTokens } from "./kinopub.ts";
import { Stremio, installAddon, isAddonInstalled } from "./stremio.ts";
import type { SyncState } from "./migrate.ts";
import { setupPage } from "./setup-page.ts";
import { runSync } from "./sync.ts";
import { MANIFEST, proxyHls, streamsFor } from "./streams.ts";

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

async function addon(env: Env, path: string, base: string): Promise<Response> {
  if (path === "manifest.json") return json(MANIFEST, 3600);
  const h = path.match(/^hls\/([A-Za-z0-9_-]+)\.m3u8$/);
  if (h) return (await proxyHls(h[1])) ?? new Response("Not found", { status: 404, headers: CORS });
  const m = path.match(/^stream\/(movie|series)\/([^/]+)\.json$/);
  if (!m) return new Response("Not found", { status: 404, headers: CORS });
  try {
    const streams = await streamsFor(new Kinopub(new KVStore(env.STATE)), env.STATE, m[1], decodeURIComponent(m[2]), `${base}hls/`);
    return json({ streams, cacheMaxAge: streams.length ? 3600 : 600 });
  } catch (e: any) {
    console.error("stream", m[2], e?.message ?? e);
    return json({ streams: [] });
  }
}

async function sync(env: Env): Promise<void> {
  const store = new KVStore(env.STATE);
  const authKey = await store.get<string>("stremio_auth");
  // not set up yet: stay quiet (no log entry, no KV write every 5 minutes)
  if (!authKey || !(await env.STATE.get("kp_tokens"))) return;
  let entry: RunLog;
  try {
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

const html = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
const fail = (error: string, status = 400) => Response.json({ error }, { status });

const NO_KEY_PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Кинопаб ⇄ Stremio</title><style>body{margin:0;padding:24px 16px;font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:auto;color-scheme:light dark}</style></head>
<body><h1>Почти готово</h1><p>Задайте секрет <code>STATUS_KEY</code> — длинную случайную строку: в панели Cloudflare откройте этот воркер → Settings → Variables and Secrets → Add → Secret. Затем откройте <code>/setup?key=&lt;ваш ключ&gt;</code>.</p></body></html>`;

/** POST /setup/… handlers; the key is already checked. */
async function setupAction(env: Env, path: string, req: Request, origin: string): Promise<Response> {
  const store = new KVStore(env.STATE);
  const body: any = await req.json().catch(() => ({}));
  const manifestUrl = `${origin}/${env.STATUS_KEY}/manifest.json`;
  try {
    if (path === "/setup/kp-start") return Response.json(await startDeviceAuth());
    if (path === "/setup/kp-poll") {
      if (typeof body.code !== "string") return fail("нет кода");
      const tokens: KpTokens | null = await pollDeviceAuth(body.code);
      if (!tokens) return Response.json({ ok: false });
      await store.put("kp_tokens", tokens);
      await notifyDevice(tokens.access_token, "Stremio (синхронизация)");
      return Response.json({ ok: true });
    }
    if (path === "/setup/stremio") {
      if (typeof body.authKey !== "string" || !body.authKey) return fail("нет ключа");
      await new Stremio(body.authKey).library(); // checks the key
      await store.put("stremio_auth", body.authKey);
      await installAddon(body.authKey, manifestUrl);
      return Response.json({ ok: true });
    }
    if (path === "/setup/install") {
      const authKey = await store.get<string>("stremio_auth");
      if (!authKey) return fail("сначала войдите в Stremio");
      await installAddon(authKey, manifestUrl);
      return Response.json({ ok: true });
    }
  } catch (e: any) {
    return fail(String(e?.message ?? e), 502);
  }
  return fail("not found", 404);
}

async function setupInfoPage(env: Env, origin: string): Promise<Response> {
  const store = new KVStore(env.STATE);
  const [kp, authKey, state, log] = await Promise.all([
    env.STATE.get("kp_tokens"),
    store.get<string>("stremio_auth"),
    store.get<SyncState>("sync"),
    store.get<RunLog[]>("log"),
  ]);
  const manifestUrl = `${origin}/${env.STATUS_KEY}/manifest.json`;
  const addon = authKey ? await isAddonInstalled(authKey, manifestUrl).catch(() => false) : false;
  const last = log?.find((r) => !r.error);
  return html(
    setupPage({
      key: env.STATUS_KEY,
      kp: !!kp,
      stremio: !!authKey,
      addon,
      manifestUrl,
      titles: Object.keys(state?.items ?? {}).length,
      waiting: Object.keys(state?.pending ?? {}).length,
      scanning: !!state?.historyScan,
      lastRun: last ? new Date(last.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : null,
    }),
  );
}

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
      return addon(env, url.pathname.slice(prefix.length), url.origin + prefix);
    }
    if (!env.STATUS_KEY) return url.pathname === "/" ? html(NO_KEY_PAGE) : new Response("Not found", { status: 404 });
    if (!/^[A-Za-z0-9_-]{12,}$/.test(env.STATUS_KEY)) {
      return html(NO_KEY_PAGE.replace("Задайте секрет", "Ключ должен быть не короче 12 символов, только латиница, цифры, «-» и «_». Замените секрет"), 500);
    }
    if (url.searchParams.get("key") !== env.STATUS_KEY) return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/setup/") && req.method === "POST") return setupAction(env, url.pathname, req, url.origin);
    if (url.pathname === "/setup" || url.pathname === "/") return setupInfoPage(env, url.origin);
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
    const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Синхронизация</title><style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#222;--card:#fff;--muted:#777;--err:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--card:#1e1e1e;--muted:#999;--err:#ef9a9a}}
body{margin:0;padding:16px;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:20px;margin:0 0 12px}section{background:var(--card);border-radius:10px;padding:10px 12px;margin:0 0 10px}
time{display:block;color:var(--muted);font-size:13px;margin-bottom:4px}.err{color:var(--err)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:0;background:#2e7dff;color:#fff;margin-bottom:14px}
</style></head><body><h1>Кинопаб ⇄ Stremio</h1>
<p>${cronLine} <a href="/setup?key=${encodeURIComponent(env.STATUS_KEY)}">Настройка</a></p>
<form method="post" action="/run?key=${encodeURIComponent(env.STATUS_KEY)}"><button>Синхронизировать сейчас</button></form>
${rows || "<p>Пока ничего не менялось. Синхронизация идёт каждые 5 минут.</p>"}</body></html>`;
    return html(page);
  },
};
