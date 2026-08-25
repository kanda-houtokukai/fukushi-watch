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
/* ⚠️「6値以上なら空配列（＝使途を問わない）」という規則を持っていたが、実データ110件で
 *   一度も発火せず（最大2〜3値）、存在しない条件のためのコードになっていたのでP24-4で外した。
 *   使途が多すぎて絞り込みの役に立たない助成が実際に現れたら、そのとき改めて入れる。 */
export function normalizeUses(uses) {
  const set = new Set((Array.isArray(uses) ? uses : []).filter((u) => USE_VOCAB.includes(u)));
  if (set.size > 1 && set.has(USE_CATCHALL)) set.delete(USE_CATCHALL);
  return USE_VOCAB.filter((u) => set.has(u)); // 語彙の並び順に揃える（表示のゆらぎも消す）
}

/** 応募主体の正規化。⚠️空配列は「誰でも可」ではなく「読み取れなかった」を意味する */
export function normalizeApplicants(list) {
  const set = new Set((Array.isArray(list) ? list : []).filter((a) => APPLICANT_VOCAB.includes(a)));
  return APPLICANT_VOCAB.filter((a) => set.has(a));
}

/**
 * 応募条件の軸（P28）。実データ10件に実在した条件だけから起こした語彙。
 * ⚠️「法人の規模・職員数」「事業所の種別・定員規模」は実データに存在しなかったため入れていない
 *   （机上で軸を作らない）。実例が現れたら、そのとき追加を判断する。
 * ⚠️「所在地」（団体の所在地の制限）と「事業の実施地」は**別の軸**。混同すると誤る
 *   （アジア生協協力基金: 団体は国内・事業地はアジア）。
 * 値は閉じた語彙にできない（都道府県列挙・年数など多様）ため、**軸だけ固定し、値は原文の引用**。
 */
export const COND_AXES = [
  "所在地", "事業の実施地", "設立・活動年数", "受給歴",
  "併願・重複", "補助率・自己負担", "主体の付帯条件", "提出書類", "その他の対象限定",
];

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
  const items = rows.map((r) => ({
    funder: (r.MAIN_NAME ?? "").trim(),
    title: (r.AS_NAME ?? "").replace(/\s+/g, " ").trim(),
    url: NAVI_VIEW + r.nid,
    postedAt: String(r.updatedAt ?? "").slice(0, 10),
    ...parseDeadline(r.enddate, today),
    _nid: r.nid,
    _purpose: (r.PURPOSE ?? "").trim(),
    _usesFromSource: naviUsesFromJigyob(r.JIGYOB),
  }));
  return { items, raw: rows.length };
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

/* ---------------------------------------------------------------------------
 * RSSの源（P24-4）。3つの型を持つ:
 *   jfc-subsidy-rss … 本文に「応募期間（締切） 2026/08/19～2026/09/30」の定型がある
 *   kyobo-rss       … 見出しに【応募受付中・11/27締切】【…8/13必着】がある（共同募金会2つ共通）
 *   wam-josei-rss   … 年1〜2回の大型公募だけを拾う（見出しに「募集」がある回のみ）
 * いずれも締切は**正規表現で取る**（AIを使わない・P24の[DECISION]）。
 * ------------------------------------------------------------------------ */

/** RSS2.0 から {title, link, pubDate, body} を取り出す（依存ゼロ・自作） */
export function parseRssItems(xml) {
  const cdata = (x) => {
    if (!x) return "";
    const m = x.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    return (m ? m[1] : x).trim();
  };
  const out = [];
  for (const [, body] of xml.matchAll(/<item[ >]([\s\S]*?)<\/item>/g)) {
    const title = decodeEntities(
      cdata(body.match(/<title>([\s\S]*?)<\/title>/)?.[1]).replace(/\s+/g, " ")
    );
    const link = decodeEntities(cdata(body.match(/<link>([\s\S]*?)<\/link>/)?.[1]));
    const pub = cdata(body.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]);
    const enc = cdata(body.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/)?.[1])
      || cdata(body.match(/<description>([\s\S]*?)<\/description>/)?.[1]);
    if (!title || !link) continue;
    let date = "";
    const t = Date.parse(pub);
    if (!Number.isNaN(t)) {
      date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(t));
    }
    out.push({
      title, link, date,
      text: decodeEntities(enc.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").normalize("NFKC").trim(),
      html: enc, // 生のHTML（本文が実質空でリンク先に実体がある源が href を取るため・P27）
    });
  }
  return out;
}

