# Strelingo Smart — כתוביות בשתי שפות, מסונכרנות לקובץ שאתם מנגנים

תוסף ל-Stremio ול-Nuvio שמציג בו-זמנית שורה בשפת הסרט (למשל צרפתית) ושורה בשפה שלכם (למשל אנגלית),
**מסונכרנות לקובץ הווידאו שמתנגן בפועל** — לא לקובץ כתוביות אקראי מראש הרשימה.

מבוסס על [Strelingo](https://github.com/Serkali-sudo/strelingo-addon) (מיזוג שתי השפות לקובץ אחד)
ועל מה שנלמד ב-Smart-Hebrew-Subtitles (זיהוי הקובץ המתנגן, טביעת אצבע, תזמון מתוך ה-MKV, סנכרון שמתקן FPS וחיתוכים).

## למה זה לא עבד ב-Nuvio

1. **Strelingo המקורי סנכרן את שתי השפות זו לזו, אבל אף אחת מהן לסרט.** הוא לקח את הכתובית הצרפתית הראשונה
   ברשימה של OpenSubtitles כמו שהיא, והתאים אליה את האנגלית. אם הכתובית הצרפתית נוצרה לגרסה אחרת של הסרט —
   ובסרטים צרפתיים זה נפוץ מאוד: גרסאות טלוויזיה/DVD של 25 פריימים לשנייה (PAL), שרצות 4% מהר יותר וצוברות
   סטייה של כמה דקות עד סוף הסרט — **כל** האפשרויות שהוא הציע ירשו את אותו תזמון שגוי.
2. **אפליקציית Nuvio לטלפון לא מוסרת לתוספי כתוביות שום מידע על הקובץ** — לא שם, לא גודל, לא טביעת אצבע
   (בדקתי בקוד של Nuvio: הבקשה היא `/subtitles/movie/<id>.json` בלבד). Stremio ו-NuvioTV שולחים לפחות את שם הקובץ;
   בטלפון — כלום. אז "הכתובית הראשונה ברשימה" הייתה ניחוש עיוור.
3. בנוסף, Nuvio מציג כתובית של תוסף רק בתור "שפה (שם התוסף)", כך שארבע האפשרויות של Strelingo נראו זהות.

## איך זה עובד עכשיו

**שלב 1 — לזהות את הקובץ המתנגן.** אם הדבקתם בהגדרות את קישור ה-AIOStreams שלכם, התוסף מציג את אותם
סטרימים מסומנים ב-🎓. כשמנגנים סטרים 🎓, הנגן עובר דרך התוסף לשבריר שנייה (הפניה, בלי להעביר וידאו),
וכך התוסף יודע בדיוק איזה קובץ מתנגן — גם בטלפון. ב-Stremio/NuvioTV, שם הקובץ שהנגן שולח מספיק כדי למצוא אותו ב-AIOStreams.

**שלב 2 — ציר זמן אמיתי של הסרט**, מהטוב לפחות טוב:
- **מתוך הקובץ עצמו**: תזמוני הכתוביות המוטמעות ב-MKV, נקראים מאינדקס הקובץ בכמה בקשות קטנות (בדרך כלל פחות ממגה, לא הסרט כולו).
- **טביעת אצבע**: כתובית ש-OpenSubtitles מזהה כמותאמת בדיוק לקובץ הזה (ה-hash מחושב מ-2×64KB של הקובץ).
- **קונצנזוס** (כשאין שום מידע על הקובץ): התזמון שרוב הכתוביות שהורדו מסכימות עליו, עם העדפה למהירות קולנוע על פני PAL.

**שלב 3 — סנכרון כל כתובית לציר הזה**: מנוע (בהשראת alass) שמוצא יחס FPS (PAL/NTSC), היסט קבוע, וחיתוכים
(הפסקות פרסומות, סצנות שנוספו) — ופוסל כתובית של סרט/פרק אחר. נבחרות הצרפתית והאנגלית שמתאימות הכי טוב,
ומתמזגות לקובץ אחד: השורה הצרפתית מודגשת, האנגלית בנטוי מתחתיה.

הכתוביות מוכנות ברקע מהרגע שמתחילים לנגן, כך שבדרך כלל הן מוכנות עוד לפני שבוחרים אותן.

## התקנה (פעם אחת)

1. **פריסה** — אחת מהאפשרויות:

   **Vercel** (חינם, בלי "הירדמות"):
   1. Vercel → **Add New → Project** → Import לריפו `strelingo-addon` → Deploy (בלי לשנות הגדרות; `vercel.json` כבר בריפו).
      Vercel מפרסם את ענף ה-production (בדרך כלל `main`), אז הקוד צריך להיות שם — או לשנות ב-Settings → Git את ה-Production Branch.
   2. **זיכרון משותף — חובה ב-Vercel.** כל בקשה יכולה לרוץ על מופע אחר, אז "איזה קובץ מתנגן" חייב להישמר מחוץ לשרת.
      אחת משתיים:
      - **Upstash**: בפרויקט ב-Vercel → **Storage → Create Database → Upstash (Redis)** → Free → Connect לפרויקט.
        משתני הסביבה נוספים לבד.
      - **או Turso** — אותו סוג מסד שכבר יש ל-Smart-Hebrew: Settings → Environment Variables →
        `TURSO_DATABASE_URL` ו-`TURSO_AUTH_TOKEN` (אפשר אפילו אותו מסד; התוסף משתמש בטבלה נפרדת `strelingo_kv`).
   3. **Redeploy** (משתני סביבה נכנסים לתוקף רק בפריסה הבאה).
   4. בדיקה: `https://<הפרויקט>.vercel.app/health` צריך להראות `"sharedState":"upstash"` (או `"turso"`) ו-`"signing":"store"`.
      אם רואים `"memory"` — הזיכרון המשותף לא מחובר, והסנכרון לקובץ לא יעבוד באופן אמין.

   **Render**: New → Blueprint → הריפו הזה (`render.yaml` עושה הכל, חינם). השרת "נרדם" אחרי 15 דקות —
   כדאי pinger חינמי (למשל UptimeRobot) על `https://<השרת>/health` כל 10 דקות, כמו ב-Smart-Hebrew.

   **שרת משלכם**: `docker compose up -d`, או `npm install && npm start`.
2. פותחים את כתובת השרת בדפדפן (`/configure`) → דף ההגדרות:
   - שפה ראשית: **French**, שפת תרגום: **English** (אלה ברירות המחדל).
   - **מדביקים את קישור ה-AIOStreams** (ה-manifest, בדיוק כמו שהותקן ב-Nuvio). זה מה שנותן סנכרון מדויק.
3. **Copy Link** → ב-Nuvio: Settings → Addons → מדביקים את הקישור. (ב-Stremio אפשר ללחוץ Install.)

## שימוש

1. בוחרים סרט → **בוחרים סטרים שמתחיל ב-🎓** (באותה איכות שהייתם בוחרים ב-AIOStreams).
2. בנגן → כתוביות → **French (Strelingo Smart …)**.

אם בחרתם סטרים רגיל (לא 🎓) בטלפון, התוסף לא יודע מה מתנגן ויבחר את התזמון הנפוץ — בדרך כלל טוב, אבל בלי
ערובה. ההבדל יהיה לכל היותר היסט קבוע, וכפתור ה-delay של הכתוביות ב-Nuvio מתקן אותו. כשאין קישור AIOStreams
בהגדרות, מוצעת גם אפשרות שנייה (↻) עם התזמון החלופי.

**מה קרה עם הכתוביות האחרונות?** `https://<השרת>/<ההגדרות שלכם>/status` (אותו קישור כמו ההתקנה, עם `status`
במקום `manifest.json`) מראה לכל סרט: מאיפה נלקח ציר הזמן (`file` / `hash` / `consensus`), אילו כתוביות נבחרו,
איזה תיקון הופעל (יחס FPS, היסט, חיתוכים) ולמה.

צבע שונה לכל שפה — בהמשך. זה שינוי בשורה אחת שבונה את הטקסט הממוזג (`src/subtitleMatching.ts`).

---

## English

Dual-language subtitles for Stremio and Nuvio — the film's language on top, yours below — **synced to the file
actually being played**.

### Why the original drifted

Strelingo synced the translation to the main subtitle, but took the main subtitle unverified from the top of the
OpenSubtitles list. French subtitles are often made for 25 fps (PAL) releases: 4% faster, minutes off by the end.
Every merged option inherited that timing. Nuvio's phone app sends subtitle add-ons no file name, size or hash, so
"top of the list" was a blind guess.

### Design

| Step | What | Where |
|---|---|---|
| Identify the file | 🎓 streams: the user's stream add-on (AIOStreams) re-listed with `/play` links that record the pick and 302 to the real URL. Or `filename`/`videoSize` from the player, matched against the stream add-on. | `src/file/upstream.ts`, `src/smart/plays.ts`, `src/index.ts` |
| Read the file | OpenSubtitles hash (2 × 64 KiB) and embedded subtitle timings from the MKV Cues index (Range requests, typically < 1 MB) | `src/file/probe.ts`, `src/file/mkv.ts`, `src/file/osHash.ts` |
| Reference timeline | file's embedded track → hash-matched subtitle → consensus of downloaded subtitles (film speed preferred over PAL) → top guess | `src/smart/pipeline.ts` |
| Align | fps ratio + global offset by overlap scoring, then a split DP for cuts; rejects subtitles of another movie/episode by contrast against chance | `src/sync/aligner.ts` |
| Merge | Strelingo's merge on the shared timeline | `src/subtitleMatching.ts` |
| Serve | background builds (started at play / subtitle listing), staged results, keep-alive while waiting | `src/smart/jobs.ts` |
| Share | 🎓 picks and finished builds across instances (Upstash / Turso / memory) | `src/store.ts` |

Subtitle sources are Strelingo's: OpenSubtitles via Stremio's v3 add-on (no key), Buta-no-subs for Japanese,
optional Wyzie / SubSource keys.

### Routes

- `/configure`, `/<config>/configure` — install page; `<config>` is base64url JSON (old URI-encoded JSON links still work)
- `/<config>/manifest.json`
- `/<config>/stream/:type/:id.json` — 🎓 streams (when a stream add-on URL is configured)
- `/<config>/play/:token` — signed; records the pick, 302 to the stream
- `/<config>/subtitles/:type/:id[/:extra].json`
- `/<config>/dual/:variant/:type/:id/:ctx/strelingo.srt` — the merged subtitle
- `/<config>/status` — recent builds for this configuration
- `/health`

### Run & deploy

```bash
npm install
npm start            # http://localhost:7000/configure
npm test             # aligner, file probing, stores, pipeline, server, multi-instance (offline, synthetic data)
npm run typecheck
```

- **Vercel**: import the repo (`vercel.json` routes everything to `src/index.ts` via `@vercel/node`) and connect a
  shared store — Upstash Redis from Vercel's Storage tab (`UPSTASH_REDIS_REST_*` / `KV_REST_API_*` are set for you)
  or Turso (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`). Requests may land on different instances, so 🎓 picks,
  finished builds and history live there; builds outlive their response through `waitUntil`; the `/play` signing
  key is derived from the store token unless `SECRET` is set. Check `/health`: `sharedState` must not be `memory`.
- **Docker**: `docker compose up -d`. **Render**: `render.yaml` blueprint. A single long-running process needs no
  store (memory is shared), though one can be used.

See `.env.example` for all options. Imports use explicit `.js` extensions so the compiled output runs as plain
Node ESM (how `@vercel/node` runs it), not only under `tsx`.

### Tests

All tests run offline on synthetic timelines: PAL/NTSC drift, offsets, ad-break cuts, different line splitting,
missing/extra lines, wrong-movie rejection, a synthetic MKV, and a real file muxed by `mkvmerge`
(`test/fixtures/`: a 10-minute video with a French track and a forced track).
`test/subtitleMatching.test.ts` is upstream's and already failed before this fork's changes (the merge started
keeping leftover translation lines); `npm run test:encoding` needs network access to download its inputs.
