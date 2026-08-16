#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 要約＋重要度判定（P2）
 *
 * data/diff-latest.json の新規項目に、Gemini で日本語要約と重要度判定を付けて
 * data/report-latest.json に出力する（P3のメール本文の材料になる）。
 *
 * - 依存ゼロ: 組み込み fetch で Gemini REST API を叩く
 * - モデル名は固定で書かない: 一覧取得 → 安定版flash系を新しい順に試行 →
 *   成功したモデルを state.json に記録し、次回はそれを最初に試す
 *   （実例: gemini-2.5-flash が世代交代で404になった）
 * - API呼び出しは全項目まとめて1リクエスト（無料枠の節約）
 * - 新規0件のときはAPIを呼ばず、空のreportを書いて正常終了
 * - APIエラー時は空の要約で正常終了せず、失敗として終了する
 *
 * 使い方: node scripts/summarize.js
 * 必要な環境変数: GEMINI_API_KEY（.env またはシェル環境。値は絶対にコミットしない）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIFF_PATH = join(ROOT, "data", "diff-latest.json");
const REPORT_PATH = join(ROOT, "data", "report-latest.json");
const STATE_PATH = join(ROOT, "data", "state.json");
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ---------------------------------------------------------------------------
// 環境変数（.env があれば読む。GitHub Actions では Secrets から環境変数で渡る）
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY がありません。.env（GEMINI_API_KEY=値）を用意してください"
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// モデル選定（固定名を書かない）
// ---------------------------------------------------------------------------

/**
 * 利用可能モデルの一覧から、テキスト生成向けの安定版 flash 系だけを
 * 新しい順に返す。preview・tts・image・robotics 等は名前の形で除外される
 * （gemini-<版>-flash / gemini-<版>-flash-lite だけを通す）。
 */
