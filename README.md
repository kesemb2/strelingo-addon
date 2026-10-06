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

**שלב 1 — לזהות את הקובץ המתנגן**, כמו ב-Smart-Hebrew: כשהנגן מוסר את שם הקובץ וגודלו (Stremio, NuvioTV) והדבקתם
בהגדרות את קישור ה-AIOStreams שלכם, התוסף מוצא את הקובץ ברשימת ה-AIOStreams. אפליקציית Nuvio בטלפון לא מוסרת
לתוספי כתוביות שום פרט על הקובץ, אז שם אין קובץ לזהות — והתזמון הוא זה שרוב הכתוביות מסכימות עליו (שלב 2).

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
   - **מדביקים את קישור ה-AIOStreams** (ה-manifest, בדיוק כמו שהותקן ב-Nuvio). כך התוסף מוצא את הקובץ שמתנגן
     כשהנגן מוסר את שמו (Stremio, NuvioTV). התוסף לא מציג זרמים משלו — בוחרים זרם כרגיל ב-AIOStreams.
3. **Copy Link** → ב-Nuvio: Settings → Addons → מדביקים את הקישור. (ב-Stremio אפשר ללחוץ Install.)

## שימוש

1. בוחרים סרט וזרם כרגיל.
2. בנגן → כתוביות → תחת **אנגלית** (השפה שלכם) מופיעות האפשרויות של התוסף, כל אחת בשם שאומר מה היא:

| אפשרות | מה זה |
|---|---|
| `★ צרפתית+אנגלית · מסונכרן לקובץ` | שתי השורות, מסונכרנות לכתוביות שמוטמעות בקובץ שמתנגן. אחרי הנקודה כתוב לפי מה: *מסונכרן לקובץ*, *לפי רוב הכתוביות* (אין מידע על הקובץ — התזמון שרוב הכתוביות מסכימות עליו), *תזמון משוער*, או *לפי הקובץ* (עוד בבנייה). |
| `↻ צרפתית+אנגלית · חלופה` | תזמון אחר, או זוג כתוביות אחר על אותו תזמון. |
| `צרפתית בלבד · מסונכרן` / `אנגלית בלבד · מסונכרן` | שפה אחת, על אותו תזמון בדיוק. |
| `⚠ הסנכרון לא טוב · החלף` | **מלמד את התוסף**: התזמון של מה שראיתם נפסל לסרט הזה, ומוגשת מיד גרסה על התזמון הבא. |
| `⚠ האנגלית לא טובה · החלף` / `⚠ הצרפתית לא טובה · החלף` | פוסל את הכתובית בשפה הזו (תרגום גרוע, סרט אחר) ובוחר את הבאה. |

כמו ב-Smart-Hebrew: דיווח מהנגן נספר רק אם הכתובית הייתה על המסך לפחות 15 שניות (נגנים שמורידים את כל הרשימה
מראש לא "מדווחים" בטעות), ופעם אחת לכל כתובית שהוגשה. מה שדווח עובר לסוף התור — לא נמחק: אם אין שום אפשרות אחרת,
עדיף משהו מכלום. כל דיווח אפשר לבטל בדף הפעילות.

ב-Nuvio בטלפון התוסף לא יודע איזה קובץ מתנגן, ובוחר את התזמון שרוב הכתוביות מסכימות עליו — בדרך כלל טוב, אבל
בלי ערובה; אם לא, `↻` או `⚠ הסנכרון לא טוב · החלף`.

### דף הפעילות — מה קרה עם כל כתובית

`https://<השרת>/` (או `/status`) — כמו ב-Smart-Hebrew: לכל סרט שנצפה — פוסטר ושם, הקובץ שהתנגן (ואיך התוסף ידע
עליו), כל בקשה של הנגן ומה הוגש לה (וכמה זמן חיכה), ובלחיצה על "פרטים": איזה עוגן תזמון נבחר ואילו נבדקו ונפסלו
ולמה, איזו כתובית נבחרה בכל שפה ואיזה תיקון הופעל (מהירות PAL, הזזה, חיתוכים, אחוז התאמה), האם שתי השורות
מסונכרנות זו לזו, כל המועמדות, וזמני כל שלב. משם אפשר גם לדווח "סנכרון לא טוב" / "האנגלית לא טובה" ולבטל דיווחים.

- **מומלץ להגדיר `ADMIN_PASSWORD`** ב-Vercel (Settings → Environment Variables → Redeploy): אחרת כל מי שיודע את
  כתובת השרת רואה מה צפיתם.
- דף לכל הגדרה בנפרד, בלי סיסמה: `https://<השרת>/<ההגדרות שלכם>/status` (הקישור מופיע גם בדף ההגדרות).

### צבעים

כל שפה בצבע משלה: **הצרפתית בצהוב, האנגלית בתכלת** (ברירת המחדל — גם קישור שהותקן לפני שהיו צבעים מקבל אותם).
משנים בדף ההגדרות ("Main language color" / "Translation color", או "Player default" בלי צבע), ואז מתקינים מחדש את
הקישור החדש. אותם צבעים גם באפשרויות "צרפתית בלבד" / "אנגלית בלבד".

