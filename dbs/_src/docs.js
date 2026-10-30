  /* ── 資料を読む（見出しごとの要点）・法令の条文 ─────────────
     資料の一覧は DATA.docs（build.py が docs.json から作る）。要点は notes/<資料>.json、横断検索は notes/search.json、
     法令は law.json を、開いたときに読む（ページを軽くするため） */
  var DOCS = DATA.docs || { groups: [], docs: [] };
  var DOCBY = {};
  DOCS.docs.forEach(function (d) { DOCBY[d.slug] = d; });
  var GT = {};
  DOCS.groups.forEach(function (g) { GT[g.k] = g.t; });
  var EXTL = { pdf: "PDF", docx: "Word", xlsx: "Excel", pptx: "PowerPoint", zip: "Zip" };
  function dDate(s) { return s ? s.slice(0, 4) + "." + s.slice(4, 6) + "." + s.slice(6, 8) : ""; }
  function pg(d, p) { return p + (d.poff || 0); }
  function pageLink(d, p, pe) {
    var lab = "p." + pg(d, p) + (pe && pe > p ? "–" + pg(d, pe) : "");
    if (d.ext !== "pdf") return '<span class="pc">' + lab + "</span>";
    return '<a class="pc" href="' + esc(d.u) + "#page=" + p + '" target="_blank" rel="noopener" aria-label="原本の' + lab + 'を開く">' + lab + "</a>";
  }
  function docHref(d) { return d.mode === "law" ? "#law-" + d.law : (d.mode === "qa" ? "#qa" : "#doc-" + d.slug); }

  /* 資料の一覧 */
  (function docList() {
    var host = $("dc-list");
    if (!host) return;
    DOCS.groups.forEach(function (g) {
      var ds = DOCS.docs.filter(function (d) { return d.g === g.k; });
      if (!ds.length) return;
      var box = el("div", { class: "dc-g" });
      box.appendChild(el("h3", { class: "lk-h" }, esc(g.t)));
      var ul = el("ul", { class: "dc-l" });
      ds.forEach(function (d) {
        var meta = [d.d ? dDate(d.d) : "", d.np ? d.np + (d.ext === "pptx" ? "枚" : d.ext === "xlsx" ? "シート" : "頁") : "", EXTL[d.ext] || ""].filter(Boolean).join("・");
        var li;
        if (d.mode === "skip") {
          li = el("li", { class: "dc-i is-skip" }, '<a href="' + esc(d.u) + '" target="_blank" rel="noopener"><span class="dc-tt">' + esc(d.t) + '</span><span class="dc-m">' + esc(meta) + "</span><span class=\"dc-n\">" + esc(d.memo || "") + "</span></a>");
        } else {
          var note = d.mode === "qa" ? "原文のまま・Q&Aのページで読む" : d.mode === "law" ? "条文をそのまま載せています" : (d.third ? "作成者の資料のため要点のみ" : "");
          li = el("li", { class: "dc-i" }, '<a href="' + docHref(d) + '"><span class="dc-tt">' + esc(d.t) + '</span><span class="dc-m">' + esc(meta) + "</span>" + (note ? '<span class="dc-n">' + esc(note) + "</span>" : "") + "</a>");
        }
        ul.appendChild(li);
      });
      box.appendChild(ul);
      host.appendChild(box);
    });
    if ($("dc-src")) $("dc-src").innerHTML = esc(DOCS.credit || "");
  })();

  /* 資料の中を探す（要点の全文から） */
  (function docSearch() {
    var q = $("dc-q"), hits = $("dc-hits"), list = $("dc-list");
    if (!q || !hits) return;
    var norm = function (s) { return String(s || "").normalize("NFKC").toLowerCase(); };
    var idx = null, T = null;
    function run() {
      var words = norm(q.value).split(/\s+/).filter(Boolean);
      if (!words.length) { hits.hidden = true; list.hidden = false; return; }
      if (!idx) { hits.hidden = false; hits.innerHTML = '<p class="dc-wait">読み込み中…</p>'; getJSON("notes/search.json", function (j) { idx = (j || []).map(function (x) { x._n = norm(x.t + " " + x.x); return x; }); run(); }); return; }
      var res = idx.filter(function (x) { return words.every(function (w) { return x._n.indexOf(w) >= 0; }); });
      list.hidden = true; hits.hidden = false; hits.innerHTML = "";
      hits.appendChild(el("p", { class: "dc-cnt" }, res.length ? res.length + " 件" + (res.length > 80 ? "（はじめの80件）" : "") : "見つかりませんでした。言葉を変えてください。"));
      var ul = el("ul", { class: "dc-hl" });
      res.slice(0, 80).forEach(function (x) {
        var d = DOCBY[x.s] || {};
        var body = esc(x.x);
        var pos = norm(x.x).indexOf(words[0]);
        if (pos > 60) body = "…" + esc(x.x.slice(pos - 40));
        body = body.slice(0, 220);
        words.forEach(function (w) { var re = new RegExp("(" + esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"); body = body.replace(re, "<mark>$1</mark>"); });
        ul.appendChild(el("li", null, '<a href="#doc-' + esc(x.s) + "~" + encodeURIComponent(x.k) + '"><span class="dc-hs">' + esc(d.t || "") + '</span><b>' + esc(x.t) + "</b><span class=\"dc-hb\">" + body + "</span></a>"));
      });
      hits.appendChild(ul);
    }
    q.addEventListener("input", function () { clearTimeout(T); T = setTimeout(run, 120); });
  })();

  /* 資料のページ（#doc-<資料>、#doc-<資料>~<見出しの鍵>） */
  var docCur = "";
  function renderDoc(slug, key, done) {
    var d = DOCBY[slug];
    var body = $("dc-body");
    if (!d || !body) { done(false); return; }
    $("dc-g").textContent = GT[d.g] || "資料";
    $("dc-t").textContent = d.t;
    var meta = [d.d ? "公表 " + dDate(d.d) : "", d.np ? d.np + (d.ext === "pptx" ? "枚" : "頁") : ""].filter(Boolean).join("・");
    $("dc-meta").innerHTML = esc(meta) + ' <a href="' + esc(d.u) + '" target="_blank" rel="noopener">原本（' + (EXTL[d.ext] || "") + "）</a>" + (d.poff ? '<span class="dc-pn">頁は印字頁</span>' : "");
    $("dc-credit").innerHTML = d.third
      ? "要点は、このガイドが資料をもとに自分の言葉でまとめたものです。資料の著作権は作成者にあります。"
      : "要点は、このガイドが資料をもとに作成したものです（出典：「" + esc(d.t) + "」（こども家庭庁）を加工して作成）。";
    if (d.mode !== "notes") {
      docCur = slug;
      $("dc-credit").innerHTML = "";
      body.innerHTML = '<p class="dc-wait">' + esc(d.memo || "") + ' <a href="' + esc(d.u) + '" target="_blank" rel="noopener">原本を開く</a></p>';
      done(true); return;
    }
    if (docCur === slug && body.childElementCount) { open(key); done(true); return; }
    docCur = slug;
    body.innerHTML = '<p class="dc-wait">読み込み中…</p>';
    getJSON("notes/" + slug + ".json", function (j) {
      body.innerHTML = "";
      if (!j || !j.items) { body.innerHTML = '<p class="dc-wait">要点を読み込めませんでした。<a href="' + esc(d.u) + '" target="_blank" rel="noopener">原本</a>を開いてください。</p>'; done(true); return; }
      var n = 0;
      j.items.forEach(function (it) {
        var det = el("details", { class: "nt lv" + it.lv + (it.par ? " sub" : ""), id: "nt-" + it.k });
        var s = el("summary", null, '<span class="nt-t">' + esc(it.t) + "</span>");
        det.appendChild(s);
        var inner = el("div", { class: "nt-b" });
        if (it.g) inner.appendChild(el("p", { class: "nt-g" }, esc(it.g)));
        if (it.pts && it.pts.length) {
          var ul = el("ul", { class: "nt-p" });
          it.pts.forEach(function (x) { ul.appendChild(el("li", null, esc(x))); });
          inner.appendChild(ul);
        }
        if (!it.g && !(it.pts && it.pts.length)) inner.appendChild(el("p", { class: "nt-g" }, "この見出しの要点は載せていません。原本で確かめてください。"));
        inner.appendChild(el("p", { class: "nt-pg" }, "原本 " + pageLink(d, it.p, it.pe)));
        det.appendChild(inner);
        body.appendChild(det);
        n++;
      });
      $("dc-count").textContent = "見出し " + n;
      open(key); done(true);
    });
    function open(k) {
      if (!k) return;
      var t = $("nt-" + k);
      if (!t) return;
      t.open = true;
      requestAnimationFrame(function () { try { t.scrollIntoView({ block: "start", behavior: "instant" }); } catch (e) { t.scrollIntoView(); } });
    }
  }
  if ($("dc-open")) $("dc-open").addEventListener("click", function () { each($("dc-body").querySelectorAll("details"), function (x) { x.open = true; }); });
  if ($("dc-close")) $("dc-close").addEventListener("click", function () { each($("dc-body").querySelectorAll("details"), function (x) { x.open = false; }); });

  /* 法令の条文（#law、#law-ho、#law-ho~a4） */
  var LAWS = null, lawCur = "";
  function lawLabel(l) { return l.short; }
  function renderLaw(slug, anchor, done) {
    getJSON("law.json", function (j) {
      if (!j) { $("law-body").innerHTML = '<p class="dc-wait">条文を読み込めませんでした。</p>'; done(); return; }
      LAWS = j;
      var l = j.filter(function (x) { return x.slug === slug; })[0] || j[0];
      var tabs = $("law-tabs");
      if (!tabs.childElementCount) {
        j.forEach(function (x) { tabs.appendChild(el("a", { class: "law-tab", href: "#law-" + x.slug, role: "tab", "data-l": x.slug }, esc(lawLabel(x)))); });
      }
      each(tabs.children, function (a) { var on = a.getAttribute("data-l") === l.slug; a.classList.toggle("is-on", on); a.setAttribute("aria-selected", on ? "true" : "false"); });
      $("law-lead").innerHTML = esc(l.title) + "（" + esc(l.num) + "）。" + esc(l.note || "") + ' <a href="' + esc(l.url) + '" target="_blank" rel="noopener">e-Gov法令検索</a>';
      if (lawCur !== l.slug) {
        lawCur = l.slug;
        var toc = $("law-toc"), body = $("law-body");
        toc.innerHTML = ""; body.innerHTML = "";
        var tul = el("ul");
        if (l.enact) body.appendChild(el("p", { class: "law-en" }, esc(l.enact)));
        l.body.forEach(function (x) {
          if (x.kind === "head") {
            var id = "lh-" + l.slug + "-" + x.id;
            body.appendChild(el("h3", { class: "law-h lv" + x.lv, id: id }, esc(x.t)));
            if (x.lv <= 2) tul.appendChild(el("li", { class: "lv" + x.lv }, '<a href="#law-' + l.slug + "~" + x.id + '">' + esc(x.t) + "</a>"));
            return;
          }
          var art = el("div", { class: "law-a", id: "la-" + l.slug + "-" + x.id });
          var h = '<p class="law-at"><b>' + esc(x.no) + "</b>" + (x.cap ? "<span>" + esc(x.cap) + "</span>" : "") + "</p>";
          x.paras.forEach(function (p) {
            h += '<p class="law-p">' + (p.n ? '<span class="law-pn">' + esc(p.n) + "</span>" : "") + esc(p.t) + "</p>";
            (p.items || []).forEach(function (it) { h += '<p class="law-i d' + it.d + '"><span class="law-in">' + esc(it.n) + "</span>" + esc(it.t) + "</p>"; });
            if (p.table) h += '<div class="scroll"><table class="tbl">' + p.table.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + esc(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</table></div>";
          });
          art.innerHTML = h;
          body.appendChild(art);
        });
        if (tul.childElementCount) toc.appendChild(tul);
      }
      done(anchor ? ($("lh-" + l.slug + "-" + anchor) || $("la-" + l.slug + "-" + anchor)) : null);
    });
  }

  /* 章の終わりに「資料で詳しく」（資料の見出しへのリンク） */
  (function seeBoxes() {
    var S = DATA.see || {};
    Object.keys(S).forEach(function (vid) {
      var v = VIEWS[vid];
      if (!v) return;
      var box = el("div", { class: "see" });
      box.innerHTML = '<p class="see-h">資料で詳しく</p><ul>' + S[vid].map(function (x) {
        var d = DOCBY[x[0]] || {};
        return '<li><a href="#doc-' + esc(x[0]) + "~" + encodeURIComponent(x[1]) + '"><span>' + esc(x[2]) + "</span><small>" + esc(d.t || "") + "</small></a></li>";
      }).join("") + "</ul>";
      var pager = v.el.querySelector("nav.pager");
      v.el.insertBefore(box, pager || null);
    });
  })();

  EXT.push(function (id, intent, st) {
    if (id === "qa" && QA_LOAD) { QA_LOAD(); return false; }
    var q = /^q[om]-[a-z0-9-]+$/.exec(id);
    if (q && QA_LOAD && VIEWS.qa) {
      show(VIEWS.qa);
      QA_LOAD(function () {
        var t = $(id);
        if (!t) { place(intent, st); return; }
        t.open = true;
        requestAnimationFrame(function () { toTarget(t); reqCx(); });
      });
      return true;
    }
    var m = /^doc-([a-z0-9-]+)(?:~(.+))?$/.exec(id);
    if (m && DOCBY[m[1]]) {
      VIEWS.doc.t = DOCBY[m[1]].t;
      show(VIEWS.doc);
      renderDoc(m[1], m[2] || "", function () { if (!m[2]) place(intent, st); else reqCx(); });
      return true;
    }
    m = /^law(?:-([a-z]+))?(?:~(.+))?$/.exec(id);
    if (m && VIEWS.law) {
      show(VIEWS.law);
      renderLaw(m[1] || "ho", m[2] || "", function (t) {
        if (t && intent === "push") requestAnimationFrame(function () { try { t.scrollIntoView({ block: "start", behavior: "instant" }); } catch (e) { t.scrollIntoView(); } reqCx(); });
        else place(intent, st);
      });
      return true;
    }
    return false;
  });
