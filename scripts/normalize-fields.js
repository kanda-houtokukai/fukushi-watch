#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 既存履歴の分野タグ正規化（P15・手動実行のみ）
 *
 * 4分野すべてが並ぶ判定は「共通」と同義なので、履歴の全項目に対して
 * 機械的に ["共通"] へ寄せる（summarize.js と同じ normalizeFields を使う）。
 *
 * - AIは使わない（機械的な置き換えのみ・API消費ゼロ）
 * - summary・importance・reason など判定の他の部分には一切触れない
 * - 報道（press）の fields も同じ規則で揃える
 *
 * 使い方: node scripts/normalize-fields.js [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeFields } from "./summarize.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_DIR = join(ROOT, "data", "history");
const dryRun = process.argv.includes("--dry-run");

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
      const after = normalizeFields(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        if (examples.length < 8) {
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
