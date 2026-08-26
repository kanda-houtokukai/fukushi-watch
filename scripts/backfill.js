#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 過去分の遡及記録（バックフィル・P14）
 *
 * 創刊（2026-08-16）より前の掲載を後から履歴に積む。手動実行のみ。
 *
 * 安全のための設計:
 * - **state.json は読むだけで書かない**（毎朝のActionsと衝突しない）
 * - **メールを送らない**（notify.js を呼ばない。過去の通知が大量に届く事故を防ぐ）
 * - **締切抽出をしない**（過去の期限は切れており、本文取得の負荷だけかかる）
 * - **`action`（対応の目安・P8）も付けない**［DECISION・2026-08-21］。同じ理屈で、
 *   過去の「対応の目安」は期日が過ぎており実用価値がほぼない。過去データを後から加工する
 *   経路を増やさない方が健全でもある。⚠️遡及分の「高」に action が無いのは**仕様**であって
 *   バグではない（`backfilled: true` が目印）。直しに行かないこと
 * - 書き込むのは data/history/YYYY-MM.json と index.json のみ。
 *   同日分が既にあってもハッシュで併合する（archive.js と同じ規則）
 * - 途中で止まっても data/backfill-progress.json から再開できる
 * - 判定は summarize.js の関数をそのまま再利用する（プロンプト・検証の二重化を避ける）
 *
 * 対象の源:
 * - こども家庭庁 … `?page=N` で範囲の下限まで遡って取得する
 * - 全国社会福祉協議会（団体・P21）… 一覧1枚に約1年分が載るのでページングなし。
 *   ⚠️**禁止文言チェック（届出の約束）を過去分にも必ず通す**
 * - それ以外の源 … state.json に残っている分で足りる（読むだけ・書かない）
 *
 * 使い方:
 *   node scripts/backfill.js --from 2026-07-01 --to 2026-08-15 [--limit-days N] [--dry-run]
 *
 *   --ignore-progress … backfill-progress.json の「処理済みの日」を読み飛ばさない。
 *     **後から源を足したときに使う**（既処理の日にも新しい源の項目があるため）。
 *     重複はハッシュ照合で防いでいるので、二重に積まれることはない。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCfaCards, parseZenshakyoNews, checkReprintNotice, itemHash, fetchHtml, readSources,
} from "./crawl.js";
import {
  loadEnv, listCandidateModels, preferModel, buildPrompt, parseResponse, generate,
  normalizeFields, applyDefaultField,
} from "./summarize.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = join(ROOT, "data", "state.json");
const HISTORY_DIR = join(ROOT, "data", "history");
const INDEX_PATH = join(HISTORY_DIR, "index.json");
const PROGRESS_PATH = join(ROOT, "data", "backfill-progress.json");

const CFA_NEWS = "https://www.cfa.go.jp/news";
const ZENSHAKYO_NEWS = "https://www.shakyo.or.jp/news/index.html";
const BATCH = 25;            // 1リクエストあたりの判定件数（summarize.js と同じ上限）
const REQ_INTERVAL_MS = 5000; // 分あたりのレート制限を避けるための間隔
const FETCH_INTERVAL_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** 各源の日付表記を YYYY-MM-DD に正規化（福岡県の「2026年8月4日更新」に対応） */
function normalizeDate(raw) {
  const s = String(raw ?? "").normalize("NFKC");
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ja = s.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (ja) return `${ja[1]}-${String(ja[2]).padStart(2, "0")}-${String(ja[3]).padStart(2, "0")}`;
  return null; // 解釈できない日付は積まない（日付レールを壊さないため）
}

function loadJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

