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
import { loadEnv } from "./summarize.js";
import { createAiContext, outlineByAi, deadlineByAi, DAILY_LIMIT } from "./outline-ai.js";
import {
  loadPdfState, savePdfState, fetchPdfIfChanged, extractPdfText, fullTextOf,
  pickPdfLink, blockForTitle, extractDeadlineDetail, blockLinesForTitle, outlineFromLines,
} from "./pdftext.js";

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

/**
 * 種別4値（P34-2。実データ30件と予定表のセクション構成から起こした）。
 * ⚠️目的は「受けなければならないものを見分ける」こと。
 *   資格要件 = 受講が開設・配置・資格の**要件**（受けないとその事業・職に就けない）
 *   法令対応 = 法令・運営基準が施設に実施や対応を求める研修（義務研修の内容）
 *   階層別   = 職位・経験年数で受ける（新任・中堅・管理職員・キャリアパス課程）
 *   テーマ別 = それ以外の技能・実務研修（受け皿。テーマでの細分化はしない＝
 *              チップが増えて絞り込みが機能しなくなる／分野タグと軸が重なる）
 * ⚠️「更新」は立てていない——実データに更新研修が0件のため（ケアマネ更新は別ページ管理）。
 *   ケアマネ更新が入る段階で「資格要件に含める／更新を立てる」を改めて判断する。
 */
export const KIND_VOCAB = ["資格要件", "法令対応", "階層別", "テーマ別"];

/** 受講が要件になる研修の名称（汎用語の「養成研修」は入れない——県の人材育成事業まで
 *  資格要件に見えてしまう。実例: 高次脳機能障がい支援者養成研修＝テーマ別が正しい） */
const REQUIRE_KW =
  /認知症介護実践|認知症介護基礎|認知症対応型|小規模多機能|計画作成担当者|介護支援専門員|喀痰吸引|サービス管理責任者|児童発達支援管理責任者|相談支援従事者|主任介護支援専門員|権利擁護推進員養成|推進員養成研修|実務研修|実習指導者|認定介護福祉士|資格認定|通信課程|資格認定講習/;
/** 法令・運営基準が求める研修（現データはBCP・感染症。虐待防止等は出れば正しく入る） */
const DUTY_KW = /ＢＣＰ|BCP|業務継続|感染症|虐待防止|身体拘束|権利擁護/;
/** 職位・経験年数で受ける研修 */
const RANK_KW = /新任職員|中堅職員|チームリーダー|管理職員|初任者コース|施設長・管理者|キャリアパス/;

