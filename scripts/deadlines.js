#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 締切ウォッチ（P11）
 *
 * 当日の新着（高・中のみ）について原本ページの本文を取得し、
 * 「期日までに行動が必要な日付」（提出期限・申込締切・回答期限・適用開始など）を抽出して
 * data/deadlines.json に保存する。
 *
 * - 本文は抽出後に破棄する。保存するのは 期限日・種類・根拠文字列・元項目のhash のみ
 *   （★スナップショット最小化方針）
 * - 幻覚ガード（三重の機械検証）:
 *   ①根拠文字列(quote)が取得本文に完全一致で含まれる
 *   ②quoteから自前パーサで日付を再抽出しAIのdateと一致する
 *   ③過去日・2年超先は不採用
 * - 1項目の失敗（404・タイムアウト・抽出失敗）は記録して続行（失敗隔離の既存方針）
 * - 判定本体(summarize.js)には一切触れない。本スクリプトは自己完結
 * - アクセス間隔1.5秒・UA明示（行政サイトへのマナー）
 *
 * 使い方: node scripts/deadlines.js（notify・archive の後に実行する）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "data", "report-latest.json");
const STATE_PATH = join(ROOT, "data", "state.json");
const DEADLINES_PATH = join(ROOT, "data", "deadlines.json");
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const USER_AGENT =
  "fukushi-watch/0.1 (+https://github.com/kanda-houtokukai/fukushi-watch)";
const FETCH_INTERVAL_MS = 1500; // 行政サイトへのアクセス間隔
const BODY_MAX_CHARS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());

function loadEnvKey() {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY がありません");
  return process.env.GEMINI_API_KEY;
}

/* ---- Gemini（summarize.js と同型の自己完結版。判定本体には触れない） ---- */

async function listCandidateModels(apiKey) {
  const res = await fetch(`${API_BASE}/models?pageSize=100`, {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`モデル一覧の取得に失敗: HTTP ${res.status}`);
  const { models = [] } = await res.json();
  const c = [];
  for (const m of models) {
    if (!(m.supportedGenerationMethods || []).includes("generateContent")) continue;
    const name = m.name.replace(/^models\//, "");
    const mm = name.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/);
    if (mm) c.push({ name, v: parseFloat(mm[1]), lite: Boolean(mm[2]) });
  }
  c.sort((a, b) => b.v - a.v || a.lite - b.lite);
  if (!c.length) throw new Error("安定版flash系モデルが見つかりません");
  return c.map((x) => x.name);
}

async function generate(apiKey, model, prompt) {
  const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) throw new Error("応答にテキストがありません");
  return text;
}

/* ---- 本文取得とテキスト化（本文は保存しない） ---- */

