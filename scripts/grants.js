#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 助成金の収集（P24）
 *
 * 紙面（history）とは**別系統**。理由:
 *  - 時間の向きが逆（紙面は過去に積み上がる／助成は締切に向かって減る）
 *  - 同じ助成が数か月間ずっと有効なので、日ごとに記録すると同じものが何度も並ぶ
 *  - 件数集計とグラフ（この7日＝対応が要る日の地図）の主語が壊れる
 * したがって書き先は data/grants.json ただ1つ。「いま応募できる助成」だけを持ち、
 * 締切が過ぎたものは表示からも保存からも消す（deadlines.js と同じ思想）。
 *
 * ⚠️ 締切の抽出に**AIを使わない**（P24の[DECISION]）。助成の源はどれも締切が
 *    ラベル付きの定型フィールドで、正規表現で取れる。AIを介さないので幻覚が
 *    原理的に起こらない。P11から流用するのは日付パーサと範囲チェックだけ。
 * AIを使うのは 要約・用途タグ・応募主体タグ・分野タグ の付与のみ。
 *
 * 対象の源は docs/sources.md の **区分=助成** の行（状態が「巡回中」のものだけ）。
 * crawl.js はこの区分を巡回しない（別系統のため）。
 *
 * 使い方: node scripts/grants.js [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchHtml, checkReprintNotice, readSources } from "./crawl.js";
import {
  loadEnv, listCandidateModels, preferModel, generate, normalizeFields,
} from "./summarize.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GRANTS_PATH = join(ROOT, "data", "grants.json");
const USER_AGENT =
  "fukushi-watch/0.1 (+https://github.com/kanda-houtokukai/fukushi-watch)";
const FETCH_INTERVAL_MS = 1500; // 監視先サイトへのアクセス間隔（マナー）
const BATCH = 20;               // 1リクエストあたりの判定件数（本文を含むので25より控えめ）
const BODY_MAX_CHARS = 2500;    // 判定に渡す本文の上限（本文は保存しない）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dryRun = process.argv.includes("--dry-run");
const jstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());

/* ===========================================================================
 * 語彙（P24で実データ134件から起こした）
 * ======================================================================== */

/** 用途タグ9値。モノ・ハコ系4＋ヒト・コト系5 */
export const USE_VOCAB = [
  "設備・改修", "機器・用具", "ICT", "車両",
  "人材・研修", "事業・活動", "研究・調査", "行事・啓発", "表彰",
];
/** 用途のうち「その他・一般」の受け皿。具体が付いたら落とす（下の normalizeUses） */
const USE_CATCHALL = "事業・活動";
/** これ以上の値が付いたら「使途を問わない」とみなして空にする
 *  ⚠️閾値6は**未検証**。AI付与を1回走らせた実測で確定すること（台帳に記録済み） */
const USE_ALL_THRESHOLD = 6;

/** 応募主体タグ5値 */
export const APPLICANT_VOCAB = [
  "社会福祉法人", "NPO・公益法人", "任意団体", "個人", "研究者・大学",
];

/**
 * 用途タグの正規化（P15の教訓＝AIの揺らぎはプロンプトでなく後処理で潰す）。
 * ⚠️分野タグとは**逆向き**にする。分野の「共通」は「全分野に効く」という強い意味だが、
 *   用途の「事業・活動」は「その他・一般」という弱い受け皿なので、
 *   具体的な使途が付いているなら受け皿の方を落とす。
 */
export function normalizeUses(uses) {
  const set = new Set((Array.isArray(uses) ? uses : []).filter((u) => USE_VOCAB.includes(u)));
  if (set.size >= USE_ALL_THRESHOLD) return []; // 使途を問わない＝絞り込みの手掛かりにならない
  if (set.size > 1 && set.has(USE_CATCHALL)) set.delete(USE_CATCHALL);
  return USE_VOCAB.filter((u) => set.has(u)); // 語彙の並び順に揃える（表示のゆらぎも消す）
}

