/**
 * pdftext.js — PDF併読の部品（P43 区切り①・汎用）
 *
 * 「締切が本文でなくリンク先PDFにしか無い」源（f-kaigo・facsw 型）のための共通部品。
 * 源ごとの事情はコードに埋め込まず docs/sources.md の3列（PDFリンクの目印・
 * ブロックの区切り語・締切の表記パターン）が持つ（P36の既定分野・P44の表示名と同じ作法）。
 * ⚠️この段階では kenshu.js に接続しない（接続は区切り②）。import の向きは
 *   kenshu.js → pdftext.js の一方向にする予定のため、このファイルは kenshu.js を
 *   import しない（iso/fiscalIso は同じ定義を複製してある）。
 *
 * 部品1: fetchPdfIfChanged — HEADで ETag / Last-Modified / Content-Length を照合し、
 *        前回と同一なら再取得もパースもしない（f-kaigo は26URLで実体12ファイル・実測）。
 *        ⚠️PDFの本文はファイルにもJSONにも保存しない。メモリ上で処理して破棄する。
 * 部品2: extractPdfText — ページごと・列ごとのテキスト。段組は台帳の列にせず、
 *        x座標の空白帯（どの行のテキストも横切らない縦の帯）で自動判定する。
 *        1段組なら帯が無く1列になるだけで壊れない。テキスト層が無ければ
 *        例外でなく { noTextLayer: true } を返す。
 * 部品3: splitBlocks / extractDeadline — 区切り語でブロックに切り（空欄＝PDF全体を
 *        1ブロック＝facsw の 1PDF=1研修型を吸収）、締切の目印に続く日付を和暦・西暦
 *        から西暦ISOへ変換して拾う。⚠️目印に《 》ごと指定することが誤検出0の要——
 *        本文に「定員になり次第締め切ります」「締切後も〜」の平文がある（実測）。
 * 部品4: norm / blockForTitle — **NFKC正規化＋空白除去を共通の前処理**に置く。
 *        これが無いとHTML半角「DX/ACP」とPDF全角「ＤＸ/ＡＣＰ」で9件中2件が外れる（実測）。
 *        HTML側の題名がブロック本文に含まれるかで引く（⚠️題名をPDFから切り出さない——
 *        行の重なりで文字が混線する事故が実測で出た）。複数候補は開催日で絞り、
 *        **1件に絞れなければ null**（誤った締切は無い締切より悪い・助成の幻覚ガードと同思想）。
 *
 * PDFの読み取りは pdfjs-dist（scripts/vendor/pdfjs/ に直置き・npm install 不要）。
 * 出所・更新手順は scripts/vendor/pdfjs/README.md。機械確認は scripts/pdftext-check.js。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PDF_STATE_PATH = join(ROOT, "data", "pdf-state.json");

// crawl.js と同じ名乗り（源には常に同じUAで挨拶する）
const USER_AGENT =
  "fukushi-watch/0.1 (+https://github.com/kanda-houtokukai/fukushi-watch)";

// kenshu.js と同じ定義の複製（循環importを避けるため。変えるときは両方を揃える）
const jstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
const iso = (y, m, d) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const validMd = (mm, dd) => mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
function fiscalIso(m, d, today) {
  const y = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
  return iso(m >= 4 ? y : y + 1, m, d);
}

/* ===========================================================================
 * pdfjs-dist の読み込み（直置き・遅延import）
 * ======================================================================== */

// 描画専用のブラウザAPI（DOMMatrix等）が import 時に要求されるが、テキスト抽出では
// 使われないため最小スタブで足りる（実測: f-kaigo 5ページ・9,565字を抽出できた）
globalThis.DOMMatrix ??= class DOMMatrix {
  constructor(init) {
    this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    if (Array.isArray(init) && init.length === 6)
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
  }
};
globalThis.Path2D ??= class Path2D {};
globalThis.ImageData ??= class ImageData {};