export function kindOf(title, section) {
  // 「資格取得研修」セクションはサイトの分類がそのまま種別として使える（配下は全て要件系）。
  // ⚠️**「階層別研修」セクションは種別に使えない**——あれは新任→中堅→管理職の順に
  //   その階層向けのテーマ研修（コーチング・リスクマネジメント等）まで含めて並べた
  //   **並べ方**であって、個々の研修の性質ではない（実測で23行中の大半がテーマ研修だった）。
  //   階層別かどうかは**タイトルの職位語**だけで判定する。
  if (/資格取得/.test(section ?? "")) return "資格要件";
  if (REQUIRE_KW.test(title)) return "資格要件";
  if (DUTY_KW.test(title)) return "法令対応";
  if (RANK_KW.test(title)) return "階層別";
  return "テーマ別";
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
  // 見出しタグごと分割し、id（link1〜5）も拾う——個別ページが無い研修は
  // 一覧ページ＋セクションのアンカーへ飛ばすため（P34-2）
  const parts = html.split(/(?=<h[35][^>]*>)/);
  let section = "";
  let anchor = "";
  for (const part of parts) {
    const head = part.match(/^<h([35])([^>]*)>([\s\S]*?)<\/h\1>/);
    let body = part;
    if (head) {
      section = strip(head[3]);
      // h5（認知症介護研修など）は自前のidを持たないので、直近のh3のアンカーを保つ
      const id = head[2].match(/id="([^"]+)"/)?.[1];
      if (id) anchor = id;
      body = part.slice(head[0].length);
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
        // 原本=開催要綱。未公開の間は予定表の**該当セクションのアンカー**へ
        //（一覧の先頭に飛ばすと目的の研修に辿り着けない・P34-2）
        url: yoko ?? (anchor ? `${baseUrl}#${anchor}` : baseUrl),
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

/* ===========================================================================
 * 新着記事（kenshu-info）: 「◯◯研修の開催について」型の記事。
 * 予定表に無い研修の告知と、記事本文にしか無い締切（例: 認知症介護実践リーダー研修の
 * 「申込締切 令和８年７月１５日」）を補完する。⚠️締切の有無は記事による——
 * 無ければ開催日を「開催 M月D日」のラベルで示し、開催日を過ぎたら消す（P34の設計）。
 * ======================================================================== */

const FETCH_INTERVAL_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 受講者向け・事務連絡の記事は載せない（募集の記事だけを拾う） */
const INFO_EXCLUDE = /^保護中|様式|資料|事前課題|定員に達し|受講料について|研修体系|事業計画/;

/** 記事タイトル→研修名（「の開催について」等の定型と【…】印を落とす） */
const infoTitle = (t) =>
  t.replace(/^【[^】]*】\s*/, "").replace(/（動画配信）|【動画配信研修】|（ＷＥＢ研修）/g, "")
    .replace(/の開催(?:案内)?について.*$|について.*$/, "").trim();

/** 本文から申込締切（和暦・年なしM/D対応）を取る。無ければ null */
function infoDeadline(text, today) {
  const seg = text.match(/(?:申込(?:み)?締切|申込期限|受付期限)[^。]{0,40}/)?.[0] ?? "";
  let m = seg.match(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
  if (m) return iso(Number(m[1]) + 2018, Number(m[2]), Number(m[3]));
  m = seg.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return fiscalIso(Number(m[1]), Number(m[2]), today);
  return null;
}

/**
 * 本文の「期日/日程」の段落から開催日を集める（最終日=掲載を保つ期限にも使う）。
 * ⚠️セグメントは**次の項目ラベルの手前で切る**——伸ばすと「申込期限」の日付や
 *   受講料の説明まで開催日・但し書きに混ざる（実測でコーチング研修が該当）。
 * ⚠️元HTMLのタグ由来で「令和8年1 0月23日」のように**数字の間に空白が入る**ため、
 *   数字間の空白だけを先に詰める。月日は範囲で検証し、壊れた値は捨てる（P34-3）。
 */
const heldSegment = (text) => {
  const m = text.match(/(?:期\s*日|日\s*程|受講日程|開催日)[\s\S]{0,220}/);
  if (!m) return "";
  const seg = m[0].replace(/(\d)\s+(?=\d)/g, "$1");
  const cut = seg.search(/申込期限|申込締切|受講申込|研修方法|受講料|会員|お申し?込み/);
  return cut > 10 ? seg.slice(0, cut) : seg;
};
const validMd = (mm, dd) => mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;

/**
 * 日本語の日付列をISOの配列にする（共通ヘルパ・P35で新着とf-kaigoが共用）。
 * 「令和8年10月22日」「10月23日」「・26日」（直前の月を引き継ぐ）の3型。
 * ⚠️`日(?!目)` で「1日目：」「2日目：」を除く——これを日付として拾うと
 *   直前の月と合成されて実在しない開催日になる（実測: 2日目→10月2日）
 */
export function datesInText(seg, today) {
  const out = [];
  let lastMonth = null;
  for (const m of seg.matchAll(/(?:令和\s*(\d+)\s*年)?\s*(?:(\d{1,2})月)?(\d{1,2})日(?!目)/g)) {
    const mm = m[2] ? Number(m[2]) : lastMonth;
    const dd = Number(m[3]);
    if (!mm || !validMd(mm, dd)) continue;
    lastMonth = mm;
    out.push(m[1] ? iso(Number(m[1]) + 2018, mm, dd) : fiscalIso(mm, dd, today));
  }
  return [...new Set(out)].sort();
}

function infoHeldDates(text, today) {
  // ⚠️日付を拾うのは**但し書き（※）の手前まで**——「※2日間受講できる…」の「2日」を
  //   直前の月と合成して実在しない開催日にしてしまう（実測: 2日間→10月2日）
  return datesInText(heldSegment(text).split("※")[0], today);
}

/**
 * 期日の但し書き（P34-3）。「※2日間受講できる方に限ります」のような**受講判断に効く**
 * 一文だけを拾う。⚠️「※詳細は開催要綱をご確認ください」の類は情報がないので落とす。
 */
export function heldNote(text) {
  const seg = heldSegment(text);
  for (const m of seg.matchAll(/※\s*([^※。]{4,32})[。]?/g)) {
    const s = m[1].trim();
    if (/詳細|要綱|ご確認|お問い?合わせ|通知|ダウンロード/.test(s)) continue;
    // 受講判断に効く但し書きだけを拾う（受講料や会員資格の説明は期日の但し書きではない）
    if (!/受講|参加|日間|限り|オンライン|会場|欠席/.test(s)) continue;
    return s;
  }
  return null;
}

async function collectKenshuInfo(src, today) {
  const list = await fetchHtml(src.url);
  // 一覧1ページ目の記事リンク（月4〜5件なので毎朝の新着検知はここで足りる）
  const links = [];
  for (const m of list.matchAll(
    /<a href="(https:\/\/fuku-shakyo-kenshu\.jp\/info\/[^"]{30,}?)"[^>]*>([\s\S]{0,160}?)<\/a>/g
  )) {
    const title = strip(m[2]);
    if (!title || title === "この記事を読む") continue;
    if (links.some((l) => l.url === m[1])) continue;
    links.push({ url: m[1], title });
  }
  const items = [];
  for (const l of links) {
    if (INFO_EXCLUDE.test(l.title)) continue;
    if (!/研修|講習|養成/.test(l.title)) continue;
    await sleep(FETCH_INTERVAL_MS);
    const text = strip(await fetchHtml(l.url));
    const dl = infoDeadline(text, today);
    const held = infoHeldDates(text, today);
    // ★開催日は締切の有無に関わらず持つ（P34-3。2日間拘束されるか等は受講判断に直結する）。
    //   締切が取れない項目では最終開催日が掲載を保つ期限にもなる
    const held2 = { heldDates: held, heldNote: heldNote(text) };
    const item = dl
      ? { deadline: dl, deadlineType: "date", deadlineRaw: `申込締切 ${dl}` }
      : {
          deadline: null, deadlineType: "unknown", deadlineRaw: "締切の記載なし",
          ...(held.length ? { expireOn: held[held.length - 1] } : {}),
        };
    const title = infoTitle(l.title);
    items.push({
      title,
      url: l.url,
      ...item,
      ...(held.length ? { heldDates: held2.heldDates } : {}),
      ...(held2.heldNote ? { heldNote: held2.heldNote } : {}),
      openFrom: null,
      fields: fieldsOf(title),
      kind: kindOf(title, ""),
    });
  }
  return { items, raw: links.length };
}

/* ===========================================================================
 * 紙面からの合流（kenshu-goryu・P34承認済みの二段判定）:
 * 既存6源の新着のうち、①タイトルが研修語彙に該当し ②ノイズ語彙に該当せず
 * ③**P11の締切ウォッチで申込締切が実際に取れた項目だけ**を研修面にも載せる。
 * ③により「締切のない検討会の開催案内」型が構造的に落ちる（誤混入で面の信頼を
 * 落とさないことを最優先・ユーザー承認の設計）。
 * ⚠️取りこぼしは設計上ありうる（締切が本文になく要綱PDFにしかない研修は落ちる）。
 * ======================================================================== */

const GORYU_INCLUDE = /研修|講習|養成講座|セミナー/;
const GORYU_EXCLUDE =
  /検討会|審議会|分科会|部会|委員会|入札|落札|公示|公告|議事|報告書|プロポーザル|意見募集|パブリックコメント/;

function collectKenshuGoryu() {
  const path = join(ROOT, "data", "deadlines.json");
  if (!existsSync(path)) return { items: [], raw: 0, allowEmpty: true };
  const d = JSON.parse(readFileSync(path, "utf8"));
  const list = d.items ?? [];
  const items = [];
  for (const it of list) {
    if (!GORYU_INCLUDE.test(it.title)) continue;
    if (GORYU_EXCLUDE.test(it.title)) continue;
    if (/傍聴/.test(it.label ?? "")) continue; // 会議の傍聴申込は受講の締切ではない
    items.push({
      title: it.title,
      url: it.url,
      deadline: it.deadline,
      deadlineType: "date",
      deadlineRaw: `${it.label ?? "締切"} ${it.deadline}`,
      openFrom: null,
      fields: fieldsOf(it.title),
      kind: kindOf(it.title, ""),
      _source: it.source, // 出どころの行政名（印章は国/県が名前判定で付く）
    });
  }
  // ⚠️締切ウォッチが空の朝は0件が正常（構造変化ではない）
  return { items, raw: list.length, allowEmpty: true };
}

/* ===========================================================================
 * 福岡県介護福祉士会（kenshu-fkaigo・P35）: /training/index.php の一覧ハブ型。
 * div.kenshu 単位で 研修名（detail_NNN.php への個別リンク）・開催日・会場・費用が平文。
 * ⚠️締切の記載は無い（個別ページにも無い）＝開催日ベースで、最終開催日を過ぎたら消す。
 * ⚠️親睦系（納涼会・交流会等）と「【受付終了しました】」は載せない。
 * ======================================================================== */

const FKAIGO_EXCLUDE = /納涼会|懇親|交流会|忘年会|新年会|総会|フェスタ|調査員募集|委員募集/;

export function parseFkaigo(html, today, baseUrl) {
  const items = [];
  let raw = 0;
  for (const block of html.split(/<div class="kenshu">/).slice(1)) {
    const t = block.match(/<h3><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>/);
    if (!t) continue;
    raw++;
    const title = strip(t[2]);
    if (!title) continue;
    if (/受付終了|受付を終了/.test(title)) continue;
    if (FKAIGO_EXCLUDE.test(title)) continue;
    const dateCell = strip(block.match(/class="date"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "");
    const held = datesInText(dateCell, today);
    if (!held.length) continue;            // 開催日が読めない行は載せない（期限管理できない）
    if (held[held.length - 1] < today) continue; // 全日程終了
    items.push({
      title,
      url: new URL(t[1], baseUrl).href,    // detail_NNN.php（個別ページ・P34-2の原則）
      deadline: null,
      deadlineType: "unknown",
      deadlineRaw: "締切の記載なし",
      heldDates: held,
      expireOn: held[held.length - 1],
      openFrom: null,
      fields: fieldsOf(title),
      kind: kindOf(title, ""),
    });
  }
  return { items, raw };
}

/* ===========================================================================
 * 中央福祉学院（kenshu-gakuin・P35・⚠️届出の投函まで「保留（届出前）」）:
 * 「募集中の講座」カテゴリ（/info-cate/course/）の【募集開始】【申込開始】型の記事。
 * タイトル・本文に締切（「第一次締切 9/24」「申込は7/24まで」）と研修日程が平文。
 * ======================================================================== */

const GAKUIN_EXCLUDE = /不具合|復旧|受講者ページ|募集(?:を)?終了|一覧表を更新/;

/** タイトル→講座名（【…】印・「の申込を開始しました！(…)」等の定型を落とす） */
const gakuinTitle = (t) =>
  t.replace(/^【[^】]*】\s*/, "")
    .replace(/[（(][^）)]*締切[^）)]*[）)]/g, "")
    .replace(/の?(?:お?申込(?:み)?|募集)(?:受付)?を開始しました.*$/, "")
    .replace(/の申込期間延長について.*$/, "")
    .replace(/[「」]/g, "").trim();