/**
 * 「M/D締切」「M/D必着」の年を補う。
 * ⚠️基準は**掲載日**であって今日ではない。「今日以降でいちばん近い年」にすると、
 *   既に締め切られた古い記事（見出しが更新されないことがある）の締切が
 *   翌年へ繰り上がり、締切済みの助成が1年先の予定として並ぶ（実際にこれで
 *   福岡県共同募金会の締切済み2件が2027年として出た）。
 *   掲載日基準で解いた結果が過去日なら、それは正しく「締切済み」として落ちる。
 */
function deadlineFromMonthDay(m, d, postedAt, today) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(postedAt || "") ? postedAt : today;
  const by = Number(base.slice(0, 4));
  for (const y of [by, by + 1]) {
    const cand = iso(y, m, d);
    if (cand >= base) return cand; // 掲載日以降でいちばん近い年
  }
  return iso(by, m, d);
}

async function fetchRss(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * JFC記事から財団側の募集ページへのリンクを選ぶ（P28・条件抽出の材料）。
 * 実測: 記事は財団トップと募集ページの両方にリンクすることが多い。財団トップ（パスが"/"）と
 * 連絡先・添付ファイルを除き、助成・募集を思わせる語をURLに含む候補を優先、
 * 同格なら**最後**の候補を採る（「詳細はこちら」は本文の後方にあることが多い）。
 */
export function pickFunderLink(html) {
  const cands = [];
  for (const m of String(html ?? "").matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const u = decodeEntities(m[1]);
    let host, path;
    try { ({ host, pathname: path } = new URL(u)); } catch { continue; }
    if (/jfc\.or\.jp|gmpg\.org|twitter\.com|x\.com|facebook\.com|line\.me|instagram\.com|youtube\.com|google\./.test(host)) continue;
    if (path === "/" || path === "") continue; // 財団トップに条件は無い
    if (/contact|privacy|policy|sitemap/i.test(path)) continue;
    if (/\.(pdf|docx?|xlsx?|zip)$/i.test(path)) continue; // 添付は解析しない（P28の決定）
    cands.push(u);
  }
  const hinted = cands.filter((u) =>
    /josei|jyosei|grant|subsid|koubo|boshu|bosyu|oubo|information|entry/i.test(u)
  );
  return (hinted.length ? hinted : cands).pop() ?? null;
}

/** JFC 助成金募集ニュース。本文の「応募期間（締切）」から締切を取る */
async function collectJfcRss(src, today) {
  const rows = parseRssItems(await fetchRss(src.url));
  const items = [];
  for (const r of rows) {
    // 「応募期間(締切) 2026/08/19~2026/09/30」
    // ⚠️本文は NFKC 正規化済みなので**括弧は半角・波線はU+7E(~)**になっている。
    //   全角のまま書くと一致しない（実際に一度これで締切が全部 unknown になった）
    const seg = r.text.match(/応募期間\s*[(（]\s*締切\s*[)）]\s*(.{0,60})/)?.[1] ?? "";
    // 期間表記なら終わりの日付を締切とする（波線は環境により U+7E / U+FF5E / U+301C）
    const end = seg.split(/[~～〜]/).pop() ?? seg;
    const dl = parseDeadline(end || seg, today);
    items.push({
      funder: "", // JFCの見出しは助成名のみ。出し手は本文にあるのでAIに拾わせる
      // ⚠️先頭の【助成先募集】等は状態の印であって助成名ではない。
      //   外しておかないと、他の源から入った同じ助成と同定できない
      title: r.title.replace(/^【[^】]*】\s*/, ""),
      url: r.link,
      postedAt: r.date,
      ...dl,
      _body: r.text.slice(0, BODY_MAX_CHARS),
      _condUrl: pickFunderLink(r.html), // 条件の実体は財団側のページにある（P28実測）
    });
  }
  return { items, raw: rows.length };
}

/** 共同募金会（中央・福岡県）。見出しの【応募受付中・M/D締切】から状態と締切を取る */
async function collectKyoboRss(src, today) {
  const rows = parseRssItems(await fetchRss(src.url));
  const items = [];
  for (const r of rows) {
    // ⚠️【助成先決定】【応募受付終了】は結果や終了の告知＝助成面に出さない。
    //   義援金の「募集」も寄付のお願いであって応募できる助成ではないので除く
    if (/受付終了|締め切りました|決定しました|助成先団体決定|助成先決定/.test(r.title)) continue;
    if (/義援金/.test(r.title)) continue;
    if (!/応募受付中|募集|公募/.test(r.title)) continue;
    const md = r.title.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*(?:締切|必着|まで)/);
    const dl = md
      ? { deadline: deadlineFromMonthDay(Number(md[1]), Number(md[2]), r.date, today),
          deadlineType: "date", deadlineRaw: md[0] }
      : parseDeadline(r.text.match(/応募締切[^。]{0,40}/)?.[0] ?? "", today);
    items.push({
      funder: src.name.replace(/^\S+\s/, ""),
      title: r.title.replace(/^【[^】]*】\s*/, ""),
      url: r.link,
      postedAt: r.date,
      ...dl,
      _body: r.text.slice(0, BODY_MAX_CHARS),
    });
  }
  return { items, raw: rows.length };
}

