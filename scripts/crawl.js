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

/** sources.md の表から { name, url, method, status } の配列を返す */
function readSources() {
  const md = readFileSync(SOURCES_MD, "utf8");
  const rows = [];
  for (const line of md.split("\n")) {
    // | # | 名前 | URL | 巡回方法 | 状態 | の行だけを拾う
    const cells = line.split("|").map((c) => c.trim());
    // 先頭セルが数字の行がデータ行（見出し・罫線は除外）
    if (cells.length >= 6 && /^\d+$/.test(cells[1])) {
      rows.push({
        name: cells[2],
        url: cells[3],
        method: cells[4],
        status: cells[5],
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

async function fetchHtml(url) {
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
function parseCfaCards(html, baseUrl) {
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

const PARSERS = {
  "cfa-cards": parseCfaCards,
  "mhlw-news": parseMhlwNews,
};

// ---------------------------------------------------------------------------
// 差分検知（項目単位のハッシュ）
// ---------------------------------------------------------------------------

/**
 * 項目ハッシュはタイトル＋日付＋URLで作る。
 * URLだけにしない: こども家庭庁は同一URLへ繰り返し掲載する項目がある
 * （例: 人事異動は毎回 /about/jinji）。URLだけだと2回目以降を検知できない。
 */
function itemHash(item) {
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
  const active = sources.filter((s) => s.status === "巡回中");
  if (active.length === 0) {
    console.log("状態が「巡回中」の源がありません。docs/sources.md を確認してください。");
    return;
  }

  const state = loadState();
  const newItems = [];
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

      const prev = state.sources[source.name];
      if (!prev) {
        // 初回: 全項目をベースラインとして保存（差分は報告しない）
        console.log(`  初回巡回: ${items.length}件をベースラインとして保存`);
      } else {
        const known = new Set(prev.items.map((it) => it.hash));
        const fresh = items.filter((it) => !known.has(it.hash));
        console.log(`  取得${items.length}件 / 新規${fresh.length}件`);
        newItems.push(...fresh.map((it) => ({ source: source.name, ...it })));
      }

      // state更新: 今回の項目＋過去の項目（重複除去）を上限まで保持
      // ★ 失敗した源はこのブロックに到達しないため、既存の記録はそのまま残る
      const merged = [...items];
      const seen = new Set(items.map((it) => it.hash));
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
      { generatedAt: new Date().toISOString(), newItems, crawlErrors },
      null,
      2
    ) + "\n"
  );

  console.log(
    `完了: 新規${newItems.length}件（巡回失敗${crawlErrors.length}源） → ${DIFF_PATH.replace(ROOT + "/", "")}`
  );
}

main().catch((e) => {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
});