async function listCandidateModels(apiKey) {
  const res = await fetch(`${API_BASE}/models?pageSize=100`, {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`モデル一覧の取得に失敗: HTTP ${res.status}`);
  const { models = [] } = await res.json();
  const candidates = [];
  for (const m of models) {
    if (!(m.supportedGenerationMethods || []).includes("generateContent")) continue;
    const name = m.name.replace(/^models\//, "");
    const match = name.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/);
    if (!match) continue;
    candidates.push({
      name,
      version: parseFloat(match[1]),
      lite: Boolean(match[2]),
    });
  }
  // 新しい版が先。同版なら flash が flash-lite より先
  candidates.sort((a, b) => b.version - a.version || a.lite - b.lite);
  if (candidates.length === 0) {
    throw new Error("安定版 flash 系のモデルが一覧に見つかりません");
  }
  return candidates.map((c) => c.name);
}

/** 前回成功したモデルを最初に試す並びにする */
function preferModel(candidates, preferred) {
  if (!preferred || !candidates.includes(preferred)) return candidates;
  return [preferred, ...candidates.filter((c) => c !== preferred)];
}

// ---------------------------------------------------------------------------
// プロンプトと応答の処理
// ---------------------------------------------------------------------------

function buildPrompt(items) {
  const list = items.map((it, i) => ({
    index: i,
    title: it.title,
    category: it.category,
    date: it.date,
  }));
  return `あなたは社会福祉法人（障害福祉・児童発達支援・保育を運営）の情報担当者です。
行政サイトの新着情報の一覧（タイトル・カテゴリ・日付のみ。本文はありません）から、
各項目について次を判定してください。

1. summary: その項目が何の情報かの日本語の説明（1〜2文。タイトルの繰り返しでなく、
   法人にとって何の話かが分かる補足を含める）
2. importance: 実務上の重要度を3段階で判定
   - 「高」= 法人に対応・確認の行動が必要になりうる
     （報酬改定・基準/法令改正・義務化・監査/指導方針・加算/補助金と申請期限・
      虐待防止/安全/感染症の通知・パブコメ募集）
   - 「中」= 行動は不要だが先々に効くので把握しておくべき
     （審議会/検討会・調査/統計・ガイドライン案・こども施策の方針文書）
   - 「低」= 実務への影響が薄い（人事異動・調達情報・採用・行事/イベント・広報）
   - 迷ったら「中」に倒す
3. reason: 判定理由（1行）

入力（${items.length}件）:
${JSON.stringify(list, null, 1)}

出力の規則:
- JSONの配列のみを出力する。前置き・後書き・コードフェンスは一切禁止
- 必ず入力と同じ${items.length}件を、index を含めて返す
- 形式: [{"index":0,"summary":"…","importance":"高|中|低","reason":"…"}, …]`;
}

/** 応答テキストから JSON を安全に取り出す（```json フェンスが付く前提で除去） */
function parseResponse(text, expectedCount) {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  let arr;
  try {
    arr = JSON.parse(stripped);
  } catch {
    throw new Error(`応答をJSONとして解釈できません: ${stripped.slice(0, 200)}`);
  }
  if (!Array.isArray(arr)) throw new Error("応答が配列ではありません");
  // ★ Gemini が項目数を勝手に減らして返すことがある。件数一致を必ず検証する
  if (arr.length !== expectedCount) {
    throw new Error(
      `入力${expectedCount}件に対し応答が${arr.length}件です。件数不一致のため失敗扱いにします`
    );
  }
  for (const it of arr) {
    if (!["高", "中", "低"].includes(it.importance)) {
      throw new Error(`不正な importance: ${JSON.stringify(it.importance)}`);
    }
    if (typeof it.summary !== "string" || !it.summary.trim()) {
      throw new Error(`summary が空の項目があります (index=${it.index})`);
    }
  }
  return arr;
}

async function generate(apiKey, model, prompt) {
  const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json", // JSON強制（フェンス除去は受け側でも行う）
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  if (!text) throw new Error("応答にテキストがありません");
  return text;
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main() {
  const diff = JSON.parse(readFileSync(DIFF_PATH, "utf8"));
  const items = diff.newItems ?? [];

  // 新規0件: APIを呼ばずに空のreportを書いて正常終了
  if (items.length === 0) {
    writeFileSync(
      REPORT_PATH,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), model: null, items: [] },
        null,
        2
      ) + "\n"
    );
    console.log("新規0件のためAPIは呼び出さず、空のレポートを書きました");
    return;
  }

  const apiKey = loadEnv();
  const state = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
    : {};
  const models = preferModel(
    await listCandidateModels(apiKey),
    state.preferredModel
  );
  console.log(`モデル候補（試行順）: ${models.join(", ")}`);

  const prompt = buildPrompt(items);
  let judged, usedModel;
  const errors = [];
  for (const model of models) {
    try {
      console.log(`試行: ${model}`);
      const text = await generate(apiKey, model, prompt);
      judged = parseResponse(text, items.length);
      usedModel = model;
      break;
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
      console.log(`  失敗（次の候補へ）: ${e.message.slice(0, 120)}`);
    }
  }
  // ★ 全滅なら失敗として終了する（空の要約で正常終了しない）
  if (!judged) {
    throw new Error(`全モデルで失敗しました:\n${errors.join("\n")}`);
  }

  const byIndex = new Map(judged.map((j) => [j.index, j]));
  const report = {
    generatedAt: new Date().toISOString(),
    model: usedModel,
    items: items.map((it, i) => {
      const j = byIndex.get(i);
      if (!j) throw new Error(`応答に index=${i} がありません`);
      return {
        hash: it.hash,
        source: it.source,
        title: it.title,
        url: it.url, // 原本URLを必ず残す（鉄則5）
        date: it.date,
        category: it.category,
        summary: j.summary.trim(),
        importance: j.importance,
        reason: (j.reason ?? "").trim(),
      };
    }),
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");

  // 成功したモデルを記録し、次回はそれを最初に試す
  if (state.preferredModel !== usedModel) {
    state.preferredModel = usedModel;
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  }

  console.log(
    `完了: ${report.items.length}件を ${usedModel} で判定 → data/report-latest.json`
  );
}

main().catch((e) => {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
});