/** WAM助成。年1〜2回の大型公募のみ。⚠️募集が無い時期は0件だが**正常**（rawで判定する） */
async function collectWamRss(src, today) {
  const rows = parseRssItems(await fetchRss(src.url));
  const items = [];
  for (const r of rows) {
    if (!/募集/.test(r.title)) continue;      // 訪問レポート・内定団体の公表などは除く
    if (/内定|決定|報告|終了/.test(r.title)) continue;
    items.push({
      funder: "独立行政法人福祉医療機構",
      title: r.title,
      url: r.link,
      postedAt: r.date,
      ...parseDeadline(r.text.match(/(?:応募|申請|提出)(?:期限|締切|期間)[^。]{0,40}/)?.[0] ?? "", today),
      _body: r.text.slice(0, BODY_MAX_CHARS),
    });
  }
  return { items, raw: rows.length };
}

/**
 * 馬主財団（中央競馬馬主社会福祉財団）。P27で追加。
 * ⚠️記事本文が実質空（「こちらをご覧になって下さい」のみ）で、締切が機械的に取れない源。
 *   締切がサイトに無いのは**構造的**——申請の受付期間は窓口（各馬主協会・都道府県共同募金会）
 *   ごとに異なると財団サイトが明記している。したがって原則「締切不明」の束に落ちる。
 *   **それでよい**（P27の[DECISION]。締切不明でも存在を知ることに価値がある）。
 * - 流れる記事の大半は研修の実施報告・交付決定・監査書式（実測で月1.2件）。
 *   **募集・申請の案内だけ**をタイトルで絞る（年2件程度）
 * - 判定の材料は、記事内の最初のリンク先（助成事業ページ。対象と助成内容の記載がある）を
 *   読んで補う。リンクが無い・読めないときは RSS の本文だけで判定する
 */
/**
 * 馬主財団の記事本文から、実体のあるリンク先（助成事業ページ）を選ぶ。
 * ⚠️**RSSの content:encoded（記事本文だけ）に対して使うこと。** 記事ページのHTML全体に
 *   かけると、head内のWordPressの雑リンク（wlwmanifest等）やナビを拾う（P28で実際に踏んだ）。
 */
function pickUmanushiLink(bodyHtml, selfLink) {
  return [...String(bodyHtml ?? "").matchAll(/href="([^"]+)"/g)]
    .map((m) => decodeEntities(m[1]))
    .find(
      (u) =>
        u.startsWith("https://www.jra-umanushi-hukushi.or.jp") &&
        u !== selfLink &&
        !/^https:\/\/www\.jra-umanushi-hukushi\.or\.jp\/?$/.test(u) &&
        !/\/wp-content\/uploads\/|\.(pdf|docx?|xlsx?|zip)$/i.test(u)
    ) ?? null;
}

