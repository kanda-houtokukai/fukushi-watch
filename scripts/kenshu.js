#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 研修の収集（P34）
 *
 * 助成（grants.js）と同じ別系統。書き先は data/kenshu.json ただ1つで、
 * 「いま申し込める研修」だけを持ち、締切（無ければ開催時期）を過ぎたものは
 * 表示からも保存からも消す。紙面（history）には積まない。
 *
 * ⚠️**AIを一切使わない**（P34の[DECISION]）。判定材料が研修名だけなので、
 *    締切もタグ（分野・種別）もすべて機械抽出・機械写像にする。
 *    幻覚が原理的に起こらず、写像の全件が検証できる。
 *
 * 対象の源は docs/sources.md の **区分=研修** の行（状態が「巡回中」のものだけ）。
 * ⚠️年間予定表のURLは年度替わり（毎年4月）に変わる（/schedule-r8/ → /schedule-r9/）。
 *    URLは台帳（sources.md）で管理し、コードに埋め込まない。変え忘れは
 *    毎朝の取得エラー（404/0件）で気づける——失敗時は前日までの kenshu.json を温存する。
 *
 * 使い方: node scripts/kenshu.js [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchHtml, readSources } from "./crawl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KENSHU_PATH = join(ROOT, "data", "kenshu.json");

const dryRun = process.argv.includes("--dry-run");
const jstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
const iso = (y, m, d) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/* ===========================================================================
 * タグの語彙と機械写像（P34。実データ＝令和8年度の予定表53行から起こした）
 * ======================================================================== */

/** 種別2値。⚠️「受けなければならないもの」を見分ける核（P34の[DECISION]） */
export const KIND_VOCAB = ["法定・資格系", "任意・スキル系"];

/**
 * 種別の判定: ①予定表の「資格取得研修」セクション配下（認知症介護・介護支援専門員・
 * 高齢者権利擁護を含む）は法定・資格系 ②セクションが取れない場合の保険として
 * 語彙でも判定する（指定研修・修了が要件になる研修の名称）。
 */
const LEGAL_KW =
  /認知症介護実践|認知症対応型|小規模多機能|介護支援専門員|喀痰吸引|計画作成担当者|権利擁護等推進研修|推進員養成研修/;
export function kindOf(title, section) {
  if (/資格取得/.test(section ?? "")) return "法定・資格系";
  if (LEGAL_KW.test(title)) return "法定・資格系";
  return "任意・スキル系";
}

/**
 * 分野の写像（語彙はP6の5値）。研修名は定型的なので語彙写像が最も正確。
 * ⚠️どれにも該当しない＝分野を問わない職員研修なので「共通」（P6の「迷ったら共通」と同じ向き）。
 */
export function fieldsOf(title) {
  const f = [];
  if (/認知症|介護支援専門員|小規模多機能|高齢者|老人/.test(title)) f.push("高齢");
  if (/障がい|障害/.test(title)) f.push("障害");
  if (/保育/.test(title)) f.push("保育");
  if (/児童|こども|子ども/.test(title)) f.push("児童");
  return f.length ? f : ["共通"];
}

/* ===========================================================================
 * 年間予定表のパース
 * ======================================================================== */

/**
 * 年度内の「M月D日」をISOへ。年度は4月始まりで、**今日の属する年度**で解く
 * （予定表はその年度の研修だけを載せるため。P24-4の「年は掲載日基準」と同じ考え方）。
 */
export function fiscalIso(m, d, today) {
  const y = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
  return iso(m >= 4 ? y : y + 1, m, d);
}

const strip = (html) =>
  String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .normalize("NFKC")
    .trim();

/**
 * kenshu-schedule: 年間予定表（h3セクション見出し＋ column-1〜5 のクラス付きの表）。
 *   column-1=研修名 / column-2=開催要綱PDF・申込フォーム（未公開なら「11月～1月開催予定」等の文）
 *   column-4=申込開始日 / column-5=申込終了日（複数日程あり: 「B日程4月24日 C･D日程5月22日」）
 * ⚠️**ハブ型**（中身が入れ替わる）。一覧に載っている＝今年度の研修、という読み方をする。
 * 返り値: { items, raw } — raw は読み取れた行数（0件ガードは raw にかける）。
 */