let pdfjsPromise = null;
function pdfjs() {
  pdfjsPromise ??= import("./vendor/pdfjs/pdf.min.mjs").then((m) => {
    // ⚠️未指定だと同梱していない pdf.worker.mjs（非min）を探して落ちる
    m.GlobalWorkerOptions.workerSrc = new URL(
      "./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
    return m;
  });
  return pdfjsPromise;
}

/* ===========================================================================
 * 部品1: 取得層（HEAD照合つき・本文は保存しない）
 * ======================================================================== */

/** data/pdf-state.json（URL → 前回の検証子）。無ければ空で始める */
export function loadPdfState() {
  if (!existsSync(PDF_STATE_PATH)) return {};
  return JSON.parse(readFileSync(PDF_STATE_PATH, "utf8"));
}

export function savePdfState(state) {
  mkdirSync(dirname(PDF_STATE_PATH), { recursive: true });
  writeFileSync(PDF_STATE_PATH, JSON.stringify(state, null, 1) + "\n");
}

const signatureOf = (headers) => ({
  etag: headers.get("etag") ?? null,
  lastModified: headers.get("last-modified") ?? null,
  contentLength: headers.get("content-length") ?? null,
});

/** 双方に存在する検証子だけを比べ、1つ以上一致し不一致が無いときだけ「同一」 */
function sameSignature(prev, cur) {
  let matched = 0;
  for (const k of ["etag", "lastModified", "contentLength"]) {
    if (prev?.[k] != null && cur[k] != null) {
      if (prev[k] !== cur[k]) return false;
      matched++;
    }
  }
  return matched > 0;
}

/**
 * URLのPDFを「変わっていたときだけ」取得する。
 * 返り値: { changed:false }（前回と同一・再取得もパースも不要）
 *       ／ { changed:true, data:Uint8Array }（新規または更新。dataは呼び出し側で使い捨てる）
 *       ／ { error:string }（取得失敗。stateは書き換えない＝翌朝やり直す）
 * ⚠️state[url] には検証子とサイズだけを記録する。本文を入れてはならない。
 */
export async function fetchPdfIfChanged(url, state) {
  const prev = state[url];
  if (prev) {
    try {
      const head = await fetch(url, {
        method: "HEAD", headers: { "User-Agent": USER_AGENT }, redirect: "follow",
      });
      if (head.ok && sameSignature(prev, signatureOf(head.headers))) {
        return { changed: false };
      }
    } catch {
      // HEADを拒否・失敗するサーバはGETで取り直す（照合はGETのヘッダで更新される）
    }
  }
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
  if (!res.ok) return { error: `HTTP ${res.status} for ${url}` };
  const data = new Uint8Array(await res.arrayBuffer());
  state[url] = { ...signatureOf(res.headers), size: data.length, seenAt: jstToday() };
  return { changed: true, data };
}

/* ===========================================================================
 * 部品2: テキスト抽出（ページごと・列ごと。段組はx座標の空白帯で自動判定）
 * ======================================================================== */

/**
 * PDFのバイト列から { pages: [{ columns: [string,…] }], chars, noTextLayer } を返す。
 * 列の中は行（y降順→x昇順）を改行でつないだテキスト。
 * ⚠️テキスト層が無い（画像PDF）・壊れたPDFでも例外を投げず noTextLayer:true で返す。
 */
export async function extractPdfText(data) {
  let task;
  let doc;
  try {
    const lib = await pdfjs();
    task = lib.getDocument({ data, isEvalSupported: false, disableFontFace: true });
    doc = await task.promise;
  } catch (e) {
    return { pages: [], chars: 0, noTextLayer: true, error: String(e?.message ?? e) };
  }
  const pages = [];
  let chars = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const width = page.getViewport({ scale: 1 }).width;
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0 }));
      const columns = columnsOf(items, width);
      pages.push({ columns });
      chars += columns.join("").replace(/\s+/g, "").length;
    }
  } catch (e) {
    return { pages: [], chars: 0, noTextLayer: true, error: String(e?.message ?? e) };
  } finally {
    await task.destroy().catch(() => {}); // v6: 破棄は loadingTask 側（doc.destroy は無い）
  }
  return { pages, chars, noTextLayer: chars === 0 };
}

/** ページ→列の順で全文を1本にする（ブロック分割・突合への入力） */
export const fullTextOf = (extracted) =>
  extracted.pages.map((pg) => pg.columns.join("\n")).join("\n");

