#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 巡回＋差分検知（P1）
 *
 * docs/sources.md（監視対象台帳）を読み、状態が「巡回中」の源だけを巡回する。
 * 監視源の増設は台帳に1行追加するだけ（このファイルに源を書き込まない）。
 *
 * 保存するのはハッシュ＋見出し等の最小限のみ。ページ全文は保存しない（台帳★方針）。
 * 差分は項目単位で検知する。ページ全体のハッシュにはしない
 * （無関係な変動で毎回差分になるため）。
 *
 * 使い方: node scripts/crawl.js
 * 出力:   data/state.json      … 前回巡回時の項目リスト（源ごと）
 *         data/diff-latest.json … 今回検出した新規項目（P2の入力になる）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_MD = join(ROOT, "docs", "sources.md");
const STATE_PATH = join(ROOT, "data", "state.json");
const DIFF_PATH = join(ROOT, "data", "diff-latest.json");

const USER_AGENT =
  "fukushi-watch/0.1 (+https://github.com/kanda-houtokukai/fukushi-watch)";

// 1源あたり state に保持する項目数の上限（一覧の先頭ページは10件＝約10日分。
// ページから消えた項目を約1か月分覚えておき、再掲載を新規と誤認しないための余裕）
const MAX_ITEMS_PER_SOURCE = 300;

// ---------------------------------------------------------------------------
// 監視対象台帳（docs/sources.md）の読み込み
// ---------------------------------------------------------------------------