export function parseKenshuSchedule(html, today, baseUrl) {
  const items = [];
  let raw = 0;
  // セクション見出し（h3/h5）で分割しながら読む。見出しはタグを剥いで持ち回す
  const parts = html.split(/<h[35][^>]*>/);
  let section = "";
  for (const part of parts) {
    const headEnd = part.indexOf("</h");
    let body = part;
    if (headEnd >= 0) {
      section = strip(part.slice(0, headEnd));
      body = part.slice(headEnd);
    }
    for (const [, rowHtml] of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = {};
      for (const [, n, cell] of rowHtml.matchAll(
        /<t[dh][^>]*class="column-(\d)"[^>]*>([\s\S]*?)<\/t[dh]>/g
      )) {
        cells[n] = cell;
      }
      // 「※1日目は…」のような行内注記はタイトルから落とす（詳細は要綱が担う）
      const title = strip(cells["1"]).replace(/\s*※.*$/, "");
      if (!title || title === "研修名") continue; // 見出し行
      raw++;
      // 「定員に達したため受付を終了しました」等は募集が閉じている＝載せない
      if (/受付(?:を|は)?終了|定員に達した|締め切りました/.test(strip(rowHtml))) continue;
      const yoko = cells["2"]?.match(/href="([^"]+\.pdf)"/)?.[1] ?? null;
      const openText = strip(cells["4"]);
      const endText = strip(cells["5"]);
      // 申込終了日: 複数日程は**今日以降でいちばん近い日**を採る（過ぎた日程は対象外）
      const ends = [...endText.matchAll(/(\d{1,2})月(\d{1,2})日/g)].map((m) =>
        fiscalIso(Number(m[1]), Number(m[2]), today)
      );
      const future = ends.filter((d) => d >= today).sort();
      let deadline = null, deadlineType, deadlineRaw;
      if (future.length) {
        deadline = future[0];
        deadlineType = "date";
        deadlineRaw = endText;
      } else if (ends.length) {
        continue; // 全日程の申込が終了
      } else {
        // 日付が無い＝要綱未公開の「◯月開催予定」など。存在を知ることに価値がある
        //（馬主財団と同じ理屈）ので「締切不明」の束に入れる。
        // ⚠️note に使えるのは時期の文だけ（col2のリンクテキスト「開催要綱」を
        //   締切の記載として出さない）
        const col2text = strip((cells["2"] ?? "").replace(/<a[\s\S]*?<\/a>/g, " "));
        const note =
          endText || (/月|予定/.test(col2text) ? col2text : "");
        if (!note && !yoko) continue; // 情報が何も無い行
        deadlineType = "unknown";
        deadlineRaw = note || "締切の記載なし";
      }
      const om = openText.match(/(\d{1,2})月(\d{1,2})日/);
      items.push({
        title,
        url: yoko ?? baseUrl, // 原本=開催要綱。未公開の間は予定表そのもの
        deadline,
        deadlineType,
        deadlineRaw,
        openFrom: om ? fiscalIso(Number(om[1]), Number(om[2]), today) : null,
        fields: fieldsOf(title),
        kind: kindOf(title, section),
      });
    }
  }
  return { items, raw };
}

const COLLECTORS = {
  "kenshu-schedule": async (src, today) => {
    const html = await fetchHtml(src.url);
    return parseKenshuSchedule(html, today, src.url);
  },
};

/** 項目ハッシュ。タイトル＋URL（締切は延長されうるので入れない・grants と同じ） */
export function kenshuHash(it) {
  return createHash("sha256").update(`${it.title}\n${it.url}`).digest("hex").slice(0, 16);
}

/* ===========================================================================
 * メイン（構成は grants.js と同じ: ハブ型・期限切れ削除・失敗時は前日分を温存）
 * ======================================================================== */