/**
 * 列の自動判定（再帰XYカット）。ほぼどのテキストも横切らない縦の空白帯
 * （ページ幅1.5%以上）で左右に割り、割れなくなるまで繰り返す。
 * ⚠️「被覆ゼロ」を条件にしない——f-kaigo の実PDFでは、中央寄せのページ見出しと
 *   ノンブル（ページ番号）が列間の帯を数件だけ横切っており、ゼロ条件だと
 *   2段組を1列と誤判定する（実測）。少数（範囲内の3%まで）の横断は許容する。
 * 誤割りの保険として、帯の両側それぞれに項目の2割以上が残る割りだけを採用する
 * （1段組のページは、この条件を満たす帯が無く1列のまま＝壊れない）。
 */
function columnsOf(items, pageWidth) {
  if (!items.length) return [];
  const ranges = [];
  cutRange(items, 0, pageWidth, pageWidth, ranges);
  return ranges.map(({ members }) => linesOf(members)).filter(Boolean);
}

function cutRange(items, x0, x1, pageWidth, out) {
  const BUCKETS = 200;
  const span = x1 - x0;
  const cover = new Array(BUCKETS).fill(0);
  for (const it of items) {
    const b0 = Math.max(0, Math.floor(((it.x - x0) / span) * BUCKETS));
    const b1 = Math.min(BUCKETS - 1, Math.ceil(((it.x + it.w - x0) / span) * BUCKETS));
    for (let b = b0; b <= b1; b++) cover[b]++;
  }
  // 本文の左右端の外（余白）は帯に数えない
  let lo = 0;
  while (lo < BUCKETS && cover[lo] === 0) lo++;
  let hi = BUCKETS - 1;
  while (hi >= 0 && cover[hi] === 0) hi--;
  const tol = Math.max(1, Math.floor(items.length * 0.03)); // 見出し・ノンブルの横断を許容
  // 帯の最小幅は**ページ幅**の1.5%を絶対基準にする（範囲の幅にすると、再帰で範囲が
  // 狭まったとき語間の隙間まで帯とみなして列を割りすぎる）
  const minRun = Math.max(2, Math.round(BUCKETS * ((pageWidth * 0.015) / span)));
  let best = null; // いちばん広い帯を採用
  for (let b = lo; b <= hi; ) {
    if (cover[b] <= tol) {
      let e = b;
      while (e <= hi && cover[e] <= tol) e++;
      if (e - b >= minRun && (!best || e - b > best.run)) best = { at: (b + e) / 2, run: e - b };
      b = e;
    } else {
      b++;
    }
  }
  if (best) {
    const splitX = x0 + (best.at / BUCKETS) * span;
    const left = items.filter((it) => it.x + it.w / 2 < splitX);
    const right = items.filter((it) => it.x + it.w / 2 >= splitX);
    const minSide = Math.max(3, Math.floor(items.length * 0.2));
    if (left.length >= minSide && right.length >= minSide) {
      cutRange(left, x0, splitX, pageWidth, out);
      cutRange(right, splitX, x1, pageWidth, out);
      return;
    }
  }
  out.push({ members: items });
}

/** 列内の項目を行にまとめる（y降順→x昇順。yの揺れは4単位まで同じ行とみなす） */
function linesOf(colItems) {
  const sorted = colItems.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null;
  let curY = null;
  for (const it of sorted) {
    if (curY === null || Math.abs(it.y - curY) > 4) {
      cur = [];
      lines.push(cur);
      curY = it.y;
    }
    cur.push(it);
  }
  return lines
    .map((l) => l.sort((a, b) => a.x - b.x).map((i) => i.str).join(""))
    .join("\n");
}

/* ===========================================================================
 * 共通の前処理（部品4の核。突合・分割・締切抽出はすべてこの正規化空間で行う）
 * ======================================================================== */

export const nfkc = (s) => String(s ?? "").normalize("NFKC");

/** NFKC正規化＋空白除去。HTML半角「DX」とPDF全角「ＤＸ」・「《 締 切 》」の空白を吸収する */
export const norm = (s) => nfkc(s).replace(/\s+/g, "");

const escRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 台帳の目印文字列（区切り語・締切パターン）を正規化空間の正規表現にする */
export const markerRegex = (marker, flags = "g") =>
  new RegExp(norm(marker).split("").map(escRe).join(""), flags);

/* ===========================================================================
 * 部品1の入口: 個別ページから「読むべきPDF」を1本選ぶ
 * ======================================================================== */

/**
 * HTMLから、アンカー文字列が目印を含むPDFリンクを探して絶対URLで返す。
 * ⚠️1ページに複数のPDFが並ぶ（f-kaigoは全ページ共通のバナー3本・facswは様式類10本）ため
 *   目印での選別が要る。**1本に絞れなければ null**（取り違えるより取らない）。
 */
export function pickPdfLink(html, anchorMarker, baseUrl) {
  const marker = norm(anchorMarker ?? "");
  if (!marker) return null;
  const hits = new Set();
  for (const m of String(html ?? "").matchAll(
    /<a\s[^>]*href="([^"]+\.pdf[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const anchor = norm(m[2].replace(/<[^>]+>/g, " "));
    if (!anchor.includes(marker)) continue;
    try {
      hits.add(new URL(m[1], baseUrl).href);
    } catch {
      /* 壊れたhrefは無視する */
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/* ===========================================================================
 * 部品3: ブロック分割と締切抽出
 * ======================================================================== */

/**
 * 区切り語でブロックに切る（正規化空間の文字列の配列を返す）。
 * 空欄＝PDF全体を1ブロック（facsw の 1PDF=1研修型）。区切り語が見つからない場合も
 * 全体を1ブロックとして返す（0件にはしない——締切の抽出は目印側が守る）。
 */
export function splitBlocks(text, delimiter) {
  const t = norm(text);
  if (!norm(delimiter ?? "")) return [t];
  const starts = [...t.matchAll(markerRegex(delimiter))].map((m) => m.index);
  if (!starts.length) return [t];
  return starts.map((s, i) => t.slice(s, starts[i + 1] ?? t.length));
}

/**
 * ブロックから締切を1つ拾ってISOで返す。無ければ null。
 * 目印（例:「《 締 切 》」）に続く30字から、令和N年M月D日 → 西暦YYYY年M月D日 →
 * 年なしM月D日（年度で補完・kenshu.js と同じ規則）の順で読む。
 * ⚠️目印に《 》ごと指定すれば「定員になり次第締め切ります」等の平文は拾わない。
 */
export function extractDeadline(blockText, marker, today = jstToday()) {
  return extractDeadlineDetail(blockText, marker, today)?.iso ?? null;
}

/**
 * 締切を { iso, raw } で返す（無ければ null）。`raw` はPDF側の日付の表記そのもの
 * （例「令和8年9月3日」・全半角はNFKCで均した後の姿）。deadlineRaw に載せて
 * **原文との突合の拠り所**にするために返す（P43の要件4）。
 */
export function extractDeadlineDetail(blockText, marker, today = jstToday()) {
  if (!norm(marker ?? "")) return null;
  const t = norm(blockText);
  const m = markerRegex(marker, "").exec(t);
  if (!m) return null;
  const seg = t.slice(m.index + m[0].length, m.index + m[0].length + 30);
  let d = seg.match(/令和(\d{1,2})年(\d{1,2})月(\d{1,2})日/);
  if (d && validMd(+d[2], +d[3])) return { iso: iso(+d[1] + 2018, +d[2], +d[3]), raw: d[0] };
  d = seg.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (d && validMd(+d[2], +d[3])) return { iso: iso(+d[1], +d[2], +d[3]), raw: d[0] };
  d = seg.match(/(?<![\d年])(\d{1,2})月(\d{1,2})日/);
  if (d && validMd(+d[1], +d[2])) return { iso: fiscalIso(+d[1], +d[2], today), raw: d[0] };
  return null;
}

/* ===========================================================================
 * 部品4: 突合（HTML題名 → ブロック）
 * ======================================================================== */

/** ブロック（正規化空間）にISO日付の月日が現れるか（複数候補を開催日で絞るのに使う） */
function blockHasDate(block, isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new RegExp(`(?:令和${y - 2018}年|${y}年)?(?<!\\d)${m}月${d}日`).test(norm(block));
}

/**
 * 突合に使う題名（正規化＋HTML側だけの装飾を除去）。
 * ⚠️HTMLの題名には「【2日間研修】」「【申込期間延長!】」のようなPDF本文に無い
 *   【 】の装飾が付くことがあり、そのままでは含有judgeが外れる（実測: 排泄ケア）。
 *   除去して短くなりすぎたら（4字未満）誤ヒットのほうが怖いので除去しない側に倒す。
 */
export function titleNeedle(title) {
  const stripped = norm(title).replace(/【[^】]*】/g, "");
  return stripped.length >= 4 ? stripped : norm(title);
}

// 題名は自分の区切り語の近傍（直前の見出し行か直後の本文頭）にある。この距離（正規化
// 空間の字数）を超える出現は「末尾の研修一覧・目次など」とみなして候補にしない——
// f-kaigo の実PDFは5ページ目に全研修の一覧表があり、そこでの出現を拾うと候補が
// 2件になり、一覧は全研修の開催日も含むため開催日でも絞れなくなる（実測）。
const TITLE_NEAR = 300;

/**
 * HTML側の題名からブロックを引く。見つからない・1件に絞れないときは null。
 * ⚠️題名は自分の区切り語の**直前**にも**直後**にもありうる（f-kaigo は
 *   題名→数行→「開催要綱」→本文→《締切》の並び＝直前型・実測）。そこで
 *   題名の出現位置に**最も近い**区切り語のブロックを候補にする——自分の区切り語は
 *   数十字先、隣の区切り語は本文1件ぶん（数百字）先なので取り違えない。
 * 複数候補（目次での重複・同名研修）は開催日で絞り、それでも1件に絞れなければ null。
 */
export function blockForTitle(text, delimiter, title, heldDates = []) {
  const t = norm(text);
  const needle = titleNeedle(title);
  if (!needle) return null;
  const starts = norm(delimiter ?? "")
    ? [...t.matchAll(markerRegex(delimiter))].map((m) => m.index)
    : [];
  if (!starts.length) return t; // 区切りなし＝全体1ブロック（題名は含まれている）
  const blockOf = (k) => t.slice(starts[k], starts[k + 1] ?? t.length);

  let candidates = [...blocksNear(t, starts, needle)];
  // 題名の表記ゆれへの後退路。⚠️開催日の一致を**必須**にする（題名だけでは当てない）。
  // 実測: HTML「介助をおこなおう!」／PDF「介助を行おう!」、HTML「とり方~」／
  // PDF「とり方を学びましょう」——同じ研修なのに末尾も送り仮名も違う。前方一致だけで
  // 決めると別の研修に当たりうるので、**題名の前方一致＋開催日**の2条件で引く（P43の[DECISION]）。
  let dateRequired = false;
  if (!candidates.length) {
    const prefix = needle.slice(0, 10);
    if (prefix.length < 8 || !heldDates.length) return null;
    candidates = [...blocksNear(t, starts, prefix)];
    dateRequired = true;
  }
  if (dateRequired || candidates.length > 1) {
    const narrowed = candidates.filter((k) => heldDates.some((d) => blockHasDate(blockOf(k), d)));
    if (dateRequired || narrowed.length) candidates = narrowed;
  }
  if (candidates.length !== 1) return null; // 誤った締切は無い締切より悪い
  return blockOf(candidates[0]);
}

/** 針が現れる位置ごとに、最も近い区切り語のブロック番号を集める（遠い出現は捨てる） */
function blocksNear(t, starts, needle) {
  const hits = new Set();
  for (let p = t.indexOf(needle); p !== -1; p = t.indexOf(needle, p + 1)) {
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < starts.length; k++) {
      const dist = Math.abs(p - starts[k]);
      if (dist < bestDist) {
        bestDist = dist;
        best = k;
      }
    }
    if (bestDist <= TITLE_NEAR) hits.add(best); // 一覧・目次上の遠い出現は捨てる
  }
  return hits;
}
