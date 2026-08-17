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

export function loadEnv() {
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
export async function listCandidateModels(apiKey) {
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
export function preferModel(candidates, preferred) {
  if (!preferred || !candidates.includes(preferred)) return candidates;
  return [preferred, ...candidates.filter((c) => c !== preferred)];
}

// ---------------------------------------------------------------------------
// プロンプトと応答の処理
// ---------------------------------------------------------------------------

const FIELD_VOCAB = ["保育", "障害", "高齢", "児童", "共通"];
const FOUR_FIELDS = ["保育", "児童", "障害", "高齢"];

/**
 * 分野タグの正規化（P15）。
 * 4分野すべてに該当する判定は「共通」と論理的に同義なので、機械的に ["共通"] へ寄せる。
 * プロンプトの改善でなく出力の後処理で行う理由: AIに毎回同じ選択をさせるより、
 * 出力を機械で整える方が揺らがない（モデル差・世代交代にも強い）。
 */
export function normalizeFields(fields) {
  const set = new Set(Array.isArray(fields) ? fields : []);
  if (FOUR_FIELDS.every((f) => set.has(f))) return ["共通"];
  if (set.has("共通") && set.size > 1) return ["共通"]; // 共通＋個別の混在も冗長なので寄せる
  return [...set];
}

export function buildPrompt(items) {
  const list = items.map((it, i) => ({
    index: i,
    title: it.title,
    category: it.category,
    date: it.date,
  }));
  return `あなたは福祉事業（保育・障害福祉・高齢者福祉・児童福祉）の情報担当者です。
行政サイトの新着情報の一覧（タイトル・カテゴリ・日付のみ。本文はありません）から、
各項目について次を判定してください。

1. summary: その項目が何の情報かの日本語の説明（1〜2文。タイトルの繰り返しでなく、
   福祉事業者にとって何の話かが分かる補足を含める）
2. importance: 福祉事業者一般にとっての実務上の重要度を3段階で判定（分野は問わない）
   - 「高」= 事業者に対応・確認の行動が必要になりうる
     （報酬改定・基準/法令改正・義務化・監査/指導方針・加算/補助金と申請期限・
      虐待防止/安全/感染症の通知・パブコメ募集）
   - 「中」= 行動は不要だが先々に効くので把握しておくべき
     （審議会/検討会・調査/統計・ガイドライン案・福祉施策の方針文書）
   - 「低」= 実務への影響が薄い（人事異動・調達情報・採用・行事/イベント・広報・
      福祉と関係のない行政情報）
   - 迷ったら「中」に倒す
3. fields: その情報が効く分野のタグ。次の5値のみ使用し、配列で返す（複数可）
   - 「保育」「障害」「高齢」「児童」= 特定分野に効くもの。2分野以上に効くなら列挙する
     （例: 児童発達支援の話題→["障害","児童"]、母子保健→["児童"]、介護報酬→["高齢"]）
   - 「共通」= 分野を問わず福祉事業の運営に効くもの
     （虐待防止・処遇改善・感染症対策・災害対応・BCP・福祉現場の労務など）
   - 空配列 [] = 福祉事業の運営に関係がないものだけ
     （薬事・年金・一般労働政策・省庁の人事・調達・採用など）
   - ⚠️迷ったら空配列でなく「共通」に倒す（分野で絞ったとき重要情報が消える事故を防ぐ）
   - ⚠️4分野すべてに該当する場合は列挙せず ["共通"] とする（同義なので表記を一つに揃える）
4. reason: 判定理由（1行）

入力（${items.length}件）:
${JSON.stringify(list, null, 1)}

出力の規則:
- JSONの配列のみを出力する。前置き・後書き・コードフェンスは一切禁止
- 必ず入力と同じ${items.length}件を、index を含めて返す
- 形式: [{"index":0,"summary":"…","importance":"高|中|低","fields":["障害"],"reason":"…"}, …]`;
}

/** 応答テキストから JSON を安全に取り出す（```json フェンスが付く前提で除去） */
export function parseResponse(text, expectedCount) {
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
    // ★ fields の語彙検証（5値のみ・配列必須。空配列=福祉と無関係、は許可）
    if (!Array.isArray(it.fields)) {
      throw new Error(`fields が配列ではありません (index=${it.index})`);
    }
    for (const f of it.fields) {
      if (!FIELD_VOCAB.includes(f)) {
        throw new Error(`不正な分野タグ: ${JSON.stringify(f)} (index=${it.index})`);
      }
    }
  }
  return arr;
}

export async function generate(apiKey, model, prompt) {
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
  const press = diff.newPress ?? []; // 報道(P9): 要約・重要度判定はせず分野タグのみ付ける

  // 新規0件(行政・報道とも): APIを呼ばずに空のreportを書いて正常終了
  if (items.length === 0 && press.length === 0) {
    writeFileSync(
      REPORT_PATH,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), model: null, items: [], press: [] },
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

  // ★ 出力が長くなるほど件数抜け・JSON崩れが起きやすいため、25件を超えたら分割する
  const BATCH = 25;
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH) {
    batches.push(items.slice(i, i + BATCH));
  }
  if (batches.length > 1) {
    console.log(`${items.length}件を${batches.length}リクエストに分割して判定します`);
  }

  let usedModel = null;
  const judgedAll = [];
  for (const batch of batches) {
    const prompt = buildPrompt(batch);
    let judged;
    const errors = [];
    // 直前のバッチで成功したモデルを最初に試す
    const order = usedModel ? preferModel(models, usedModel) : models;
    for (const model of order) {
      try {
        console.log(`試行: ${model}（${batch.length}件）`);
        const text = await generate(apiKey, model, prompt);
        judged = parseResponse(text, batch.length);
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
    batch.forEach((it, i) => {
      const j = byIndex.get(i);
      if (!j) throw new Error(`応答に index=${i} がありません`);
      judgedAll.push({
        hash: it.hash,
        source: it.source,
        title: it.title,
        url: it.url, // 原本URLを必ず残す（鉄則5）
        date: it.date,
        category: it.category,
        summary: j.summary.trim(),
        importance: j.importance,
        fields: normalizeFields(j.fields), // 分野タグ（4分野すべて→共通へ正規化・P15）
        reason: (j.reason ?? "").trim(),
      });
    });
  }

  // ==== AIの働きかけ(a): 「高」の項目だけに対応の翻訳を生成(P8) ====
  // 本体の判定プロンプトには手を入れず、別の小さな第2リクエストで行う
  // (件数不一致リスクの高い本体を太らせない)。失敗しても action 無しで続行する
  // (働きかけは付加物であり、メール・履歴の本体を止めない)。
  const high = judgedAll.filter((it) => it.importance === "高");
  if (high.length > 0) {
    try {
      const actPrompt = `福祉事業者向けの情報サイトの編集者として、次の行政情報それぞれについて、
「この種の通知では一般にどんな対応が必要になるか」を1〜2文の日本語で書いてください。

規則:
- 「一般に、こうした通知では〜の確認（〜の対応）が必要になります」という距離感で書く
- 命令形・「あなた」「〜すべき」は使わない。特定の事業所への指示にしない
- 本文は読めていない前提。タイトルと要約から言える範囲を超えない
- JSONの配列のみを出力（コードフェンス禁止）。必ず${high.length}件、indexを含める
- 形式: [{"index":0,"action":"…"}, …]

入力（${high.length}件）:
${JSON.stringify(high.map((it, i) => ({ index: i, title: it.title, summary: it.summary })), null, 1)}`;
      const order = preferModel(models, usedModel);
      let acts = null;
      for (const model of order) {
        try {
          console.log(`対応の目安を生成: ${model}（高${high.length}件）`);
          const text = await generate(apiKey, model, actPrompt);
          const stripped = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
          const arr = JSON.parse(stripped);
          if (!Array.isArray(arr) || arr.length !== high.length) {
            throw new Error(`件数不一致(期待${high.length}/実際${Array.isArray(arr) ? arr.length : "非配列"})`);
          }
          for (const a of arr) {
            if (typeof a.action !== "string" || !a.action.trim()) {
              throw new Error(`actionが空(index=${a.index})`);
            }
          }
          acts = arr;
          break;
        } catch (e) {
          console.log(`  失敗（次の候補へ）: ${e.message.slice(0, 100)}`);
        }
      }
      if (acts) {
        acts.forEach((a) => { if (high[a.index]) high[a.index].action = a.action.trim(); });
        console.log(`対応の目安: ${acts.length}件を付与`);
      } else {
        console.log("対応の目安: 全モデルで失敗したため付与せず続行");
      }
    } catch (e) {
      console.log(`対応の目安: 生成をスキップ(${e.message.slice(0, 80)})`);
    }
  }

  // ==== 報道(P9): 分野タグのみ付与。要約・重要度判定はしない(確定方針) ====
  // 出力は index と fields だけを返させ、見出しの複製すら出力に含めない。
  // 失敗しても fields 空で続行する(報道は付加セクションであり本体を止めない)。
  let pressOut = [];
  if (press.length > 0) {
    let fieldsByIdx = null;
    const pressPrompt = `次のニュース見出しの一覧について、それぞれが関わる福祉の分野タグだけを判定してください。
要約・言い換え・解釈は出力しない。

分野タグ: 「保育」「児童」「障害」「高齢」= 特定分野(複数可)／「共通」= 分野を問わず
福祉事業の運営に効くもの(処遇改善・虐待防止・感染症・災害等)／空配列 = 福祉と無関係。
迷ったら空でなく「共通」に倒す。

入力（${press.length}件）:
${JSON.stringify(press.map((it, i) => ({ index: i, title: it.title, category: it.category })), null, 1)}

出力の規則:
- JSONの配列のみ。前置き・コードフェンス禁止。タイトル等の文字列は出力に含めない
- 必ず${press.length}件、indexを含める
- 形式: [{"index":0,"fields":["高齢"]}, …]`;
    const order = usedModel ? preferModel(models, usedModel) : models;
    for (const model of order) {
      try {
        console.log(`報道の分野タグ: ${model}（${press.length}件）`);
        const text = await generate(apiKey, model, pressPrompt);
        const stripped = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        const arr = JSON.parse(stripped);
        if (!Array.isArray(arr) || arr.length !== press.length) {
          throw new Error(`件数不一致(期待${press.length})`);
        }
        for (const a of arr) {
          if (!Array.isArray(a.fields)) throw new Error(`fieldsが配列でない(index=${a.index})`);
          for (const f of a.fields) {
            if (!FIELD_VOCAB.includes(f)) throw new Error(`不正な分野タグ: ${f}`);
          }
        }
        fieldsByIdx = new Map(arr.map((a) => [a.index, a.fields]));
        usedModel = model;
        break;
      } catch (e) {
        console.log(`  失敗（次の候補へ）: ${e.message.slice(0, 100)}`);
      }
    }
    if (!fieldsByIdx) console.log("報道の分野タグ: 全モデルで失敗したため空で続行");
    pressOut = press.map((it, i) => ({
      hash: it.hash,
      source: it.source,
      kind: "press",
      title: it.title,
      url: it.url, // 原本(元記事)への直リンク
      date: it.date,
      category: it.category,
      fields: normalizeFields(fieldsByIdx?.get(i) ?? []),
    }));
    console.log(`報道: ${pressOut.length}件（タグのみ・要約なし）`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    model: usedModel,
    items: judgedAll,
    press: pressOut,
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

/* 直接実行されたときだけ main を走らせる（他スクリプトから関数を再利用するため） */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  main().catch((e) => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  });
}
