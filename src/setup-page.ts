// Setup page of the sync worker (/setup?key=…): connects kinopub (device code on
// kino.pub/device) and Stremio (official link.stremio.com code, same as on a TV), then
// installs the "Кинопаб" stream add-on. Everything lands in this Worker's own KV, on the
// owner's own Cloudflare account. No password is typed anywhere.

export interface SetupInfo {
  key: string;
  fresh: boolean; // key generated just now
  keyFromKv: boolean; // generated key (not the STATUS_KEY secret)
  kp: boolean;
  stremio: boolean;
  addon: boolean;
  manifestUrl: string;
  titles: number;
  waiting: number;
  scanning: boolean;
  lastRun: string | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function setupPage(i: SetupInfo): string {
  const q = `?key=${encodeURIComponent(i.key)}`;
  const done = (ok: boolean) => (ok ? `<span class="ok">✓ подключено</span>` : `<span class="muted">не подключено</span>`);
  const syncLine = !(i.kp && i.stremio)
    ? "Начнётся, когда подключите кинопаб и Stremio."
    : [
        `В синхронизации ${i.titles} фильмов и сериалов.`,
        i.waiting ? `Ещё ${i.waiting} ждут переноса — переносятся понемногу каждые 5 минут.` : "",
        i.scanning ? "Просматривается история кинопаба, чтобы найти всё из «Я смотрю»." : "",
        i.lastRun ? `Последние изменения: ${esc(i.lastRun)}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Кинопаб ⇄ Stremio</title><style>
:root{color-scheme:light dark;--bg:#f6f6f8;--fg:#1d1d1f;--card:#fff;--muted:#6e6e73;--accent:#2e7dff;--ok:#2e7d32;--err:#c62828;--line:#d8d8de}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#f2f2f4;--card:#1f1f23;--muted:#a1a1a6;--ok:#81c784;--err:#ef9a9a;--line:#38383d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
main{max-width:520px;margin:16px auto}h1{font-size:22px;margin:0 0 4px}
section{background:var(--card);border-radius:14px;padding:16px 18px;margin:12px 0}
h2{font-size:17px;margin:0 0 6px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.muted{color:var(--muted)}.ok{color:var(--ok);font-weight:600}.err{color:var(--err)}small{font-size:14px}
.code{font:700 34px/1 ui-monospace,monospace;letter-spacing:.12em;margin:10px 0}
.qr{display:block;width:150px;height:150px;margin:6px 0 10px;background:#fff;border-radius:8px}
.btn{display:inline-block;padding:10px 16px;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:10px;text-decoration:none;cursor:pointer}
.btn.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
button:disabled{opacity:.6}[hidden]{display:none!important}a{color:var(--accent)}
input{width:100%;padding:9px 11px;font:13px ui-monospace,monospace;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px}
</style></head><body><main>
<h1>Кинопаб ⇄ Stremio</h1>
${
    i.fresh
      ? `<section style="border:2px solid var(--accent)"><b>Сохраните адрес этой страницы в закладки.</b><br><small>В нём ваш личный ключ — только так сюда можно попасть. Никому его не показывайте: с ним можно смотреть по вашей подписке.</small></section>`
      : ""
  }
<p class="muted"><small>Ваш личный сервер на вашем аккаунте Cloudflare. Входы и данные хранятся только здесь. Адрес этой страницы с ключом — пароль от неё, не делитесь им.${
    i.keyFromKv
      ? " Если потеряете адрес: панель Cloudflare → Storage & databases → Workers KV → хранилище этого воркера → ключ <code>status_key</code>, и откройте <code>/setup?key=…</code> с этим значением."
      : ""
  }</small></p>

<section>
  <h2>1. Кинопаб ${done(i.kp)}</h2>
  <div id="kp-idle">
    <p class="muted"><small>Нужна активная подписка. Вход как на телевизоре: код вводится на сайте кинопаба.</small></p>
    <button class="btn ${i.kp ? "secondary" : ""}" id="kp-start">${i.kp ? "Войти заново" : "Войти в кинопаб"}</button>
  </div>
  <div id="kp-code" hidden>
    <p>Откройте <a id="kp-link" href="https://kino.pub/device" target="_blank" rel="noopener">kino.pub/device</a> и введите код:</p>
    <div class="code" id="kp-user-code">····</div>
    <p class="muted"><small id="kp-status">Жду подтверждения…</small></p>
  </div>
</section>

<section>
  <h2>2. Stremio ${done(i.stremio)}</h2>
  <div id="st-idle">
    <p class="muted"><small>Вход подтверждается на официальном сайте Stremio, пароль здесь не вводится.</small></p>
    <button class="btn ${i.stremio ? "secondary" : ""}" id="st-start">${i.stremio ? "Войти заново" : "Войти в Stremio"}</button>
  </div>
  <div id="st-code" hidden>
    <p><a id="st-link" class="btn" target="_blank" rel="noopener">Открыть link.stremio.com</a></p>
    <p class="muted"><small>Или отсканируйте QR-код телефоном, где вы вошли в Stremio, или введите код на link.stremio.com:</small></p>
    <img id="st-qr" class="qr" alt="">
    <div class="code" id="st-user-code">····</div>
    <p class="muted"><small id="st-status">Жду подтверждения…</small></p>
  </div>
</section>

<section>
  <h2>3. Аддон «Кинопаб» ${i.addon ? `<span class="ok">✓ установлен</span>` : `<span class="muted">не установлен</span>`}</h2>
  <p class="muted"><small>Смотреть фильмы и сериалы из подписки прямо в Stremio. В настройках Stremio на каждом устройстве выберите плеер <b>MPV</b>: со встроенными ExoPlayer и VLC переключение озвучек не работает.</small></p>
  ${i.stremio ? `<button class="btn ${i.addon ? "secondary" : ""}" id="install">${i.addon ? "Переустановить" : "Установить в Stremio"}</button>` : `<p class="muted"><small>Сначала войдите в Stremio.</small></p>`}
  <details><summary class="muted"><small>Установить вручную</small></summary>
    <p class="muted"><small>Вставьте ссылку в поиск в разделе «Аддоны». Она личная: с ней можно смотреть по вашей подписке.</small></p>
    <input readonly value="${esc(i.manifestUrl)}" onclick="this.select()">
  </details>
</section>

<section>
  <h2>Синхронизация</h2>
  <p><small>${syncLine}</small></p>
  <p><small>Отметки «просмотрено» и место, где вы остановились, синхронизируются в обе стороны каждые 5 минут. <a href="/status${q}">Журнал синхронизации</a></small></p>
</section>

<p class="err" id="error" hidden></p>
<script>
const $ = (id) => document.getElementById(id);
const Q = ${JSON.stringify(q)};
const fail = (msg) => { $("error").hidden = false; $("error").textContent = msg; };
const post = (path, body) => fetch(path + Q, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });

$("kp-start").onclick = async () => {
  try {
    const d = await post("/setup/kp-start");
    $("kp-idle").hidden = true; $("kp-code").hidden = false; $("kp-user-code").textContent = d.user_code;
    if (d.verification_uri) { $("kp-link").href = d.verification_uri; $("kp-link").textContent = d.verification_uri.replace(/^https?:\\/\\//, ""); }
    const until = Date.now() + (d.expires_in || 600) * 1000;
    const poll = async () => {
      if (Date.now() > until) { $("kp-status").textContent = "Код устарел — обновите страницу."; return; }
      try {
        const r = await post("/setup/kp-poll", { code: d.code });
        if (r.ok) { $("kp-status").textContent = "Готово!"; location.reload(); return; }
      } catch (e) { fail("Кинопаб: " + e.message); return; }
      setTimeout(poll, Math.max(5, d.interval || 5) * 1000);
    };
    setTimeout(poll, Math.max(5, d.interval || 5) * 1000);
  } catch (e) { fail("Не удалось получить код от кинопаба: " + e.message); }
};

const LINK = "https://link.stremio.com/api/v2";
$("st-start").onclick = async () => {
  try {
    const r = (await fetch(LINK + "/create?type=Create").then((r) => r.json())).result;
    if (!r || !r.code) throw new Error("нет кода");
    $("st-idle").hidden = true; $("st-code").hidden = false;
    $("st-link").href = r.link; $("st-qr").src = r.qrcode; $("st-user-code").textContent = r.code;
    const started = Date.now();
    const poll = async () => {
      if (Date.now() - started > 5 * 60 * 1000) { $("st-status").textContent = "Код устарел — обновите страницу."; return; }
      const res = await fetch(LINK + "/read?type=Read&code=" + encodeURIComponent(r.code)).then((r) => r.json()).catch(() => ({}));
      const authKey = res && res.result && res.result.authKey;
      if (!authKey) return setTimeout(poll, 3000);
      $("st-status").textContent = "Подтверждено, устанавливаю аддон…";
      try { await post("/setup/stremio", { authKey }); location.reload(); }
      catch (e) { fail("Stremio: " + e.message); }
    };
    poll();
  } catch (e) { fail("Не удалось получить код от Stremio: " + e.message); }
};

const inst = $("install");
if (inst) inst.onclick = async () => {
  inst.disabled = true; inst.textContent = "Устанавливаю…";
  try { await post("/setup/install"); location.reload(); }
  catch (e) { inst.disabled = false; inst.textContent = "Установить в Stremio"; fail("Не получилось установить: " + e.message); }
};
</script>
</main></body></html>`;
}