async function fetchBodyText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .normalize("NFKC")
      .trim();
    return text.slice(0, BODY_MAX_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

/* ---- 幻覚ガード: quoteからの日付の機械再抽出 ---- */

/** quote内の日付表現をすべて {y?,m,d} で返す（令和N年M月D日 / YYYY年M月D日 / M月D日） */
export function extractDatesFromText(s) {
  const t = String(s).normalize("NFKC");
  const out = [];
  for (const m of t.matchAll(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/g)) {
    out.push({ y: Number(m[1]) + 2018, m: Number(m[2]), d: Number(m[3]) });
  }
  for (const m of t.matchAll(/(\d{4})\s*年\s*(\d+)\s*月\s*(\d+)\s*日/g)) {
    out.push({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
  }
  for (const m of t.matchAll(/(?<![年\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    out.push({ y: null, m: Number(m[1]), d: Number(m[2]) });
  }
  return out;
}

/** AIのdate(YYYY-MM-DD)がquote内の日付表現と一致するか */
export function dateMatchesQuote(date, quote) {
  const [y, mo, d] = date.split("-").map(Number);
  return extractDatesFromText(quote).some(
    (q) => q.m === mo && q.d === d && (q.y === null || q.y === y)
  );
}

function withinRange(date, today) {
  const t = new Date(today + "T00:00:00Z").getTime();
  const v = new Date(date + "T00:00:00Z").getTime();
  return v >= t && v <= t + 730 * 86400000; // 今日〜2年先
}

/* ---- メイン ---- */

async function main() {
  const today = jstToday();
  const store = existsSync(DEADLINES_PATH)
    ? JSON.parse(readFileSync(DEADLINES_PATH, "utf8"))
    : { items: [] };

  // 期限切れは表示からも保存からも消す（最小化方針）
  const before = store.items.length;
  store.items = store.items.filter((it) => it.deadline >= today);
  const pruned = before - store.items.length;

  const report = existsSync(REPORT_PATH)
    ? JSON.parse(readFileSync(REPORT_PATH, "utf8"))
    : { items: [] };
  // 項目の「検知日」= レポートの日付(JST)。紙面ジャンプ先として保存する
  const reportDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" })
    .format(new Date(report.generatedAt ?? Date.now()));
  // 対象は高・中のみ（[DECISION] 締切を持つ層をカバーしつつ負荷を抑える）
  const targets = (report.items ?? []).filter(
    (it) => it.importance === "高" || it.importance === "中"
  );

  if (targets.length === 0) {
    writeFileSync(
      DEADLINES_PATH,
      JSON.stringify({ updatedAt: new Date().toISOString(), items: store.items }, null, 1) + "\n"
    );
    console.log(`対象0件。期限切れ${pruned}件を整理して終了`);
    return;
  }

  const apiKey = loadEnvKey();
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
  let models = await listCandidateModels(apiKey);
  if (state.preferredModel && models.includes(state.preferredModel)) {
    models = [state.preferredModel, ...models.filter((m) => m !== state.preferredModel)];
  }

  console.log(`締切抽出の対象: ${targets.length}件（高・中）`);
  let found = 0, failed = 0;
  const t0 = Date.now();

  for (const [idx, it] of targets.entries()) {
    try {
      if (idx > 0) await sleep(FETCH_INTERVAL_MS);
      const body = await fetchBodyText(it.url);
      if (body.length < 100) throw new Error("本文が短すぎます(取得失敗の疑い)");

      const prompt = `次の行政ページ本文から、読者（福祉事業者）が「期日までに行動する必要がある日付」だけを抽出してください。
対象: 提出期限・申込締切・回答期限・意見募集の締切・様式や制度の適用開始日など。
対象外: 単なる開催日・発表日・過去の日付。

出力規則:
- JSONのみ。形式: {"deadlines":[{"date":"YYYY-MM-DD","label":"申込期限","quote":"本文中の根拠文字列"}]}
- quote は本文から**一字一句そのまま**コピーした30〜80字（日付表現を必ず含める）
- 和暦（令和N年）は西暦に変換してdateに入れる（令和N年=N+2018年）
- 該当がなければ {"deadlines":[]}

タイトル: ${it.title}
本文: ${body}`;

      let deadlines = null;
      for (const model of models) {
        try {
          const text = await generate(apiKey, model, prompt);
          const arr = JSON.parse(
            text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
          ).deadlines;
          if (!Array.isArray(arr)) throw new Error("deadlinesが配列でない");
          deadlines = arr;
          break;
        } catch (e) {
          if (model === models[models.length - 1]) throw e;
        }
      }

      for (const dl of deadlines) {
        if (typeof dl.date !== "string" || typeof dl.quote !== "string") continue;
        // 幻覚ガード①: 根拠文字列が本文に実在する
        if (!body.includes(dl.quote.normalize("NFKC").trim())) {
          console.log(`  却下(quote不一致): ${it.title.slice(0, 24)} → ${dl.date}`);
          continue;
        }
        // ②: quoteから日付を機械再抽出して一致
        if (!dateMatchesQuote(dl.date, dl.quote)) {
          console.log(`  却下(日付不一致): ${dl.date} ⇔ ${dl.quote.slice(0, 30)}`);
          continue;
        }
        // ③: 今日〜2年先の範囲
        if (!withinRange(dl.date, today)) {
          console.log(`  却下(範囲外): ${dl.date}`);
          continue;
        }
        // 併合（同一項目・同一期限は上書き）
        store.items = store.items.filter(
          (x) => !(x.hash === it.hash && x.deadline === dl.date)
        );
        store.items.push({
          hash: it.hash,
          day: reportDay,
          source: it.source,
          title: it.title,
          url: it.url,
          deadline: dl.date,
          label: String(dl.label ?? "期限").slice(0, 20),
          quote: dl.quote.trim().slice(0, 120),
        });
        found++;
        console.log(`  採用: ${dl.date}（${dl.label}） ← ${it.title.slice(0, 30)}`);
      }
    } catch (e) {
      failed++;
      console.log(`  失敗（続行）: ${it.title.slice(0, 30)}: ${e.message.slice(0, 80)}`);
    }
  }

  store.items.sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
  writeFileSync(
    DEADLINES_PATH,
    JSON.stringify({ updatedAt: new Date().toISOString(), items: store.items }, null, 1) + "\n"
  );
  console.log(
    `完了: 採用${found}件・失敗${failed}件・期限切れ整理${pruned}件・保持${store.items.length}件` +
      `（所要${Math.round((Date.now() - t0) / 1000)}秒）`
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  main().catch((e) => {
    // 締切ウォッチは付加機能: 失敗してもパイプライン全体は止めない(exit 0)が、ログには残す
    console.error(`締切抽出でエラー(続行): ${e.message}`);
  });
}
