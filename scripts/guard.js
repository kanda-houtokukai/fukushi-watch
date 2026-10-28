#!/usr/bin/env node
// 見張り役（P64追記 10/29）: 毎朝の更新3本が、今日ちゃんと動いて公開まで済んだかを確かめる。
//   ① ウォッチの巡回（Actions daily）… data/state.json の lastCrawlDate が今日か
//   ② 報酬改定ガイドの毎朝のタスク … kaitei/_src/live.json の checkedAt が今日か・公開ページにも出ているか
//   ③ 性暴力防止ガイドの毎朝のタスク … dbs/_src/live.json の checkedAt が今日か・公開ページにも出ているか
// どれかが止まっていたら終了コード1で終わる → GitHub から「Run failed: guard」のメールが届く。
// 外部には自分の公開ページしか取りに行かない。鍵は使わない。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://fukushi-watch.fknd.jp";
const jstToday = () =>
  new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function readJSON(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
}

async function pageHasToday(url, today) {
  try {
    const res = await fetch(`${url}?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) return `公開ページを開けません（HTTP ${res.status}）`;
    const html = await res.text();
    return html.includes(`"checkedAt": "${today}`) || html.includes(`"checkedAt":"${today}`)
      ? null
      : "公開ページに今日の確認日時が出ていません（GitHub Pages の反映が止まっている可能性）";
  } catch (e) {
    return `公開ページを開けません（${e.message}）`;
  }
}

async function main() {
  const today = jstToday();
  const problems = [];

  const state = readJSON("data/state.json");
  if (state.lastCrawlDate !== today) {
    problems.push(`ウォッチの巡回: 今日（${today}）の巡回が記録されていません（最後は ${state.lastCrawlDate || "記録なし"}）。Actions の daily の実行を確かめてください`);
  }

  const guides = [
    ["報酬改定ガイドの毎朝の更新", "kaitei"],
    ["性暴力防止ガイドの毎朝の更新", "dbs"],
  ];
  for (const [name, dir] of guides) {
    const live = readJSON(`${dir}/_src/live.json`);
    const last = String(live.checkedAt || "").slice(0, 10);
    if (last !== today) {
      problems.push(`${name}: 今日（${today}）の確認が記録されていません（最後は ${last || "記録なし"}）。定期タスクの実行を確かめてください`);
      continue;
    }
    const p = await pageHasToday(`${SITE}/${dir}/`, today);
    if (p) problems.push(`${name}: ${p}`);
  }

  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    console.log(`\n止まっているもの ${problems.length} 件（${today}）`);
    process.exit(1);
  }
  console.log(`3本とも今日（${today}）の更新を確認しました`);
}

main();