/**
 * 記事ページの本文だけに絞る。⚠️ページ全体を使うと、サイドバーの
 * 「カテゴリー別新着情報」に載る**他の記事のタイトルから別記事の締切を拾う**
 * （実測: 4件全部が別記事の「第一次締切 9/24」になった）。
 */
function gakuinBody(text) {
  const cut = text.search(/カテゴリー別新着情報|前の記事|次の記事/);
  return cut > 0 ? text.slice(0, cut) : text;
}

/** 締切: 「第一次締切 9/24」「申込は7/24まで」「申込期限」等の表記ゆれを拾う */
function gakuinDeadline(text, today) {
  const seg =
    text.match(/(?:第?一?次?締切|申込期限|受付期限)[^。]{0,30}/)?.[0] ??
    text.match(/申込は[^。]{0,20}まで/)?.[0] ?? "";
  let m = seg.match(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
  if (m) return iso(Number(m[1]) + 2018, Number(m[2]), Number(m[3]));
  m = seg.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
  if (m && validMd(Number(m[1]), Number(m[2]))) return fiscalIso(Number(m[1]), Number(m[2]), today);
  return null;
}

/** 研修日程: 【研修日程1】…のように複数ブロックがあるので広めに読み、金額等の手前で切る */
function gakuinHeld(text, today) {
  const m = text.match(/(?:研修日程|日\s*程|開催日)[\s\S]{0,340}/);
  if (!m) return [];
  const seg = m[0].replace(/(\d)\s+(?=\d)/g, "$1");
  const cut = seg.search(/申込|受講料|定員|会場|宿泊/);
  return datesInText((cut > 10 ? seg.slice(0, cut) : seg).split("※")[0], today);
}

async function collectGakuin(src, today) {
  const list = await fetchHtml(src.url);
  const links = [];
  for (const m of list.matchAll(
    /<a href="(https:\/\/www\.gakuin\.gr\.jp\/info\/[^"]+)"[^>]*>([\s\S]{4,160}?)<\/a>/g
  )) {
    const title = strip(m[2]);
    if (!title || title.length < 8) continue;
    if (links.some((l) => l.url === m[1])) continue;
    links.push({ url: m[1], title });
  }
  const items = [];
  for (const l of links.slice(0, 10)) {
    if (GAKUIN_EXCLUDE.test(l.title)) continue;
    if (!/研修|講座|課程|講習|募集|申込/.test(l.title)) continue;
    await sleep(FETCH_INTERVAL_MS);
    const body = gakuinBody(strip(await fetchHtml(l.url)));
    const dl = gakuinDeadline(l.title + " " + body, today);
    const held = gakuinHeld(body, today);
    if (dl && dl < today) continue; // 締切済み
    const item = dl
      ? { deadline: dl, deadlineType: "date", deadlineRaw: `申込締切 ${dl}` }
      : {
          deadline: null, deadlineType: "unknown", deadlineRaw: "締切の記載なし",
          ...(held.length ? { expireOn: held[held.length - 1] } : {}),
        };
    const title = gakuinTitle(l.title);
    items.push({
      title,
      url: l.url,
      ...item,
      ...(held.length ? { heldDates: held } : {}),
      openFrom: null,
      fields: fieldsOf(title),
      kind: kindOf(title, ""),
    });
  }
  return { items, raw: links.length };
}

