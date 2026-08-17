#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 履歴の蓄積（P4）
 *
 * data/report-latest.json を日次の履歴へ追記する。ダッシュボード（index.html）の材料。
 *
 * 構造（月次＋索引。1年で約5.5MB・初期読み込みは当月+索引のみ）:
 *   data/history/YYYY-MM.json  … { days: { "YYYY-MM-DD": { counts, items } } }
 *   data/history/index.json    … { months: [...], days: { "YYYY-MM-DD": {t,h,m,l} } }
 *
 * - 新規0件の日も「0件だった」記録を残す（動いていた証拠。グラフにも意味が出る）
 * - 同じ日に複数回実行されても安全: 項目はハッシュで併合する（手動実行が朝の記録を消さない）
 * - 日付はJSTで揃える（Actionsの実行環境はUTCのため、必ずタイムゾーン指定で計算する）
 *
 * 使い方: node scripts/archive.js（notify の後に実行する）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "data", "report-latest.json");
const HISTORY_DIR = join(ROOT, "data", "history");
const INDEX_PATH = join(HISTORY_DIR, "index.json");

/** JSTの YYYY-MM-DD を返す */
function jstDay(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function loadJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

/**
 * AIの働きかけ(b): 関連する過去項目への参照(P8)。AI照合でなく機械照合。
 * タイトルから回数・日付表現を除いた「系列キー」を作り、同じ系列の過去項目を最大3件参照する。
 * 行政情報の「関連」の大半は定例系列(第N回部会・毎月の統計・人事異動)で、これが最も正確に拾える。
 */
function seriesKey(title) {
  const t = String(title ?? "")
    .normalize("NFKC")
    .replace(/第\s*\d+\s*回/g, "")
    .replace(/令和\s*\d+\s*年度?/g, "")
    .replace(/\d{4}[年度]?/g, "")
    .replace(/\d+月\d+日付?/g, "")
    .replace(/\d{4}-\d{2}-\d{2}/g, "")
    .replace(/[【】\[\]（）()「」『』・、。．:：／/\s]/g, "");
  return t.length >= 6 ? t : null; // 短すぎるキーは誤照合のもとなので使わない
}

/** 既存履歴(当月+前月)から 系列キー→過去項目 の索引を作る */
function buildSeriesIndex(month) {
  const index = new Map();
  const [y, m] = month.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  for (const mo of [prev, month]) {
    const data = loadJson(join(HISTORY_DIR, `${mo}.json`), null);
    if (!data) continue;
    for (const [day, rec] of Object.entries(data.days)) {
      for (const it of rec.items ?? []) {
        const key = seriesKey(it.title);
        if (!key) continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ day, hash: it.hash, title: it.title, url: it.url });
      }
    }
  }
  return index;
}

function main() {
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  const day = jstDay(new Date(report.generatedAt ?? Date.now()));
  const month = day.slice(0, 7); // YYYY-MM
  const monthPath = join(HISTORY_DIR, `${month}.json`);

  const monthly = loadJson(monthPath, { days: {} });
  const existing = monthly.days[day]?.items ?? [];

  // 関連参照(系列キーの機械照合)を新規項目に付与してから記録する
  const series = buildSeriesIndex(month);
  const incoming = (report.items ?? []).map((it) => {
    const key = seriesKey(it.title);
    const rel = key
      ? (series.get(key) ?? [])
          .filter((p) => p.hash !== it.hash)
          .sort((a, b) => (a.day < b.day ? 1 : -1))
          .slice(0, 3)
          .map(({ day: d, title, url }) => ({ day: d, title, url }))
      : [];
    return rel.length ? { ...it, related: rel } : it;
  });

  // 同日の再実行に備え、ハッシュで併合する（新しい判定を優先して上書き）
  const byHash = new Map(existing.map((it) => [it.hash, it]));
  for (const it of incoming) byHash.set(it.hash, it);
  const items = [...byHash.values()];

  const counts = { 高: 0, 中: 0, 低: 0 };
  for (const it of items) counts[it.importance] = (counts[it.importance] ?? 0) + 1;

  // 報道(P9): 別枠 press に保存。counts・index.json(グラフの材料)には一切含めない
  const existingPress = monthly.days[day]?.press ?? [];
  const pressByHash = new Map(existingPress.map((it) => [it.hash, it]));
  for (const it of report.press ?? []) pressByHash.set(it.hash, it);
  const pressItems = [...pressByHash.values()];

  monthly.days[day] = { counts, items, ...(pressItems.length ? { press: pressItems } : {}) };

  const index = loadJson(INDEX_PATH, { months: [], days: {} });
  if (!index.months.includes(month)) {
    index.months = [...index.months, month].sort();
  }
  index.days[day] = {
    t: items.length,
    h: counts["高"],
    m: counts["中"],
    l: counts["低"],
  };

  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(monthPath, JSON.stringify(monthly, null, 1) + "\n");
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 1) + "\n");

  console.log(
    `履歴に記録: ${day} = 行政${items.length}件（高${counts["高"]}・中${counts["中"]}・低${counts["低"]}）` +
      `・報道${pressItems.length}件 → data/history/${month}.json`
  );
}

try {
  main();
} catch (e) {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
}