async function collectUmanushiRss(src, today) {
  const rows = parseRssItems(await fetchRss(src.url));
  const items = [];
  for (const r of rows) {
    if (!/募集|申請|受付|公募/.test(r.title)) continue;
    // ⚠️「海外研修生の募集要領を決定しました」（個人向けの研修生募集＝法人が応募する
    //   助成ではない）も「決定」でここで落ちる。意図どおり
    if (/終了|決定|報告|監査|交付/.test(r.title)) continue;
    // 締切は「締切」のラベルがある文だけから取る。無ければ unknown のまま
    //   （国内研修助成の受付記事は本文に「申請受付の締切りは令和8年1月30日です」の形がある）
    const dl = parseDeadline(r.text.match(/締切[^。]{0,40}/)?.[0] ?? "", today);
    let body = r.text;
    const href = pickUmanushiLink(r.html, r.link);
    if (href) {
      try {
        body = `${r.text} ${await fetchBodyText(href)}`;
      } catch { /* リンク先が読めなくてもRSS本文で判定を続ける */ }
      await sleep(FETCH_INTERVAL_MS);
    }
    items.push({
      funder: "中央競馬馬主社会福祉財団",
      title: r.title,
      url: r.link,
      postedAt: r.date,
      ...dl,
      _body: body.slice(0, BODY_MAX_CHARS),
      _condUrl: href ?? null, // 条件の実体はリンク先の助成事業ページにある
    });
  }
  return { items, raw: rows.length };
}

/**
 * 収集の入口。HTMLの源もAPIの源もRSSの源も同じ形にそろえる。
 * 返り値 `{ items, raw }` の **raw は絞り込む前に読めた件数**。
 * ⚠️0件ガードは raw に対してかける。「読めたが募集中が0件」（WAM助成のように
 *   年1回しか募集しない源では正常）を構造変化と誤判定しないため。
 */
const RSS_METHODS = new Set(["jfc-subsidy-rss", "kyobo-rss", "wam-josei-rss", "umanushi-rss"]);

const COLLECTORS = {
  "zenshakyo-sponsor": async (src) => {
    const items = parseZenshakyoSponsor(await fetchHtml(src.url), src.url);
    return { items, raw: items.length };
  },
  "jyosei-navi-api": async (src, today) => collectJyoseiNavi(src, today),
  "jfc-subsidy-rss": async (src, today) => collectJfcRss(src, today),
  "kyobo-rss": async (src, today) => collectKyoboRss(src, today),
  "wam-josei-rss": async (src, today) => collectWamRss(src, today),
  "umanushi-rss": async (src, today) => collectUmanushiRss(src, today),
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

async function fetchBodyText(url, maxChars = BODY_MAX_CHARS) {
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
    .slice(0, maxChars);
}

/* ===========================================================================
 * 応募条件の抽出（P28）
 *
 * 方針は「**AIは選ぶだけ、表示は原文**」:
 *  - AIの仕事は「本文のどの一節が、どの軸の条件か」を選ぶことだけ。出力は {axis, quote}
 *  - quote は本文からの**逐語引用**で、**本文に実在することを機械照合**する（P11の考え方）。
 *    実在しない引用は捨てる。表示するのは quote そのものなので、言い換えの誤りが
 *    構造的に起こらず、「応募できる/できない」の判定も構造的に不可能
 *  - 読み取れなかったら空配列＝「記載を確認できませんでした」と正直に出す。推測で埋めない
 *
 * 対象は conditions を持たない項目だけ（＝新規のみ。導入時の1回だけ既存分が遡及される）。
 * 取得に失敗した項目は conditions が付かないまま残り、翌朝やり直される。
 * ⚠️PDFは解析しない（依存ゼロ構成の維持・幻覚リスク回避）。詳細は要項への導線で補う。
 * ======================================================================== */

const COND_TEXT_MAX = 9000; // 条件は要項ページ全体に散らばる（実測で最大5千字級）ため広めに読む
const COND_BATCH = 5;       // 本文が長いので判定より小さい束にする
const COND_PER_RUN = 15;    // 1回の実行で条件抽出する上限（相手への負荷とAPI消費を抑える）

/** 引用の照合用に均す（空白をすべて落とす。AIが空白の入り方を変えても照合できるように） */
const condFlat = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "");