/* ===========================================================================
 * 特定ページの中身を監視する型（kenshu-watch・P35実装順序4。P23から懸案の型の初実装）
 *
 * 設計原則（ユーザー承認済み・台帳に記録）:
 *  ① ページ全体のハッシュを使わない。「ページの変化」ではなく
 *     「監視の意図に合う要素の集合の変化」を見る
 *  ② 誤検知防止は3層: 領域の限定（start/end）・採用/除外語彙（accept/exclude）・
 *     要素キーの設計
 *  ③ ⚠️最重要は要素キー: **正規化テキストを主・URLは種類（pdf/html）だけ**にする。
 *     これで「URLが年度替わりで差し替わる様式PDF」は発火せず、
 *     「受付中の文言が新出する」は発火する
 *  ④ 受付期外で実データの発火を確認できないため、合成テストで両方向を担保する
 *     （注入した変化で発火する／無関係な変更で発火しない）
 *
 * 初回はベースラインの保存のみ（項目0・P21の型）。以後、ベースラインにも active にも
 * 無い要素が現れたら「募集が始まった」として研修面に載せ、要素がページから消えたら消す。
 * 状態は data/pagewatch.json（正規化キーのみ。ページ全文は保存しない）。
 * ======================================================================== */

const PAGEWATCH_PATH = join(ROOT, "data", "pagewatch.json");

/** ページ別の監視ルール。⚠️将来の適用先（全国保育士会の処遇改善ページ・
 *  福岡県社協の民間助成ハブ等）はここに1エントリ足し、台帳に1行足すだけでよい */
const WATCH_RULES = {
  "https://www.facsw.or.jp/service_training/select": {
    label: "サビ管・児発管研修",
    start: /class="fs-post_main"/, end: /<footer/,
    accept: /受付中|受付を開始|申込フォーム|募集要項|開催要綱|申込手順/,
    exclude: /入会|会員募集/,
  },
  "https://www.facsw.or.jp/support_training/entry": {
    label: "相談支援従事者研修",
    start: /class="fs-post_main"/, end: /<footer/,
    accept: /受付中|受付を開始|申込フォーム|募集要項|開催要綱|申込手順/,
    exclude: /入会|会員募集/,
  },
  "https://fuku-shakyo-kenshu.jp/kaigoshien/": {
    label: "介護支援専門員研修",
    start: /id="main"/, end: /class="pagetop"|<footer/,
    accept: /募集|受付中|受付開始|受付につい|開催要綱|申込期間|申込方法/,
    // 受講中向けの様式・フォーム類は語彙で殺す（本文領域内に同居しているため）
    exclude: /記録シート|辞退|同意書|インボイス|領収書|修了書|給付金|表紙|受付シート|基本情報|メールアドレス|問い?合わせ/,
  },
  "https://fukuoka-cm.jp/": {
    label: "福岡県介護支援専門員協会",
    start: /id="contents"/, end: /<footer/,
    urlExclude: /news2\.php/, // 求人欄（頻繁に入れ替わる最大の誤検知源）
    accept: /主任|専門(?:研修|II|Ⅱ)|更新(?:研修|前期|後期)|実務研修|法定研修/,
    exclude: /求人|正社員|募集要項なし/,
  },
};

/** 要素キー: 正規化テキスト主・URLは種類だけ（設計原則③） */
const watchKey = (title, url) =>
  createHash("sha256")
    .update(`${flat(title)}|${/\.pdf(?:$|[?#])/i.test(url) ? "pdf" : "html"}`)
    .digest("hex")
    .slice(0, 12);

/** ページから「監視の意図に合う要素」を抽出する（コア・源を問わず共通） */
export function watchElements(html, rule, baseUrl) {
  let seg = html;
  const i = seg.search(rule.start);
  if (i < 0) throw new Error("本文領域が見つかりません（構造変化の疑い）");
  seg = seg.slice(i);
  const j = seg.search(rule.end);
  if (j > 0) seg = seg.slice(0, j);
  const out = new Map();
  for (const m of seg.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,160}?)<\/a>/g)) {
    const text = strip(m[2]);
    let url;
    try { url = new URL(m[1].trim(), baseUrl).href; } catch { continue; }
    if (/^javascript:/i.test(url)) continue;
    if (rule.urlExclude?.test(url)) continue;
    const ctx = strip(seg.slice(Math.max(0, m.index - 220), m.index));
    const hay = `${ctx} ${text}`;
    if (rule.exclude?.test(hay)) continue;
    if (!rule.accept.test(hay)) continue;
    // タイトル解決: リンク文言が無意味（こちら/ダウンロード等）なら周辺から研修名を拾う
    let title = text;
    if (!title || title.length < 6 || /こちら|ダウンロード|ＰＤＦ|PDF|クリック|詳しく/.test(title)) {
      const nm = ctx.match(/([^\s。、]{4,40}(?:研修|講習|コース|課程|勉強会)[^。、\s]{0,10})[^。、]*$/);
      title = nm ? nm[1].trim() : title;
    }
    if (!title || title.length < 4) title = `${rule.label}の受付情報`;
    const key = watchKey(title, url);
    if (!out.has(key)) out.set(key, { key, title, url, ctx });
  }
  return [...out.values()];
}

function loadPagewatch() {
  if (!existsSync(PAGEWATCH_PATH)) return {};
  return JSON.parse(readFileSync(PAGEWATCH_PATH, "utf8"));
}

async function collectWatch(src, today) {
  const rule = WATCH_RULES[src.url];
  if (!rule) throw new Error(`監視ルールがありません: ${src.url}`);
  const html = await fetchHtml(src.url);
  const elems = watchElements(html, rule, src.url);
  const state = loadPagewatch();
  const page = state[src.url] ?? { baseline: null, active: {} };
  const currentKeys = new Set(elems.map((e) => e.key));
  if (!page.baseline) {
    page.baseline = [...currentKeys];
    console.log(`  初回ベースライン: ${currentKeys.size}要素（項目は出さない）`);
  } else {
    const base = new Set(page.baseline);
    for (const e of elems) {
      if (base.has(e.key) || page.active[e.key]) continue;
      // 周辺に締切のラベルつき日付があれば拾う（無ければ「募集情報あり」のまま）
      const seg = `${e.ctx} ${e.title}`.match(/(?:締切|期限)[^。]{0,30}/)?.[0] ?? "";
      const dates = datesInText(seg, today).filter((d) => d >= today);
      page.active[e.key] = {
        title: e.title, url: e.url, detectedAt: today, deadline: dates[0] ?? null,
      };
      console.log(`  検知: ${e.title}`);
    }
    for (const k of Object.keys(page.active)) {
      if (!currentKeys.has(k)) delete page.active[k]; // ページから消えた＝掲載終了
    }
  }
  state[src.url] = page;
  if (!dryRun) writeFileSync(PAGEWATCH_PATH, JSON.stringify(state, null, 1) + "\n");
  const items = Object.values(page.active).map((a) => ({
    title: a.title,
    url: a.url,
    deadline: a.deadline,
    deadlineType: a.deadline ? "date" : "unknown",
    deadlineRaw: a.deadline ? `締切 ${a.deadline}` : "募集情報あり",
    openFrom: null,
    fields: fieldsOf(a.title),
    kind: kindOf(a.title, ""),
  }));
  // ⚠️採用0要素は正常（受付期外）。本文領域が見つからない場合は上で失敗している
  return { items, raw: elems.length, allowEmpty: true };
}