function loadStore() {
  if (!existsSync(KENSHU_PATH)) return { updatedAt: null, items: [] };
  return JSON.parse(readFileSync(KENSHU_PATH, "utf8"));
}

async function main() {
  const today = jstToday();
  const sources = readSources().filter((s) => s.kind === "training" && s.status === "巡回中");
  if (sources.length === 0) {
    console.log("状態が「巡回中」の研修の源がありません（docs/sources.md の区分=研修）");
    return;
  }

  const store = loadStore();
  const before = store.items.length;
  store.items = store.items.filter(
    (it) => it.deadlineType !== "date" || !it.deadline || it.deadline >= today
  );
  const pruned = before - store.items.length;

  const known = new Map(store.items.map((it) => [it.hash, it]));
  const seenThisRun = new Set();
  const fresh = [];
  const errors = [];

  for (const src of sources) {
    try {
      const collect = COLLECTORS[src.method];
      if (!collect) throw new Error(`巡回方法「${src.method}」に対応するコレクタがありません`);
      console.log(`取得: ${src.name} (${src.url})`);
      const { items: parsed, raw } = await collect(src, today);
      // ★0件は構造変化・年度替わりのURL失効の疑いとして失敗扱い（サイレント0件の禁止）
      if (raw === 0) {
        throw new Error("1件も読み取れませんでした（構造変化か、年度替わりのURL未更新の疑い）");
      }
      console.log(`  掲載${raw}行 / 申込可能${parsed.length}件`);
      for (const it of parsed) {
        const hash = kenshuHash(it);
        seenThisRun.add(hash);
        const prev = known.get(hash);
        if (prev) {
          // 既知: 締切・タグを更新する（日程の追加・要綱の公開で変わる）
          Object.assign(prev, it);
          continue;
        }
        fresh.push({ hash, source: src.name, sourceKind: "org", ...it });
      }
    } catch (e) {
      console.error(`  失敗（続行）: ${src.name}: ${e.message}`);
      errors.push({ source: src.name, error: e.message });
    }
  }

  // ★ハブ型: 一覧から消えた＝終了。ただし取得に失敗した回は消さない（全消えの事故防止）
  if (errors.length === 0) {
    const dropped = store.items.filter((it) => !seenThisRun.has(it.hash));
    store.items = store.items.filter((it) => seenThisRun.has(it.hash));
    if (dropped.length) console.log(`  一覧から消えたため削除: ${dropped.length}件`);
  }

  store.items.push(...fresh);
  console.log(`新規${fresh.length}件 / 合計${store.items.length}件 / 期限切れ整理${pruned}件`);

  // 並び: 締切ありを近い順 → 不明（開催予定）。grants と同じ規則
  const rank = { date: 0, rolling: 1, unknown: 2 };
  store.items.sort(
    (a, b) =>
      (rank[a.deadlineType] ?? 3) - (rank[b.deadlineType] ?? 3) ||
      String(a.deadline ?? "").localeCompare(String(b.deadline ?? "")) ||
      String(a.title).localeCompare(String(b.title))
  );
  store.updatedAt = new Date().toISOString();

  if (dryRun) {
    console.log("（下見のため書き込みません）");
    for (const it of store.items.slice(0, 12)) {
      console.log(
        `  ${it.deadline ?? it.deadlineType} [${it.kind}] ${it.fields.join("・")} ${it.title}`.slice(0, 110)
      );
    }
    return;
  }
  mkdirSync(dirname(KENSHU_PATH), { recursive: true });
  writeFileSync(KENSHU_PATH, JSON.stringify(store, null, 1) + "\n");
  const byType = store.items.reduce(
    (a, it) => ((a[it.deadlineType] = (a[it.deadlineType] ?? 0) + 1), a), {});
  console.log(
    `完了: ${store.items.length}件（締切あり${byType.date ?? 0}・締切不明${byType.unknown ?? 0}）→ data/kenshu.json`
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  main().catch((e) => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  });
}