- **Nuvio בטלפון אנדרואיד**: מנוע הניגון שנבחר כברירת מחדל (ExoPlayer) מוחק כל עיצוב בכתוביות — צבע, הדגשה ונטוי —
  ומציג הכל בצבע אחד. כדי לראות צבעים: **Settings → Playback → Playback engine → libmpv**.
- **Nuvio באייפון ו-NuvioTV**: הצבעים מופיעים בלי לשנות כלום.

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
| Identify the file | `filename`/`videoSize` from the player (Stremio, NuvioTV), matched against the user's stream add-on (AIOStreams) — the Smart-Hebrew way. Nuvio's phone app sends no file info. (Versions up to 1.1 re-listed the streams as 🎓 `/play` links; those links still work.) | `src/file/upstream.ts`, `src/smart/plays.ts`, `src/index.ts` |
| Read the file | OpenSubtitles hash (2 × 64 KiB) and embedded subtitle timings from the MKV Cues index (Range requests, typically < 1 MB) | `src/file/probe.ts`, `src/file/mkv.ts`, `src/file/osHash.ts` |
| Reference timeline | file's embedded text track → hash-matched subtitle → consensus of downloaded subtitles (film speed preferred over PAL) → top guess. A reference counts only once a subtitle fits it (a signs-only or picture track is passed over); reported ones go last | `src/smart/pipeline.ts` |
| Align | fps ratio + global offset by overlap scoring, then a split DP for cuts; rejects subtitles of another movie/episode by contrast against chance | `src/sync/aligner.ts` |
| Pair | the translation must share the main line's timeline (else it is fitted to the main line itself) | `src/smart/pipeline.ts` |
| Merge | Strelingo's merge on the shared timeline; each language alone too; a color per language (SRT `<font color>`, set on the configure page; Nuvio's Android phone ExoPlayer strips inline styles — use its libmpv engine) | `src/subtitleMatching.ts`, `src/subs/style.ts` |
| Serve | background builds (started at play / subtitle listing), one builder across instances (store lease), keep-alive while waiting, never an unsynced guess as ★ | `src/smart/jobs.ts` |
| Teach | in-player "⚠ … · replace" entries and the activity page: per-video bans of a timing reference or a subtitle | `src/smart/feedback.ts` |
| Show | append-only activity log + Hebrew activity page (Smart-Hebrew style) | `src/smart/activity.ts`, `src/dashboard/` |
| Share | builds, reports and the log across instances (Upstash / Turso / memory) | `src/store.ts` |

Subtitle sources are Strelingo's: OpenSubtitles via Stremio's v3 add-on (no key), Buta-no-subs for Japanese,
optional Wyzie / SubSource keys.

### Routes

- `/configure`, `/<config>/configure` — install page; `<config>` is base64url JSON (old URI-encoded JSON links still work)
- `/<config>/manifest.json`
- `/<config>/stream/:type/:id.json` — always empty (for players holding an older manifest)
- `/<config>/play/:token` — 🎓 links from earlier versions: signed; records the pick, 302 to the stream
- `/<config>/subtitles/:type/:id[/:extra].json` — the entries (★, ↻, each language alone, ⚠ reports), all under the translation language; Nuvio shows the `id`, so it is the readable name
- `/<config>/sub/:entry/:type/:id/:ctx/strelingo-<entry>.srt` — one entry (`star`, `alt`, `main`, `trans`, `bad_sync`, `bad_trans`, `bad_main`); `/<config>/dual/...` links from 1.0 still work
- `/` and `/status` — everyone's activity (locked by `ADMIN_PASSWORD` when set); `/api/status`, `/api/activity`, `/api/login`, `/api/feedback`, `/api/feedback/undo`
- `/<config>/status` — this configuration's activity; same API under `/<config>/api/…`
- `/health`

### Run & deploy

```bash
npm install
npm start            # http://localhost:7000/configure
npm test             # aligner, file probing, stores, pipeline, server, multi-instance, activity page (offline, synthetic data)
npm run typecheck
npm run embed        # after editing src/dashboard/page.html (regenerates page.ts)
```

- **Vercel**: import the repo (`vercel.json` routes everything to `src/index.ts` via `@vercel/node`) and connect a
  shared store — Upstash Redis from Vercel's Storage tab (`UPSTASH_REDIS_REST_*` / `KV_REST_API_*` are set for you)
  or Turso (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`). Requests may land on different instances, so
  finished builds and history live there; builds outlive their response through `waitUntil`; the `/play` signing
  key is derived from the store token unless `SECRET` is set. Check `/health`: `sharedState` must not be `memory`.
  `src/index.ts` exports `config = { maxDuration: 60 }` so a subtitle request may wait for its build. Set
  `ADMIN_PASSWORD` to lock the activity page.
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