/** 応募主体の正規化。⚠️空配列は「誰でも可」ではなく「読み取れなかった」を意味する */
export function normalizeApplicants(list) {
  const set = new Set((Array.isArray(list) ? list : []).filter((a) => APPLICANT_VOCAB.includes(a)));
  return APPLICANT_VOCAB.filter((a) => set.has(a));
}

/* ===========================================================================
 * 締切のパース（AIを使わない。P11の日付パーサの考え方を流用）
 * ======================================================================== */

/**
 * 締切の原文を {deadline, deadlineType, deadlineRaw} に正規化する。
 *   date    … 日付が1つに定まる（並び順・残り日数に使える）
 *   rolling … 随時・通年（締切がない。締切ありと分けて扱う＝P24の[DECISION]）
 *   unknown … 「11月中旬」等、日付に落とせない表記（隠さず件数は見せる）
 * ⚠️複数日付（「A ／ B ／ 随時・通年」）は**いちばん近い未来の日付**を採る。
 */
export function parseDeadline(raw, today = jstToday()) {
  const s = String(raw ?? "").normalize("NFKC").trim();
  if (!s) return { deadline: null, deadlineType: "unknown", deadlineRaw: "" };
  const dates = [];
  for (const m of s.matchAll(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/g)) {
    dates.push(iso(Number(m[1]) + 2018, m[2], m[3]));
  }
  for (const m of s.matchAll(/(\d{4})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*日?/g)) {
    dates.push(iso(m[1], m[2], m[3]));
  }
  const future = dates.filter((d) => d && d >= today).sort();
  if (future.length) return { deadline: future[0], deadlineType: "date", deadlineRaw: s };
  if (/随時|通年/.test(s)) return { deadline: null, deadlineType: "rolling", deadlineRaw: s };
  // 過去日しか無い＝募集終了。呼び出し側で落とす
  if (dates.length) return { deadline: dates.sort().pop(), deadlineType: "date", deadlineRaw: s };
  return { deadline: null, deadlineType: "unknown", deadlineRaw: s };
}
const iso = (y, m, d) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/* ===========================================================================
 * パーサ（源ごと。増設はここに1つ足す）
 * ======================================================================== */

/**
 * zenshakyo-sponsor: 全社協「福祉の助成情報」ハブ（/guide/sponsor/）
 *   <h2><a href="p/260824sompo.html">SOMPO福祉財団「…助成」</a></h2>
 *   <p>（情報掲載2026年8月24日/募集締切2026年10月9日）</p>
 * ⚠️**ハブ型**（新着として流れず、ページの中身が入れ替わる）。一覧に載っている＝
 *   募集中、という読み方をする。消えた項目は grants.json からも消える。
 */
