// Setup page of the "Я смотрю" add-on: Stremio login form -> personal install link.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function configurePage(opts: { origin: string; installUrl?: string; error?: string }): string {
  const { installUrl, error } = opts;
  const body = installUrl
    ? `<h2>Готово</h2>
<p><a class="btn" href="${esc(installUrl.replace(/^https?:/, "stremio:"))}">Установить в Stremio</a></p>
<p class="muted">Если кнопка не открыла Stremio, скопируйте ссылку и вставьте её в поиск в разделе «Аддоны»:</p>
<input class="link" readonly value="${esc(installUrl)}" onclick="this.select()">
<p class="warn">Это ваша личная ссылка: в ней ключ доступа к вашему аккаунту Stremio. Не делитесь ею. Если ключ утёк — выйдите из Stremio на всех устройствах, ключ перестанет работать.</p>`
    : `${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/configure">
  <label>Почта Stremio<input name="email" type="email" autocomplete="username" required></label>
  <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
  <button class="btn">Получить ссылку</button>
</form>
<p class="muted">Пароль используется один раз, чтобы получить ключ доступа к вашей библиотеке, и нигде не сохраняется. Аккаунты через Facebook/Apple не поддерживаются.</p>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Я смотрю — аддон для Stremio</title><style>
:root{color-scheme:light dark;--bg:#f6f6f8;--fg:#1d1d1f;--card:#fff;--muted:#6e6e73;--accent:#7b5bf5;--err:#c62828;--line:#d8d8de}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#f2f2f4;--card:#1f1f23;--muted:#a1a1a6;--err:#ef9a9a;--line:#38383d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
main{max-width:460px;margin:24px auto;background:var(--card);border-radius:16px;padding:24px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:19px;margin:0 0 12px}.muted{color:var(--muted);font-size:14px}
label{display:block;margin:0 0 14px;font-size:14px;color:var(--muted)}
input{display:block;width:100%;margin-top:4px;padding:10px 12px;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px}
.btn{display:inline-block;padding:11px 18px;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:10px;text-decoration:none;cursor:pointer}
.link{font-size:13px}.err{color:var(--err)}.warn{font-size:14px;color:var(--muted);border-left:3px solid var(--accent);padding-left:10px}
</style></head><body><main>
<h1>Я смотрю</h1>
<p class="muted">Полка на главной Stremio: сериалы из вашей библиотеки, где есть непросмотренные серии, с их числом на постере.</p>
${body}
</main></body></html>`;
}
