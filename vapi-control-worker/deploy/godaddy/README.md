# Что загрузить на GoDaddy

Цель: чтобы адрес `https://kidletto.com/vapi-control/` открывал консоль.
Сама консоль живёт в Cloudflare Worker за Cloudflare Access; здесь только
страница-переадресация. Секретов в ней нет.

## Как загрузить (cPanel)

1. GoDaddy → Hosting → cPanel → **File Manager**.
2. Откройте каталог сайта — тот, где лежит `index.html` главной страницы
   (обычно `public_html`).
3. Нажмите **Upload** и загрузите `vapi-control-godaddy.zip`.
4. Вернитесь в File Manager, правый клик по загруженному архиву → **Extract**.
5. Должно появиться: `public_html/vapi-control/index.html`.
6. Удалите сам zip.
7. Проверьте https://kidletto.com/vapi-control/ — откроется вход Cloudflare Access.

Альтернатива: просто перетащите папку `vapi-control/` из этого каталога
по FTP в корень сайта.

`.htaccess` менять не нужно. Другие файлы сайта не затрагиваются.

## Когда это можно удалить

Если позже перенесёте DNS `kidletto.com` в Cloudflare (README, §10, вариант B),
Worker начнёт обслуживать `kidletto.com/vapi-control/` напрямую — тогда удалите
каталог `public_html/vapi-control/`.
