#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 関連記録の再計算（P14の付随・手動実行のみ）
 *
 * バックフィルで履歴が厚くなった後、**全履歴の項目に対して**系列照合をやり直し、
 * related（関連する過去の記録）を付け直す。
 * 毎朝の archive.js は「当月＋前月」しか見ないため、後から積んだ過去分には
 * related が付いていない。これを埋めるための一回きりの処理。
 *
 * - AIは使わない（系列キーの機械照合のみ。API消費ゼロ）
 * - 判定内容（summary/importance/fields）には一切触れない
 * - related は「その項目より前の日付」の同系列項目だけを指す（時間の順序を守る）
 *
 * 使い方: node scripts/relink.js [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seriesKey } from "./archive.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_DIR = join(ROOT, "data", "history");
const dryRun = process.argv.includes("--dry-run");

const files = readdirSync(HISTORY_DIR).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
const months = new Map();
for (const f of files) {
  months.set(f.replace(".json", ""), JSON.parse(readFileSync(join(HISTORY_DIR, f), "utf8")));
}

// 全履歴から 系列キー → 項目一覧 の索引を作る
const index = new Map();
for (const data of months.values()) {
  for (const [day, rec] of Object.entries(data.days)) {
    for (const it of rec.items ?? []) {
      const key = seriesKey(it.title);
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ day, hash: it.hash, title: it.title, url: it.url });
    }
  }
}

let touched = 0, before = 0, after = 0;
const examples = [];
for (const [month, data] of months) {
  let changed = false;
  for (const [day, rec] of Object.entries(data.days)) {
    for (const it of rec.items ?? []) {
      if (it.related) before++;
      const key = seriesKey(it.title);
      const rel = key
        ? (index.get(key) ?? [])
            .filter((p) => p.hash !== it.hash && p.day < day) // 自分より前の日だけ
            .sort((a, b) => (a.day < b.day ? 1 : -1))
            .slice(0, 3)
            .map(({ day: d, title, url }) => ({ day: d, title, url }))
        : [];
      const now = rel.length ? rel : undefined;
      if (JSON.stringify(now) !== JSON.stringify(it.related)) {
        if (now) it.related = now; else delete it.related;
        changed = true; touched++;
      }
      if (now) {
        after++;
        if (examples.length < 6) examples.push({ day, title: it.title, rel: now });
      }
    }
  }
  if (changed && !dryRun) {
    writeFileSync(join(HISTORY_DIR, `${month}.json`), JSON.stringify(data, null, 1) + "\n");
  }
}

console.log(`関連記録の再計算${dryRun ? "（下見）" : ""}: 変更${touched}件 / related付き ${before}件 → ${after}件`);
for (const e of examples) {
  console.log(`  ${e.day} ${e.title.slice(0, 34)}`);
  for (const r of e.rel) console.log(`    ← ${r.day} ${r.title.slice(0, 34)}`);
}