/** sources.md の表から { name, kind, url, method, status } の配列を返す */
export function readSources() {
  const md = readFileSync(SOURCES_MD, "utf8");
  const rows = [];
  for (const line of md.split("\n")) {
    // | # | 名前 | 区分 | URL | 巡回方法 | 状態 | の行だけを拾う
    const cells = line.split("|").map((c) => c.trim());
    // 先頭セルが数字の行がデータ行（見出し・罫線は除外）
    if (cells.length >= 7 && /^\d+$/.test(cells[1])) {
      // 区分: 報道=press（別配列・要約なし）／団体=org（行政と同じ扱い。印章だけ分ける・P21）
      //       助成=grant（**別系統**。crawl.js は巡回せず scripts/grants.js が扱う・P24）
      const kubun = cells[3].replace(/\*/g, "");
      rows.push({
        name: cells[2],
        kind:
          kubun === "報道" ? "press"
          : kubun === "団体" ? "org"
          : kubun === "助成" ? "grant"
          : "gov",
        url: cells[4],
        method: cells[5],
        status: cells[6],
      });
    }
  }
  if (rows.length === 0) {
    throw new Error(`監視対象台帳から行を読み取れません: ${SOURCES_MD}`);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 取得（控えめなリトライ付き）
// ---------------------------------------------------------------------------

export async function fetchHtml(url) {
  const RETRIES = 2; // 控えめに: 計2回まで
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastError = e;
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 5000)); // 5秒待って1回だけ再試行
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// 抽出（巡回方法ごとのパーサ。P4で源が増えたらここに追加する）
// ---------------------------------------------------------------------------

/**
 * cfa-cards: こども家庭庁 /news の一覧構造
 *   <section class="card"> → a[href]・.card__category・.card__title span・time[datetime]
 * 依存ゼロ方針のため正規表現で抽出する。構造が変わって0件になったら
 * エラー終了する（サイレント0件にしない）ので、壊れたことには必ず気づける。
 */
export function parseCfaCards(html, baseUrl) {
  const items = [];
  const cardRe = /<section class="card">([\s\S]*?)<\/section>/g;
  for (const [, card] of html.matchAll(cardRe)) {
    const href = card.match(/href="([^"]+)"/)?.[1];
    const title = card
      .match(/card__title">\s*<span>([\s\S]*?)<\/span>/)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const category = card
      .match(/card__category">\s*([\s\S]*?)\s*<\/span>/)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    const date = card.match(/datetime="([^"]+)"/)?.[1]; // 文字列のまま保持（解釈はP2）
    if (!href || !title) continue; // 断片は捨てる（件数0なら呼び出し側で検知）
    items.push({
      title,
      url: new URL(href, baseUrl).href, // 相対URLを絶対URLへ（原本URL必須＝鉄則5）
      date: date ?? "",
      category: category ?? "",
    });
  }
  return items;
}

/**
 * mhlw-news: 厚生労働省 /stf/new-info/ の新着一覧
 * ページ内のHTMLコメント <!--YYYYMMDDHHMM [カテゴリ] 絶対URL タイトル--> が
 * 一覧の機械可読な複製になっており、これを一次情報として抽出する。
 * コメントが将来消えても、0件ガードで構造変化として必ず検知される。
 */
function parseMhlwNews(html) {
  const items = [];
  const re = /<!--(\d{12}) \[([^\]]*)\] (https?:\/\/\S+) (.*?)-->/g;
  for (const [, stamp, category, url, rawTitle] of html.matchAll(re)) {
    const title = rawTitle.replace(/\s+/g, " ").trim();
    if (!title) continue;
    items.push({
      title,
      url,
      date: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`,
      category,
    });
  }
  return items;
}

/** RSS/HTML内の文字参照を実体に戻す（&amp; 等。リンクのクエリ結合に必須） */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * wam-rss: WAM NET 行政資料の新着RSS（UTF-8）
 * 厚労省・こども家庭庁の福祉関連通知/事務連絡の集約。RSSは機械取得が前提の口。
 * カテゴリはフィードに無いため「行政資料」で固定する。
 */
function parseWamRss(xml) {
  const items = [];
  for (const [, body] of xml.matchAll(/<item[ >]([\s\S]*?)<\/item>/g)) {
    const title = body.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const link = body.match(/<link>([\s\S]*?)<\/link>/)?.[1];
    const date = body.match(/<(?:dc:date|pubDate)>([\s\S]*?)<\//)?.[1];
    if (!title || !link) continue;
    items.push({
      title: decodeEntities(title.replace(/\s+/g, " ").trim()),
      url: decodeEntities(link.trim()),
      date: (date ?? "").trim().slice(0, 10), // 例 2026-08-14（元はISO文字列）
      category: "行政資料",
    });
  }
  return items;
}

/**
 * fukuoka-life: 福岡県の分野別更新一覧（/life/3/27/ 障がい福祉・/life/3/39/ 子ども・青少年）
 * <span class="article_date">…</span><span class="article_title"><a href>…</a></span> の並び。
 * カテゴリ表記は無いため空文字で通す（設計どおり）。日付は「2026年8月4日更新」の文字列のまま。
 */
function parseFukuokaLife(html, baseUrl) {
  const items = [];
  const re =
    /<span class="article_date">([^<]*)<\/span><span class="article_title"><a href="([^"]+)">([^<]*)<\/a>/g;
  for (const [, date, href, rawTitle] of html.matchAll(re)) {
    const title = decodeEntities(rawTitle.replace(/\s+/g, " ").trim());
    if (!title || !href) continue;
    items.push({
      title,
      url: new URL(decodeEntities(href), baseUrl).href, // 相対URL(/contents/…)を絶対化
      date: date.trim(),
      category: "",
    });
  }
  return items;
}

/**
 * press-rss: 報道各社のRSS（WordPress標準のRSS2.0を想定・P9）
 * ⚠️ 保存するのは 見出し・リンク・日付・カテゴリ のみ。
 *    RSSに説明文・本文が含まれていても**読み捨てて保存しない**（著作権への配慮・確定方針）。
 */
function parsePressRss(xml) {
  const cdata = (s) => {
    if (!s) return "";
    const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    return (m ? m[1] : s).trim();
  };
  const items = [];
  for (const [, body] of xml.matchAll(/<item[ >]([\s\S]*?)<\/item>/g)) {
    let title = cdata(body.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const link = cdata(body.match(/<link>([\s\S]*?)<\/link>/)?.[1]);
    const pub = cdata(body.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]);
    const category = cdata(body.match(/<category>([\s\S]*?)<\/category>/)?.[1]);
    if (!title || !link) continue;
    title = decodeEntities(title.replace(/\s+/g, " "))
      .replace(/\s*[-｜|]\s*福祉新聞(Web)?\s*$/i, ""); // 媒体名サフィックスは除去
    // RFC822日付 → JSTの YYYY-MM-DD 文字列
    let date = "";
    const t = Date.parse(pub);
    if (!Number.isNaN(t)) {
      date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(t));
    }
    items.push({ title, url: decodeEntities(link), date, category });
  }
  return items;
}

/**
 * zenshakyo-news: 全国社会福祉協議会 新着情報一覧（/news/index.html・P21）
 *   <li><span class="date">2026年8月17日</span><span class="news_cat_04">助成</span>
 *       <span><a href="…">タイトル</a></span></li>
 * 日付・カテゴリ・タイトル・リンクがそのまま取れる。カテゴリ（案内/告知/助成）は
 * こども家庭庁と同じく機械で絞らず保存し、判定に渡す。
 * 見出しナビ等の <li> は日付・リンクを持たないため自然に落ちる。
 *
 * ⚠️ 届出（2026-08-21）で約束した運用のため、次の2つを対象から除く:
 *   - shakyo.or.jp 以外のドメインへのリンク（他団体の情報であり、出典「全国社会福祉協議会」
 *     と原本の発行主体が食い違う）
 *   - PDFへの直リンク（HTMLでないため無断転載の記載を機械確認できない＝安全側に倒す）
 *   残った項目は main 側で原本の禁止文言を確認してから差分に載せる。
 */
export function parseZenshakyoNews(html, baseUrl) {
  const items = [];
  for (const [, li] of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const date = li.match(/<span class="date">\s*([^<]*?)\s*<\/span>/)?.[1];
    const category = li.match(/<span class="news_cat_\d+">\s*([^<]*?)\s*<\/span>/)?.[1];
    const a = li.match(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!date || !a) continue;
    // アイコンの読み上げ用スパン（「ファイルダウンロード 新規ウインドウで開きます。」）を落とす
    const title = decodeEntities(
      a[2]
        .replace(/<span class="guidance">[\s\S]*?<\/span>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!title) continue;
    const url = new URL(decodeEntities(a[1]), baseUrl).href;
    if (new URL(url).hostname !== "www.shakyo.or.jp") continue; // 他団体の原本は載せない
    if (/\.pdf(\?|#|$)/i.test(url)) continue; // HTMLでないものは禁止文言を確認できない
    const ymd = date.normalize("NFKC").match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
    items.push({
      title,
      url,
      date: ymd
        ? `${ymd[1]}-${String(ymd[2]).padStart(2, "0")}-${String(ymd[3]).padStart(2, "0")}`
        : date.trim(),
      category: category ?? "",
    });
  }
  return items;
}

/**
 * 原本に「無断転載を禁ずる旨の記載」があるかを確認する（P21）。
 * 全社協の利用規約は、その記載がある情報の引用・転載・複製を認めていない。
 * 届出でこの除外を約束しているため、団体源の新規項目は差分に載せる前に必ず通す。
 *
 * 返り値: "ok"=記載なし / "blocked"=記載あり（恒久的に除外）/ "unknown"=確認できず（保留）
 * ⚠️ 取得に失敗したときに "blocked" を返してはいけない。state に載って二度と再評価されず、
 *    一時的な通信障害で項目が永久に消えるため。"unknown" は state にも載せず翌朝やり直す。
 */
const NO_REPRINT_RE =
  /無断(?:転載|複製|使用|転用)|転載[^。]{0,8}禁(?:止|じ)|複製[^。]{0,8}禁(?:止|じ)/;

export async function checkReprintNotice(url) {
  let html;
  try {
    html = await fetchHtml(url);
  } catch {
    return "unknown";
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .normalize("NFKC");
  return NO_REPRINT_RE.test(text) ? "blocked" : "ok";
}

const PARSERS = {
  "cfa-cards": parseCfaCards,
  "mhlw-news": parseMhlwNews,
  "wam-rss": parseWamRss,
  "fukuoka-life": parseFukuokaLife,
  "press-rss": parsePressRss,
  "zenshakyo-news": parseZenshakyoNews,
};

// ---------------------------------------------------------------------------
// 差分検知（項目単位のハッシュ）
// ---------------------------------------------------------------------------

/**
 * 項目ハッシュはタイトル＋日付＋URLで作る。
 * URLだけにしない: こども家庭庁は同一URLへ繰り返し掲載する項目がある
 * （例: 人事異動は毎回 /about/jinji）。URLだけだと2回目以降を検知できない。
 */
export function itemHash(item) {
  return createHash("sha256")
    .update(`${item.title}\n${item.date}\n${item.url}`)
    .digest("hex")
    .slice(0, 16);
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { sources: {} };
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main() {
  const sources = readSources();
  // ★助成(grant)は別系統。紙面のパイプラインでは巡回しない（scripts/grants.js の担当）
  const active = sources.filter((s) => s.status === "巡回中" && s.kind !== "grant");
  if (active.length === 0) {
    console.log("状態が「巡回中」の源がありません。docs/sources.md を確認してください。");
    return;
  }

  const state = loadState();
  const newItems = [];  // 行政（区分=gov）の新規項目
  const newPress = []; // 報道（区分=press）の新規項目。件数集計・グラフに含めない（P9）
  const crawlErrors = []; // 1源の失敗は記録して続行する（後述の全滅チェックで使う）

  for (const source of active) {
    try {
      const parse = PARSERS[source.method];
      if (!parse) {
        throw new Error(
          `巡回方法「${source.method}」に対応するパーサがありません`
        );
      }

      console.log(`巡回: ${source.name} (${source.url})`);
      const html = await fetchHtml(source.url);
      const items = parse(html, source.url).map((it) => ({
        hash: itemHash(it),
        ...it,
      }));

      // ★ 抽出0件は「成功・差分なし」ではなく構造変化の疑いとして失敗扱い
      if (items.length === 0) {
        throw new Error(
          `項目を1件も抽出できませんでした。` +
            `ページの構造が変わった疑いがあります（サイレント0件は許可しない）`
        );
      }

      // 本文の確認ができなかった項目（翌朝やり直すため state にも載せない・P21）
      const deferred = new Set();

      const prev = state.sources[source.name];
      if (!prev) {
        // 初回: 全項目をベースラインとして保存（差分は報告しない）
        console.log(`  初回巡回: ${items.length}件をベースラインとして保存`);
      } else {
        const known = new Set(prev.items.map((it) => it.hash));
        let fresh = items.filter((it) => !known.has(it.hash));
        console.log(`  取得${items.length}件 / 新規${fresh.length}件`);

        // ★ 団体源(P21): 原本に「無断転載を禁ずる旨の記載」がある項目を差分から除く。
        //   全社協への届出（2026-08-21）で約束した運用。除外した項目は state には残すので
        //   翌朝に再検知されない。確認できなかった項目だけは state にも載せず翌朝やり直す。
        if (source.kind === "org" && fresh.length > 0) {
          const kept = [];
          for (const it of fresh) {
            const verdict = await checkReprintNotice(it.url);
            if (verdict === "ok") kept.push(it);
            else if (verdict === "blocked") {
              console.log(`  除外（無断転載を禁ずる旨の記載あり）: ${it.title}`);
            } else {
              deferred.add(it.hash);
              console.log(`  保留（本文を確認できず・翌朝やり直す）: ${it.title}`);
            }
            await new Promise((r) => setTimeout(r, 1500)); // アクセス間隔（マナー）
          }
          fresh = kept;
        }

        const dest = source.kind === "press" ? newPress : newItems;
        dest.push(...fresh.map((it) => ({ source: source.name, kind: source.kind, ...it })));
      }

      // state更新: 今回の項目＋過去の項目（重複除去）を上限まで保持
      // ★ 失敗した源はこのブロックに到達しないため、既存の記録はそのまま残る
      const stored = items.filter((it) => !deferred.has(it.hash));
      const merged = [...stored];
      const seen = new Set(stored.map((it) => it.hash));
      for (const old of prev?.items ?? []) {
        if (!seen.has(old.hash) && merged.length < MAX_ITEMS_PER_SOURCE) {
          merged.push(old);
          seen.add(old.hash);
        }
      }
      state.sources[source.name] = {
        lastCrawled: new Date().toISOString(),
        items: merged,
      };
    } catch (e) {
      // ★ 1源の失敗で他の源まで止めない。記録して次の源へ
      console.error(`  失敗（続行）: ${source.name}: ${e.message}`);
      crawlErrors.push({ source: source.name, error: e.message });
    }
  }

  // ★ 全滅した場合だけはエラー終了する（部分的な失敗は diff に記録して正常終了）
  if (crawlErrors.length === active.length) {
    throw new Error(
      `全${active.length}源の巡回に失敗しました:\n` +
        crawlErrors.map((c) => `  ${c.source}: ${c.error}`).join("\n")
    );
  }

  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  writeFileSync(
    DIFF_PATH,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), newItems, newPress, crawlErrors },
      null,
      2
    ) + "\n"
  );

  console.log(
    `完了: 行政 新規${newItems.length}件・報道 新規${newPress.length}件（巡回失敗${crawlErrors.length}源） → ${DIFF_PATH.replace(ROOT + "/", "")}`
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
