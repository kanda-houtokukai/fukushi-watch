/**
 * pdftext-check.js — P43 区切り①の機械確認（手動実行・daily.yml には接続しない）
 *
 * 使い方: node scripts/pdftext-check.js [PDFのURL]
 * f-kaigo の実PDF（支部地区部会研修のお知らせ）を1本取得し、部品1〜4を通しで検証する。
 * ⚠️PDFはメモリ上で処理して破棄する（ファイルにも data/*.json にも保存しない。
 *   照合の状態もこのスクリプトでは書き出さない——本番の状態書き込みは区切り②の仕事）。
 * ⚠️既定URLと期待件数（16ブロック等）は 2026-08 時点の実PDFに合わせた値。
 *   PDFが改版されたら件数は変わりうる（検証の「型」として残す。URLは引数で差し替え可）。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchPdfIfChanged, extractPdfText, fullTextOf,
  splitBlocks, extractDeadline, blockForTitle, norm, titleNeedle,
} from "./pdftext.js";
import { survivesPrune } from "./kenshu.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "https://www.f-kaigo.jp/upimg/o6a6982bda4b95.pdf"; // 26URL中9研修が指す実体
// ⚠️フラグ（--ai）はURLとして受け取らない
const url = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? DEFAULT_URL;

// f-kaigo の台帳値（区切り②で docs/sources.md に入れる値と同じもの）
const DELIMITER = "開催要綱";
const MARKER = "《 締 切 》";

let ok = 0;
let ng = 0;
const t = (name, cond, detail = "") => {
  console.log(`${cond ? "OK" : "NG"} ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? ok++ : ng++;
};

/* 検証7で使う「テキスト層の無いPDF」（白紙1ページ・オフセットは組み立て時に計算） */
function makeBlankPdf() {
  const objs = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (const o of objs) {
    offsets.push(body.length);
    body += o;
  }
  const xrefAt = body.length;
  body += `xref\n0 4\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer<</Size 4/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const state = {}; // このスクリプト内だけの照合状態（保存しない）

// --- 取得（1回目・必ず changed:true）
const first = await fetchPdfIfChanged(url, state);
if (first.error || !first.changed) {
  console.error(`取得に失敗: ${first.error ?? "changed:false（状態が空なのに？）"}`);
  process.exit(1);
}
console.log(`取得: ${url}（${first.data.length.toLocaleString()} bytes）`);

// --- 部品2: 抽出と段組
const ex = await extractPdfText(first.data);
t("テキスト層あり", !ex.noTextLayer, `${ex.chars}字`);
const colCounts = ex.pages.map((p) => p.columns.length);
console.log(`   ページごとの列数: [${colCounts.join(", ")}]`);
// 1〜4ページは2段組・5ページ目は研修一覧の表（全幅＝1列）が正
t("列の自動判定: [2,2,2,2,1]（本文4ページ=2段組・末尾=一覧表）",
  colCounts.join(",") === "2,2,2,2,1");

// --- 検証1: ブロック16件
const text = fullTextOf(ex);
const blocks = splitBlocks(text, DELIMITER);
t("検証1: ブロックが16件", blocks.length === 16, `${blocks.length}件`);

// --- 検証2: 締切16/16・うち1件が2027-01-14
const deadlines = blocks.map((b) => extractDeadline(b, MARKER, "2026-08-27"));
const got = deadlines.filter(Boolean);
t("検証2a: 締切が16/16", got.length === 16, `${got.length}/16`);
t("検証2b: 令和9年→2027-01-14 を含む", got.includes("2027-01-14"));
console.log(`   締切の分布: ${[...new Set(got)].sort().join(", ")}`);

// --- 検証3: 平文（《 》の外）を拾わない
t("検証3a: 「定員になり次第締め切ります」を拾わない",
  extractDeadline("定員になり次第締め切ります。令和８年９月３日", MARKER, "2026-08-27") === null);
t("検証3b: 「締切後も〜」（《 》なし）を拾わない",
  extractDeadline("締切後も定員に余裕がある場合は令和８年９月３日まで受け付けます", MARKER, "2026-08-27") === null);
t("検証3c: 本文中の《締切》出現がブロック数と同じ16回（余分な平文ヒットなし）",
  (norm(text).match(/《締切》/g) ?? []).length === 16);

// --- 検証4: NFKC正規化の有無で突合が変わる（data/kenshu.json の実題名で実測）
// ⚠️対象は「このPDFを研修用リンクに持つ9件」（detail_497〜505）に固定する。
//   PDFには【再掲】として他のPDFを指す研修の題名も載るため（実測12件が含有）、
//   全26件で数えると期待値が動く。再掲を含む数は参考として表示だけする。
const kenshu = JSON.parse(readFileSync(join(ROOT, "data", "kenshu.json"), "utf8"));
const fkaigo = kenshu.items.filter((i) => i.via === "fkaigo");
const CLUSTER = [497, 498, 499, 500, 501, 502, 503, 504, 505]; // このPDFを指す個別ページ
const cluster = fkaigo.filter((i) => CLUSTER.some((n) => i.url.includes(`detail_${n}.php`)));
// 双方とも【 】の装飾は落として比べる（比べたいのはNFKCの効果だけ）
const naive = (s) => String(s ?? "").replace(/\s+/g, "").replace(/【[^】]*】/g, "");
const withNfkc = cluster.filter((i) => norm(text).includes(titleNeedle(i.title)));
const without = cluster.filter((i) => naive(text).includes(naive(i.title)));
const anyNfkc = fkaigo.filter((i) => norm(text).includes(titleNeedle(i.title)));
console.log(`   9研修の題名の含有: NFKCあり ${withNfkc.length}件 ／ NFKCなし ${without.length}件` +
  `（参考: 再掲を含む全26件では ${anyNfkc.length}件が含有）`);
// ⚠️手順0の報告は「無しで2件外れ」だったが、全文字で照合し直すと『いいね!』の
//   半角!（PDFは全角！）も外れて実測は**3件**（手順0は部分文字列で試したための見逃し）
t("検証4: NFKC無しでは3件外れる（あり9・なし6）",
  withNfkc.length === 9 && without.length === 6,
  `NFKC無しで外れた題名: ${withNfkc.filter((i) => !without.includes(i)).map((i) => i.title).join("・")}`);

// --- 突合の通し（このPDFの9研修すべてでブロックが引け、締切が取れること）
let matched = 0;
let matchedDeadlines = [];
for (const item of withNfkc) {
  const block = blockForTitle(text, DELIMITER, item.title, item.heldDates ?? []);
  const dl = block ? extractDeadline(block, MARKER, "2026-08-27") : null;
  if (block && dl) {
    matched++;
    matchedDeadlines.push(`${dl} ${item.title.slice(0, 18)}`);
  } else {
    console.log(`   引けず: ${item.title}`);
  }
}
t("突合: 9研修すべてでブロックと締切が引ける", matched === 9, `${matched}/9`);
for (const line of matchedDeadlines) console.log(`   ${line}`);
// 目視裏取り済みの1点（PDF1ページ目: 排泄ケア →《 締 切 》令和８年９月３日）
const haisetsu = withNfkc.find((i) => i.title.includes("排泄ケア"));
if (haisetsu) {
  const dl = extractDeadline(
    blockForTitle(text, DELIMITER, haisetsu.title, haisetsu.heldDates ?? []) ?? "",
    MARKER, "2026-08-27");
  t("突合の答え合わせ: 排泄ケア＝2026-09-03（PDF目視値）", dl === "2026-09-03", String(dl));
}

// --- 検証5: 実在しない題名は null
t("検証5: 実在しない題名で null",
  blockForTitle(text, DELIMITER, "存在しない研修のテスト題名", []) === null);

// --- 複数候補→開催日で絞る／絞れなければ null（合成データ）
{
  const fake =
    "開催要綱 研修A 《日時》10月22日 《 締 切 》10月1日 " +
    "開催要綱 研修A 《日時》11月5日 《 締 切 》10月15日";
  const b1 = blockForTitle(fake, DELIMITER, "研修A", ["2026-11-05"]);
  t("複数候補: 開催日で1件に絞れる", b1 !== null && extractDeadline(b1, MARKER, "2026-08-27") === "2026-10-15");
  t("複数候補: 開催日でも絞れなければ null", blockForTitle(fake, DELIMITER, "研修A", []) === null);
}

// --- 検証6: HEAD照合（2回目は再取得もパースもしない）
const second = await fetchPdfIfChanged(url, state);
t("検証6: 2回目は changed:false（HEADのみ・本文を取得しない）",
  second.changed === false && second.data === undefined);

// --- 検証7: テキスト層の無いPDFは例外でなく noTextLayer
const blank = await extractPdfText(makeBlankPdf());
t("検証7: 白紙PDFで noTextLayer:true（例外なし）", blank.noTextLayer === true);

// --- 空欄＝全体1ブロック（facsw型の既定動作）
t("区切り語が空欄なら全体を1ブロック", splitBlocks("ある研修の案内 《 締 切 》令和8年10月1日", "").length === 1);

/* --- 区切り②: 締切超過の扱い（P43の要件3）。⚠️表示に直結するので機械で押さえる。
   PDF由来の締切は超過しても消さず、最終開催日（expireOn）まで残す。
   消えるのは、この扱いを指定していない源だけ。 */
const pdfItem = (over) => ({
  deadlineType: "date", deadline: "2026-09-03", expireOn: "2026-11-06", keepUntilHeld: true, ...over,
});
t("要件3a: PDF由来は締切超過でも残る（開催日はまだ先）",
  survivesPrune(pdfItem(), "2026-09-30") === true);
t("要件3b: 指定していない源は締切超過で消える",
  survivesPrune(pdfItem({ keepUntilHeld: undefined }), "2026-09-30") === false);
t("要件3c: PDF由来でも最終開催日を過ぎたら消える",
  survivesPrune(pdfItem(), "2026-11-07") === false);
t("要件3d: 締切前はどちらも残る",
  survivesPrune(pdfItem(), "2026-09-01") === true &&
  survivesPrune(pdfItem({ keepUntilHeld: undefined }), "2026-09-01") === true);

/* ===========================================================================
 * ゴールデン基準（P48）: **AI方式と規則方式が一致するか**
 *
 * ⚠️《 》型の15件は「規則で正解が分かっているデータ」であり、**将来モデルが変わったときに
 *   AIのずれを検知する唯一の物差し**。規則方式を消してはいけない理由がこれ。
 * ⚠️APIを使うので既定では走らせない。`node scripts/pdftext-check.js --ai` のときだけ。
 *   daily.yml には接続しない（毎朝の失敗経路を増やさない）。
 * ======================================================================== */
if (process.argv.includes("--ai")) {
  const { loadEnv } = await import("./summarize.js");
  const { createAiContext, outlineByAi } = await import("./outline-ai.js");
  const { blockLinesForTitle, outlineFromLines } = await import("./pdftext.js");
  const NAMES = ["日時", "会場", "講師", "参加費", "定員", "ポイント"];
  const ctx = createAiContext(loadEnv(), {});
  const texts = new Map();
  const cands = kenshu.items.filter((i) => i.via === "fkaigo" && i.outlineUrl);
  let target = 0;
  let agree = 0;
  console.log(`\n--- ゴールデン基準（AI方式 vs 規則方式）---`);
  for (const item of cands) {
    if (!texts.has(item.outlineUrl)) {
      const res = await fetch(item.outlineUrl, { headers: { "User-Agent": "fukushi-watch/0.1" } });
      texts.set(item.outlineUrl, fullTextOf(await extractPdfText(new Uint8Array(await res.arrayBuffer()))));
      await new Promise((r) => setTimeout(r, 1500)); // 源に控えめに当たる
    }
    const pdfText = texts.get(item.outlineUrl);
    // ⚠️対象は「規則方式で正解が分かるもの」だけ——番号付き型は規則が0件なので基準に使えない
    const lines = blockLinesForTitle(pdfText, "開催要綱", item.title, item.heldDates ?? []);
    const rule = lines?.length ? outlineFromLines(lines, "《 》", NAMES).filter((o) => o.value) : [];
    if (!rule.length) continue;
    target++;
    const got = await outlineByAi(lines.join("\n"), NAMES, ctx, item.heldDates ?? []);
    const ai = new Map((got?.kept ?? []).map((k) => [k.name, norm(k.value)]));
    const ruleMap = new Map(rule.map((o) => [o.name, norm(o.value)]));
    const diff = NAMES.filter((n) => (ai.get(n) ?? "") !== (ruleMap.get(n) ?? ""));
    if (!diff.length) { agree++; continue; }
    console.log(`  差異: ${item.title.slice(0, 24)}`);
    for (const n of diff) {
      console.log(`    【${n}】AI「${(ai.get(n) ?? "—").slice(0, 46)}」`);
      console.log(`          規則「${(ruleMap.get(n) ?? "—").slice(0, 46)}」`);
    }
  }
  t(`ゴールデン: AI方式と規則方式が ${target}/${target} 一致`,
    agree === target && target > 0, `${agree}/${target}（AI呼び出し${ctx.calls}回）`);
}

console.log(`\n結果: OK ${ok} ／ NG ${ng}`);
process.exit(ng ? 1 : 0);
