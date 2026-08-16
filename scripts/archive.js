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

function main() {
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  const day = jstDay(new Date(report.generatedAt ?? Date.now()));
  const month = day.slice(0, 7); // YYYY-MM
  const monthPath = join(HISTORY_DIR, `${month}.json`);

  const monthly = loadJson(monthPath, { days: {} });
  const existing = monthly.days[day]?.items ?? [];

  // 同日の再実行に備え、ハッシュで併合する（新しい判定を優先して上書き）
  const byHash = new Map(existing.map((it) => [it.hash, it]));
  for (const it of report.items ?? []) byHash.set(it.hash, it);
  const items = [...byHash.values()];

  const counts = { 高: 0, 中: 0, 低: 0 };
  for (const it of items) counts[it.importance] = (counts[it.importance] ?? 0) + 1;

  monthly.days[day] = { counts, items };

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
    `履歴に記録: ${day} = ${items.length}件（高${counts["高"]}・中${counts["中"]}・低${counts["低"]}） → data/history/${month}.json`
  );
}

try {
  main();
} catch (e) {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
}
