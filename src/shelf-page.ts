// Setup page of the "Я смотрю" add-on. Uses Stremio's official link-code login
// (link.stremio.com, the same flow as signing in on a TV). It runs entirely in the
// visitor's browser: the user confirms on Stremio's own site, the browser receives
// the authKey from Stremio and builds the personal install URL. Neither the password
// nor the key passes through this Worker during setup.

export function configurePage(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Я смотрю — аддон для Stremio</title><style>
:root{color-scheme:light dark;--bg:#f6f6f8;--fg:#1d1d1f;--card:#fff;--muted:#6e6e73;--accent:#7b5bf5;--err:#c62828;--line:#d8d8de}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#f2f2f4;--card:#1f1f23;--muted:#a1a1a6;--err:#ef9a9a;--line:#38383d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
main{max-width:460px;margin:24px auto;background:var(--card);border-radius:16px;padding:24px}
h1{font-size:22px;margin:0 0 6px}.muted{color:var(--muted);font-size:14px}
.code{font:700 40px/1 ui-monospace,monospace;letter-spacing:.12em;margin:8px 0 14px}
.qr{display:block;width:160px;height:160px;margin:4px 0 14px;background:#fff;border-radius:8px}
.btn{display:inline-block;padding:11px 18px;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:10px;text-decoration:none;cursor:pointer}
input{display:block;width:100%;margin:8px 0;padding:10px 12px;font:13px/1.4 inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px}
.err{color:var(--err)}.warn{font-size:14px;color:var(--muted);border-left:3px solid var(--accent);padding-left:10px}
[hidden]{display:none!important}
</style></head><body><main>
<h1>Я смотрю</h1>
<p class="muted">Полка на главной Stremio: сериалы из вашей библиотеки, где есть непросмотренные серии, с их числом на постере.</p>

<section id="step-link">
  <p>1. Откройте официальную страницу Stremio и подтвердите вход:</p>
  <p><a id="link" class="btn" target="_blank" rel="noopener">Открыть link.stremio.com</a></p>
  <p class="muted">Или отсканируйте QR-код телефоном, где вы вошли в Stremio, или введите код на link.stremio.com:</p>
  <img id="qr" class="qr" alt="">
  <div id="code" class="code">····</div>
  <p class="muted" id="status">Жду подтверждения…</p>
</section>

<section id="step-done" hidden>
  <p>2. Готово — установите аддон:</p>
  <p><a id="install" class="btn">Установить в Stremio</a></p>
  <p class="muted">Если кнопка не открыла Stremio, скопируйте ссылку и вставьте её в поиск в разделе «Аддоны»:</p>
  <input id="url" readonly onclick="this.select()">
  <p class="warn">Это личная ссылка: в ней ключ доступа к вашему аккаунту Stremio (так работают все аддоны, которым нужна библиотека). Не делитесь ею. Если ключ утёк — выйдите из Stremio на всех устройствах, и он перестанет работать.</p>
</section>

<p id="error" class="err" hidden></p>
<p class="muted">Пароль на этом сайте не вводится: вход подтверждается на сайте Stremio, а ключ ваш браузер получает напрямую от Stremio.</p>
<script>
const $ = (id) => document.getElementById(id);
const LINK = "https://link.stremio.com/api/v2";
const b64url = (str) => btoa(str).split("+").join("-").split("/").join("_").split("=").join("");
async function start() {
  try {
    const r = (await fetch(LINK + "/create?type=Create").then((r) => r.json())).result;
    if (!r || !r.code) throw new Error("no code");
    $("link").href = r.link; $("qr").src = r.qrcode; $("code").textContent = r.code;
    const started = Date.now();
    const poll = async () => {
      if (Date.now() - started > 5 * 60 * 1000) { $("status").textContent = "Код устарел — обновите страницу."; return; }
      const res = await fetch(LINK + "/read?type=Read&code=" + encodeURIComponent(r.code)).then((r) => r.json()).catch(() => ({}));
      const authKey = res && res.result && res.result.authKey;
      if (authKey) {
        const url = location.origin + "/u/" + b64url(authKey) + "/manifest.json";
        $("step-link").hidden = true; $("step-done").hidden = false;
        $("install").href = url.replace(/^https?:/, "stremio:"); $("url").value = url;
      } else setTimeout(poll, 3000);
    };
    poll();
  } catch (e) { $("error").hidden = false; $("error").textContent = "Не удалось получить код от Stremio. Обновите страницу."; }
}
start();
</script>
</main></body></html>`;
}