const COLLECTORS = {
  "kenshu-schedule": async (src, today) => {
    const html = await fetchHtml(src.url);
    return parseKenshuSchedule(html, today, src.url);
  },
  "kenshu-gakuin": async (src, today) => collectGakuin(src, today),
  "kenshu-watch": async (src, today) => collectWatch(src, today),
  "kenshu-info": async (src, today) => collectKenshuInfo(src, today),
  "kenshu-goryu": async () => collectKenshuGoryu(),
  "kenshu-fkaigo": async (src, today) => {
    const html = await fetchHtml(src.url);
    return parseFkaigo(html, today, src.url);
  },
};

/** 比較用に均す（記号・空白を落とす）。
 *  ⚠️回次（1回目/第2回）は落とさない——落とすと**別の回次の研修まで畳む**
 *  （実測: 認知症対応型の開設者1回目と2回目が統合され3件消えた。P24-4の教訓の再演） */
const flat = (s) =>
  String(s ?? "").normalize("NFKC").replace(/[\s【】\[\]（）()「」・、。,.／/―ー\-~〜]/g, "");

/**
 * 同じ研修が複数の源から入るので統合する（P34。助成の型の変形）。
 * ⚠️助成は「締切一致を必須」にしたが、研修は新着・合流側が締切を持たないことがあるため
 *   「名称が包含関係 かつ（締切が一致する or どちらかが締切を持たない）」で畳む。
 *   締切が両方あって異なるなら**別の回次**なので畳まない。
 * 残す方の優先順: 締切を持つ > 予定表 > 新着 > 合流（情報の確度の順）。
 */
export function dedupeKenshu(items) {
  const rank = (it) =>
    (it.deadlineType === "date" ? 4 : 0) +
    (it.via === "schedule" ? 2 : it.via === "info" ? 1 : 0);
  const out = [];
  for (const it of items) {
    const a = flat(it.title);
    const hit = out.find((o) => {
      const b = flat(o.title);
      if (!a || !b || !(a.includes(b) || b.includes(a))) return false;
      if (it.deadlineType === "date" && o.deadlineType === "date") {
        return it.deadline === o.deadline;
      }
      return true; // 片方が締切を持たない＝同じ研修の告知の別段階とみなす
    });
    if (!hit) { out.push(it); continue; }
    const win = rank(it) > rank(hit) ? it : hit;
    const lose = win === it ? hit : it;
    // ★入口は「読める個別ページ」を優先する（P34-2）。予定表側が勝っても、
    //   新着に同じ研修のHTML記事があればそのURLを引き継ぐ——要綱PDFや一覧の
    //   アンカーより、日程・締切・申込導線が1枚に揃った記事の方が親切
    if (!/\/info\//.test(win.url) && /\/info\//.test(lose.url ?? "")) {
      win.url = lose.url;
    }
    // 受付開始日は持っている方を残す（予定表にしか無い）
    if (!win.openFrom && lose.openFrom) win.openFrom = lose.openFrom;
    // 開催日・但し書きは新着記事にしか無いので、予定表側が勝っても引き継ぐ（P34-3）
    if (!win.heldDates?.length && lose.heldDates?.length) win.heldDates = lose.heldDates;
    if (!win.heldNote && lose.heldNote) win.heldNote = lose.heldNote;
    out[out.indexOf(hit)] = win;
  }
  if (out.length !== items.length) {
    console.log(`  同一の研修を統合: ${items.length}件 → ${out.length}件`);
  }
  return out;
}

/* ===========================================================================
 * PDF併読（P43）: 締切が本文でなくリンク先PDFにしか無い源のための後処理。
 *
 * 台帳（docs/sources.md）が3列を持つ源だけに効く。⚠️源の名前も条件もここに書かない——
 * 「PDFリンクの目印・ブロックの区切り語・締切の表記パターン」は全て台帳から来る（★の原則）。
 * 部品は scripts/pdftext.js（機械確認は node scripts/pdftext-check.js）。
 *
 * ⚠️**個別ページのHTMLは毎回読む**。PDFは差し替わる（実測: f-kaigo に
 *   「【申込期間延長!】」の研修が実在する＝延長のたびに別のPDFが貼られる）。
 *   リンクの対応を覚え込むと、延長後も古い締切を出し続ける——誤った締切は
 *   無い締切より悪い（P43の[DECISION]）。**PDFの本体**は HEAD 照合で
 *   変わっていなければ取得もパースもしない（26URLで実体12ファイル・実測）。
 *
 * ⚠️締切を過ぎた項目の扱い（P43の要件3）: **消さない**——当のPDFに
 *   「締切後も定員に余裕がある場合は申込みを受け付けることがあります」と明記がある。
 *   ただし `deadlineType="date"` のまま残すと index.html が「残り-5日」を朱で明滅させる
 *   （index.html:1819。表示側は1行も変えない前提）。そこで**過ぎた締切は
 *   deadlineType を "unknown" のままにし**、出どころだけ deadlineRaw に残す。
 *   これで画面はP43以前と同じ「開催日だけの表示」に戻り、項目は expireOn まで生きる。
 * ======================================================================== */

/**
 * PDFの抽出結果の記憶（data/pdf-state.json）。⚠️本文は持たない・構造化された値だけ。
 * 形は `results[項目のハッシュ] = { deadline: {iso,raw}|null, outline: [{name,value}]|null }`。
 * ⚠️P46で `deadlines` から `results` に変えた（締切と要点を同時に決めるため）。
 *   旧キーは読まない＝入れ替えの朝だけ全PDFを1度取り直す（以後はHEADのみ）。
 */
