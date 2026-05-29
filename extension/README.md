# Расширение (v3.1)

Полная стартовая страница в расширении (`index.html`). Подсказки в поиске — из **истории браузера** (`history` в manifest).

В адресной строке будет `chrome-extension://…/index.html?focus=1` — зато **фокус в поиске** на Ctrl+T.

## Установка

```bash
make extension
make run
```

1. `brave://extensions` → **Обновить** (или удалить и загрузить `extension` заново)
2. `brave://settings/newTab` → **Пустая страница**
3. **Ctrl+T**

После правок в `index.html` / `js/app.js` снова `make extension` и обновить расширение.
