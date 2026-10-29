/* 集団指導 特設ページの画面。データは build.py が埋め込む #data（資料の一覧と見出し）と、
   探すときに読む kw.json（頁ごとの語の索引。文は持たない）。
   画面の切り替えは URL の # で行う: #home / #svc / #svc-<id> / #search?q=…&d=… / #sources */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const D = JSON.parse($("data").textContent);
  const DOCS = D.docs, TOC = D.toc;
  const BY = Object.fromEntries(TOC.map((d) => [d.id, d]));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const EXT = '<svg class="ext" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const pdf = (u, p) => u + (p ? "#page=" + p : "");
  const A = (u, inner, cls) => `<a${cls ? ` class="${cls}"` : ""} href="${esc(u)}" target="_blank" rel="noopener">${inner}</a>`;

  /* サービスの区分（県の資料の区分）。common＝全事業所共通編。docs＝見出しを持つ資料（toc の id） */
  const SVC = [{ id: "common", t: "全事業所共通", names: "すべての事業所", docs: ["common", "kaitei"] }]
    .concat(DOCS.services.map((s) => Object.assign({}, s, { docs: s.id === "ji" ? ["ji", "dbs"] : [s.id] })));
  const SV = Object.fromEntries(SVC.map((s) => [s.id, s]));
  /* 「探す」の絞り込みの短い呼び名 */
  const SHORT = { common: "全事業所共通編", kyotaku: "居宅訪問系", nicchu: "通所・入所系", gh: "共同生活援助", ji: "障がい児系", dbs: "こども性暴力防止法", soudan: "相談支援系", kaitei: "令和8年度報酬改定（国）" };
  const itemOf = (docId) => DOCS.items.find((i) => i.id === docId);

  /* ── 見出しの組み立て ── */
  function chapterRange(doc, i) {
    const s = doc.secs[i], nx = doc.secs[i + 1];
    const end = nx ? Math.max(s.p, nx.p - 1) : doc.pages;
    return s.p === end ? "p." + s.p : "p." + s.p + "–" + end;
  }
  function docBlock(doc, opts) {
    const it = itemOf(doc.id) || {};
    const meta = [doc.pages + "ページ", it.size].filter(Boolean).join("・");
    let h = `<div class="doc" id="doc-${doc.id}"><div class="doc-h"><h2>${esc(doc.t)}</h2><span class="meta">${esc(meta)}</span>`
      + A(pdf(doc.u), "PDFを開く" + EXT, "open") + "</div>";
    if (it.note) h += `<p class="vsub" style="margin:4px 0 0">${esc("※" + it.note)}</p>`;
    h += '<div class="chs">';
    doc.secs.forEach((s, i) => {
      const range = chapterRange(doc, i);
      if (!s.sub.length) {
        h += `<div class="ch"><div class="ch-row">${A(pdf(doc.u, s.p), esc(s.t))}<span class="n">${range}</span></div></div>`;
        return;
      }
      h += `<details class="ch"${opts && opts.open ? " open" : ""}><summary><span>${esc(s.t)}</span><span class="n">${range}</span><span class="n">${s.sub.length}項目</span></summary><ul class="subs">`
        + `<li>${A(pdf(doc.u, s.p), `<span>章のはじめ</span><span class="pg">p.${s.p}</span>`, "ch-top")}</li>`
        + s.sub.map((x) => `<li>${A(pdf(doc.u, x.p), `<span>${esc(x.t)}</span><span class="pg">p.${x.p}</span>`)}</li>`).join("")
        + "</ul></details>";
    });
    if (!doc.secs.length) h += `<div class="ch"><div class="ch-row">${A(pdf(doc.u, 1), "1ページ目から開く")}<span class="n">全${doc.pages}ページ</span></div></div>`;
    return h + "</div></div>";
  }
  function itemRow(it) {
    const ty = it.kind && it.kind !== "HTML" ? it.kind : (it.kind === "HTML" ? "ページ" : "");
    const note = [it.size, it.note].filter(Boolean).join("・");
    return `<li>${A(it.u, esc(it.t))}${ty ? `<span class="ty">${esc(ty)}</span>` : ""}${note ? `<span class="note">${esc(note)}</span>` : ""}</li>`;
  }
  function groupLabel(g) {
    const x = DOCS.groups.find((y) => y.g === g);
    return x ? x.label : g;
  }

  /* ── 各画面 ── */
  function svcCard(s) {
    const pages = s.docs.reduce((n, id) => n + (BY[id] ? BY[id].pages : 0), 0);
    const heads = s.docs.reduce((n, id) => n + (BY[id] ? BY[id].secs.reduce((m, x) => m + 1 + x.sub.length, 0) : 0), 0);
    return `<a class="svc-card" href="#svc-${s.id}"><b>${esc(s.t)}</b><span>${esc(s.names)}</span><span class="m">${pages}ページ・見出し${heads}</span></a>`;
  }
  function renderHome() {
    $("svc-home").innerHTML = SVC.map(svcCard).join("");
    const c = BY.common;
    $("common-quick").innerHTML = c.secs.map((s, i) =>
      `<li>${A(pdf(c.u, s.p), `<span class="t">${esc(s.t)}</span><span class="pg">${chapterRange(c, i)}${EXT}</span>`)}</li>`).join("");
    const links = [[DOCS.page, DOCS.pageTitle || "県の集団指導のページ"], [DOCS.schedule, "日程表"], [DOCS.register, "受講登録のフォーム"]].filter((x) => x[0]);
    $("pref-links").innerHTML = links.map((x) => `<li>${A(x[0], esc(x[1]) + EXT)}</li>`).join("")
      + `<li><a href="#sources">資料一覧（${DOCS.items.length}点）</a></li>`;
    if (DOCS.extractedAt) {
      const [y, m, d] = DOCS.extractedAt.split("-").map(Number);
      $("extracted").textContent = `資料の取得 ${y}年${m}月${d}日`;
    }
    $("year").textContent = DOCS.year || "";
    // 受講登録の期限
    const dl = DOCS.registerDeadline;
    if (dl) {
      const [y, m, d] = dl.split("-").map(Number);
      $("reg-date").textContent = `${y}.${m}.${d}`;
      const DAY = 864e5, JST = 9 * 36e5;
      const today = Math.floor((Date.now() + JST) / DAY) * DAY - JST;
      const left = Math.round((Date.parse(dl + "T00:00:00+09:00") - today) / DAY);
      $("reg-left").innerHTML = left > 0 ? `${m}月${d}日まで あと<b>${left}</b>日` : (left === 0 ? `本日（${m}月${d}日）が期限` : `${m}月${d}日で期限を過ぎました`);
      $("reg-go").href = DOCS.register;
      if (left < 0) $("reg-go").hidden = true;
    } else {
      $("dateplate").hidden = true;
    }
    $("foot-page").href = DOCS.page;
  }
  function renderSvcIndex() {
    $("svc-index").innerHTML = SVC.map(svcCard).join("");
  }
  function renderSvc(id) {
    const s = SV[id];
    let h = `<div class="svc-head"><h1 class="vh">${esc(s.t)}</h1>`;
    if (s.names !== s.t) h += `<p class="svc-names">${esc(s.names)}</p>`;
    h += `<form class="find inline" data-scope="${s.docs.join(",")}" role="search"><label class="sr" for="q-svc">${esc(s.t)}の資料の中を探す</label>`
      + '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m12.6 12.6 4.4 4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
      + `<input type="search" id="q-svc" placeholder="この資料の中を探す" autocomplete="off" enterkeyhint="search"><button type="submit">探す</button></form></div>`;
    h += s.docs.filter((d) => BY[d]).map((d) => docBlock(BY[d])).join("");
    // 説明資料と一緒に掲載された資料（同じ区分の、見出しを持たない資料）
    const extra = DOCS.items.filter((it) => it.part === "説明資料" && !it.id && it.svc.includes(id) && it.kind !== "HTML");
    if (extra.length) h += `<section class="also"><h2>説明資料と一緒に掲載された資料</h2><ul class="rows">${extra.map(itemRow).join("")}</ul></section>`;
    if (id !== "common") {
      h += `<section class="also"><h2>あわせて見る</h2><ul class="rows"><li><a href="#svc-common">全事業所共通編の説明資料</a><span class="note">指導監督の方針・行政処分の事例・虐待防止・事故・処遇改善など</span></li>`
        + `<li>${A(BY.kaitei.u, esc(BY.kaitei.t))}<span class="ty">PDF</span><span class="note">国の資料（${BY.kaitei.pages}ページ）。見出しは「全事業所共通」に載せています</span></li></ul></section>`;
    }
    // 参考資料（このサービス向けの区分。全事業所共通では「全般」などの区分）
    const refs = DOCS.items.filter((it) => it.part === "参考資料" && !it.id && (id === "common" ? it.svc.includes("*") : it.svc.includes(id)));
    if (refs.length) {
      const groups = [...new Set(refs.map((r) => r.g))];
      h += `<section class="refs"><h2>参考資料</h2>` + groups.map((g) =>
        `<h3>${esc(groupLabel(g))}</h3><ul class="rows">${refs.filter((r) => r.g === g).map(itemRow).join("")}</ul>`).join("") + "</section>";
    }
    $("svc-body").innerHTML = h;
    // サブメニュー（PCは左の列、スマホは横に流れる札）
    $("subnav").innerHTML = "<ol>" + SVC.map((x) => {
      const pages = x.docs.reduce((n, d) => n + (BY[d] ? BY[d].pages : 0), 0);
      return `<li><a href="#svc-${x.id}"${x.id === id ? ' class="is-active" aria-current="page"' : ""}><span>${esc(x.t)}</span><span class="c">${pages}p</span></a></li>`;
    }).join("") + "</ol>";
    document.title = s.t + "｜集団指導 特設ページ";
  }

  /* ── 探す（語の索引で頁を引く。文は持たないので、見出しと頁番号を出してPDFの該当頁を開く） ── */
  let KW = null, kwLoading = null;
  /* 章とその節を出てきた順に並べたもの（extract.py の index_segments と同じ並び） */
  const FLAT = Object.fromEntries(TOC.map((d) => {
    const f = [];
    d.secs.forEach((s) => { f.push({ t: s.t, sec: null }); s.sub.forEach((x) => f.push({ t: x.t, sec: s.t })); });
    return [d.id, f];
  }));
  function loadKW() {
    if (KW) return Promise.resolve(KW);
    if (!kwLoading) {
      kwLoading = fetch("kw.json", { cache: "no-cache" }).then((r) => r.json()).then((j) => {
        // 索引のキーは「資料:頁:見出しの番号」。頁を見出しの位置で区切った単位ごとに語の集合を持つ
        const segs = {};
        j.docs.forEach((id) => { segs[id] = []; });
        Object.entries(j.pages).forEach(([k, v]) => {
          const [di, p, h] = k.split(":").map(Number);
          segs[j.docs[di]].push({ p, h, w: "|" + v + "|" });
        });
        Object.values(segs).forEach((a) => a.sort((x, y) => x.p - y.p || x.h - y.h));
        KW = segs;
        return KW;
      }).catch((e) => { kwLoading = null; throw e; });
    }
    return kwLoading;
  }
  const RUN = /[一-龥々〆ヵヶ]+|[ァ-ヴー]+|[A-Za-z0-9]+/g;   // extract.py の WORD と同じ区切り
  const JOIN = /[A-Za-z0-9]+[一-龥々〆ヵヶ]/g;               // extract.py の JOIN と同じ
  function terms(q) {
    q = (q || "").normalize("NFKC").trim();
    // ひらがなだけの語はカタカナに直して探す（例: ひやりはっと → ヒヤリハット）
    const parts = q.split(/\s+/).filter(Boolean).map((w) => /^[ぁ-ゖー]+$/.test(w) ? w.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)) : w);
    const out = [];
    const add = (r) => { if (!out.includes(r)) out.push(r); };
    parts.forEach((w) => {
      // 「A型」「33条」のような英数字＋漢字1字は、つながりのまま探す（extract.py の JOIN）。残りは連なりごとに
      (w.match(JOIN) || []).forEach(add);
      (w.replace(JOIN, " ").match(RUN) || []).forEach(add);
    });
    return out;
  }
  function mark(text, ts) {
    let h = esc(text);
    ts.forEach((t) => { h = h.split(esc(t)).join("<mark>" + esc(t) + "</mark>"); });
    return h;
  }
  let scope = "";   // 絞り込む資料（toc の id を「,」で）。空ならすべて
  function renderScope() {
    const opts = [["", "すべて"]].concat(TOC.map((d) => [d.id, SHORT[d.id] || d.t]));
    const custom = scope && !opts.some((o) => o[0] === scope);
    if (custom) opts.splice(1, 0, [scope, scope.split(",").map((x) => SHORT[x] || x).join("＋")]);
    $("scope").innerHTML = opts.map(([v, t]) => `<button type="button" data-v="${v}" aria-pressed="${v === scope}">${esc(t)}</button>`).join("");
  }
  async function runSearch(q) {
    const ts = terms(q);
    $("q-main").value = q || "";
    renderScope();
    if (!ts.length) {
      $("s-sum").textContent = q ? "漢字・カタカナ・英数字を含む語で探してください" : "";
      $("s-res").innerHTML = "";
      return;
    }
    $("s-sum").textContent = "索引を読み込んでいます…";
    let kw;
    try { kw = await loadKW(); } catch (e) { $("s-sum").textContent = "索引を読み込めませんでした。時間をおいて開き直してください"; return; }
    const want = scope ? scope.split(",") : TOC.map((d) => d.id);
    let total = 0, ndoc = 0, h = "";
    TOC.filter((d) => want.includes(d.id)).forEach((doc) => {
      const hits = (kw[doc.id] || []).filter((sg) => ts.every((t) => sg.w.includes(t)));
      if (!hits.length) return;
      const pagesHit = new Set(hits.map((x) => x.p)).size;
      total += pagesHit; ndoc++;
      const rows = hits.map((sg) => {
        const f = FLAT[doc.id][sg.h];
        const head = f ? f.t : (doc.secs.length ? "表紙・目次" : "");
        return `<li>${A(pdf(doc.u, sg.p), `<span class="p">p.${sg.p}</span><span class="h">${mark(head, ts)}</span>${f && f.sec ? `<span class="c">${esc(f.sec)}</span>` : ""}`)}</li>`;
      });
      const LIM = 30;
      h += `<section class="s-doc"><h2>${esc(doc.t)}<small>${pagesHit}ページ</small></h2><ul class="hits">${rows.slice(0, LIM).join("")}</ul>`
        + (rows.length > LIM ? `<ul class="hits" hidden>${rows.slice(LIM).join("")}</ul><button type="button" class="more">残り${rows.length - LIM}件を表示</button>` : "")
        + "</section>";
    });
    const tl = ts.map((t) => "「" + t + "」").join("");
    const long = ts.some((t) => t.length >= 4 && /^[一-龥々〆ヵヶ]+$/.test(t));
    $("s-sum").innerHTML = total ? `${esc(tl)}を含むページ <b>${total}</b>（${ndoc}編）`
      : `${esc(tl)}を含むページは見つかりませんでした` + (long ? "。語を空白で区切ると見つかることがあります（例：虐待防止 委員会）" : "");
    $("s-res").innerHTML = h;
  }
  $("s-res").addEventListener("click", (e) => {
    const b = e.target.closest(".more");
    if (!b) return;
    b.previousElementSibling.hidden = false;
    b.remove();
  });
  $("scope").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    scope = b.dataset.v;
    go("#search?" + qs($("q-main").value, scope), true);
  });
  const qs = (q, s) => new URLSearchParams(Object.assign({ q: q || "" }, s ? { d: s } : {})).toString();
  document.addEventListener("submit", (e) => {
    const f = e.target.closest(".find");
    if (!f) return;
    e.preventDefault();
    const q = f.querySelector("input").value;
    if (f.dataset.scope !== undefined) scope = f.dataset.scope;
    else if (f.id === "find-home") scope = "";
    go("#search?" + qs(q, scope));
  });

  /* ── 画面の切り替え ── */
  function go(hash, replace) {
    if (replace) { history.replaceState(null, "", hash); route(); }
    else location.hash = hash;
  }
  function route() {
    const raw = location.hash.slice(1) || "home";
    const [name, query] = raw.split("?");
    let view = "home", g = "home";
    if (name === "svc") { view = "svc"; g = "svc"; renderSvcIndex(); document.title = "サービス別｜集団指導 特設ページ"; }
    else if (name.startsWith("svc-") && SV[name.slice(4)]) { view = "svcview"; g = "svc"; renderSvc(name.slice(4)); }
    else if (name === "search") {
      view = "search"; g = "search";
      const p = new URLSearchParams(query || "");
      scope = p.get("d") || "";
      runSearch(p.get("q") || "");
      document.title = "資料の中を探す｜集団指導 特設ページ";
    } else if (name === "sources") { view = "sources"; g = "sources"; document.title = "資料一覧｜集団指導 特設ページ"; }
    else document.title = "令和8年度 福岡県 集団指導 特設ページ";
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === view));
    document.querySelectorAll("[data-g]").forEach((a) => {
      if (a.tagName !== "A") return;
      const on = a.dataset.g === g;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const shell = $("shell");
    shell.classList.toggle("no-sub", view !== "svcview");
    shell.classList.toggle("is-home", view === "home");
    window.scrollTo(0, 0);
    if (view === "search" && !$("q-main").value && matchMedia("(hover: hover)").matches) $("q-main").focus();
  }
  window.addEventListener("hashchange", route);
  renderHome();
  route();

  /* 資料一覧の絞り込み（scripts/linkbook.py の部品） */
  const lq = $("lk-q");
  if (lq) lq.addEventListener("input", () => {
    const ws = lq.value.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
    let n = 0;
    document.querySelectorAll("#lk .lk-g").forEach((g) => {
      let shown = 0;
      g.querySelectorAll(".lk-i").forEach((li) => {
        const t = (li.dataset.q || "").normalize("NFKC").toLowerCase();
        const ok = ws.every((w) => t.includes(w));
        li.hidden = !ok;
        if (ok) shown++;
      });
      g.hidden = !shown;
      n += shown;
    });
    document.querySelector("#lk .lk-none").hidden = n > 0;
  });
})();
