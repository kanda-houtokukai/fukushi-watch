(function () {
  "use strict";
  var DATA = window.GUIDE_DATA || {};
  var LIVE = {};
  try { LIVE = JSON.parse(document.getElementById("live-data").textContent) || {}; } catch (e) { LIVE = {}; }
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  };
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
  function $(id) { return document.getElementById(id); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  var QA_LOAD = null, QA_DRAW = null;
  var CACHE = {};
  function getJSON(path, cb) {
    if (CACHE[path]) { if (CACHE[path].data) cb(CACHE[path].data); else CACHE[path].wait.push(cb); return; }
    CACHE[path] = { wait: [cb] };
    fetch(path, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (j) {
      CACHE[path].data = j; var w = CACHE[path].wait; CACHE[path].wait = []; w.forEach(function (f) { f(j); });
    }).catch(function () { var w = CACHE[path].wait; delete CACHE[path]; w.forEach(function (f) { f(null); }); });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* ── 日付（日本時間で数える） ─────────── */
  var DAY = 86400000, JST = 9 * 3600000;
  var NOW = Date.now();
  var TODAY = Math.floor((NOW + JST) / DAY) * DAY - JST;          // 今日 0:00（日本時間）
  var WD = "日月火水木金土";
  function dayOf(s) { return Date.parse(String(s).slice(0, 10) + "T00:00:00+09:00"); }
  function parts(ms) { var d = new Date(ms + JST); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: WD[d.getUTCDay()], hh: d.getUTCHours(), mi: d.getUTCMinutes() }; }
  function md(ms) { var p = parts(ms); return p.m + "月" + p.d + "日"; }
  function ymd(ms) { var p = parts(ms); return p.y + "年" + p.m + "月" + p.d + "日"; }
  function hm(ms) { var p = parts(ms); return p.hh + ":" + (p.mi < 10 ? "0" : "") + p.mi; }
  var SEKO = dayOf("2026-12-25"), KOFU = dayOf("2024-06-26");

  /* ── 施行日までの日数 ───────────────── */
  (function countdown() {
    var left = Math.round((SEKO - TODAY) / DAY);
    var txt;
    if (left > 0) txt = "施行まで あと<b>" + left + "</b>日";
    else if (left === 0) txt = "<b>本日</b>施行";
    else txt = "施行から<b>" + (-left) + "</b>日";
    if ($("cd-chip")) $("cd-chip").innerHTML = txt;
    if ($("cd-left")) $("cd-left").innerHTML = txt;
    var bar = $("cd-bar");
    if (bar) {
      var p = Math.max(0, Math.min(1, (NOW - KOFU) / (SEKO - KOFU)));
      requestAnimationFrame(function () { bar.style.width = (p * 100).toFixed(1) + "%"; });
    }
    var cap = $("now-cap");
    if (cap) cap.textContent = left > 0 ? "施行まで、あと" + left + "日。" : (left === 0 ? "本日施行。" : "施行日を過ぎています。");
    // 第1章の図：今日の位置（10/27 を x=40、12/25 を x=920 として描いている）
    var dot = $("now-dot"), lbl = $("now-lbl"), pass = $("now-pass");
    if (dot && lbl) {
      var d0 = dayOf("2026-10-27");
      var x = 40 + Math.max(0, Math.min(59, (TODAY - d0) / DAY)) * (880 / 59);
      dot.setAttribute("cx", x.toFixed(1));
      if (pass) pass.setAttribute("x2", x.toFixed(1));
      var p2 = parts(TODAY);
      lbl.textContent = "今日 " + p2.m + "/" + p2.d;
      lbl.setAttribute("x", x.toFixed(1));
      lbl.setAttribute("text-anchor", x < 90 ? "start" : (x > 860 ? "end" : "middle"));
    }
  })();

  /* ── 最終確認の日時 ─────────────────── */
  var CHECKED = LIVE.checkedAt ? Date.parse(LIVE.checkedAt) : null;
  each(document.querySelectorAll(".js-checked"), function (n) { if (CHECKED) n.textContent = ymd(CHECKED) + " " + hm(CHECKED); });
  if ($("checked-at") && CHECKED) $("checked-at").textContent = "情報の確認 " + ymd(CHECKED);


  /* ── 判定フロー ─────────────────────── */
  var PILL = { gimu: "義務", nintei: "認定（任意）", gai: "対象外", kakunin: "個別に確認", doryoku: "努力義務" };
  function renderTree(host) {
    var id = host.getAttribute("data-tree");
    var tree = (DATA.trees || {})[id];
    if (!tree) return;
    var path = [];
    host.classList.add("dt");
    host.innerHTML = "";
    var head = el("div", { class: "dt-head" });
    head.appendChild(el("div", { class: "dt-title" }, tree.title));
    var reset = el("button", { class: "btn", type: "button" }, "最初から");
    head.appendChild(reset);
    var body = el("div", { class: "dt-body", "aria-live": "polite" });
    host.appendChild(head); host.appendChild(body);

    function show(nodeId) {
      var node = tree.nodes[nodeId];
      body.innerHTML = "";
      reset.hidden = path.length === 0;
      if (path.length) {
        var trail = el("ol", { class: "dt-trail", "aria-label": "これまでの回答" });
        path.forEach(function (s, i) {
          var li = el("li", null, s.q + " → <b>" + s.a + "</b>");
          li.style.cursor = "pointer";
          li.title = "ここからやり直す";
          li.addEventListener("click", function () { var back = path[i].node; path = path.slice(0, i); show(back); });
          trail.appendChild(li);
        });
        body.appendChild(trail);
      }
      if (node.result) {
        var r = el("div", { class: "dt-res r-" + node.result });
        r.appendChild(el("div", { class: "res-t" }, '<span class="pill ' + node.result + '">' + (node.pill || PILL[node.result] || "") + "</span>" + node.title));
        if (node.body) r.appendChild(el("div", null, node.body));
        body.appendChild(r);
        var acts = el("div", { class: "dt-actions" });
        if (path.length) {
          var back = el("button", { class: "btn", type: "button" }, "ひとつ戻る");
          back.addEventListener("click", function () { var last = path.pop(); show(last.node); });
          acts.appendChild(back);
        }
        var again = el("button", { class: "btn primary", type: "button" }, "別のケースを判定");
        again.addEventListener("click", function () { path = []; show(tree.start); });
        acts.appendChild(again);
        if (node.link) { var a = el("a", { class: "btn", href: node.link[0] }, node.link[1]); acts.appendChild(a); }
        body.appendChild(acts);
        return;
      }
      body.appendChild(el("p", { class: "dt-q" }, node.q));
      if (node.hint) body.appendChild(el("p", { class: "dt-hint" }, node.hint));
      var opts = el("div", { class: "dt-opts" });
      node.opts.forEach(function (o) {
        var b = el("button", { class: "dt-opt", type: "button" }, "<span>" + o.label + "</span>" + (o.sub ? "<small>" + o.sub + "</small>" : ""));
        b.addEventListener("click", function () { path.push({ node: nodeId, q: node.short || node.q.replace(/<[^>]+>/g, ""), a: o.short || o.label.replace(/<[^>]+>/g, "") }); show(o.next); });
        opts.appendChild(b);
      });
      body.appendChild(opts);
      if (path.length) {
        var acts2 = el("div", { class: "dt-actions" });
        var back2 = el("button", { class: "btn", type: "button" }, "ひとつ戻る");
        back2.addEventListener("click", function () { var last = path.pop(); show(last.node); });
        acts2.appendChild(back2);
        body.appendChild(acts2);
      }
    }
    reset.addEventListener("click", function () { path = []; show(tree.start); });
    show(tree.start);
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-tree]"), renderTree);

  /* ── チェックリスト ─────────────────── */
  (function checklist() {
    var host = document.getElementById("ck-list");
    var phases = DATA.checklist;
    if (!host || !phases) return;
    var KEY = "dbs-guide-check-v1";
    var saved = {};
    try { saved = JSON.parse(store.get(KEY) || "{}") || {}; } catch (e) { saved = {}; }
    host.classList.add("ck");
    phases.forEach(function (ph) {
      var box = el("section", { class: "ck-phase" });
      var hd = el("header");
      hd.appendChild(el("h4", null, ph.title + (ph.when ? ' <span class="when">' + ph.when + "</span>" : "")));
      var cnt = el("span", { class: "ck-count" });
      hd.appendChild(cnt);
      box.appendChild(hd);
      var meter = el("div", { class: "ck-meter" }, "<i></i>");
      box.appendChild(meter);
      var ul = el("ul");
      ph.items.forEach(function (it) {
        var li = el("li");
        var lab = el("label");
        var cb = el("input", { type: "checkbox", id: "ck-" + it.id });
        cb.checked = !!saved[it.id];
        lab.appendChild(cb);
        var TAG = { law: '<span class="pill kakunin">法違反</span>', gimu: '<span class="pill gimu">義務</span>', rec: '<span class="pill doryoku">推奨</span>' };
        lab.appendChild(el("span", null, "<b>" + it.t + "</b>" + (it.tag ? '<span class="who">' + TAG[it.tag] + "</span>" : "") + (it.d ? '<span class="d">' + it.d + "</span>" : "")));
        cb.addEventListener("change", function () { saved[it.id] = cb.checked; store.set(KEY, JSON.stringify(saved)); update(); });
        li.appendChild(lab); ul.appendChild(li);
      });
      box.appendChild(ul);
      function update() {
        var n = ph.items.filter(function (it) { return saved[it.id]; }).length;
        cnt.textContent = n + " / " + ph.items.length + " 完了";
        meter.firstChild.style.width = (n / ph.items.length * 100) + "%";
      }
      update();
      host.appendChild(box);
    });
    var clr = document.getElementById("ck-clear");
    if (clr) {
      var armed = false;
      clr.addEventListener("click", function () {
        if (!armed) { armed = true; clr.textContent = "もう一度押すと全てのチェックを外します"; setTimeout(function () { armed = false; clr.textContent = "チェックをすべて外す"; }, 4000); return; }
        saved = {}; store.set(KEY, "{}");
        Array.prototype.forEach.call(host.querySelectorAll("input[type=checkbox]"), function (c) { c.checked = false; c.dispatchEvent(new Event("change")); });
        armed = false; clr.textContent = "チェックをすべて外す";
      });
    }
  })();

  /* ── 日程：済んだこと・今日の印 ─────────── */
  (function schedule() {
    var ol = $("tl-main");
    if (!ol) return;
    var lis = Array.prototype.slice.call(ol.querySelectorAll("li[data-d]"));
    var done = [], insertBefore = null;
    lis.forEach(function (li) {
      var d = dayOf(li.getAttribute("data-d"));
      if (d < TODAY) { li.classList.add("done"); done.push(li); }
      else if (!insertBefore) insertBefore = li;
    });
    var p = parts(TODAY);
    var now = el("li", { class: "now" }, '<span class="when">今日</span><span class="dot"></span><span class="what"><b>' + p.m + "月" + p.d + "日（" + p.w + "）</b></span>");
    ol.insertBefore(now, insertBefore);
    var hide = done.slice(0, Math.max(0, done.length - 2));
    if (hide.length) {
      hide.forEach(function (li) { li.hidden = true; });
      var wrap = el("div", { class: "tl-toggle" });
      var b = el("button", { class: "btn", type: "button", "aria-expanded": "false" }, "これまでの経過を表示（" + hide.length + "件）");
      b.addEventListener("click", function () {
        var open = b.getAttribute("aria-expanded") !== "true";
        hide.forEach(function (li) { li.hidden = !open; });
        b.setAttribute("aria-expanded", open ? "true" : "false");
        b.textContent = open ? "これまでの経過をたたむ" : "これまでの経過を表示（" + hide.length + "件）";
      });
      wrap.appendChild(b);
      ol.parentNode.insertBefore(wrap, ol);
    }
  })();

  /* ── Q&A（検索・分類） ─────────────── */
  (function qa() {
    var list = $("qa-list");
    var items = DATA.qa;
    if (!list || !items) return;
    var input = $("qa-q"), chipsHost = $("qa-chips"), kindHost = $("qa-kind"), meta = $("qa-count");
    // 分類（公式Q&Aは章から決める。「研修」は問と答に研修を含むものにも付ける）
    var CAT_ORDER = ["制度全般", "定義", "対象事業", "対象者", "障害福祉", "確認の手続", "時期・期限", "安全確保措置", "研修", "事案対応", "防止措置", "採用・労務", "情報管理", "システム", "認定", "監督・報告", "費用・支援", "その他"];
    var CHAP = [[/総論/, "制度全般"], [/定義/, "定義"], [/対象事業/, "対象事業"], [/認定/, "認定"], [/犯罪事実確認/, "確認の手続"], [/防止措置/, "防止措置"],
      [/安全確保措置/, "安全確保措置"], [/情報管理/, "情報管理"], [/監督/, "監督・報告"], [/その他/, "その他"]];
    var PART = { "基礎編": "k", "応用編": "o", "まとめ登録": "m" };
    var SRCT = { qa: "こども性暴力防止法に関するQ&A（令和8年9月29日改訂）", "qa-matome": "事業者アカウントまとめ登録に関するQ&A（令和8年6月）" };
    var DOCU = {}; (DATA.docs && DATA.docs.docs || []).forEach(function (d) { DOCU[d.slug] = d.u; });
    var nodes = [], active = "すべて", kind = "all";
    function addNode(q, i) {
      var off = q.kind === "official";
      var d = el("details", { class: "qa" + (off ? " is-off" : ""), id: off ? "qo-" + q.key : q.id ? "qm-" + q.id : "qa-" + (i + 1) });
      var s = el("summary");
      var badge = off ? '<span class="qk off">公式Q&amp;A ' + esc(q.label) + "</span>" : '<span class="qk mat">資料から回答</span>';
      s.innerHTML = '<span class="qt"></span><span class="tags">' + badge + q.cat.map(function (c) { return "<span>" + c + "</span>"; }).join("") + "</span>";
      d.appendChild(s);
      var body = off ? q.a.map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("") : q.a;
      var src = off
        ? '<div class="src">出典：こども家庭庁「' + esc(SRCT[q.doc] || "") + "」" + esc(q.label) + '（<a href="' + esc(DOCU[q.doc] || "") + "#page=" + q.p + '" target="_blank" rel="noopener">p.' + q.p + "</a>）</div>"
        : (q.src ? '<div class="src">根拠・出典：' + q.src + "</div>" : "") + (q.more ? '<div class="src">' + q.more + "</div>" : "");
      var a = el("div", { class: "a" }, body + src);
      d.appendChild(a);
      list.insertBefore(d, empty);
      var x = { d: d, qt: s.querySelector(".qt"), q: q, off: off, text: (q.q + " " + (off ? q.label + " " + q.a.join(" ") : a.textContent) + " " + q.cat.join(" ")).normalize("NFKC").toLowerCase() };
      nodes.push(x);
      return x;
    }
    var empty = el("div", { class: "qa-empty", hidden: "" }, "該当する質問が見つかりませんでした。言葉を変えるか、分類を「すべて」に戻してください。");
    list.appendChild(empty);
    items.forEach(function (q, i) {
      var c = q.cat.slice();
      if (/研修/.test(q.q) && c.indexOf("研修") < 0) c.push("研修");
      addNode({ kind: "guide", id: q.id, q: q.q, a: q.a, src: q.src, more: q.more, cat: c }, i);
    });
    var cats = [];
    function drawChips() {
      var have = {};
      nodes.forEach(function (x) { x.q.cat.forEach(function (c) { have[c] = 1; }); });
      cats = CAT_ORDER.filter(function (c) { return have[c]; }).concat(Object.keys(have).filter(function (c) { return CAT_ORDER.indexOf(c) < 0; }));
      chipsHost.innerHTML = "";
      ["すべて"].concat(cats).forEach(function (c) {
        var b = el("button", { class: "chip", type: "button", "aria-pressed": c === active ? "true" : "false" }, c);
        b.addEventListener("click", function () { active = c; each(chipsHost.children, function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); }); draw(); });
        chipsHost.appendChild(b);
      });
    }
    if (kindHost) [["all", "すべて"], ["guide", "資料から回答"], ["official", "公式Q&A"]].forEach(function (k) {
      var b = el("button", { type: "button", "aria-pressed": k[0] === kind ? "true" : "false" }, k[1]);
      b.addEventListener("click", function () { kind = k[0]; each(kindHost.children, function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); }); draw(); });
      kindHost.appendChild(b);
    });
    var loaded = false;
    function loadOfficial(cb) {
      if (loaded) { if (cb) cb(); return; }
      getJSON("qa_mat.json", function (mj) {
      getJSON("qa_official.json", function (j) {
        if (!loaded && j) {
          loaded = true;
          (mj || []).forEach(function (q) {
            var c = q.cat.slice();
            if (/研修/.test(q.q) && c.indexOf("研修") < 0) c.push("研修");
            addNode({ kind: "guide", id: q.id, q: q.q, a: q.a, more: q.more, cat: c }, 0);
          });
          j.forEach(function (o) {
            var cat = [];
            if (o.doc === "qa-matome") cat.push("システム");
            else CHAP.some(function (m) { if (m[0].test(o.chap || "")) { cat.push(m[1]); return true; } return false; });
            if (/研修/.test(o.q + o.a.join("")) && cat.indexOf("研修") < 0) cat.push("研修");
            var key = (PART[o.part] || "x") + o.no;
            addNode({ kind: "official", key: key, label: (o.part === "まとめ登録" ? "まとめ登録" : o.part) + o.no, q: o.q, a: o.a, cat: cat, doc: o.doc, p: o.p });
          });
          drawChips(); draw();
        }
        if (cb) cb();
      });
      });
    }
    QA_LOAD = loadOfficial;
    function draw() {
      var term = (input.value || "").trim().normalize("NFKC").toLowerCase();
      var words = term.split(/\s+/).filter(Boolean);
      var n = 0, nOff = 0, nMat = 0;
      nodes.forEach(function (x) {
        var okKind = kind === "all" || (kind === "official") === x.off;
        var okCat = active === "すべて" || x.q.cat.indexOf(active) >= 0;
        var okTerm = words.every(function (w) { return x.text.indexOf(w) >= 0; });
        var show = okKind && okCat && okTerm;
        x.d.hidden = !show;
        if (show) { n++; if (x.off) nOff++; else nMat++; }
        var t = esc(x.q.q);
        if (words.length) words.forEach(function (w) { var re = new RegExp("(" + esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"); t = t.replace(re, "<mark>$1</mark>"); });
        x.qt.innerHTML = t;
      });
      meta.textContent = n + " 件を表示（資料から回答 " + nMat + "・公式Q&A " + nOff + "）" + (loaded ? "" : "・資料から回答と公式Q&Aを読み込み中");
      empty.hidden = n !== 0 || !loaded;
    }
    input.addEventListener("input", draw);
    if ($("qa-open")) $("qa-open").addEventListener("click", function () { nodes.forEach(function (x) { if (!x.d.hidden) x.d.open = true; }); });
    if ($("qa-close")) $("qa-close").addEventListener("click", function () { nodes.forEach(function (x) { x.d.open = false; }); });
    drawChips(); draw();
    QA_DRAW = draw;
  })();

  /* ── 研修・説明会 ─────────────────────── */
  var KIND = { official: "国", municipal: "自治体", private: "民間" };
  var FMT = { online: "オンライン", venue: "会場", ondemand: "オンデマンド", fukuoka: "福岡県内" };
  var EVENTS = (LIVE.events || []).slice();
  function evState(e) {
    var st = Date.parse(e.start), en = Date.parse(e.end || e.start);
    if (en < NOW) return { t: "終了", c: "past" };
    if (e.status === "cancelled") return { t: "中止", c: "past" };
    if (e.status === "waitlist") return { t: "キャンセル待ち", c: "wait" };
    if (e.status === "planned") return { t: "公開予定", c: "plan" };
    if (st <= NOW) return { t: e.fmt.indexOf("ondemand") >= 0 ? "配信中" : "開催中", c: "live" };
    var d = Math.round((dayOf(e.start) - TODAY) / DAY);
    return { t: d <= 0 ? "今日" : (d === 1 ? "明日" : "あと" + d + "日"), c: "soon" };
  }
  function evKey(e) { var st = Date.parse(e.start), en = Date.parse(e.end || e.start); if (en < NOW || e.status === "cancelled") return 8e12 + st; if (st <= NOW && e.fmt.indexOf("ondemand") >= 0) return 4e12 + en; return st; }
  EVENTS.sort(function (a, b) { return evKey(a) - evKey(b); });

  (function events() {
    var host = $("ev-list");
    if (!host) return;
    var focus = LIVE.eventsFocus;
    if ($("ev-focus") && focus && focus.title && (!focus.until || dayOf(focus.until) >= TODAY)) {
      $("ev-focus").innerHTML = '<p class="box-t">' + esc(focus.title) + "</p><p>" + esc(focus.body) + "</p>";
      $("ev-focus").hidden = false;
    }
    if ($("ev-local-note") && LIVE.eventsLocalNote) $("ev-local-note").textContent = LIVE.eventsLocalNote;
    var chips = $("ev-chips"), showPast = $("ev-past"), meta = $("ev-count");
    var FILTERS = [
      { k: "all", t: "すべて" },
      { k: "fukuoka", t: "福岡県内の会場" },
      { k: "online", t: "オンライン（Zoom・YouTube）" },
      { k: "ondemand", t: "オンデマンド" },
      { k: "venue", t: "会場開催（全国）" }
    ];
    var active = "all";
    FILTERS.forEach(function (f) {
      var b = el("button", { class: "chip", type: "button", "aria-pressed": f.k === active ? "true" : "false" }, f.t);
      b.addEventListener("click", function () {
        active = f.k;
        each(chips.children, function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        draw();
      });
      chips.appendChild(b);
    });
    var rows = EVENTS.map(function (e) {
      var s = evState(e);
      var card = el("article", { class: "ev " + s.c + (e.featured ? " featured" : ""), id: "ev-" + (e.id || "") });
      var badges = e.fmt.map(function (f) { return '<span class="evb">' + FMT[f] + "</span>"; }).join("") + '<span class="evb k-' + e.kind + '">' + KIND[e.kind] + "</span>";
      card.innerHTML =
        '<div class="ev-when"><span class="ev-state">' + s.t + '</span><span class="ev-date">' + esc(e.date) + "</span></div>" +
        '<div class="ev-body"><div class="ev-badges">' + badges + "</div>" +
        "<h4>" + esc(e.title) + "</h4>" +
        '<p class="ev-org">' + esc(e.org) + "</p>" +
        '<dl class="ev-dl">' +
          (e.place ? "<div><dt>会場</dt><dd>" + esc(e.place) + "</dd></div>" : "") +
          "<div><dt>対象</dt><dd>" + esc(e.target) + "</dd></div>" +
          "<div><dt>費用</dt><dd>" + esc(e.fee) + "</dd></div>" +
          "<div><dt>定員</dt><dd>" + esc(e.cap) + "</dd></div>" +
          "<div><dt>申込</dt><dd>" + esc(e.how) + "</dd></div>" +
        "</dl>" +
        (e.note ? '<p class="ev-note">' + esc(e.note) + "</p>" : "") +
        '<a class="btn" href="' + esc(e.url) + '" target="_blank" rel="noopener">主催者のページを開く</a>' +
        "</div>";
      host.appendChild(card);
      return { card: card, e: e, past: s.c === "past" };
    });
    var empty = el("div", { class: "qa-empty", hidden: "" }, "この条件に当てはまる研修・説明会は、最終確認の時点で見つかっていません。");
    host.appendChild(empty);
    function draw() {
      var n = 0, inclPast = showPast && showPast.checked;
      rows.forEach(function (r) {
        var ok = (active === "all" || r.e.fmt.indexOf(active) >= 0) && (inclPast || !r.past);
        r.card.hidden = !ok; if (ok) n++;
      });
      empty.hidden = n !== 0;
      if (meta) meta.textContent = n + " 件を表示";
    }
    if (showPast) showPast.addEventListener("change", draw);
    draw();
  })();

  (function library() {
    var host = $("lib-list");
    if (!host || !LIVE.library) return;
    LIVE.library.forEach(function (l) {
      host.appendChild(el("li", null, '<span class="evb k-' + l.kind + '">' + KIND[l.kind] + '</span><span><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.title) + "</a><small>" + esc(l.note) + "</small></span>"));
    });
  })();

  /* ── ページ（ビュー）の一覧 ───────────── */
  var GROUPS = [
    { k: "home", t: "ホーム" }, { k: "todo", t: "やること" }, { k: "tools", t: "判定ツール" },
    { k: "basics", t: "しくみ" }, { k: "ops", t: "運用" }, { k: "sectors", t: "事業別" },
    { k: "qa", t: "Q&A" }, { k: "events", t: "研修・窓口" }, { k: "docs", t: "資料" }, { k: "updates", t: "更新情報" }
  ];
  var VIEWS = {}, SEQ = [];
  GROUPS.forEach(function (g) { g.views = []; });
  each(document.querySelectorAll(".view"), function (v) {
    var g = GROUPS.filter(function (x) { return x.k === v.getAttribute("data-group"); })[0];
    if (!g) return;
    var info = { id: v.id, el: v, g: g, t: v.getAttribute("data-title") };
    VIEWS[v.id] = info;
    if (!v.hasAttribute("data-hidden")) g.views.push(info);   // 資料のページ（#doc-…）は一覧・前後のページに出さない
  });
  // 並び順は ORDER と GROUPS に従う（同じグループ内は文書順）
  GROUPS.forEach(function (g) { g.views.forEach(function (v) { if (g.k !== "home") SEQ.push(v); }); });
  // ページ（ビュー）の要素から id を外す。#schedule などで開いたとき、ブラウザがその位置へ勝手に移り、
  // 上の「福祉情報ウォッチに戻る」が隠れて途中から表示されるのを防ぐ（報酬改定ガイドと同じ・切り替えは VIEWS で行う）
  Object.keys(VIEWS).forEach(function (k) { var e = VIEWS[k].el; e.setAttribute("data-vid", k); e.removeAttribute("id"); });
  function viewTitle(id) {
    if (VIEWS[id]) return VIEWS[id].t || "";
    var n = $(id); if (!n) return "";
    var v = n.closest(".view");
    return v ? (VIEWS[v.getAttribute("data-vid")] || {}).t || "" : "";
  }

  /* ── 前後のページ ─────────────────── */
  // 薄い色の面に、矢印・「次へ」・行き先を1行で収める（報酬改定ガイドと同じ部品・ユーザー指示 2026-10-27）
  var ARR = {
    prev: '<svg class="pa" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg class="pa" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function plain(t) { var d = document.createElement("div"); d.innerHTML = t; return d.textContent; }
  function pgLink(dir, href, k, t) {
    return el("a", { class: dir, href: href, "aria-label": k + "：" + plain(t) }, (dir === "prev" ? ARR.prev : "") + '<span class="pk">' + esc(k) + "</span>" +
      (dir === "prev" ? '<span class="ps">前へ</span>' : "") + '<span class="pt">' + t + "</span>" + (dir === "next" ? ARR.next : ""));
  }
  SEQ.forEach(function (v, i) {
    var prev = SEQ[i - 1], next = SEQ[i + 1];
    if (!prev && !next) return;
    function dest(x) { return x.g !== v.g && plain(x.t).indexOf(x.g.t) < 0 ? esc(x.g.t) + " › " + x.t : x.t; }
    var nav = el("nav", { class: "pager" + (prev && next ? " two" : ""), "aria-label": "前後のページ" });
    if (prev) nav.appendChild(pgLink("prev", "#" + prev.id, "前へ", dest(prev)));
    if (next) nav.appendChild(pgLink("next", "#" + next.id, "次へ", dest(next)));
    v.el.appendChild(nav);
  });

  /* ── メニュー（全ページ） ───────────── */
  var drawer = $("drawer"), drawerList = $("drawer-list"), menuBtn = $("menu-btn");
  if (drawerList) {
    drawerList.appendChild(el("a", { class: "dback", href: "../" }, '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>福祉情報ウォッチに戻る</span>'));
    GROUPS.forEach(function (g) {
      if (!g.views.length) return;
      var box = el("div", { class: "dg" });
      box.appendChild(el("a", { href: "#" + g.views[0].id, "data-v": g.views[0].id }, esc(g.t)));
      if (g.views.length > 1) {
        var ul = el("ul");
        g.views.forEach(function (v) { var li = el("li"); li.appendChild(el("a", { href: "#" + v.id, "data-v": v.id }, v.t)); ul.appendChild(li); });
        box.appendChild(ul);
      }
      drawerList.appendChild(box);
    });
  }
  function setDrawer(open) {
    if (!drawer) return;
    if (open) {
      var tb = document.querySelector(".topbar");
      if (tb) drawer.style.top = Math.max(0, Math.round(tb.getBoundingClientRect().bottom)) + "px";
    }
    drawer.hidden = !open;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    document.documentElement.classList.toggle("drawer-open", open);
  }
  if (menuBtn) menuBtn.addEventListener("click", function () { setDrawer(drawer.hidden); });
  if (drawer) drawer.addEventListener("click", function (e) { if (e.target === drawer || e.target.closest("a")) setDrawer(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && drawer && !drawer.hidden) { setDrawer(false); menuBtn.focus(); } });

  /* ── タブ ─────────────────────────── */
  function activateTab(pane, updateHash) {
    var tabs = pane.closest("[data-tabs]");
    if (!tabs) return;
    each(tabs.querySelectorAll(":scope > .pane"), function (p) { p.classList.toggle("is-on", p === pane); });
    each(tabs.querySelectorAll(".tabbtn"), function (b) { b.setAttribute("aria-selected", b.getAttribute("aria-controls") === pane.id ? "true" : "false"); b.tabIndex = b.getAttribute("aria-controls") === pane.id ? 0 : -1; });
    if (updateHash) { try { history.replaceState(history.state, "", "#" + pane.id); } catch (e) {} }   // 位置の記録（history.state）は残す
  }
  each(document.querySelectorAll("[data-tabs]"), function (tabs) {
    var btns = Array.prototype.slice.call(tabs.querySelectorAll(".tabbtn"));
    btns.forEach(function (b, i) {
      b.id = b.id || "tab-" + b.getAttribute("aria-controls");
      var pane = $(b.getAttribute("aria-controls"));
      if (pane) pane.setAttribute("aria-labelledby", b.id);
      b.tabIndex = b.getAttribute("aria-selected") === "true" ? 0 : -1;
      b.addEventListener("click", function () { if (pane) activateTab(pane, true); });
      b.addEventListener("keydown", function (e) {
        var j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
        if (j < 0 && e.key !== "ArrowLeft") return;
        j = (j + btns.length) % btns.length;
        e.preventDefault(); btns[j].focus(); btns[j].click();
      });
    });
  });

  var IMP = { done: ["done", "ガイドに反映済み"], todo: ["todo", "反映待ち"], info: ["info", "参考"] };   // 報酬改定ガイドと同じ言葉にそろえる（2026-10-27）
  function sortedUpdates() { return (LIVE.updates || []).slice().sort(function (a, b) { return dayOf(b.date) - dayOf(a.date); }); }
  function updItem(u, compact) {
    var d = dayOf(u.date), p = parts(d);
    var imp = IMP[u.impact] || IMP.info;
    var link = u.url ? '<a href="' + esc(u.url) + '" target="_blank" rel="noopener">' + esc(u.title) + "</a>" : "<b>" + esc(u.title) + "</b>";
    var tags = '<span class="tags"><span class="evb">' + esc(u.src) + '</span><span class="imp ' + imp[0] + '">' + imp[1] + "</span></span>";
    if (compact) return el("li", null, "<time>" + p.m + "/" + p.d + '</time><span class="ft">' + link + tags + "</span>");
    var where = u.where && viewTitle(u.where.slice(1)) ? '<a class="u-where" href="' + esc(u.where) + '">関係する章：' + esc(viewTitle(u.where.slice(1))) + "</a>" : "";
    return el("li", { class: "u" + (u.impact === "todo" ? " is-todo" : "") }, "<time>" + p.y + "." + (p.m < 10 ? "0" : "") + p.m + "." + (p.d < 10 ? "0" : "") + p.d + '</time><div class="u-b">' + tags + link + (u.note ? "<p>" + esc(u.note) + "</p>" : "") + where + "</div>");
  }

  /* ── ホーム ───────────────────────── */
  (function home() {
    // 近づいている日程
    var dl = $("dl-cards");
    if (dl && LIVE.milestones) {
      var next = LIVE.milestones.filter(function (m) { return dayOf(m.date) >= TODAY; }).sort(function (a, b) { return dayOf(a.date) - dayOf(b.date); }).slice(0, 3);
      next.forEach(function (m, i) {
        var d = dayOf(m.date), p = parts(d), cur = parts(TODAY);
        var left = Math.round((d - TODAY) / DAY);
        var dateTxt = m.approx && m.label ? esc(m.label) : (p.y !== cur.y ? p.y + "/" : "") + p.m + "/" + p.d + "<small>（" + p.w + "）</small>";
        var rest = m.approx ? "目安" : (left === 0 ? "今日" : (left === 1 ? "明日" : "あと" + left + "日"));
        dl.appendChild(el("a", { class: "dlc" + (i === 0 ? " first" : ""), href: m.link || "#schedule" },
          '<span class="when"><span class="date">' + dateTxt + '</span><span class="rest">' + rest + "</span></span>" +
          "<b>" + (m.time ? esc(m.time) + "　" : "") + esc(m.title) + '</b><span class="d">' + esc(m.desc || "") + "</span>"));
      });
    }
    // 更新情報
    var feed = $("feed-home");
    if (feed && LIVE.updates) {
      sortedUpdates().slice(0, 7).forEach(function (u) { feed.appendChild(updItem(u, true)); });
      var meta = el("p", { class: "feed-meta" }, CHECKED ? "最終確認 " + md(CHECKED) + " " + hm(CHECKED) : "");
      feed.parentNode.appendChild(meta);
    }
    // 次の研修・説明会
    var evh = $("ev-home");
    if (evh) {
      var up = EVENTS.filter(function (e) { var s = evState(e).c; return s !== "past"; }).slice(0, 3);
      up.forEach(function (e) {
        var s = evState(e);
        var li = el("li");
        li.appendChild(el("a", { href: "#ev-" + e.id }, '<span class="ed">' + esc(s.t) + "<small>" + e.fmt.map(function (f) { return FMT[f]; }).join("・") + "</small></span><span><b>" + esc(e.title) + '</b><span class="o">' + esc(e.date) + "　" + esc(e.org) + "</span></span>"));
        evh.appendChild(li);
      });
      if (!up.length) evh.appendChild(el("li", { class: "o" }, "最終確認の時点で、これからの研修・説明会は見つかっていません。"));
    }
    // よく出る質問
    var faq = $("faq-home");
    if (faq && DATA.qa) {
      ["現職の職員の確認は", "2027年4月入職予定", "送迎の運転手", "研修はいつまで", "相談窓口は法人内", "人事台帳に", "前科の確認が済んでいますか", "どこに通報しますか"].forEach(function (key) {
        for (var i = 0; i < DATA.qa.length; i++) if (DATA.qa[i].q.indexOf(key) >= 0) {
          var li = el("li"); li.appendChild(el("a", { href: "#qa-" + (i + 1) }, esc(DATA.qa[i].q))); faq.appendChild(li); break;
        }
      });
    }
    // お知らせ
    var banner = $("banner");
    var notes = (LIVE.notices || []).filter(function (n) { return !n.until || dayOf(n.until) >= TODAY; });
    if (banner && notes.length) {
      banner.innerHTML = notes.map(function (n) { return "<div><b>" + esc(n.title) + "</b>" + (n.body ? "　" + esc(n.body) : "") + (n.link ? ' <a href="' + esc(n.link) + '">詳しく</a>' : "") + "</div>"; }).join("");
      banner.hidden = false;
    }
  })();

  /* ── 更新情報 ─────────────────────── */
  (function updates() {
    var list = $("upd-list");
    if (!list) return;
    var metaBox = $("check-meta");
    if (metaBox) {
      var todoN = (LIVE.updates || []).filter(function (u) { return u.impact === "todo"; }).length;
      metaBox.innerHTML = "<span>最終確認 <b>" + (CHECKED ? ymd(CHECKED) + " " + hm(CHECKED) : "―") + "</b></span>" +
        "<span>反映待ち <b>" + todoN + "件</b></span>" +
        (LIVE.checkNote ? '<span class="cm-note">' + esc(LIVE.checkNote) + "</span>" : "");
    }
    var chips = $("upd-chips"), only = $("upd-todo");
    var srcs = ["すべて"];
    (LIVE.updates || []).forEach(function (u) { if (srcs.indexOf(u.src) < 0) srcs.push(u.src); });
    var active = "すべて";
    srcs.forEach(function (s) {
      var b = el("button", { class: "chip", type: "button", "aria-pressed": s === active ? "true" : "false" }, esc(s));
      b.addEventListener("click", function () { active = s; each(chips.children, function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); }); draw(); });
      chips.appendChild(b);
    });
    var rows = sortedUpdates().map(function (u) { var li = updItem(u, false); list.appendChild(li); return { li: li, u: u }; });
    var empty = el("li", { class: "qa-empty", hidden: "" }, "この条件に当てはまる更新はありません。");
    list.appendChild(empty);
    function draw() {
      var n = 0;
      rows.forEach(function (r) { var ok = (active === "すべて" || r.u.src === active) && (!only.checked || r.u.impact === "todo"); r.li.hidden = !ok; if (ok) n++; });
      empty.hidden = n !== 0;
    }
    only.addEventListener("change", draw);
    draw();
    var w = $("watch-list");
    if (w && LIVE.watch) {
      LIVE.watch.forEach(function (x) { w.appendChild(el("li", null, x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + "</a>" : esc(x.name))); });
      if ($("watch-count")) $("watch-count").textContent = LIVE.watch.length + "か所";
    }
  })();

  /* ── 表示の切り替え（#で指定） ───────── */
  // 押したら「新しいページ」に切り替わる（先頭から出す）。戻る操作（スワイプ・ブラウザの戻る）では、
  // 前のページを離れたときと同じ位置で出す。再読み込みは先頭から（報酬改定ガイドと同じ・ユーザー指示 2026-10-27）
  var shell = document.querySelector(".shell"), subnav = $("subnav");
  var current = null;
  var EXT = [];   // 中身を読み込んで作るページ（資料・法令）の行き先。docs.js が足す
  var MQ = window.matchMedia ? window.matchMedia("(max-width: 960px)") : { matches: false };
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}
  function getState() { var s = null; try { s = history.state; } catch (e) {} return s && typeof s === "object" ? s : {}; }
  function setState(patch) {
    try { var s = getState(), n = {}; Object.keys(s).forEach(function (k) { n[k] = s[k]; }); Object.keys(patch).forEach(function (k) { n[k] = patch[k]; }); history.replaceState(n, ""); } catch (e) {}
  }
  var navIntent = null, saveT = null;
  function saveY() { if (saveT) { clearTimeout(saveT); saveT = null; } setState({ y: Math.round(window.scrollY) }); }
  window.addEventListener("scroll", function () { if (saveT) clearTimeout(saveT); saveT = setTimeout(function () { saveT = null; setState({ y: Math.round(window.scrollY) }); }, 150); }, { passive: true });
  function jumpTop() { try { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, 0); } }
  function jumpTo(y) { try { window.scrollTo({ top: y, left: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, y); } }
  function renderSubnav(g, v) {
    if (!subnav) return;
    subnav.innerHTML = "";
    if (g.views.length < 2) return;
    subnav.appendChild(el("div", { class: "sg" }, esc(g.t)));
    var ol = el("ol");
    g.views.forEach(function (x, i) {
      var li = el("li");
      li.appendChild(el("a", { href: "#" + x.id, class: x === v ? "is-active" : "", "aria-current": x === v ? "page" : "false" }, '<span class="n">' + (i < 9 ? "0" : "") + (i + 1) + "</span><span>" + x.t + "</span>"));
      ol.appendChild(li);
    });
    subnav.appendChild(ol);
    // スマホの横並びは、表示中のページを横方向だけ真ん中へ寄せる（縦には動かさない。動かすとページが途中から表示される）
    var act = subnav.querySelector(".is-active");
    if (act && MQ.matches) { try { ol.scrollLeft = Math.max(0, act.offsetLeft - (ol.clientWidth - act.offsetWidth) / 2); } catch (e) {} }
  }
  function show(v) {
    if (current !== v) {
      each(document.querySelectorAll(".view.is-active"), function (x) { x.classList.remove("is-active"); });
      v.el.classList.add("is-active");
      current = v;
    }
    shell.classList.toggle("no-sub", v.g.views.length < 2);
    shell.classList.toggle("is-home", v.g.k === "home");
    renderSubnav(v.g, v);
    each(document.querySelectorAll(".gnav a, .tabbar a"), function (a) {
      var on = a.getAttribute("data-g") === v.g.k;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    each(document.querySelectorAll(".drawer a[data-v]"), function (a) { a.classList.toggle("is-active", a.getAttribute("data-v") === v.id); });
    document.title = (v.g.k === "home" ? "" : v.t.replace(/&amp;/g, "&") + "｜") + "こども性暴力防止法 実務ガイド";
  }
  function place(intent, st) {
    if (intent !== "push" && typeof st.y === "number") { var y = st.y; requestAnimationFrame(function () { jumpTo(y); reqCx(); }); }
    else { jumpTop(); reqCx(); }
  }
  var NAVTYPE = "";
  try { var ne = performance.getEntriesByType("navigation")[0]; NAVTYPE = ne ? ne.type : ""; } catch (e) {}
  var firstRoute = true;
  function route() {
    var intent = navIntent; navIntent = null;
    var st = getState(), id = "";
    if (firstRoute && NAVTYPE === "reload") st = {};   // 再読み込みは先頭から
    firstRoute = false;
    try { id = decodeURIComponent((location.hash || "").slice(1)); } catch (e) { id = ""; }
    if (!id || id === "top") { show(VIEWS.home); place(intent, st); return; }
    for (var xi = 0; xi < EXT.length; xi++) { if (EXT[xi](id, intent, st)) return; }
    if (VIEWS[id]) { show(VIEWS[id]); place(intent, st); return; }
    var t = $(id);
    var vEl = t && t.closest(".view");
    var vid = vEl && vEl.getAttribute("data-vid");
    if (!t || !vEl || !VIEWS[vid]) { show(VIEWS.home); place(intent, st); return; }
    show(VIEWS[vid]);
    var pane = t.classList.contains("pane") ? t : t.closest(".pane");
    if (pane) activateTab(pane, false);
    var det = t.tagName === "DETAILS" ? t : null;
    if (det) det.open = true;
    var p = t.parentElement;
    while (p && p !== vEl) { if (p.tagName === "DETAILS") p.open = true; p = p.parentElement; }
    if (intent !== "push" && typeof st.y === "number") { place(intent, st); return; }
    if (pane && t === pane) { jumpTop(); reqCx(); return; }
    requestAnimationFrame(function () { try { t.scrollIntoView({ block: "start", behavior: "instant" }); } catch (e) { t.scrollIntoView(); } reqCx(); });
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    if (a === brand && tb.classList.contains("cx-on")) { e.preventDefault(); return; }   // 現在地を出しているあいだは押しても動かない
    saveY(); navIntent = "push";
    if (a.getAttribute("href") === location.hash || (a.getAttribute("href") === "#home" && !location.hash)) { e.preventDefault(); route(); }
  }, true);

  /* ── 上のバーの現在地（スマホ） ─────────
     ページの見出しが上に隠れたら、ガイド名の代わりに「親 › 表示中のページ」を出す。押しても動かない */
  var tb = document.querySelector(".topbar"), brand = tb && tb.querySelector(".brand"), BRAND = brand ? brand.innerHTML : "", cxKey = "", cxTick = false;
  function updCx() {
    cxTick = false; if (!brand) return;
    var on = false, parent = "", title = "";
    if (MQ.matches && current && current.g.k !== "home") {
      var h = current.el.querySelector(".chapter > header h2, header h2, h2");
      on = h ? h.getBoundingClientRect().bottom < tb.getBoundingClientRect().bottom : window.scrollY > 160;
      title = plain(current.t); parent = title.indexOf(current.g.t) >= 0 ? "" : current.g.t;
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
/*@DOCS@*/
  route();

  /* ── 資料リンク集：資料名・日付で絞り込む ────────── */
  (function () {
    var q = document.getElementById("lk-q"), box = document.getElementById("lk");
    if (!q || !box) return;
    var norm = function (s) { return (s || "").normalize("NFKC").toLowerCase(); };
    var rows = [].slice.call(box.querySelectorAll(".lk-i"));
    rows.forEach(function (li) {
      li._t = norm(li.getAttribute("data-q"));
      li._s = [].slice.call(li.querySelectorAll(".lk-s"));
      li._s.forEach(function (s) { s._t = li._t + " " + norm(s.getAttribute("data-q")); });
    });
    var none = box.querySelector(".lk-none");
    function run() {
      var words = norm(q.value).split(/\s+/).filter(Boolean);
      var hit = function (t) { return words.every(function (w) { return t.indexOf(w) >= 0; }); };
      var shown = 0;
      rows.forEach(function (li) {
        var own = hit(li._t), any = own;
        li._s.forEach(function (s) { var v = own || hit(s._t); s.hidden = !v; if (v) any = true; });
        li.hidden = !any;
        if (any) shown++;
      });
      each(box.querySelectorAll(".lk-g"), function (g) { g.hidden = !g.querySelector(".lk-i:not([hidden])"); });
      if (none) none.hidden = shown > 0;
    }
    q.addEventListener("input", run);
    if (q.value) run();
  })();

  /* ── 印刷するときはすべて開く ────────── */
  window.addEventListener("beforeprint", function () { each(document.querySelectorAll("details"), function (d) { d.open = true; }); });
})();
