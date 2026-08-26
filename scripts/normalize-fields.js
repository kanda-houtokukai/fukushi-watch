#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 既存履歴の分野タグ正規化（P15・P36・手動実行のみ）
 *
 * 履歴の全項目（行政・団体・報道）の分野タグに、本流と同じ機械正規化をかけ直す:
 *  - P15: 4分野すべてが並ぶ判定は「共通」と同義なので ["共通"] へ寄せる
 *  - P36: 源そのものが分野を持つ場合（介護福祉士会=高齢・Joint=高齢 等・
 *         正本は docs/sources.md の「既定分野」列）、「共通」に落ちた項目を既定分野へ倒す。
 *         全分野向けの内容（虐待防止・BCP・感染症・外国人材等）は共通のまま残す
 *  いずれも summarize.js と同じ関数を使う（本流の判断を再計算経路にも等しく効かせる）
 *
 * - AIは使わない（機械的な置き換えのみ・API消費ゼロ）
 * - summary・importance・reason など判定の他の部分には一切触れない
 *
 * 使い方: node scripts/normalize-fields.js [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeFields, applyDefaultField } from "./summarize.js";
import { readSources } from "./crawl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_DIR = join(ROOT, "data", "history");
const dryRun = process.argv.includes("--dry-run");

const srcByName = new Map(readSources().map((r) => [r.name, r]));

let changed = 0, total = 0;
const examples = [];

for (const file of readdirSync(HISTORY_DIR).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort()) {
  const path = join(HISTORY_DIR, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  let touched = false;
  for (const [day, rec] of Object.entries(data.days)) {
    for (const it of [...(rec.items ?? []), ...(rec.press ?? [])]) {
      total++;
      const before = it.fields ?? [];
      const after = applyDefaultField(
        normalizeFields(before), srcByName.get(it.source), it.title
      );
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        if (examples.length < 12) {
          examples.push(`${day} ${it.title.slice(0, 30)}  [${before.join("・")}] → [${after.join("・")}]`);
        }
        it.fields = after;
        changed++; touched = true;
      }
    }
  }
  if (touched && !dryRun) writeFileSync(path, JSON.stringify(data, null, 1) + "\n");
}

console.log(`分野タグの正規化${dryRun ? "（下見）" : ""}: ${changed}件を変更 / 全${total}件`);
for (const e of examples) console.log(`  ${e}`);