/**
 * 条件ページのURLを決める。⚠️源の性質はコードに埋め込まず台帳（method）で引く（P26の教訓）。
 * JFC・馬主財団は記事が紹介だけで、条件の実体はリンク先にある。他は記事・個別ページ自体に載る。
 */
async function resolveConditionsUrl(it, srcByName) {
  const src = srcByName.get(it.source);
  if (src?.method === "jfc-subsidy-rss") {
    return pickFunderLink(await fetchHtml(it.url)) ?? it.url;
  }
  if (src?.method === "umanushi-rss") {
    // ⚠️記事ページのHTML全体からリンクを拾わない（headの雑リンクを掴む）。
    //   コレクタと同じく、RSSの記事本文（content:encoded）から選ぶ
    const r = parseRssItems(await fetchRss(src.url)).find((x) => x.link === it.url);
    return (r ? pickUmanushiLink(r.html, r.link) : null) ?? it.url;
  }
  return it.url;
}

function buildCondPrompt(batch) {
  const list = batch.map((t, i) => ({
    index: i, funder: t.it.funder, title: t.it.title, body: t.text,
  }));
  return `あなたは社会福祉法人の助成金担当者です。次の助成の募集ページ本文から、応募の条件が書かれている一節をそのまま抜き出してください。

axis は次の9値のみ:
- 「所在地」= 応募できる団体の**所在地**の制限（都道府県・地区など）
- 「事業の実施地」= 助成対象となる事業を**行う場所**の制限（⚠️団体の所在地とは別の軸。混同しない）
- 「設立・活動年数」= 設立からの年数・活動実績年数の条件
- 「受給歴」= 過去にこの助成（同じ出し手の助成）を受けた団体への制限
- 「併願・重複」= 他の助成・補助金との重複や併願についての定め
- 「補助率・自己負担」= 補助率や自己負担についての定め（例: 総事業費の4分の3以内）
- 「主体の付帯条件」= 応募主体に付く手続き上の条件（推薦が必要・施設や機関を通じて応募・電子申請を使えること等）
- 「提出書類」= 応募時に必要な書類の定め
- 「その他の対象限定」= 上記以外で対象を限定している条件（対象となる施設・活動の種別等）

規則:
- quote は**本文からの逐語引用**。一字も変えない・要約しない・複数箇所をつなぎ合わせない。150字以内で切り出す
- 本文に書かれている条件だけを拾う。**推測で作らない**。該当の記載が無い軸は出さない
- 同じ軸に複数の条件があれば別々の要素にしてよい（1件あたり最大10要素）
- 締切・金額・助成の趣旨説明は条件ではないので拾わない

入力（${batch.length}件）:
${JSON.stringify(list, null, 1)}

出力の規則:
- JSONの配列のみを出力する。前置き・後書き・コードフェンスは一切禁止
- 必ず入力と同じ${batch.length}件を、index を含めて返す。条件が無ければ conditions は空配列
- 形式: [{"index":0,"conditions":[{"axis":"所在地","quote":"…"}]}, …]`;
}

function parseCondResponse(text, expected) {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const arr = JSON.parse(stripped);
  if (!Array.isArray(arr)) throw new Error("応答が配列ではありません");
  if (arr.length !== expected) {
    throw new Error(`入力${expected}件に対し応答が${arr.length}件です（件数不一致）`);
  }
  for (const it of arr) {
    if (!Array.isArray(it.conditions)) throw new Error(`conditions が配列ではありません (index=${it.index})`);
  }
  return arr;
}

