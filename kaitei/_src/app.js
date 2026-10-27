(function () {
  "use strict";
  var C = {}, LIVE = {};
  try { C = JSON.parse(document.getElementById("content-data").textContent) || {}; } catch (e) { C = {}; }
  try { LIVE = JSON.parse(document.getElementById("live-data").textContent) || {}; } catch (e) { LIVE = {}; }
  function $(id) { return document.getElementById(id); }
  var main = document.getElementById("main");
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* ── 日付（日本時間） ─────────────── */
  var DAY = 86400000, JST = 9 * 3600000, NOW = Date.now();
  var TODAY = Math.floor((NOW + JST) / DAY) * DAY - JST;
  var WD = "日月火水木金土";
  function dayOf(s) { return Date.parse(String(s).slice(0, 10) + "T00:00:00+09:00"); }
  function parts(ms) { var d = new Date(ms + JST); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: WD[d.getUTCDay()], hh: d.getUTCHours(), mi: d.getUTCMinutes() }; }
  function ymd(ms) { var p = parts(ms); return p.y + "年" + p.m + "月" + p.d + "日"; }
  function hm(ms) { var p = parts(ms); return p.hh + ":" + (p.mi < 10 ? "0" : "") + p.mi; }
  function dot(s) { var p = parts(dayOf(s)); return p.y + "." + (p.m < 10 ? "0" : "") + p.m + "." + (p.d < 10 ? "0" : "") + p.d; }
  function mdw(s) { var p = parts(dayOf(s)); return p.m + "/" + p.d + "（" + p.w + "）"; }
  var TEKIYO = dayOf(C.tekiyo || "2027-04-01"), KAISHI = dayOf(C.kaishi || "2026-04-28");

  /* ── 段階・方向・種類 ─────────────── */
  var STAGES = C.stages || [];
  var CUR = LIVE.currentStage || C.currentStage || 1;
  function stageOf(k) { return STAGES.filter(function (s) { return s.k === k; })[0] || { k: k, name: "" }; }
  function stg(k, label) {
    var s = stageOf(k), sq = "";
    for (var i = 1; i <= 5; i++) sq += '<span class="' + (i <= k ? "on" : "") + '"></span>';
    return '<span class="stg s' + k + '" title="確度 ' + k + '/5"><i aria-hidden="true">' + sq + "</i>" + esc(label || s.name) + "</span>";
  }
  var DIR = {
    "拡充": ["up", "評価の拡充"], "新設": ["up", "新設"],
    "適正化": ["down", "適正化"], "廃止・縮小": ["down", "廃止・縮小"],
    "見直し": ["flat", "見直し"], "継続検討": ["flat", "方向は今後"]
  };
  var ARROW = {
    up: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2.5M2.5 6 6 2.5 9.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v7.5M2.5 6 6 9.5 9.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    flat: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h7.5M6 2.5 9.5 6 6 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  // 減算の新設・拡大は事業所にとって厳しくなる向き、減算の縮小は緩む向きとして色を付ける
  function polar(r) {
    var x = DIR[r.direction] || DIR["見直し"], k = r.kind || [];
    var genOnly = k.indexOf("減算") >= 0 && k.indexOf("加算") < 0;
    if (genOnly && (r.direction === "新設" || r.direction === "拡充")) return ["down", r.direction === "新設" ? "減算の新設" : "減算の拡大"];
    if (genOnly && r.direction === "廃止・縮小") return ["up", "減算の縮小"];
    return x;
  }
  function dirTag(r) { var x = polar(r); return '<span class="dir ' + x[0] + '">' + ARROW[x[0]] + esc(x[1]) + "</span>"; }
  function dirClass(r) { return polar(r)[0]; }

  /* ── サービスとグループ ───────────── */
  var GRPS = C.groups || [];
  var SVC2G = {};
  GRPS.forEach(function (g) { g.services.forEach(function (s) { SVC2G[s] = g.id; }); });
  var ALL = (C.ronten || []).slice();
  var CROSS = ALL.filter(function (r) { return r.group === "横断"; });
  var SVCR = ALL.filter(function (r) { return r.group !== "横断"; });
  function groupsOf(r) {
    var out = [];
    (r.services || []).forEach(function (s) { var g = SVC2G[s]; if (g && out.indexOf(g) < 0) out.push(g); });
    if (!out.length && r.gid) out.push(r.gid);
    return out;
  }
  SVCR.forEach(function (r) { r._g = groupsOf(r); });
  var BASE = (C.zentei || []).slice();
  BASE.forEach(function (r) { r._g = groupsOf(r); });
  function lastDate(r) { var h = r.history || []; return h.length ? h[h.length - 1].date : (r.src && r.src.date) || ""; }
  // 取り下げ・統合済みのカードは後ろへ回す
  function byNewest(a, b) { return ((a.withdrawn || a.merged_into) ? 1 : 0) - ((b.withdrawn || b.merged_into) ? 1 : 0) || dayOf(lastDate(b)) - dayOf(lastDate(a)) || String(a.id).localeCompare(String(b.id)); }

  /* ── 論点カード ───────────────────── */
  function pdfLink(src, page) { if (!src || !src.url) return ""; return src.url + (page ? "#page=" + page : ""); }
  function firstPage(r) { var m = String(r.pages || "").match(/\d+/); return m ? m[0] : ""; }
  function isNew(r) { var d = lastDate(r); return d && (TODAY - dayOf(d)) / DAY <= 14; }
  var READ = {};   // スマホで論点のページを開いた論点（この表示のあいだだけ。一覧の行に「読んだ」印を付ける）
  function tagsHtml(r, opts) {
    var tags = [];
    if (r.stageLabel) tags.push(stg(r.stage || 4, r.stageLabel)); else tags.push(stg(r.stage || 1));
    if (r.direction) tags.push(dirTag(r));
    if (r.withdrawn) tags.push('<span class="limit">取り下げ</span>');
    if (r.merged_into) tags.push('<span class="kd">統合済み</span>');
    if (r.limited) tags.push('<span class="limit">期限つき</span>');
    (r.kind || []).slice(0, 3).forEach(function (k) { tags.push('<span class="kd">' + esc(k) + "</span>"); });
    if (isNew(r) && !(opts && opts.noNew)) tags.push('<span class="newmark">' + mdw(lastDate(r)).replace(/（.）/, "") + " 更新</span>");
    return tags.join("");
  }
  function card(r, opts) {
    opts = opts || {};
    var prim = typeof opts.primary === "function" ? opts.primary(r) : !!opts.primary;
    var cls = "rc" + (r.withdrawn ? " gone" : "");
    // id 属性は付けない（#r-… を開いたとき、ブラウザが長い一覧の途中へ勝手に移るのを防ぐ）。
    // そのカードの「持ち場」（サービス別の最初のグループ・前提・全体像）だけに data-anchor を付け、#r-… の行き先にする
    var attrs = { class: cls, "data-rid": r.id };
    if (prim) attrs["data-anchor"] = "r-" + r.id;
    var d = el("details", attrs);
    if (READ[r.id]) d.classList.add("is-read");
    var svcLine = (r.services || []).join("・");
    d.innerHTML = "<summary><span class=\"tags\">" + tagsHtml(r, opts) + '</span><span class="rt">' + esc(r.title) + "</span>" + (svcLine && !opts.noSvc ? '<span class="rs">' + esc(svcLine) + "</span>" : "") + "</summary>";
    d.addEventListener("toggle", function () { if (d.open && !d._built) { d._built = true; d.appendChild(body(r)); } }, { once: false });
    return d;
  }
  function body(r) {
    var b = el("div", { class: "rb" });
    var h = "";
    if (r.label) h += '<div class="lbl">' + esc(r.label) + "</div>";
    if (r.effective) h += '<div class="blk"><h5>適用</h5><p>' + esc(r.effective) + "</p></div>";
    if (r.genjo) h += '<div class="blk"><h5>現状・課題</h5><p>' + esc(r.genjo) + "</p></div>";
    var sl = r.stageLabel || "";
    var dirHead = /^確定/.test(sl) ? "決まった内容" : (sl === "調査" ? "調査の内容" : (sl ? "資料に書かれていること" : ((r.stage || 1) >= 4 ? "決まった内容" : ((r.stage || 1) === 3 ? "改定案の内容" : "検討の方向性（案）"))));
    if (r.houkousei) h += '<div class="blk dirb"><h5>' + dirHead + "</h5><p>" + esc(r.houkousei) + "</p></div>";
    if (r.r9) h += '<div class="blk dirb"><h5>令和9年度改定での扱い</h5><p>' + esc(r.r9) + "</p></div>";
    if (r.kentou && r.kentou.length) h += '<div class="blk"><h5>想定される検討事項</h5><ul class="kj">' + r.kentou.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>";
    if (r.numbers && r.numbers.length) {
      h += '<div class="blk"><h5>資料にある数字</h5><ul class="nums">' + r.numbers.map(function (n) {
        var u = n.url ? n.url + (n.page ? "#page=" + n.page : "") : pdfLink(r.src, n.page);
        return "<li><span>" + esc(n.text) + "</span>" + (n.page ? (u ? '<a class="pg" href="' + esc(u) + '" target="_blank" rel="noopener">p.' + esc(n.page) + "</a>" : '<span class="pg">p.' + esc(n.page) + "</span>") : "") + "</li>";
      }).join("") + "</ul></div>";
    }
    if (r.merged_into) h += '<div class="blk"><h5>統合先</h5><p><a href="#r-' + esc(r.merged_into) + '">統合先の論点を開く</a></p></div>';
    if (r.point) h += '<div class="blk point"><h5>事業所で確かめておくこと</h5><p>' + esc(r.point) + "</p></div>";
    if (r.notes) h += '<div class="blk"><h5>資料のあいだの違い・注記</h5><p>' + esc(r.notes) + "</p></div>";
    if (r.history && r.history.length) {
      h += '<div class="blk"><h5>変遷</h5><ul class="hist">' + r.history.slice().reverse().map(function (x) {
        return "<li><time>" + dot(x.date) + "</time><span>" + stg(x.stage || 1, x.stageLabel) + " " + esc(x.text) + "</span></li>";
      }).join("") + "</ul></div>";
    }
    if (r.src) {
      var u = pdfLink(r.src, firstPage(r));
      h += '<div class="src"><span>出典：' + esc(r.src.meeting || "") + "（" + dot(r.src.date) + "）</span>" +
        (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(r.src.title) + (r.pages ? " p." + esc(r.pages) : "") + "</a>" : "<span>" + esc(r.src.title) + "</span>") +
        (r.src.page_url ? '<a href="' + esc(r.src.page_url) + '" target="_blank" rel="noopener">資料の掲載ページ</a>' : "") + "</div>";
    }
    if (r.related && r.related.length) {
      h += '<div class="src"><span>同じ内容がある資料：</span>' + r.related.map(function (x) {
        return '<a href="' + esc(x.url) + (x.pages && /^\d+/.test(x.pages) ? "#page=" + esc(String(x.pages).match(/^\d+/)[0]) : "") + '" target="_blank" rel="noopener">' + esc((x.meeting ? x.meeting + " " : "") + x.title) + (x.pages ? " p." + esc(x.pages) : "") + "</a>";
      }).join("") + "</div>";
    }
    b.innerHTML = h;
    return b;
  }
  function fill(host, list, opts) {
    host.innerHTML = "";
    if (!list.length) { host.appendChild(el("div", { class: "empty" }, (opts && opts.empty) || "当てはまる論点はありません。")); return; }
    list.forEach(function (r) { host.appendChild(card(r, opts)); });
  }

  /* ── サービス別のページを作る ─────── */
  (function serviceViews() {
    var anchor = null;
    each(document.querySelectorAll("#main > section"), function (s) { if (s.id === "list") anchor = s; });
    GRPS.forEach(function (g) {
      var rs = SVCR.filter(function (r) { return r._g.indexOf(g.id) >= 0; }).sort(byNewest);
      var bs = BASE.filter(function (r) { return r.group !== "横断" && /^確定/.test(r.stageLabel || "") && r._g.indexOf(g.id) >= 0; });
      var bcross = BASE.filter(function (r) { return r.group === "横断" && /^確定/.test(r.stageLabel || ""); }).length;
      g._n = rs.length;
      var sec = el("section", { class: "chapter view", id: "svc-" + g.id, "data-group": "svc", "data-title": g.name, "data-count": rs.length });
      var met = (g.discussed || []).map(function (m) { return "<b>" + esc(m.meeting) + "</b>（" + dot(m.date) + "）"; }).join("・");
      var status = met
        ? '<div class="status-line"><span>検討チームの議題 ' + met + "</span><span>論点 <b>" + rs.length + "件</b></span>" + stg(Math.max.apply(null, rs.map(function (r) { return r.stage || 1; }).concat([1]))) + "</div>"
        : '<div class="status-line pending"><span>このサービスを議題にした回は開かれていません。' + (rs.length ? "ほかの回で触れられた論点を載せています。" : "") + "</span><span>" + esc(g.expect || "") + "</span></div>";
      sec.innerHTML = '<header><div class="ch-no">サービス別</div><h2>' + esc(g.name) + '</h2><p class="ch-lead">' + esc(g.services.join("・")) + "</p></header>" + status;
      if (rs.length) {
        var chips = el("div", { class: "chips svc-chips" });
        var cards = el("div", { class: "cards" });
        var active = "";
        var names = [""].concat(g.services.filter(function (s) { return rs.some(function (r) { return (r.services || []).indexOf(s) >= 0; }); }));
        names.forEach(function (s) {
          var n = s ? rs.filter(function (r) { return (r.services || []).indexOf(s) >= 0; }).length : rs.length;
          var b = el("button", { class: "chip", type: "button", "aria-pressed": s === active ? "true" : "false" }, esc(s || "すべて") + '<span class="c">' + n + "</span>");
          b.addEventListener("click", function () { active = s; each(chips.children, function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); }); draw(); });
          chips.appendChild(b);
        });
        function draw() { fill(cards, rs.filter(function (r) { return !active || (r.services || []).indexOf(active) >= 0; }), { noSvc: g.services.length === 1, primary: function (r) { return r._g[0] === g.id; } }); }
        if (names.length > 2) sec.appendChild(chips);
        sec.appendChild(cards);
        draw();
      }
      if (bs.length) {
        sec.appendChild(el("h3", null, "令和8年度に確定済みの前提"));
        var bc = el("div", { class: "cards" });
        fill(bc, bs, { noNew: true });
        sec.appendChild(bc);
      }
      var cn = CROSS.filter(function (r) { return (r.services || []).indexOf("全サービス") >= 0 || (r.services || []).some(function (s) { return g.services.indexOf(s) >= 0; }); }).length;
      sec.appendChild(el("p", { class: "prose" }, '全サービスにかかる論点が <a href="#overview">' + cn + "件</a>" + (bcross ? '、確定済みの前提が <a href="#base">' + bcross + "件</a>" : "") + " あります。"));
      main.insertBefore(sec, anchor);
    });
  })();

  /* ── 論点一覧（絞り込み） ─────────── */
  (function listView() {
    var host = $("list-cards"); if (!host) return;
    var all = ALL.slice().sort(byNewest);
    var st = { g: "", dir: "", kind: "", q: "" };
    function mk(hostId, key, items) {
      var box = $(hostId);
      items.forEach(function (it) {
        var b = el("button", { class: "chip", type: "button", "aria-pressed": it.v === st[key] ? "true" : "false" }, esc(it.t) + (it.n != null ? '<span class="c">' + it.n + "</span>" : ""));
        b.addEventListener("click", function () { st[key] = st[key] === it.v ? "" : it.v; sync(); draw(); });
        b._v = it.v; b._k = key;
        box.appendChild(b);
      });
    }
    function sync() { each(document.querySelectorAll("#f-grp .chip, #f-dir .chip, #f-kind .chip"), function (b) { b.setAttribute("aria-pressed", st[b._k] === b._v ? "true" : "false"); }); }
    mk("f-grp", "g", [{ v: "", t: "すべて", n: all.length }].concat(GRPS.filter(function (g) { return g._n; }).map(function (g) { return { v: g.id, t: g.name, n: g._n }; })).concat([{ v: "横断", t: "全サービス共通", n: CROSS.length }]));
    mk("f-dir", "dir", [{ v: "", t: "すべて" }, { v: "up", t: "評価の拡充・新設" }, { v: "down", t: "適正化・縮小" }, { v: "flat", t: "見直し・今後" }]);
    var kinds = [];
    all.forEach(function (r) { (r.kind || []).forEach(function (k) { if (kinds.indexOf(k) < 0) kinds.push(k); }); });
    var ORDER = ["基本報酬", "加算", "減算", "算定要件", "人員基準", "設備基準", "運営基準", "経過措置", "報酬体系", "その他"];
    kinds.sort(function (a, b) { return (ORDER.indexOf(a) + 99) % 99 - (ORDER.indexOf(b) + 99) % 99; });
    mk("f-kind", "kind", [{ v: "", t: "すべて" }].concat(kinds.map(function (k) { return { v: k, t: k, n: all.filter(function (r) { return (r.kind || []).indexOf(k) >= 0; }).length }; })));
    var q = $("q");
    q.addEventListener("input", function () { st.q = q.value.trim(); draw(); });
    $("f-reset").addEventListener("click", function () { st = { g: "", dir: "", kind: "", q: "" }; q.value = ""; sync(); draw(); });
    function hay(r) { return [r.title, r.label, r.genjo, r.houkousei, (r.services || []).join(" "), (r.kind || []).join(" "), (r.kentou || []).join(" ")].join(" "); }
    function draw() {
      var words = st.q ? st.q.split(/\s+/) : [];
      var list = all.filter(function (r) {
        if (st.g === "横断" && r.group !== "横断") return false;
        if (st.g && st.g !== "横断" && (r._g || []).indexOf(st.g) < 0) return false;
        if (st.dir && dirClass(r) !== st.dir) return false;
        if (st.kind && (r.kind || []).indexOf(st.kind) < 0) return false;
        if (words.length) { var h = hay(r); if (!words.every(function (w) { return h.indexOf(w) >= 0; })) return false; }
        return true;
      });
      $("f-count").textContent = list.length + "件";
      $("f-reset").hidden = !(st.g || st.dir || st.kind || st.q);
      fill(host, list);
    }
    draw();
  })();

  /* ── 前提 ─────────────────────────── */
  (function baseView() {
    var host = $("base-cards"); if (!host) return;
    // 確定したものだけを最初に見せる。論点整理より前の課題・調査は、切り替えたときだけ出す（未確定の情報を増やしすぎない）
    function isFixed(r) { return /^確定/.test(r.stageLabel || ""); }
    var extraBox = $("base-extra");
    var cats = [{ v: "", t: "すべて" }, { v: "横断", t: "全サービス共通" }];
    GRPS.forEach(function (g) { if (BASE.some(function (r) { return r._g.indexOf(g.id) >= 0; })) cats.push({ v: g.id, t: g.name }); });
    var active = "";
    var box = $("base-chips");
    function inCat(r, v) { return !v || (v === "横断" ? r.group === "横断" : r._g.indexOf(v) >= 0); }
    function shown(r) { return isFixed(r) || (extraBox && extraBox.checked); }
    var btns = cats.map(function (c) {
      var b = el("button", { class: "chip", type: "button", "aria-pressed": c.v === active ? "true" : "false" });
      b.addEventListener("click", function () { active = c.v; btns.forEach(function (x) { x.b.setAttribute("aria-pressed", x.b === b ? "true" : "false"); }); draw(); });
      box.appendChild(b);
      return { b: b, c: c };
    });
    var ORD = { "確定（令和8年度）": 0, "確定（特例）": 1, "課題の提示": 2, "既存の考え方の再提示": 3, "調査": 4 };
    var SORTED = BASE.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) { return ((ORD[a.r.stageLabel] != null ? ORD[a.r.stageLabel] : 9) - (ORD[b.r.stageLabel] != null ? ORD[b.r.stageLabel] : 9)) || a.i - b.i; }).map(function (x) { return x.r; });
    fill(host, SORTED, { noNew: true, primary: true, empty: "令和8年度改定の資料を整理しています。整理が終わりしだい、ここに載せます。" });
    var cards = Array.prototype.slice.call(host.querySelectorAll(".rc"));
    cards.forEach(function (d, i) { if (!isFixed(SORTED[i])) d.classList.add("extra"); });
    var empty = el("div", { class: "empty", hidden: "" }, "この条件に当てはまる前提はありません。");
    host.appendChild(empty);
    function draw() {
      var n = 0;
      cards.forEach(function (d, i) { var ok = inCat(SORTED[i], active) && shown(SORTED[i]); d.hidden = !ok; if (ok) n++; });
      empty.hidden = n !== 0 || !cards.length;
      btns.forEach(function (x) { x.b.innerHTML = esc(x.c.t) + '<span class="c">' + BASE.filter(function (r) { return inCat(r, x.c.v) && shown(r); }).length + "</span>"; });
    }
    if (extraBox) extraBox.addEventListener("change", draw);
    window.__showBaseExtra = function () { if (extraBox && !extraBox.checked) { extraBox.checked = true; draw(); } };
    draw();
  })();

  /* ── 全体像・確度 ─────────────────── */
  (function overview() {
    var p = $("pillars");
    if (p) (C.pillars || []).forEach(function (x) {
      var rel = CROSS.filter(function (r) { return r.pillar === x.no; });
      p.appendChild(el("div", { class: "pillar" }, '<span class="pn">柱 ' + esc(x.no) + "</span><h4>" + esc(x.title) + "</h4>" + (x.desc ? "<p>" + esc(x.desc) + "</p>" : "") +
        (rel.length ? "<ul>" + rel.map(function (r) { return '<li><a href="#r-' + r.id + '">' + esc(r.title) + "</a></li>"; }).join("") + "</ul>" : "")));
    });
    var cc = $("cross-cards"); if (cc) fill(cc, CROSS.slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); }), { noSvc: true, noNew: true, primary: true });
    var sd = $("stage-def");
    if (sd) STAGES.forEach(function (s) {
      sd.appendChild(el("li", { class: s.k === CUR ? "now" : "" }, stg(s.k) + "<div><b>" + esc(s.title) + "</b>" + '<span class="when">' + esc(s.when) + "</span>" + esc(s.desc) + "</div>"));
    });
    var chip = $("stage-chip"); if (chip) chip.innerHTML = "いま <b>" + esc(stageOf(CUR).name) + "</b>";
  })();

  /* ── 日程・開催状況 ───────────────── */
  (function schedule() {
    var tl = $("tl");
    if (tl) (LIVE.timeline || []).forEach(function (t) {
      var d = dayOf(t.date);
      var cls = t.done ? "done" : (t.now ? "now" : "");
      if (t.big) cls += " big";
      tl.appendChild(el("li", { class: cls.trim() }, '<span class="when">' + esc(t.label || dot(t.date)) + '</span><span class="dot" aria-hidden="true"></span><div class="what"><b>' + esc(t.title) + "</b>" + (t.desc ? "<span>" + esc(t.desc) + "</span>" : "") + "</div>"));
    });
    var tb = document.querySelector("#mt-table tbody");
    if (tb) (LIVE.meetings || []).slice().sort(function (a, b) { return dayOf(b.date) - dayOf(a.date); }).forEach(function (m) {
      var tr = el("tr", { class: m.status === "scheduled" ? "sched" : "" });
      tr.innerHTML = "<th>" + esc(m.no) + '</th><td class="dt">' + dot(m.date) + (m.status === "scheduled" ? '<br><span class="sm">開催予定</span>' : "") + "</td><td>" + esc(m.title) + "</td><td>" +
        (m.page_url ? '<a href="' + esc(m.page_url) + '" target="_blank" rel="noopener">' + (m.status === "scheduled" ? "開催案内" : "資料") + "</a>" : "") + "</td>";
      tb.appendChild(tr);
    });
  })();

  /* ── 更新情報 ─────────────────────── */
  var CHECKED = LIVE.checkedAt ? Date.parse(LIVE.checkedAt) : null;
  each(document.querySelectorAll(".js-checked"), function (n) { if (CHECKED) n.textContent = ymd(CHECKED) + " " + hm(CHECKED); });
  if ($("checked-at") && CHECKED) $("checked-at").textContent = "情報の確認 " + ymd(CHECKED);
  if ($("asof") && C.asof) $("asof").textContent = ymd(dayOf(C.asof));
  var IMP = { done: ["done", "カードに反映済み"], todo: ["todo", "カードに反映する前"], info: ["info", "参考"] };
  function sortedUpdates() { return (LIVE.updates || []).slice().sort(function (a, b) { return dayOf(b.date) - dayOf(a.date); }); }
  function updItem(u, compact) {
    var p = parts(dayOf(u.date)), imp = IMP[u.impact] || IMP.info;
    var link = u.url ? '<a href="' + esc(u.url) + '" target="_blank" rel="noopener">' + esc(u.title) + "</a>" : "<b>" + esc(u.title) + "</b>";
    var tags = '<span class="tags"><span class="evb">' + esc(u.src) + '</span><span class="imp ' + imp[0] + '">' + imp[1] + "</span></span>";
    if (compact) return el("li", null, "<time>" + p.m + "/" + p.d + '</time><span class="ft">' + link + tags + "</span>");
    var where = u.where ? '<a class="u-where" href="' + esc(u.where) + '">関係するページを開く</a>' : "";
    return el("li", { class: "u" + (u.impact === "todo" ? " is-todo" : "") }, "<time>" + dot(u.date) + '</time><div class="u-b">' + tags + link + (u.note ? "<p>" + esc(u.note) + "</p>" : "") + where + "</div>");
  }
  (function updates() {
    var list = $("upd-list"); if (!list) return;
    var meta = $("check-meta");
    var todoN = (LIVE.updates || []).filter(function (u) { return u.impact === "todo"; }).length;
    if (meta) meta.innerHTML = "<span>最終確認 <b>" + (CHECKED ? ymd(CHECKED) + " " + hm(CHECKED) : "―") + "</b></span><span>確認したページ <b>" + (LIVE.checkedPages || (LIVE.watch || []).length) + "</b></span><span>カードに反映する前 <b>" + todoN + "件</b></span>" + (LIVE.checkNote ? '<span class="cm-note">' + esc(LIVE.checkNote) + "</span>" : "");
    var only = $("upd-todo");
    var rows = sortedUpdates().map(function (u) { var li = updItem(u, false); list.appendChild(li); return { li: li, u: u }; });
    var empty = el("li", { class: "empty", hidden: "" }, "カードに反映する前の更新はありません。");
    list.appendChild(empty);
    function draw() { var n = 0; rows.forEach(function (r) { var ok = !only.checked || r.u.impact === "todo"; r.li.hidden = !ok; if (ok) n++; }); empty.hidden = n !== 0; }
    only.addEventListener("change", draw); draw();
    var w = $("watch-list");
    if (w && LIVE.watch) { LIVE.watch.forEach(function (x) { w.appendChild(el("li", null, x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + "</a>" : esc(x.name))); }); if ($("watch-count")) $("watch-count").textContent = LIVE.watch.length + "か所"; }
    var sl = $("src-list");
    if (sl) (C.sources || []).forEach(function (s) { sl.appendChild(el("li", null, '<span class="k">' + esc(s.k) + "</span><span>" + (s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title) + "</a>" : esc(s.title)) + (s.note ? '<br><span class="sm">' + esc(s.note) + "</span>" : "") + "</span>")); });
  })();

  /* ── ホーム ───────────────────────── */
  (function home() {
    var left = Math.round((TEKIYO - TODAY) / DAY);
    var cd = $("cd-left");
    if (cd) cd.innerHTML = left > 0 ? "4月1日まで あと<b>" + left + "</b>日" : "改定後の報酬を適用中";
    var bar = $("cd-bar");
    if (bar) { var pr = Math.max(0, Math.min(1, (NOW - KAISHI) / (TEKIYO - KAISHI))); requestAnimationFrame(function () { bar.style.width = (pr * 100).toFixed(1) + "%"; }); }

    var tr = $("track");
    if (tr) STAGES.forEach(function (s) {
      var cls = s.k < CUR ? "done" : (s.k === CUR ? "now" : "");
      tr.appendChild(el("li", { class: cls }, '<span class="pt" aria-hidden="true"></span>' + (s.k === CUR ? '<span class="here">いまここ</span>' : "") + "<b>" + esc(s.name) + '</b><span class="w">' + esc(s.when) + '</span><span class="d">' + esc(s.short) + "</span>"));
    });

    var fh = $("feed-home");
    if (fh) sortedUpdates().slice(0, 6).forEach(function (u) { fh.appendChild(updItem(u, true)); });

    var gg = $("grp-grid");
    if (gg) GRPS.forEach(function (g) {
      var met = g.discussed && g.discussed.length ? g.discussed[g.discussed.length - 1] : null;
      gg.appendChild(el("a", { class: "grp" + (met ? "" : " pending"), href: "#svc-" + g.id }, "<b>" + esc(g.name) + '</b><span class="m">' + (met ? "<em>論点 " + g._n + "件</em>・" + mdw(met.date) + "の議題" : "議題になる前") + "</span>"));
    });

    var nx = $("next-row");
    if (nx) (LIVE.milestones || []).filter(function (m) { return dayOf(m.date) >= TODAY - DAY * 3; }).sort(function (a, b) { return dayOf(a.date) - dayOf(b.date); }).slice(0, 3).forEach(function (m, i) {
      nx.appendChild(el("a", { class: "nx" + (i === 0 ? " first" : ""), href: m.link || "#schedule" }, '<span class="when">' + esc(m.label || mdw(m.date)) + (m.approx ? "（見込み）" : "") + "</span><b>" + esc(m.title) + '</b><span class="d">' + esc(m.desc || "") + "</span>"));
    });

    // 担当サービスの論点。選んだ内容は表示しているあいだだけ覚え、再読み込みで選び直しに戻る（ユーザー指示 2026-10-27）
    try { window.localStorage.removeItem("hoshu-guide-mine-v1"); } catch (e) {}   // 以前の版が端末に残した選択を消す
    var mine = [];
    var host = $("mine"); if (!host) return;
    var picking = true;
    // 決定・選び直しのあと、この欄の見出しが画面の上に隠れていたら、見出しが見える位置に戻す（決定で欄が縮み、下の欄から表示されるのを防ぐ）
    function toSection() {
      var sec = host.closest(".hb"); if (!sec) return;
      var bar = document.querySelector(".topbar"), tbh = bar ? bar.getBoundingClientRect().bottom : 0;
      var top = sec.getBoundingClientRect().top;
      if (top < tbh + 4) jumpTo(Math.max(0, Math.round(top + window.scrollY - tbh - 10)));
    }
    function render() {
      host.innerHTML = "";
      if (picking) {
        var wrap = el("div", { class: "filters" });
        if (!mine.length) wrap.appendChild(el("p", { class: "hb-sub", style: "margin:0" }, "担当のサービスを選ぶと、ここに論点が並びます。"));
        GRPS.forEach(function (g) {
          var row = el("div", { class: "frow" });
          row.appendChild(el("span", { class: "fl" }, esc(g.name)));
          var chips = el("div", { class: "chips" });
          g.services.forEach(function (s) {
            var b = el("button", { class: "chip", type: "button", "aria-pressed": mine.indexOf(s) >= 0 ? "true" : "false" }, esc(s));
            b.addEventListener("click", function () { var i = mine.indexOf(s); if (i >= 0) mine.splice(i, 1); else mine.push(s); b.setAttribute("aria-pressed", mine.indexOf(s) >= 0 ? "true" : "false"); count(); });
            chips.appendChild(b);
          });
          row.appendChild(chips); wrap.appendChild(row);
        });
        var done = el("button", { class: "chip", type: "button", "aria-pressed": "true" }, "決定");
        done.addEventListener("click", function () { picking = false; render(); toSection(); });
        var foot = el("div", { class: "fmeta" }); foot.appendChild(el("span", { id: "mine-n" })); foot.appendChild(done);
        wrap.appendChild(foot);
        host.appendChild(wrap);
        count();
        return;
      }
      var head = el("div", { class: "mine-head" });
      head.appendChild(el("span", null, esc(mine.join("・"))));
      var again = el("button", { class: "linkbtn", type: "button" }, "選び直す");
      again.addEventListener("click", function () { picking = true; render(); toSection(); });
      head.appendChild(again);
      host.appendChild(head);
      var rs = SVCR.filter(function (r) { return (r.services || []).some(function (s) { return mine.indexOf(s) >= 0; }); }).sort(byNewest);
      var bs = BASE.filter(function (r) { return r.limited && (r.services || []).some(function (s) { return mine.indexOf(s) >= 0; }); });
      $("mine-count").textContent = "論点 " + rs.length + "件";
      var ul = el("ul", { class: "mine-list" });
      rs.slice(0, 8).forEach(function (r) {
        var li = el("li");
        li.appendChild(el("a", { href: "#r-" + r.id }, '<b>' + esc(r.title) + '</b><span class="svcs">' + esc((r.services || []).filter(function (s) { return mine.indexOf(s) >= 0; }).join("・")) + '</span><span class="tags">' + stg(r.stage || 1) + dirTag(r) + "</span>"));
        ul.appendChild(li);
      });
      bs.forEach(function (r) {
        var li = el("li");
        li.appendChild(el("a", { href: "#r-" + r.id }, "<b>" + esc(r.title) + '</b><span class="svcs">前提</span><span class="tags">' + stg(4, r.stageLabel) + '<span class="limit">期限つき</span></span>'));
        ul.appendChild(li);
      });
      if (!rs.length && !bs.length) host.appendChild(el("div", { class: "empty" }, "選んだサービスは、検討チームの議題になる前です。議題になったら、ここに論点が並びます。"));
      else host.appendChild(ul);
      if (rs.length > 8) {
        var g0 = SVC2G[mine[0]];
        host.appendChild(el("p", { class: "hb-sub", style: "margin:10px 0 0" }, '<a href="#svc-' + g0 + '">ほか ' + (rs.length - 8) + "件をサービス別で見る</a>"));
      }
    }
    function count() { var n = $("mine-n"); if (n) n.textContent = mine.length ? mine.length + "サービスを選択中" : ""; $("mine-count").textContent = ""; }
    render();
  })();

  /* ── お知らせ帯 ───────────────────── */
  (function notices() {
    var b = $("banner"); if (!b) return;
    var list = (LIVE.notices || []).filter(function (n) { return !n.until || dayOf(n.until) >= TODAY; });
    if (!list.length) return;
    b.innerHTML = list.map(function (n) { return "<div><b>" + esc(n.title) + "</b> " + esc(n.body || "") + (n.link ? ' <a href="' + esc(n.link) + '">開く</a>' : "") + "</div>"; }).join("");
    b.hidden = false;
  })();

  /* ── ページ（ビュー）の一覧 ───────────── */
  var GROUPS = [
    { k: "home", t: "ホーム" }, { k: "svc", t: "サービス別" }, { k: "list", t: "論点一覧" }, { k: "base", t: "前提" },
    { k: "overview", t: "全体像" }, { k: "schedule", t: "日程" }, { k: "updates", t: "更新情報" }
  ];
  var VIEWS = {}, SEQ = [];
  GROUPS.forEach(function (g) { g.views = []; });
  each(document.querySelectorAll(".view"), function (v) {
    var g = GROUPS.filter(function (x) { return x.k === v.getAttribute("data-group"); })[0];
    if (!g) return;
    var info = { id: v.id, el: v, g: g, t: v.getAttribute("data-title"), c: v.getAttribute("data-count") };
    VIEWS[v.id] = info; g.views.push(info);
  });
  GROUPS.forEach(function (g) { g.views.forEach(function (v) { if (g.k !== "home") SEQ.push(v); }); });
  // ページ（ビュー）の要素から id を外す。#home などで開いたとき、ブラウザがその位置へ自動でスクロールして
  // 上の「福祉情報ウォッチに戻る」が隠れるのを防ぐ（表示の切り替えは VIEWS で行う）
  Object.keys(VIEWS).forEach(function (k) { var e = VIEWS[k].el; e.setAttribute("data-vid", k); e.removeAttribute("id"); });

  // 前後のボタン（ページの前後・論点の前後で共通）。薄い色の面に、矢印・「次へ」・行き先を1行で収める
  var ARR = {
    prev: '<svg class="pa" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg class="pa" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function pgLink(dir, href, k, t) {
    return el("a", { class: dir, href: href, "aria-label": k + "：" + t }, (dir === "prev" ? ARR.prev : "") + '<span class="pk">' + esc(k) + "</span>" +
      (dir === "prev" ? '<span class="ps">前へ</span>' : "") + '<span class="pt">' + esc(t) + "</span>" + (dir === "next" ? ARR.next : ""));
  }
  function pager(label, prev, next) {   // prev・next は [href, 見出し語, 行き先]
    var nav = el("nav", { class: "pager" + (prev && next ? " two" : ""), "aria-label": label });
    if (prev) nav.appendChild(pgLink("prev", prev[0], prev[1], prev[2]));
    if (next) nav.appendChild(pgLink("next", next[0], next[1], next[2]));
    return nav;
  }
  SEQ.forEach(function (v, i) {
    var prev = SEQ[i - 1], next = SEQ[i + 1];
    function dest(x) { return x.g !== v.g && x.t.indexOf(x.g.t) < 0 ? x.g.t + " › " + x.t : x.t; }
    if (prev || next) v.el.appendChild(pager("前後のページ", prev && ["#" + prev.id, "前へ", dest(prev)], next && ["#" + next.id, "次へ", dest(next)]));
  });

  var drawer = $("drawer"), drawerList = $("drawer-list"), menuBtn = $("menu-btn");
  drawerList.appendChild(el("a", { class: "dback", href: "../" }, '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>福祉情報ウォッチに戻る</span>'));
  GROUPS.forEach(function (g) {
    if (!g.views.length) return;
    var box = el("div", { class: "dg" });
    box.appendChild(el("a", { href: "#" + g.views[0].id, "data-v": g.views[0].id }, esc(g.t)));
    if (g.views.length > 1) {
      var ul = el("ul");
      g.views.forEach(function (v) { var li = el("li"); li.appendChild(el("a", { href: "#" + v.id, "data-v": v.id }, esc(v.t))); ul.appendChild(li); });
      box.appendChild(ul);
    }
    drawerList.appendChild(box);
  });
  function setDrawer(open) {
    if (open) { var tb = document.querySelector(".topbar"); if (tb) drawer.style.top = Math.max(0, Math.round(tb.getBoundingClientRect().bottom)) + "px"; }
    drawer.hidden = !open; menuBtn.setAttribute("aria-expanded", open ? "true" : "false"); document.documentElement.classList.toggle("drawer-open", open); }
  menuBtn.addEventListener("click", function () { setDrawer(drawer.hidden); });
  drawer.addEventListener("click", function (e) { if (e.target === drawer || e.target.closest("a")) setDrawer(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !drawer.hidden) { setDrawer(false); menuBtn.focus(); } });

  /* ── 表示の切り替え（#で指定） ───────── */
  // 押したら「新しいページ」に切り替わる（ページの中を移るだけのショートカットにしない）。
  // 戻る操作（スワイプ・ブラウザの戻る）では、前のページを離れたときと同じ位置で出す。
  var shell = document.querySelector(".shell"), subnav = $("subnav"), current = null;
  var MQ = window.matchMedia ? window.matchMedia("(max-width: 960px)") : { matches: false };
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}
  function getState() { var s = null; try { s = history.state; } catch (e) {} return s && typeof s === "object" ? s : {}; }
  function setState(patch) {
    try { var s = getState(), n = {}; Object.keys(s).forEach(function (k) { n[k] = s[k]; }); Object.keys(patch).forEach(function (k) { n[k] = patch[k]; }); history.replaceState(n, ""); } catch (e) {}
  }
  var navIntent = null, saveT = null;   // navIntent "push"＝このページのボタン・リンクで移った（先頭から出す）
  function saveY() { if (saveT) { clearTimeout(saveT); saveT = null; } setState({ y: Math.round(window.scrollY) }); }
  window.addEventListener("scroll", function () { if (saveT) clearTimeout(saveT); saveT = setTimeout(function () { saveT = null; setState({ y: Math.round(window.scrollY) }); }, 150); }, { passive: true });
  function go(hash) { saveY(); navIntent = "push"; location.hash = hash; }
  function jumpTop() { try { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, 0); } }
  function jumpTo(y) { try { window.scrollTo({ top: y, left: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, y); } }

  function renderSubnav(g, v) {
    subnav.innerHTML = "";
    if (g.views.length < 2) return;
    subnav.appendChild(el("div", { class: "sg" }, esc(g.t)));
    var ol = el("ol");
    g.views.forEach(function (x) {
      var li = el("li");
      li.appendChild(el("a", { href: "#" + x.id, class: x === v ? "is-active" : "", "aria-current": x === v ? "page" : "false" }, "<span>" + esc(x.t) + "</span>" + (x.c != null ? '<span class="c">' + (x.c === "0" ? "―" : x.c) + "</span>" : "")));
      ol.appendChild(li);
    });
    subnav.appendChild(ol);
    // スマホの横並びは、いまのページを横方向だけ真ん中へ寄せる（縦には動かさない。動かすとページが途中から表示される）
    var act = subnav.querySelector(".is-active");
    if (act && MQ.matches) { try { ol.scrollLeft = Math.max(0, act.offsetLeft - (ol.clientWidth - act.offsetWidth) / 2); } catch (e) {} }
  }
  function markNav(gk, vid) {
    each(document.querySelectorAll(".gnav a, .tabbar a"), function (a) { var on = a.getAttribute("data-g") === gk; a.classList.toggle("is-active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    each(document.querySelectorAll(".drawer a[data-v]"), function (a) { a.classList.toggle("is-active", a.getAttribute("data-v") === vid); });
  }
  function show(v) {
    if (current !== v) { each(document.querySelectorAll(".view.is-active"), function (x) { x.classList.remove("is-active"); }); v.el.classList.add("is-active"); current = v; }
    shell.classList.toggle("no-sub", v.g.views.length < 2);
    shell.classList.toggle("is-home", v.g.k === "home");
    renderSubnav(v.g, v);
    markNav(v.g.k, v.id);
    document.title = (v.g.k === "home" ? "" : v.t + "｜") + "令和9年度 障害福祉報酬改定ガイド";
  }

  /* ── 論点のページ（スマホ） ───────────
     一覧の行を押すと、その論点だけのページに切り替わる。上に戻り先（一覧の名前）と何件目か、下に前後の論点。
     どの一覧から来たか（ctx）は履歴の各ページに持たせ、スワイプで戻っても進んでも崩れないようにする。
     PCは従来どおり、一覧の中でカードを開く。 */
  var BYID = {};
  ALL.concat(BASE).forEach(function (r) { BYID[r.id] = r; });
  var DV = el("section", { class: "chapter view detail", "data-vid": "detail" });
  main.insertBefore(DV, main.querySelector(".foot"));
  var DETAIL = { id: "detail", el: DV, t: "", parent: "" }, CTX = null, PENDING = null, LAST = null;
  function rowsIn(box, withHidden) {
    return Array.prototype.slice.call(box.querySelectorAll(":scope > .rc")).filter(function (d) { return withHidden || !d.hidden; }).map(function (d) { return d.getAttribute("data-rid"); });
  }
  function copy(o) { var n = {}; Object.keys(o || {}).forEach(function (k) { n[k] = Array.isArray(o[k]) ? o[k].slice() : o[k]; }); return n; }
  // その場から開いた：戻り先＝いまのページ（履歴を1つ戻る）
  function ctxHere(ids) {
    var v = current;
    if (!v || v === DETAIL) return null;
    return { from: v.id, fromTitle: v.g.k === "home" ? "ホーム" : v.t, fromG: v.g.k, ids: ids, depth: 1, list: true };
  }
  // 外から直接来た（ウォッチの帯・共有されたリンクなど）：戻り先＝その論点の持ち場の一覧
  function homeCtx(r) {
    var a = document.querySelector('[data-anchor="r-' + r.id + '"]');
    var vEl = a && a.closest("[data-vid]"), info = vEl && VIEWS[vEl.getAttribute("data-vid")];
    if (!info) return { from: "home", fromTitle: "ホーム", fromG: "home", ids: [r.id], depth: 0, list: false };
    return { from: info.id, fromTitle: info.t, fromG: info.g.k, ids: rowsIn(a.parentElement, a.hidden), depth: 0, list: false };
  }
  function openCard(id, ctx) { if (!BYID[id]) return; PENDING = ctx; go("r-" + id); }
  function goBack() {
    var c = CTX;
    if (c && c.list && c.depth > 0) { try { history.go(-c.depth); return; } catch (e) {} }
    go(c ? c.from : "home");
  }
  function showDetail(r, ctx, pushed) {
    CTX = ctx; setState({ ctx: ctx });
    var i = ctx.ids.indexOf(r.id), n = ctx.ids.length;
    var prev = i > 0 ? BYID[ctx.ids[i - 1]] : null, next = i >= 0 && i < n - 1 ? BYID[ctx.ids[i + 1]] : null;
    DV.innerHTML = "";
    var top = el("div", { class: "dt-top" });
    top.appendChild(el("a", { class: "dt-back", href: "#" + ctx.from }, ARR.prev + "<span>" + esc(ctx.fromTitle) + "</span>"));
    if (n > 1 && i >= 0) top.appendChild(el("span", { class: "dt-pos" }, (i + 1) + " / " + n));
    DV.appendChild(top);
    var wrap = el("article", { class: "rc is-page" });
    wrap.innerHTML = '<header class="dt-h"><span class="tags">' + tagsHtml(r, { noNew: !!r.stageLabel }) + '</span><h2 class="dt-t">' + esc(r.title) + "</h2>" +
      ((r.services || []).length ? '<p class="dt-s">' + esc(r.services.join("・")) + "</p>" : "") + "</header>";
    wrap.appendChild(body(r));
    DV.appendChild(wrap);
    if (prev || next) {
      var nav = pager("前後の論点", prev && ["#r-" + prev.id, "前の論点", prev.title], next && ["#r-" + next.id, "次の論点", next.title]);
      nav.classList.add("rpager");
      DV.appendChild(nav);
    }
    each(document.querySelectorAll(".view.is-active"), function (x) { x.classList.remove("is-active"); });
    DV.classList.toggle("from-right", !!pushed);
    DV.classList.add("is-active");
    var h2 = DV.querySelector(".dt-t");   // 読み上げ・キーボードでも、新しいページの題名から始まるようにする
    if (h2) { h2.setAttribute("tabindex", "-1"); if (pushed) { try { h2.focus({ preventScroll: true }); } catch (e) {} } }
    DETAIL.t = r.title; DETAIL.parent = ctx.fromTitle; current = DETAIL;
    shell.classList.add("no-sub"); shell.classList.remove("is-home");
    subnav.innerHTML = "";
    markNav(ctx.fromG || "svc", ctx.from);
    document.title = r.title + "｜令和9年度 障害福祉報酬改定ガイド";
    READ[r.id] = 1; LAST = r.id;
    each(document.querySelectorAll('.rc[data-rid="' + r.id + '"]'), function (d) { d.classList.add("is-read"); });
  }
  // 論点のページから一覧へ戻ったとき、読んでいた行を少しだけ光らせる（どこまで読んだかを見失わない）
  function flashLast() {
    if (!current || current === DETAIL) return;
    var id = LAST; LAST = null;
    if (!id) return;
    var d = current.el.querySelector('.rc[data-rid="' + id + '"]');
    if (!d) return;
    d.classList.remove("is-last"); void d.offsetWidth; d.classList.add("is-last");
  }
  function place(intent, st) {
    if (intent !== "push" && typeof st.y === "number") { var y = st.y; requestAnimationFrame(function () { jumpTo(y); flashLast(); reqCx(); }); }
    else { LAST = null; jumpTop(); reqCx(); }
  }

  var NAVTYPE = "";
  try { var ne = performance.getEntriesByType("navigation")[0]; NAVTYPE = ne ? ne.type : ""; } catch (e) {}
  var firstRoute = true;
  function route() {
    var intent = navIntent; navIntent = null;
    var st = getState(), id = "";
    if (firstRoute && NAVTYPE === "reload") st = { ctx: st.ctx };   // 再読み込みは選び直し・先頭から
    firstRoute = false;
    try { id = decodeURIComponent((location.hash || "").slice(1)); } catch (e) { id = ""; }
    var pend = PENDING; PENDING = null;
    if (/^r-/.test(id) && MQ.matches && BYID[id.slice(2)]) {
      var r = BYID[id.slice(2)];
      var ctx = intent === "push" && pend ? pend : (st.ctx || null);
      if (!ctx || !ctx.ids || ctx.ids.indexOf(r.id) < 0) ctx = homeCtx(r);
      showDetail(r, ctx, intent === "push");
      place(intent, st);
      return;
    }
    if (!id || id === "top") { show(VIEWS.home); place(intent, st); return; }
    if (VIEWS[id]) { show(VIEWS[id]); place(intent, st); return; }
    var t = $(id) || document.querySelector('[data-anchor="' + id.replace(/["\\]/g, "") + '"]');
    var vEl = t && t.closest(".view");
    var vid = vEl && vEl.getAttribute("data-vid");
    if (!t || !vEl || !VIEWS[vid]) { show(VIEWS.home); place(intent, st); return; }
    show(VIEWS[vid]);
    if (t.classList.contains("extra") && window.__showBaseExtra) window.__showBaseExtra();
    if (t.tagName === "DETAILS") t.open = true;
    var p = t.parentElement;
    while (p && p !== vEl) { if (p.tagName === "DETAILS") p.open = true; p = p.parentElement; }
    if (intent !== "push" && typeof st.y === "number") { place(intent, st); return; }
    requestAnimationFrame(function () { try { t.scrollIntoView({ block: "start", behavior: "instant" }); } catch (e) { t.scrollIntoView(); } reqCx(); });
  }
  window.addEventListener("hashchange", route);
  try { MQ.addEventListener("change", route); } catch (e) { try { MQ.addListener(route); } catch (e2) {} }

  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target; if (!t || !t.closest) return;
    // スマホ：一覧の行（論点）を押したら、論点のページへ
    var sm = MQ.matches && t.closest(".cards > .rc > summary");
    if (sm) { e.preventDefault(); var d = sm.parentElement; openCard(d.getAttribute("data-rid"), ctxHere(rowsIn(d.parentElement, false))); return; }
    var a = t.closest('a[href^="#"]');
    if (!a) return;
    var href = a.getAttribute("href");
    if (a === brand && tb.classList.contains("cx-on")) { e.preventDefault(); return; }   // 現在地を出しているあいだは押しても動かない
    if (a.classList.contains("dt-back")) { e.preventDefault(); goBack(); return; }
    if (a.closest(".rpager")) { e.preventDefault(); var c = copy(CTX); c.depth = (CTX && CTX.depth || 0) + 1; openCard(href.slice(3), c); return; }
    if (MQ.matches && /^#r-/.test(href)) {
      e.preventDefault();
      var box = a.closest("ul, ol");
      var ids = box ? Array.prototype.slice.call(box.querySelectorAll('a[href^="#r-"]')).map(function (x) { return x.getAttribute("href").slice(3); }).filter(function (x) { return BYID[x]; }) : [];
      openCard(href.slice(3), ctxHere(ids.length > 1 ? ids : [href.slice(3)]));
      return;
    }
    saveY(); navIntent = "push";
    if (href === location.hash || (href === "#home" && !location.hash)) { e.preventDefault(); route(); }
  }, true);

  /* ── 上のバーの現在地（スマホ） ─────────
     ページの見出しが上に隠れたら、ガイド名の代わりに「親 › いまのページ」を出す。押しても動かない（ショートカットにしない） */
  var tb = document.querySelector(".topbar"), brand = tb && tb.querySelector(".brand"), BRAND = brand ? brand.innerHTML : "", cxKey = "", cxTick = false;
  function headOf(v) { return v === DETAIL ? DV.querySelector(".dt-t") : v.el.querySelector(".chapter > header h2"); }
  function updCx() {
    cxTick = false; if (!brand) return;
    var on = false, parent = "", title = "";
    if (MQ.matches && current && (current === DETAIL || current.g.k !== "home")) {
      var h = headOf(current);
      on = h ? h.getBoundingClientRect().bottom < tb.getBoundingClientRect().bottom : window.scrollY > 160;
      if (current === DETAIL) { parent = DETAIL.parent; title = DETAIL.t; }
      else { title = current.t; parent = current.t.indexOf(current.g.t) >= 0 ? "" : current.g.t; }
    }
    var key = on ? parent + "|" + title : "";
    if (key === cxKey) return;
    cxKey = key;
    tb.classList.toggle("cx-on", on);
    brand.innerHTML = on ? '<span class="cx">' + (parent ? "<small>" + esc(parent) + "</small>" : "") + "<b>" + esc(title) + "</b></span>" : BRAND;
  }
  function reqCx() { if (!cxTick) { cxTick = true; requestAnimationFrame(updCx); } }
  window.addEventListener("scroll", reqCx, { passive: true });
  window.addEventListener("resize", reqCx);
  route();
})();
