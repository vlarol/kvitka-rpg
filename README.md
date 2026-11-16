# STS-187 · Квітка Розуму RPG

Онлайн-стіл для настільної рольової гри у світі «Квітки Розуму» (правила на основі Mothership 1e).
Гравці відкривають сайт, пишуть ім'я, обирають персонажа і кидають кубики. Ведучий керує грою з пульта.

- **Гравці:** `https://vlarol.github.io/kvitka-rpg/`
- **Ведучий:** `https://vlarol.github.io/kvitka-rpg/?gm`

Поки в `js/config.js` порожній `apiKey`, сайт працює в **демо-режимі**: дані живуть лише у вашому браузері,
а вкладки синхронізуються між собою. Цього досить, щоб подивитися інтерфейс.

## Підключення Firebase (один раз)

1. **Realtime Database:** Firebase Console → Databases & Storage → Realtime Database → Create database
   (europe-west1, locked mode).
2. **Правила:** вкладка *Rules* → вставити вміст `database.rules.json` → *Publish*.
3. **Вхід:** Security → Authentication → Sign-in method → увімкнути **Anonymous** і **Google**.
   *Settings → Authorized domains* → додати `vlarol.github.io`.
4. **Конфіг:** Project settings → General → Your apps → Web app → скопіювати `firebaseConfig`
   (разом із `databaseURL`) у `js/config.js`.
5. **Ведучий:** відкрити `?gm`, увійти через Google, скопіювати показаний UID.
   Realtime Database → Data → додати вузол `admins` → ключ = UID, значення = `true`. Оновити сторінку.
6. На пульті натиснути **ЗАПУСТИТИ ГРУ**, вписати таємні цілі персонажів, додати кат-сцени.

## Що де лежить

| Файл | Що в ньому |
| --- | --- |
| `js/data.js` | персонажі, кімнати мапи, таблиці паніки, ран і подій |
| `js/app.js` | екрани гравця і ведучого, кубики |
| `js/store.js` | синхронізація (Firebase або демо) |
| `css/style.css` | вигляд |
| `assets/ship.png` | схема корабля |
| `assets/portraits/` | портрети (необов'язково, див. коментар у `data.js`) |

Таємні цілі **не зберігаються** в репозиторії: він публічний. Ведучий вводить їх на пульті,
і кожну бачить лише гравець цього персонажа.