/**
 * ⚠️**抽出の版**。取り方を変えたら必ず上げる。記憶は「取れなかった」ことも覚えるため、
 *   版を上げないと**新しい取り方が二度と試されない**（P48で実際に踏んだ:
 *   AI方式を入れたのに、前日「要点なし」と記憶した11件が再評価されず0件のままだった）。
 *   版1=P46（規則のみ）／版2=P48（規則→AI）／版3=P48（見出しの申告を照合に使う）／版6=P50（締切もAIに回す）。
 */
const RESULT_VERSION = 6;
const pdfResults = (state, pdfUrl) =>
  state[pdfUrl]?.resultsVersion === RESULT_VERSION ? (state[pdfUrl].results ?? {}) : {};
const rememberResult = (state, pdfUrl, hash, value) => {
  state[pdfUrl] = {
    ...(state[pdfUrl] ?? {}),
    resultsVersion: RESULT_VERSION,
    results: { ...pdfResults(state, pdfUrl), [hash]: value },
  };
};

/**
 * 台帳がPDF併読を指定した源の項目に、PDFから読んだ締切を付ける。
 * 対象は `deadlineType !== "date"` の項目だけ（HTML側で締切が取れたものには触らない）。
 * 返り値は実測の内訳（検証・ログ用）。
 */