export function parseZenshakyoSponsor(html, baseUrl) {
  const items = [];
  const re =
    /<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>\s*<p>（情報掲載(\d+)年(\d+)月(\d+)日\/募集締切([^）]*)）<\/p>/g;
  for (const [, href, rawTitle, y, m, d, dl] of html.matchAll(re)) {
    const full = decodeEntities(
      rawTitle.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    );
    if (!full) continue;
    // 「SOMPO福祉財団「認定NPO法人取得資金助成」」→ funder と title に割る。
    // ⚠️括弧が入れ子・後置になる例があるので貪欲に閉じ「」まで取る
    //   例「日本生命財団「児童・少年の健全育成助成」（物品助成）」→ 財団名／助成名（物品助成）
    let funder = "";
    let title = full;
    let mm = full.match(/^([^「]+)「(.+)」(.*)$/);
    if (mm) {
      funder = mm[1].trim();
      title = (mm[2] + mm[3]).trim();
    } else if ((mm = full.match(/^([^（(]+)[（(](.+)[）)]\s*$/))) {
      funder = mm[1].trim();
      title = mm[2].trim();
    }
    // ★安全弁: 助成名から始まる見出し（「〇〇助成」「△△助成事業」）では割れない。
    //   割れなかった痕跡（括弧が残る／出し手が助成名より長い）があれば分割を捨てる。
    //   出し手が空でも表示は成立する（助成名だけ出す）。誤った出し手を出すよりよい。
    if (/[「」『』]/.test(funder) || funder.length > title.length) {
      funder = "";
      title = full;
    }
    items.push({
      funder,
      title,
      url: new URL(href, baseUrl).href,
      postedAt: iso(y, m, d),
      ...parseDeadline(dl),
    });
  }
  return items;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/* ---------------------------------------------------------------------------
 * jyosei-navi-api: 助成財団センター「助成・奨学金情報navi」の検索API（P24）
 *
 * ⚠️**公開・文書化されたAPIではない**。SPAの通信から把握した内部APIで、
 *   予告なく変わりうる（0件ガードでその日のうちに気づける）。
 *   このため `docs/sources.md` の状態は**照会の承諾を得るまで「保留（照会前）」**にしてある。
 *   有効化は状態を「巡回中」に1行変えるだけ（福祉新聞・全社協と同じ手順）。
 * ⚠️画像(PHOTO)は使わない（免責事項で画像の利用は事前承諾が必要とされているため）。
 *
 * 取得は毎朝1回。一覧APIは pageSize がサーバ側で10に固定されているため
 * 110件で11リクエスト。詳細API（応募資格 SEIGEN の取得）は**新規項目のみ・1回10件まで**に
 * 絞り、1日あたり最大21リクエストに収める。
 * ------------------------------------------------------------------------ */

const NAVI_API = "https://jyosei-navi.jfc.or.jp/api";
const NAVI_VIEW = "https://jyosei-navi.jfc.or.jp/search/search/assist/view/";
const NAVI_DETAIL_PER_RUN = 10; // 1回に読む詳細の上限（相手への負荷を抑える）

/** 検索条件の雛形。⚠️全キーが必須（一部だけ渡すと400が返る） */
function naviQuery(today) {
  const [y, m] = today.split("-").map(Number);
  const q = {
    orgname: "", JIGYOKEITAI1: false, JIGYOKEITAI2: false, JIGYOKEITAI3: false,
    JIGYOKEITAI4: false, JIGYOKEITAI5: false,
    研: false, 派: false, 招: false, 会: false, 版: false, 事: false, 展: false, 組: false, 施: false,
    奨日内: false, 奨日留: false, 奨外: false, 賞: false, 他: false,
    物理科学: false, 地球科学: false, 生命科学: false, 工学: false, 理学: false, 医学: false,
    形式科学: false, 農学: false, 科学技術全般: false, 人文科学全般: false, 社会科学全般: false,
    環境: false, 教育: false, 福祉: true, 医保: false, 文芸: false, 国際: false, 公共: false,
    人権: false, 災害: false, 就労支援: false, 地域開発: false, 起業支援: false, 他分: false,
    給与: false, 貸与: false,
    DANTAIDOMESTIC: false, DOMESTIC_SELECT: "/", DANTAIOVERSEA: false, OVERSEA_SELECT: "/",
    SCHOOL_SELECT: "/",
    // 募集期間が「1年前〜1年半先」に重なるものを引き、締切は下で今日以降に絞る
    datemode: 1, startyear: y - 1, startmonth: m, endyear: y + 1, endmonth: m,
  };
  return q;
}

async function naviPost(path, body) {
  const res = await fetch(`${NAVI_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

/** JIGYOB(事業形態)→用途タグの機械写像。⚠️構造化データはAIより確かなので優先する */
const NAVI_USE_MAP = {
  研究: "研究・調査", 研究その他: "研究・調査",
  会議: "行事・啓発", "公演・展示": "行事・啓発", 出版: "行事・啓発",
  表彰: "表彰",
  "事業・活動": "事業・活動", 組識運営支援: "事業・活動",
  派遣: "人材・研修", 招聘: "人材・研修",
  // 「施設・備品」は 設備・改修／機器・用具／ICT／車両 のどれかに割れるのでAIに委ねる
};
export function naviUsesFromJigyob(jigyob) {
  const out = new Set();
  for (const m of String(jigyob ?? "").matchAll(/【([^】]+)】/g)) {
    const u = NAVI_USE_MAP[m[1]];
    if (u) out.add(u);
  }
  return [...out];
}

/** SEIGEN の「法人格:」「所属機関:」→応募主体タグの機械写像 */
export function naviApplicantsFromSeigen(seigen) {
  const s = String(seigen ?? "");
  const out = new Set();
  if (/社会福祉法人/.test(s)) out.add("社会福祉法人");
  if (/特定非営利活動法人|認定特定非営利活動法人|公益財団法人|公益社団法人|一般財団法人|一般社団法人/.test(s)) {
    out.add("NPO・公益法人");
  }
  if (/任意団体|法人格の有無は問|法人格:無/.test(s)) out.add("任意団体");
  if (/所属機関|大学|研究機関|研究者/.test(s)) out.add("研究者・大学");
  return [...out];
}

async function collectJyoseiNavi(src, today) {
  const query = naviQuery(today);
  const rows = [];
  let total = 0;
  for (let page = 1; page <= 40; page++) {
    const d = await naviPost("/search/assist/", {
      query,
      condition: { page, pageSize: 10, searchTerm: "", sortMode: 2 },
    });
    total = d.total ?? 0;
    if (!d.datas || d.datas.length === 0) break;
    rows.push(...d.datas);
    if (rows.length >= total) break;
    await sleep(FETCH_INTERVAL_MS);
  }
  console.log(`  API: ${rows.length}件を取得（総数${total}）`);
  return rows.map((r) => ({
    funder: (r.MAIN_NAME ?? "").trim(),
    title: (r.AS_NAME ?? "").replace(/\s+/g, " ").trim(),
    url: NAVI_VIEW + r.nid,
    postedAt: String(r.updatedAt ?? "").slice(0, 10),
    ...parseDeadline(r.enddate, today),
    _nid: r.nid,
    _purpose: (r.PURPOSE ?? "").trim(),
    _usesFromSource: naviUsesFromJigyob(r.JIGYOB),
  }));
}

/** 応募資格(SEIGEN)は詳細APIにしか無い。新規項目のみ・1回10件までに絞って読む */
async function naviFillDetails(items) {
  let n = 0;
  for (const it of items) {
    if (!it._nid || n >= NAVI_DETAIL_PER_RUN) break;
    try {
      const res = await fetch(`${NAVI_API}/search/assistinfo/${it._nid}`, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (res.ok) {
        const d = await res.json();
        it._seigen = d.assist?.SEIGEN ?? "";
        it._appFromSource = naviApplicantsFromSeigen(it._seigen);
        const sc = d.assist?.schedules?.[0];
        if (sc?.kns) it._amount = String(sc.kns).replace(/\s+/g, " ").trim();
      }
    } catch { /* 1件の失敗は無視して続ける（次回拾い直す） */ }
    n++;
    await sleep(FETCH_INTERVAL_MS);
  }
  if (n) console.log(`  詳細（応募資格）を${n}件読んだ`);
}

/** 収集の入口。HTMLの源もAPIの源も同じ形（源を受け取り項目の配列を返す）にそろえる */
const COLLECTORS = {
  "zenshakyo-sponsor": async (src) => parseZenshakyoSponsor(await fetchHtml(src.url), src.url),
  "jyosei-navi-api": async (src, today) => collectJyoseiNavi(src, today),
};

/** 助成の項目ハッシュ。タイトル＋出し手＋URL（締切は延長されうるので入れない） */
export function grantHash(it) {
  return createHash("sha256")
    .update(`${it.funder}\n${it.title}\n${it.url}`)
    .digest("hex")
    .slice(0, 16);
}

/* ===========================================================================
 * 個別ページの本文（用途・応募主体の材料。⚠️本文は保存しない）
 * ======================================================================== */

async function fetchBodyText(url) {
  const html = await fetchHtml(url);
  const b = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  const i = b.indexOf("本文ここから");
  const j = b.indexOf("本文ここまで");
  const seg = i >= 0 && j > i ? b.slice(i, j) : b;
  return seg
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .normalize("NFKC")
    .trim()
    .slice(0, BODY_MAX_CHARS);
}

/* ===========================================================================
 * AI: 要約・分野タグ・用途タグ・応募主体タグ
 * ======================================================================== */

function buildGrantPrompt(items) {
  const list = items.map((it, i) => ({
    index: i,
    funder: it.funder,
    title: it.title,
    body: it._body ?? "",
  }));
  return `あなたは社会福祉法人の助成金担当者です。次の助成金の募集要項から、探すときに使うタグを付けてください。

1. summary: どんな助成かの日本語の説明（1〜2文。「何に使える助成か」と「誰が応募できるか」が分かるように）
2. fields: 対象者の分野タグ。次の5値のみ・配列（複数可）
   「保育」「児童」「障害」「高齢」= 特定分野／「共通」= 分野を問わず福祉事業に効く
   空配列 = 福祉と関係がない。⚠️迷ったら空でなく「共通」に倒す
3. uses: **お金の使いみち**のタグ。次の9値のみ・配列（複数可）
   - 「設備・改修」= 施設の建設・建て替え・改修・増改築・工事・設備整備
   - 「機器・用具」= 福祉用具・介護機器・訓練用品・備品・物品の購入
   - 「ICT」= 介護ソフト・記録システム・見守り機器・パソコン等のデジタル機器・ICT化
   - 「車両」= 福祉車両・送迎車・自動車の購入や整備
   - 「人材・研修」= 研修・人材育成・養成・資格取得・海外研修・派遣
   - 「事業・活動」= 日常の事業運営・活動費・組織基盤の強化（**いちばん広い受け皿**）
   - 「研究・調査」= 調査研究・学術研究
   - 「行事・啓発」= イベント・大会・公演・展示・出版・会議開催・普及啓発
   - 「表彰」= 表彰・顕彰・賞（応募して賞金を得る型）
   ⚠️募集要項に書かれている使いみちだけを拾う。書かれていないものを推測で足さない
   ⚠️具体的な使いみちが読み取れるなら「事業・活動」は付けない
4. applicants: **誰が応募できるか**のタグ。次の5値のみ・配列（複数可）
   - 「社会福祉法人」「NPO・公益法人」（特定非営利活動法人・公益/一般の財団・社団）
   - 「任意団体」（法人格のない団体・グループ）「個人」「研究者・大学」
   ⚠️募集要項に応募資格の記載が無ければ**空配列**（「誰でも可」ではなく「読み取れない」の意味）
5. amount: 助成金額の記載（原文のまま短く。例「1団体30万円上限」）。無ければ空文字

入力（${items.length}件）:
${JSON.stringify(list, null, 1)}

出力の規則:
- JSONの配列のみを出力する。前置き・後書き・コードフェンスは一切禁止
- 必ず入力と同じ${items.length}件を、index を含めて返す
- 形式: [{"index":0,"summary":"…","fields":["障害"],"uses":["車両"],"applicants":["NPO・公益法人"],"amount":"…"}, …]`;
}

function parseGrantResponse(text, expected) {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const arr = JSON.parse(stripped);
  if (!Array.isArray(arr)) throw new Error("応答が配列ではありません");
  if (arr.length !== expected) {
    throw new Error(`入力${expected}件に対し応答が${arr.length}件です（件数不一致）`);
  }
  for (const it of arr) {
    if (typeof it.summary !== "string" || !it.summary.trim()) {
      throw new Error(`summary が空です (index=${it.index})`);
    }
    for (const [key, vocab] of [["uses", USE_VOCAB], ["applicants", APPLICANT_VOCAB]]) {
      if (!Array.isArray(it[key])) throw new Error(`${key} が配列ではありません (index=${it.index})`);
      for (const v of it[key]) {
        if (!vocab.includes(v)) throw new Error(`不正な ${key}: ${JSON.stringify(v)}`);
      }
    }
    if (!Array.isArray(it.fields)) throw new Error(`fields が配列ではありません (index=${it.index})`);
  }
  return arr;
}

/* ===========================================================================
 * メイン
 * ======================================================================== */

function loadStore() {
  if (!existsSync(GRANTS_PATH)) return { updatedAt: null, items: [] };
  return JSON.parse(readFileSync(GRANTS_PATH, "utf8"));
}

async function main() {
  const today = jstToday();
  const sources = readSources().filter((s) => s.kind === "grant" && s.status === "巡回中");
  if (sources.length === 0) {
    console.log("状態が「巡回中」の助成の源がありません（docs/sources.md の区分=助成）");
    return;
  }

  const store = loadStore();
  // ★期限切れの整理（保存からも消す。deadlines.js と同じ最小化方針）
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
      const parsed = await collect(src, today);
      // ★抽出0件は構造変化の疑いとして失敗扱い（サイレント0件の禁止）
      if (parsed.length === 0) {
        throw new Error("助成を1件も抽出できませんでした（ページ構造の変化の疑い）");
      }
      const open = parsed.filter(
        (it) => it.deadlineType !== "date" || !it.deadline || it.deadline >= today
      );
      console.log(`  掲載${parsed.length}件 / 締切前${open.length}件`);

      for (const it of open) {
        const hash = grantHash(it);
        seenThisRun.add(hash);
        const prev = known.get(hash);
        if (prev) {
          // 既知: 締切だけ更新する（延長されることがある）。判定は再実行しない
          Object.assign(prev, {
            deadline: it.deadline, deadlineType: it.deadlineType,
            deadlineRaw: it.deadlineRaw, postedAt: it.postedAt,
          });
          continue;
        }
        fresh.push({ hash, source: src.name, sourceKind: "org", _method: src.method, ...it });
      }
    } catch (e) {
      console.error(`  失敗（続行）: ${src.name}: ${e.message}`);
      errors.push({ source: src.name, error: e.message });
    }
  }

  // ★ハブ型: 一覧から消えた＝募集終了。保存からも消す
  //   ただし源の取得に失敗したときは消さない（全消えの事故を防ぐ）
  if (errors.length === 0) {
    const dropped = store.items.filter((it) => !seenThisRun.has(it.hash));
    store.items = store.items.filter((it) => seenThisRun.has(it.hash));
    if (dropped.length) console.log(`  一覧から消えたため削除: ${dropped.length}件`);
  }

  console.log(`新規${fresh.length}件 / 既知${store.items.length}件 / 期限切れ整理${pruned}件`);

  if (fresh.length > 0 && !dryRun) {
    const targets = [];

    // (a) APIの源: 応募資格(SEIGEN)を新規のみ・1回10件まで読み、本文はAPIが返した文面を使う。
    //     ⚠️禁止文言の確認は全社協への届出で約束したものなので、この源には適用しない
    //     （相手も目的も違う。無関係な相手に確認リクエストを撃たない）
    const naviFresh = fresh.filter((it) => it._method === "jyosei-navi-api");
    if (naviFresh.length) {
      await naviFillDetails(naviFresh);
      for (const it of naviFresh) {
        it._body = [it._purpose, it._seigen ? `応募制限: ${it._seigen}` : ""]
          .filter(Boolean).join(" ").slice(0, BODY_MAX_CHARS);
        targets.push(it);
      }
    }

    // (b) HTMLの源(全社協): 個別ページの本文を読む。
    //     ⚠️届出で約束した禁止文言の確認を同じ関門として必ず通す
    for (const it of fresh.filter((x) => x._method !== "jyosei-navi-api")) {
      const verdict = await checkReprintNotice(it.url);
      if (verdict === "blocked") {
        console.log(`  除外（無断転載を禁ずる旨の記載あり）: ${it.title}`);
        await sleep(FETCH_INTERVAL_MS);
        continue;
      }
      if (verdict === "unknown") {
        console.log(`  保留（本文を確認できず・翌朝やり直す）: ${it.title}`);
        await sleep(FETCH_INTERVAL_MS);
        continue;
      }
      try {
        it._body = await fetchBodyText(it.url);
        targets.push(it);
      } catch (e) {
        console.log(`  保留（本文の取得に失敗）: ${it.title}: ${e.message}`);
      }
      await sleep(FETCH_INTERVAL_MS);
    }

    if (targets.length > 0) {
      const apiKey = loadEnv();
      const models = await listCandidateModels(apiKey);
      let used = null;
      for (let i = 0; i < targets.length; i += BATCH) {
        const batch = targets.slice(i, i + BATCH);
        let judged = null;
        for (const model of (used ? preferModel(models, used) : models)) {
          try {
            console.log(`判定: ${model}（${batch.length}件）`);
            judged = parseGrantResponse(
              await generate(apiKey, model, buildGrantPrompt(batch)), batch.length
            );
            used = model;
            break;
          } catch (e) {
            console.log(`  失敗（次の候補へ）: ${e.message.slice(0, 110)}`);
          }
        }
        // ★全モデルで失敗したら失敗終了する（空のタグで正常終了しない）
        if (!judged) throw new Error("全モデルで判定に失敗しました");
        const byIndex = new Map(judged.map((j) => [j.index, j]));
        batch.forEach((it, n) => {
          const j = byIndex.get(n);
          if (!j) throw new Error(`応答に index=${n} がありません`);
          // ★源が持つ構造化データ（JIGYOB・SEIGEN）とAIの出力を合流させる。
          //   構造化データはAIより確かなので必ず含め、AIには「そこに無いもの」を補わせる。
          const uses = normalizeUses([...(it._usesFromSource ?? []), ...(j.uses ?? [])]);
          const applicants = normalizeApplicants([
            ...(it._appFromSource ?? []), ...(j.applicants ?? []),
          ]);
          const amount = (it._amount || j.amount || "").trim();
          // ★本文・作業用の値は保存しない
          const clean = Object.fromEntries(
            Object.entries(it).filter(([k]) => !k.startsWith("_"))
          );
          store.items.push({
            ...clean,
            summary: j.summary.trim(),
            fields: normalizeFields(j.fields),
            uses,
            applicants,
            amount,
          });
        });
      }
    }
  }

  // 並び: 締切ありを締切の近い順 → 随時・通年 → 不明（P24の[DECISION]）
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
    for (const it of store.items.slice(0, 10)) {
      console.log(`  ${it.deadline ?? it.deadlineType} ${it.funder} / ${it.title}`.slice(0, 100));
    }
    return;
  }
  mkdirSync(dirname(GRANTS_PATH), { recursive: true });
  writeFileSync(GRANTS_PATH, JSON.stringify(store, null, 1) + "\n");
  const byType = store.items.reduce((a, it) => ((a[it.deadlineType] = (a[it.deadlineType] ?? 0) + 1), a), {});
  console.log(
    `完了: ${store.items.length}件（締切あり${byType.date ?? 0}・随時通年${byType.rolling ?? 0}・不明${byType.unknown ?? 0}）→ data/grants.json`
  );
}

/* 直接実行されたときだけ main を走らせる（他スクリプトから関数を再利用するため） */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  main().catch((e) => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  });
}