/** 1束をAIにかけ、逐語引用を機械照合して {axis, quote} の配列を割り当てる */
async function judgeCondBatch(batch, apiKey, models, used) {
  let judged = null;
  for (const model of (used ? preferModel(models, used) : models)) {
    try {
      console.log(`条件抽出: ${model}（${batch.length}件）`);
      judged = parseCondResponse(await generate(apiKey, model, buildCondPrompt(batch)), batch.length);
      used = model;
      break;
    } catch (e) {
      console.log(`  失敗（次の候補へ）: ${e.message.slice(0, 110)}`);
    }
  }
  if (!judged) return { ok: false, used };
  const byIndex = new Map(judged.map((j) => [j.index, j]));
  batch.forEach((t, n) => {
    const verified = [];
    for (const c of (byIndex.get(n)?.conditions ?? []).slice(0, 10)) {
      if (!COND_AXES.includes(c?.axis)) continue;
      const quote = String(c.quote ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
      if (!quote || quote.length > 200) continue;
      // ★引用が本文に実在しないものは捨てる（言い換え・幻覚をここで落とす）
      if (!condFlat(t.text).includes(condFlat(quote))) continue;
      verified.push({ axis: c.axis, quote });
    }
    verified.sort((a, b) => COND_AXES.indexOf(a.axis) - COND_AXES.indexOf(b.axis));
    t.claimed = (byIndex.get(n)?.conditions ?? []).length;
    t.verified = verified;
  });
  return { ok: true, used };
}

async function extractConditions(store) {
  const pending = store.items.filter((it) => it.conditions === undefined).slice(0, COND_PER_RUN);
  if (pending.length === 0) return;
  console.log(`条件抽出の対象: ${pending.length}件`);
  const srcByName = new Map(readSources().map((s) => [s.name, s]));

  const targets = [];
  for (const it of pending) {
    try {
      const url = it.conditionsUrl ?? (await resolveConditionsUrl(it, srcByName));
      const text = await fetchBodyText(url, COND_TEXT_MAX);
      if (text.length < 100) throw new Error("本文がほぼ空です");
      targets.push({ it, url, text });
    } catch (e) {
      // 取得できなかった項目は conditions を付けずに残す＝翌朝やり直す（保留側に倒す）
      console.log(`  条件: 取得できず（翌朝やり直す）: ${it.title.slice(0, 30)}: ${e.message}`);
    }
    await sleep(FETCH_INTERVAL_MS);
  }
  if (targets.length === 0) return;

  const apiKey = loadEnv();
  const models = await listCandidateModels(apiKey);
  let used = null;
  for (let i = 0; i < targets.length; i += COND_BATCH) {
    const batch = targets.slice(i, i + COND_BATCH);
    const res = await judgeCondBatch(batch, apiKey, models, used);
    if (!res.ok) {
      // 全モデルで失敗: この回は未抽出のまま残す（翌朝やり直す）。実行全体は落とさない
      console.log("  条件抽出: 全モデルで失敗（この回は見送り）");
      return;
    }
    used = res.used;
  }

  // ★AIが条件を挙げたのに1つも照合を通らなかった項目だけ、1回やり直す（言い訳引用の救済）
  const retry = targets.filter((t) => t.claimed > 0 && t.verified.length === 0);
  if (retry.length) {
    console.log(`  引用の照合を通らなかった${retry.length}件を1回だけやり直す`);
    await judgeCondBatch(retry, apiKey, models, used);
  }

  let found = 0, empty = 0;
  for (const t of targets) {
    t.it.conditions = t.verified ?? [];      // 空配列＝「記載を確認できませんでした」の正直表示
    t.it.conditionsUrl = t.url;
    t.it.conditions.length ? found++ : empty++;
  }
  console.log(`条件抽出: ${found}件で条件を取得・${empty}件は確認できず`);
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

/** 見出し・出し手を比較用に均す（記号と空白を落とす） */
const flatten = (s) =>
  String(s ?? "").normalize("NFKC").replace(/[\s【】\[\]（）()「」『』・、。,.／/―ー\-~〜]/g, "");

/** 同一の助成を1件に畳む。情報の多い方（応募主体・金額が埋まっている方）を残す */
export function dedupeGrants(items) {
  const out = [];
  const score = (it) =>
    (it.applicants?.length ? 2 : 0) + (it.amount ? 1 : 0) + (it.funder ? 1 : 0);
  for (const it of items) {
    const a = flatten(it.title);
    const af = flatten(it.funder);
    const hit = out.find((o) => {
      if (o.deadline !== it.deadline || o.deadlineType !== it.deadlineType) return false;
      const b = flatten(o.title);
      const bf = flatten(o.funder);
      // (1) 助成名が包含関係にある
      if (a && b && (a.includes(b) || b.includes(a))) return true;
      // (2) 一方に出し手の欄が無く、その見出しの中に他方の出し手名が入っている
      //     （JFCは見出しに財団名を含み、出し手の欄を持たないため）
      //     ⚠️**片方が空のときだけ**にする。両方に出し手があるときに名前で照合すると、
      //       同じ財団の別の助成（締切が同じことがある）まで畳んでしまう
      if (!af && bf && a.includes(bf)) return true;
      if (!bf && af && b.includes(af)) return true;
      return false;
    });
    if (!hit) { out.push(it); continue; }
    if (score(it) > score(hit)) out[out.indexOf(hit)] = it;
  }
  if (out.length !== items.length) {
    console.log(`  同一の助成を統合: ${items.length}件 → ${out.length}件`);
  }
  return out;
}

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
      const { items: parsed, raw } = await collect(src, today);
      // ★読み取り0件は構造変化の疑いとして失敗扱い（サイレント0件の禁止）。
      //   絞り込み後の0件は正常（募集中が無い時期がある源のため）
      if (raw === 0) {
        throw new Error("1件も読み取れませんでした（ページ構造の変化の疑い）");
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
        // 印章の種別。⚠️WAMは独立行政法人なので「団」ではなく「独」。
        //   sourceKind を空にすると index.html の sealHtml が源の名前から判定する
        //   （"WAM" を含む → 独）。他の助成の源はいずれも全国団体なので "org"（団）
        const sourceKind = src.method === "wam-josei-rss" ? "" : "org";
        fresh.push({ hash, source: src.name, sourceKind, _method: src.method, ...it });
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

    // (b) RSSの源: 本文(content:encoded)を既に持っているので追加の取得をしない
    for (const it of fresh.filter((x) => RSS_METHODS.has(x._method))) targets.push(it);

    // (c) HTMLの源(全社協): 個別ページの本文を読む。
    //     ⚠️届出で約束した禁止文言の確認を同じ関門として必ず通す
    for (const it of fresh.filter(
      (x) => x._method !== "jyosei-navi-api" && !RSS_METHODS.has(x._method)
    )) {
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

    const dropped = [];
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
          const fields = normalizeFields(j.fields);
          // ★分野タグが空＝福祉と無関係（P6の規則）。助成面に出さない。
          //   JFCは全分野を扱うため、ここで福祉外（研究・学術・奨学など）が落ちる
          if (fields.length === 0) { dropped.push(it.title); return; }
          // ★本文・作業用の値は保存しない
          const clean = Object.fromEntries(
            Object.entries(it).filter(([k]) => !k.startsWith("_"))
          );
          store.items.push({
            ...clean,
            // 条件ページのURL（P28）。コレクタが解決済みなら持ち越す（無ければ抽出時に解決）
            ...(it._condUrl ? { conditionsUrl: it._condUrl } : {}),
            summary: j.summary.trim(),
            fields,
            uses,
            applicants,
            amount,
          });
        });
      }
      if (dropped.length) {
        console.log(`  福祉と無関係のため除外: ${dropped.length}件（分野タグが空）`);
      }
    }
  }

  // ★同じ助成が複数の源から入ることがある（JFCと全社協など）。
  //   締切が一致し、かつ 助成名が包含関係にある／一方の出し手名が他方の見出しに出てくる
  //   ものを同一とみなし、**情報の多い方**を残す。
  //   ⚠️締切一致を必ず条件にする（名前の一致だけで畳むと別年度の同名助成が消える）
  store.items = dedupeGrants(store.items);

  // ★応募条件の抽出（P28）。conditions を持たない項目だけ＝日常は新規のみ・導入時に1回だけ遡及。
  //   統合で消える項目に抽出しないよう、重複統合の後に置く
  if (!dryRun) {
    try {
      await extractConditions(store);
    } catch (e) {
      // 条件抽出の失敗で実行全体を落とさない（項目は未抽出のまま残り、翌朝やり直される）
      console.error(`  条件抽出でエラー（続行）: ${e.message}`);
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