async function attachPdfDeadlines(items, src, today, pdfState, aiCtx) {
  const stat = { targets: 0, filled: 0, past: 0, noLink: 0, noBlock: 0, noDeadline: 0,
    pdfParsed: 0, pdfSkipped: 0, noTextLayer: 0, errors: 0, remembered: 0, outlined: 0,
    byRule: 0, byAi: 0, gateHallucination: 0, gateTabular: 0, gateTooLong: 0, gateNear: 0, gateDate: 0, aiNull: 0, deferred: 0, dlByRule: 0, dlByAi: 0, htmlKept: 0 };
  // 中身のハッシュ → 全文（この実行の中だけ・ファイルには残さない）。
  // ⚠️URLではなく**中身**で覚える——f-kaigo は同じPDFを研修ごとに別URLで貼るため
  //   （26URLで実体12ファイル・実測）、URLで覚えると同じPDFを何度も解析する
  const textCache = new Map();
  const refreshed = new Set(); // この実行で中身が変わっていたPDF（古い記憶を捨てる）
  for (const it of items) {
    // ⚠️**行単位で判定する**（P50）。HTMLから締切が取れた行はPDFを読まない。
    //   源単位で「この源はPDF併読が要る／要らない」と決めるのをやめた理由:
    //   P47で「#18は締切がHTML表にあるから不要」と**源単位で**判定し、
    //   同じ表の中に**申込終了日が空欄の行が20行ある**ことを見落とした。
    //   「表に列がある」ことと「全行に値が入っている」ことは別。
    if (it.deadlineType === "date") {
      // HTMLから締切が取れた行＝PDFは読まない（APIも呼ばない）。
      // ⚠️どの経路で取れたかを残す（原文との突合の拠り所・パーサ側には触らない）
      if (it.deadlineRaw && !/より/.test(it.deadlineRaw)) {
        it.deadlineRaw = `一覧の申込終了日より ${it.deadlineRaw}`;
      }
      stat.htmlKept++;
      continue;
    }
    stat.targets++;
    try {
      // 読むべきPDFの決め方も**リンクの形**だけで決める（源の名前もURLも条件にしない）:
      //   項目のリンクがPDF → それを読む（予定表のように行から要綱へ直接張る源）
      //   HTMLページ       → 台帳の目印でページ内のPDFを1本選ぶ（個別ページを挟む源）
      const linksToPdf = /\.pdf(\?|#|$)/i.test(it.url);
      if (!linksToPdf && !src.pdfAnchor) continue; // 読むべきPDFを特定できない＝何もしない
      let pdfUrl;
      if (linksToPdf) {
        pdfUrl = it.url;
      } else {
        const page = await fetchHtml(it.url);
        await sleep(FETCH_INTERVAL_MS);
        pdfUrl = pickPdfLink(page, src.pdfAnchor, it.url);
      }
      if (!pdfUrl) { stat.noLink++; continue; }

      const hash = kenshuHash(it);
      const got = await fetchPdfIfChanged(pdfUrl, pdfState);
      if (got.error) { stat.errors++; continue; }
      if (got.changed && !refreshed.has(pdfUrl)) {
        // 中身が変わった＝この PDF についての記憶は全て捨てる（古い締切・要点を残さない）
        refreshed.add(pdfUrl);
        pdfState[pdfUrl] = { ...(pdfState[pdfUrl] ?? {}), results: {} };
      }

      let found; // 締切 { iso, raw } | null（null＝このPDFからは取れないと確定した）
      let outline; // 要点 [{name, value|null}] | null
      let outlinePending = false; // 上限で要点を決められなかった（翌朝やり直す）
      const remembered = pdfResults(pdfState, pdfUrl);
      if (!got.changed && hash in remembered && !remembered[hash].outlinePending) {
        // 前回と同じPDF・同じ項目＝本体を取りに行かず、覚えている値を使う
        stat.pdfSkipped++;
        found = remembered[hash].deadline;
        outline = remembered[hash].outline;
        if (!found) stat.remembered++; // 前回「この項目の締切は取れない」と分かっている
      } else {
        if (!got.changed) {
          // 中身は同じだが、この項目についての記憶が無い（新しい研修・状態の初期化後）
          const re = await fetchPdfIfChanged(pdfUrl, {});
          if (re.error) { stat.errors++; continue; }
          got.data = re.data;
        }
        const bodyKey = createHash("sha256").update(got.data).digest("hex").slice(0, 16);
        if (!textCache.has(bodyKey)) {
          const ex = await extractPdfText(got.data);
          textCache.set(bodyKey, ex.noTextLayer ? null : fullTextOf(ex));
          if (ex.noTextLayer) stat.noTextLayer++;
          else stat.pdfParsed++;
        }
        await sleep(FETCH_INTERVAL_MS);
        const text = textCache.get(bodyKey);
        if (text == null) {
          // テキスト層なし（画像PDF）＝締切も要点も付けない。⚠️「取れない」ことも記憶する——
          //   記憶しないと毎朝この重いPDFを取りに行く（実測で2本が該当）
          rememberResult(pdfState, pdfUrl, hash, { deadline: null, outline: null });
          continue;
        }
        const block = blockForTitle(text, src.pdfDelimiter, it.title, it.heldDates ?? []);
        found = block ? extractDeadlineDetail(block, src.pdfDeadlineMarker, today) : null;
        if (found) stat.dlByRule++;
        if (!block) stat.noBlock++;
        // ⚠️規則で取れなければAIに回す（P50。要点と同じ「規則→0件ならAI」の形）。
        //   ブロックが引けない源（1PDF＝1研修）は全文を渡す
        if (!found) {
          const ai = await deadlineByAi(block ?? text, it.title, aiCtx, today);
          if (ai) { found = ai; stat.dlByAi++; }
        }
        // 開催の要点（P46）: 同じブロックの**生テキストの行**から原文のまま切り出す
        const res = await outlineFor(text, block, src, it, aiCtx, stat);
        outline = res.rows;
        outlinePending = res.pending;
        // 記憶する（⚠️保存するのは抽出した値だけ。PDFの本文は保存しない）
        // ⚠️未確定（上限で打ち切り）なら印を残す。翌朝この項目だけやり直す
        rememberResult(pdfState, pdfUrl, hash, {
          deadline: found ?? null, outline, ...(outlinePending ? { outlinePending: true } : {}) });
        if (!found && block) stat.noDeadline++;
      }

      // 要点は締切の有無と関係なく付ける（1項目も取れなければ付けない＝画面に展開を出さない）
      if (outline?.some((o) => o.value)) {
        it.outline = outline.map((o) => ({ name: o.name, value: o.value ?? "記載なし" }));
        it.outlineUrl = pdfUrl;
        stat.outlined++;
      }

      if (!found) continue;
      // 出どころを残す（原文との突合の拠り所・P43の要件4）
      it.deadlineRaw = `開催要綱PDFより ${found.raw}`;
      it.keepUntilHeld = true; // ⚠️締切超過でも最終開催日まで消さない（下の整理条件で効く）
      if (found.iso >= today) {
        it.deadline = found.iso;
        it.deadlineType = "date";
        stat.filled++;
      } else {
        // 過ぎた締切: 画面はP43以前と同じ（開催日だけ）に戻す。値は deadlineRaw に残る
        it.deadlineRaw = `開催要綱PDFより ${found.raw}（締切後も受け付けることがあります）`;
        stat.past++;
      }
    } catch (e) {
      stat.errors++;
      console.error(`    PDF併読に失敗（続行）: ${it.title.slice(0, 24)}: ${e.message}`);
    }
  }
  return stat;
}

/**
 * 開催の要点（P46）。台帳の「項目の囲み方」「要点として出す項目名」に従って、
 * **生テキストの行**から原文のまま切り出す。列が空欄なら null（＝要点を出さない）。
 * ⚠️正規化後の文字列を使わない——「２，０００円」が「2,000円」に化ける（実測）。
 */
function outlineOf(rawText, src, it) {
  if (!src.outlineBrackets || !src.outlineNames?.length) return null;
  const lines = blockLinesForTitle(rawText, src.pdfDelimiter, it.title, it.heldDates ?? []);
  if (!lines?.length) return null;
  return outlineFromLines(lines, src.outlineBrackets, src.outlineNames);
}

/**
 * 要点を取る（P48）: **規則を先に試し、1項目も取れなければAIに回す**。
 * ⚠️方式は台帳に書かない——台帳に方式を書き続ける運用は「源ごとに型を足す」ことと同じで、
 *   自律型の方針に反する。規則方式は《 》を探すので番号付きPDFでは必ず0件になり
 *   （実測: 番号付き9本すべてで0件・本文に「《」が1回も出てこない）、これを分岐に使える。
 * ⚠️AIに渡すのは、ブロックが引けたならそのブロック、引けないならPDF全文
 *   （番号付きの案内は1PDF＝1研修なので全文で正しい）。
 */
async function outlineFor(rawText, block, src, it, ctx, stat) {
  const byRule = outlineOf(rawText, src, it);
  if (byRule?.some((o) => o.value)) { stat.byRule++; return { rows: byRule, pending: false }; }
  if (!src.outlineNames?.length) return { rows: byRule, pending: false };
  // ⚠️上限で呼べなかったときは**未確定として記憶する**——「要点なし」と覚えてしまうと
  //   翌朝も再評価されず、打ち切りが永久に持ち越されない（P48で実際に踏んだ穴）
  if (ctx.apiKey && ctx.budget.calls >= DAILY_LIMIT) {
    stat.deferred++;
    return { rows: byRule, pending: true };
  }
  const got = await outlineByAi(block ?? rawText, src.outlineNames, ctx, it.heldDates ?? []);
  if (!got) return { rows: byRule, pending: false };
  stat.byAi++;
  for (const d of got.dropped) {
    if (d.why.startsWith("原文に無い")) stat.gateHallucination++;
    else if (d.why.startsWith("表組み")) stat.gateTabular++;
    else if (d.why.startsWith("字数超過")) stat.gateTooLong++;
    else if (d.why === "近傍に項目名が無い") stat.gateNear++;
    else if (d.why.startsWith("開催日と合わない")) stat.gateDate++;
    else if (d.why === "AIがnull") stat.aiNull++;
  }
  // 関門を通ったものだけを、台帳の順に並べて返す（取れなかったものは呼び側が「記載なし」に）
  const kept = new Map(got.kept.map((k) => [k.name, k.value]));
  return { rows: src.outlineNames.map((name) => ({ name, value: kept.get(name) ?? null })), pending: false };
}

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

/**
 * 期限切れ整理の条件（P34＋P43）。⚠️表示に直結する規則なので関数にして機械確認する。
 * ・締切を過ぎたら消す（既定）
 * ・ただし `keepUntilHeld`（台帳でPDF併読を指定した源）は**締切超過でも消さない**——
 *   PDFに「締切後も定員に余裕がある場合は申込みを受け付けることがあります」と明記が
 *   あるため。消えるのは、この扱いを指定していない源だけ。
 * ・どの源も、最終開催日（expireOn）を過ぎたら消す。
 */
export const survivesPrune = (it, today) =>
  Boolean(
    (it.deadlineType !== "date" || !it.deadline || it.deadline >= today || it.keepUntilHeld) &&
      (!it.expireOn || it.expireOn >= today)
  );

async function main() {
  const today = jstToday();
  const allSources = readSources();
  const sources = allSources.filter((s) => s.kind === "training" && s.status === "巡回中");
  // 既定分野（P36）: 合流（_source=行政名）も含めて名前で台帳の行を引く
  const srcByName = new Map(allSources.map((s) => [s.name, s]));
  if (sources.length === 0) {
    console.log("状態が「巡回中」の研修の源がありません（docs/sources.md の区分=研修）");
    return;
  }

  const store = loadStore();
  const before = store.items.length;
  store.items = store.items.filter((it) => survivesPrune(it, today));
  const pruned = before - store.items.length;

  const known = new Map(store.items.map((it) => [it.hash, it]));
  const seenThisRun = new Set();
  const fresh = [];
  const errors = [];
  const pdfState = loadPdfState(); // PDF併読の照合状態（P43。⚠️本文は持たない）
  let pdfStateDirty = false;
  // 要点のAI抽出（P48）。⚠️鍵が無い環境でも巡回は止めない——規則方式だけで続ける
  let apiKey = null;
  try {
    apiKey = loadEnv();
  } catch {
    console.log("GEMINI_API_KEY がないため、要点のAI抽出は行いません（規則方式のみ）");
  }
  const aiCtx = createAiContext(apiKey, pdfState);

  for (const src of sources) {
    try {
      const collect = COLLECTORS[src.method];
      if (!collect) throw new Error(`巡回方法「${src.method}」に対応するコレクタがありません`);
      console.log(`取得: ${src.name} (${src.url})`);
      const { items: parsed, raw, allowEmpty } = await collect(src, today);
      // ★0件は構造変化・年度替わりのURL失効の疑いとして失敗扱い（サイレント0件の禁止）。
      //   ⚠️合流（締切ウォッチが空の朝）など、0件が正常な源は allowEmpty で除く
      if (raw === 0 && !allowEmpty) {
        throw new Error("1件も読み取れませんでした（構造変化か、年度替わりのURL未更新の疑い）");
      }
      console.log(`  掲載${raw}行 / 申込可能${parsed.length}件`);
      // 既定分野（P36・正本は docs/sources.md）: タイトル語彙で分野が付かず「共通」に
      // 落ちた項目を、源（合流は出どころの行政）の既定分野へ倒す。
      // ⚠️種別=法令対応（虐待防止・BCP・感染症等）は全分野向けなので共通のまま
      //   （summarize.js の ZENBUNYA_KW と同じ例外を、研修は既存の種別判定の再利用で実現）
      for (const it of parsed) {
        const owner = it._source ? srcByName.get(it._source) : src;
        if (
          owner?.defaultFields?.length &&
          it.kind !== "法令対応" &&
          it.fields.length === 1 && it.fields[0] === "共通"
        ) {
          it.fields = [...owner.defaultFields];
        }
      }
      // PDF併読（P43）: 台帳が3列を持つ源だけ、締切が取れていない項目をPDFで補う。
      // ⚠️6つのパーサ本体には触らない——ここは全パーサが通る合流点で、
      //   「どの源がPDFを読むか」は台帳（src.pdfAnchor）だけが決める。
      // ⚠️源で足切りしない（P50）。**行単位**で「HTMLから締切が取れたか」だけで分かれる。
      //   台帳に「この源はPDF併読が要る」という列は持たない——それは源単位の判定に戻ることで、
      //   P47で#18の空欄行20行を見落とした事故の原因そのもの。
      {
        const s = await attachPdfDeadlines(parsed, src, today, pdfState, aiCtx);
        if (s.targets || s.htmlKept) pdfStateDirty = true;
        if (s.targets || s.htmlKept) console.log(
          `  締切: 規則${s.dlByRule}件・AI${s.dlByAi}件／要点: 規則${s.byRule}件・AI${s.byAi}件` +
          (s.deferred ? `・持ち越し${s.deferred}件` : "") +
          (s.byAi
            ? `（AI呼び出し${aiCtx.calls}回・失敗${aiCtx.fails}回／関門で落とした: 幻覚${s.gateHallucination}` +
              `・近傍${s.gateNear}・別の回${s.gateDate}・表組み${s.gateTabular}・字数${s.gateTooLong}・AIがnull${s.aiNull}）`
            : "")
        );
        if (s.targets) console.log(
          `  PDF併読: 対象${s.targets}件 → 締切${s.filled}件（超過${s.past}件）` +
          `／付かず${s.targets - s.filled - s.past}件` +
          `（リンク無${s.noLink}・ブロック不一致${s.noBlock}・締切無${s.noDeadline}` +
          `・テキスト層無${s.noTextLayer}・失敗${s.errors}・記憶${s.remembered}）` +
          `／要点${s.outlined}件／PDF解析${s.pdfParsed}本・HEADのみ${s.pdfSkipped}件`
        );
      }
      const via = src.method.replace(/^kenshu-/, "");
      for (const it of parsed) {
        const hash = kenshuHash(it);
        seenThisRun.add(hash);
        const prev = known.get(hash);
        if (prev) {
          // 既知: 締切・タグを更新する（日程の追加・要綱の公開で変わる）。
          // via も付け直す（付く前の旧データに残らないように＝統合の優先順が狂う）
          const { _source, ...rest } = it;
          Object.assign(prev, rest, { via });
          continue;
        }
        // 合流の項目は出どころの行政名を源として出す（印章は名前判定で国/県が付く）
        const { _source, ...rest } = it;
        fresh.push({
          hash,
          source: _source ?? src.name,
          sourceKind: _source ? "" : "org",
          via,
          ...rest,
        });
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

  // 同じ研修が複数の源から入るので統合する（予定表×新着×合流・P34）
  store.items = dedupeKenshu(store.items);

  // 並び: 受付中（締切あり）→ 受付前 → 開催予定。
  // ⚠️受付前を締切順の上位に混ぜない——申し込めないものが先頭に並ぶ（P34-2）
  const rankOf = (it) =>
    it.deadlineType === "date" ? (it.openFrom && it.openFrom > today ? 1 : 0) : 2;
  // 締切が無いものは開催日で並べる（P35。時期の目安しか無いものは末尾）。
  // ⚠️開催日は**今日以降の最初の日**を使う——過去の回を含む項目（勉強会の第1回が
  //   終了済み等）が先頭に来てしまう（実測で発見）
  const sortKey = (it) =>
    it.deadline ?? (it.heldDates ?? []).filter((d) => d >= today)[0] ?? "9999-99-99";
  store.items.sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      sortKey(a).localeCompare(sortKey(b)) ||
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
  // PDFの照合状態（P43）。⚠️持つのは検証子と抽出した締切だけ——本文は保存しない
  if (pdfStateDirty) savePdfState(pdfState);
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