/** こども家庭庁を範囲の下限まで遡って取得（他源は state に既にある分で足りる） */
async function fetchCfaBack(from) {
  const items = [];
  for (let page = 0; page < 60; page++) {
    const url = page === 0 ? CFA_NEWS : `${CFA_NEWS}?page=${page}`;
    const html = await fetchHtml(url);
    const got = parseCfaCards(html, CFA_NEWS);
    if (got.length === 0) break; // 構造変化 or 末尾
    items.push(...got);
    const oldest = got.map((g) => normalizeDate(g.date)).filter(Boolean).sort()[0];
    process.stdout.write(`\r  こども家庭庁: ${page + 1}ページ / ${items.length}件（${oldest}まで）`);
    if (oldest && oldest < from) break;
    await sleep(FETCH_INTERVAL_MS);
  }
  console.log("");
  return items;
}

/**
 * 全国社会福祉協議会（団体・P21）を遡って取得する。
 * 一覧ページ1枚に約1年分が載るためページングは不要（こども家庭庁とは事情が違う）。
 *
 * ⚠️ **範囲内の項目には必ず禁止文言チェックを通す。** 全社協への届出で
 *    「無断転載を禁ずる旨の記載がある情報は対象から除く」と約束しており、
 *    その約束は遡及して積む過去分にも及ぶため、毎朝の巡回と同じ関門を通す。
 *    取得できなかったものは積まない（手動での再実行で拾い直せる）。
 */
async function fetchZenshakyoBack(from, to) {
  const html = await fetchHtml(ZENSHAKYO_NEWS);
  const all = parseZenshakyoNews(html, ZENSHAKYO_NEWS);
  if (all.length === 0) {
    throw new Error("全社協の一覧から1件も抽出できませんでした（構造変化の疑い）");
  }
  const inRange = all.filter((it) => {
    const d = normalizeDate(it.date);
    return d && d >= from && d <= to;
  });
  console.log(`  全社協: 一覧${all.length}件 / 範囲内${inRange.length}件 → 禁止文言を確認`);

  const kept = [];
  for (const it of inRange) {
    const verdict = await checkReprintNotice(it.url);
    if (verdict === "ok") kept.push(it);
    else if (verdict === "blocked") {
      console.log(`    除外（無断転載を禁ずる旨の記載あり）: ${it.title}`);
    } else {
      console.log(`    見送り（本文を確認できず）: ${it.title}`);
    }
    await sleep(FETCH_INTERVAL_MS);
  }
  console.log(`  全社協: ${kept.length}件を積む対象にした`);
  return kept;
}

async function main() {
  const from = arg("from", "2026-07-01");
  const to = arg("to", "2026-08-15");
  const limitDays = Number(arg("limit-days", "0"));
  const dryRun = hasFlag("dry-run");
  // 源を後から足したときに使う。progress.done は再開の目印であって重複防止の本体ではない
  // （重複はハッシュ照合で防いでいる）ため、既処理の日を読み直しても二重に積まれることはない。
  const ignoreProgress = hasFlag("ignore-progress");
  console.log(`バックフィル範囲: ${from} 〜 ${to}${limitDays ? `（先頭${limitDays}日分のみ）` : ""}${dryRun ? "（判定なしの下見）" : ""}`);

  // 1) 収集: state.json の既存項目（読むだけ）＋ こども家庭庁の遡及取得
  const state = loadJson(STATE_PATH, { sources: {} });
  // ★報道の除外は**源の名前でなく docs/sources.md の区分**で判定する。
  //   名前を並べて書くと、報道源が増えたときにこのスクリプトだけ取り残され、
  //   報道にAI要約と重要度判定を付けてしまう（P9の[DECISION]に反する）。
  //   台帳に無い源は、判断できないので安全側＝対象外にする。
  const kindByName = new Map(readSources().map((r) => [r.name, r.kind]));
  // 既定分野（P36）: 源の名前 → 台帳の行（summarize.js と同じ引き方）
  const srcByName = new Map(readSources().map((r) => [r.name, r]));
  const pool = [];
  for (const [name, rec] of Object.entries(state.sources ?? {})) {
    const kind = kindByName.get(name);
    if (kind === undefined) {
      console.log(`  state の「${name}」は台帳に無いため対象外にした`);
      continue;
    }
    if (kind === "press") continue; // 報道は要約・判定をしない（P9）
    for (const it of rec.items ?? []) {
      pool.push({ ...it, source: name, ...(kind === "org" ? { kind: "org" } : {}) });
    }
  }
  console.log(`state から ${pool.length}件（書き込みはしない）`);

  // ★遡って取りに行く源も、**台帳の状態に従う**。
  //   ⚠️ここを無条件にすると、「保留」にした源を遡及だけが取りに行ってしまう
  //     （2026-08-25に実際に検知: 届出前で止めた全社協を backfill が拾おうとした）。
  //     止めるという判断は、毎朝の巡回だけでなく遡及にも等しく効かなければならない。
  const active = (name) => kindByName.has(name) &&
    readSources().some((r) => r.name === name && r.status === "巡回中");

  if (active("こども家庭庁")) {
    const cfa = await fetchCfaBack(from);
    for (const it of cfa) {
      pool.push({ ...it, source: "こども家庭庁", hash: itemHash(it) });
    }
  } else {
    console.log("  こども家庭庁: 台帳の状態が「巡回中」でないため遡及しない");
  }

  // 全社協(P21)。1源の失敗で全体を止めない（こども家庭庁の遡及は成立させる）
  if (active("全国社会福祉協議会")) {
    try {
      const zen = await fetchZenshakyoBack(from, to);
      for (const it of zen) {
        pool.push({ ...it, source: "全国社会福祉協議会", kind: "org", hash: itemHash(it) });
      }
    } catch (e) {
      console.log(`  全社協: 取得に失敗したため今回は積まない（続行）: ${e.message.slice(0, 90)}`);
    }
  } else {
    console.log("  全社協: 台帳の状態が「巡回中」でないため遡及しない");
  }

  // 2) 範囲で絞り、日付ごとにまとめる
  const byDay = new Map();
  for (const it of pool) {
    const d = normalizeDate(it.date);
    if (!d || d < from || d > to) continue;
    if (!byDay.has(d)) byDay.set(d, new Map());
    byDay.get(d).set(it.hash, { ...it, _day: d });
  }
  let days = [...byDay.keys()].sort();

  // 3) 既に履歴にある項目を除外（再判定しない）
  const monthCache = new Map();
  const monthly = (m) => {
    if (!monthCache.has(m)) monthCache.set(m, loadJson(join(HISTORY_DIR, `${m}.json`), { days: {} }));
    return monthCache.get(m);
  };
  const progress = loadJson(PROGRESS_PATH, { done: [] });

  // ★既出判定は「履歴全体」で行う。掲載日のページだけを見てはいけない。
  //   毎朝の archive.js は項目を**検知した日**に記録するため、掲載日と記録日は
  //   しばしば1日ずれる（前日掲載を翌朝に検知するのが通常）。掲載日のページだけで
  //   照合すると、既に記録済みの項目を掲載日側にもう一度積んでしまい、
  //   件数とグラフが二重になる。P14では progress.done に隠れて表面化していなかった。
  const seenHashes = new Set();
  const idxForScan = loadJson(INDEX_PATH, { months: [] });
  for (const m of idxForScan.months ?? []) {
    for (const rec of Object.values(monthly(m).days ?? {})) {
      for (const x of rec.items ?? []) seenHashes.add(x.hash);
    }
  }
  console.log(`履歴に既出のハッシュ: ${seenHashes.size}件（これらは積み直さない）`);

  const plan = [];
  for (const d of days) {
    if (!ignoreProgress && progress.done.includes(d)) continue;
    const fresh = [...byDay.get(d).values()].filter((x) => !seenHashes.has(x.hash));
    if (fresh.length) plan.push({ day: d, items: fresh });
  }
  const totalItems = plan.reduce((n, p) => n + p.items.length, 0);
  const reqs = plan.reduce((n, p) => n + Math.ceil(p.items.length / BATCH), 0);
  console.log(`対象: ${plan.length}日分 / ${totalItems}件 / 推定${reqs}リクエスト`);
  if (dryRun || totalItems === 0) {
    for (const p of plan.slice(0, 10)) console.log(`  ${p.day}: ${p.items.length}件`);
    if (plan.length > 10) console.log(`  …ほか${plan.length - 10}日`);
    return;
  }

  // 4) 日ごとに判定して履歴へ書く
  const apiKey = loadEnv();
  let models = await listCandidateModels(apiKey);
  models = preferModel(models, state.preferredModel);
  const index = loadJson(INDEX_PATH, { months: [], days: {} });
  let doneItems = 0, doneReqs = 0;

  for (const { day, items } of limitDays ? plan.slice(0, limitDays) : plan) {
    const judged = [];
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      let res = null;
      for (const model of models) {
        try {
          const text = await generate(apiKey, model, buildPrompt(batch));
          res = parseResponse(text, batch.length);
          models = preferModel(models, model);
          break;
        } catch (e) {
          console.log(`  失敗（次の候補へ）: ${model}: ${e.message.slice(0, 80)}`);
        }
      }
      doneReqs++;
      if (!res) { console.log(`  ${day}: 全モデル失敗。この日はスキップ`); judged.length = 0; break; }
      const byIndex = new Map(res.map((r) => [r.index, r]));
      batch.forEach((it, n) => {
        const j = byIndex.get(n);
        if (!j) return;
        judged.push({
          hash: it.hash, source: it.source,
          // 団体(P21)だけ kind を残す。印章［団］の判定に使う（summarize.js と同じ規則）
          ...(it.kind === "org" ? { kind: "org" } : {}),
          title: it.title, url: it.url,
          date: it.date, category: it.category ?? "",
          summary: j.summary.trim(), importance: j.importance,
          // ★P15の正規化を通す（4分野すべて／共通と個別の混在 → ["共通"]）。
          //   本スクリプトはP15より前に書かれており生の fields を書いていた
          // ★P36の既定分野も通す（本流 summarize.js と同じ判断を遡及経路にも等しく効かせる）
          fields: applyDefaultField(
            normalizeFields(j.fields), srcByName.get(it.source), it.title
          ),
          reason: (j.reason ?? "").trim(),
          backfilled: true, // 遡及で積んだ記録であることを残す
        });
      });
      await sleep(REQ_INTERVAL_MS);
    }
    if (judged.length === 0) continue;

    // 履歴へ併合（archive.js と同じ規則）
    const month = day.slice(0, 7);
    const data = monthly(month);
    const existing = data.days[day]?.items ?? [];
    const merged = new Map(existing.map((x) => [x.hash, x]));
    for (const x of judged) merged.set(x.hash, x);
    const list = [...merged.values()];
    const counts = { 高: 0, 中: 0, 低: 0 };
    for (const x of list) counts[x.importance] = (counts[x.importance] ?? 0) + 1;
    data.days[day] = { counts, items: list, ...(data.days[day]?.press ? { press: data.days[day].press } : {}) };
    if (!index.months.includes(month)) index.months = [...index.months, month].sort();
    index.days[day] = { t: list.length, h: counts["高"], m: counts["中"], l: counts["低"] };

    mkdirSync(HISTORY_DIR, { recursive: true });
    writeFileSync(join(HISTORY_DIR, `${month}.json`), JSON.stringify(data, null, 1) + "\n");
    writeFileSync(INDEX_PATH, JSON.stringify(index, null, 1) + "\n");
    if (!progress.done.includes(day)) progress.done.push(day);
    writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 1) + "\n");

    doneItems += judged.length;
    console.log(`  ${day}: ${judged.length}件（高${counts["高"]}・中${counts["中"]}・低${counts["低"]}）記録`);
  }

  console.log(`完了: ${doneItems}件・${doneReqs}リクエスト`);
}

main().catch((e) => {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
});
