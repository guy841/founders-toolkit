/* =============================================================================
   Helm — shared "active company" context
   -----------------------------------------------------------------------------
   A lightweight company registry used across every tool. Pick a company once on
   the hub and each tool reads its key facts to pre-fill itself.

   Stored at  founders-toolkit:companies:v1  as:
     { version:1, activeId, companies:[ { id, name, profile:{…} } ] }

   This key is deliberately SEPARATE from Company Records' detailed store: Company
   Records can be locked with an on-device passphrase, which would hide it from
   the other tools. The registry holds only non-sensitive identity + "key facts",
   stays readable, and (being under the founders-toolkit: prefix) syncs across
   devices automatically via helm-sync.js when signed in. Company Records links to
   the same companies by id.

   API (window.HelmCompany):
     list() activeId() active() setActive(id) create(name) rename(id,name)
     remove(id) getProfile() setProfile(patch) onChange(cb)->unsub
     mountSwitcher(el,opts) mountKeyFacts(el) mountBanner(el,opts)

   Profile fields (all optional): incorporationDate "YYYY-MM-DD", yearEndDay 1-31,
   yearEndMonth 1-12, vatRegistered, vatQuarterEndMonth, employsStaff, directors,
   multiOwner, and "what you do" flags: products, advice, publicFacing,
   handlesData, online, construction, importExport.
   ============================================================================= */
(function () {
  "use strict";

  var KEY = "founders-toolkit:companies:v1";
  var listeners = [];

  function uid() { try { return crypto.randomUUID(); } catch (e) { return "co-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36); } }
  function read() {
    var s;
    try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { s = null; }
    if (!s || !Array.isArray(s.companies)) s = { version: 1, activeId: null, companies: [] };
    s.companies = s.companies.filter(function (c) { return c && c.id; }).map(function (c) {
      return { id: c.id, name: c.name || "", profile: (c.profile && typeof c.profile === "object") ? c.profile : {} };
    });
    if (s.activeId && !s.companies.some(function (c) { return c.id === s.activeId; })) s.activeId = null;
    if (!s.activeId && s.companies.length) s.activeId = s.companies[0].id;
    return s;
  }
  function write(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
    emit();
  }
  function emit() { listeners.forEach(function (cb) { try { cb(api.active()); } catch (e) {} }); }

  // ---- model API ------------------------------------------------------------
  var api = {
    list: function () { return read().companies; },
    activeId: function () { return read().activeId; },
    active: function () { var s = read(); return s.companies.find(function (c) { return c.id === s.activeId; }) || null; },
    setActive: function (id) { var s = read(); if (s.companies.some(function (c) { return c.id === id; })) { s.activeId = id; write(s); } },
    create: function (name) {
      var s = read(); var c = { id: uid(), name: (name || "Untitled company").trim() || "Untitled company", profile: {} };
      s.companies.push(c); s.activeId = c.id; write(s); return c;
    },
    rename: function (id, name) { var s = read(); var c = s.companies.find(function (x) { return x.id === id; }); if (c) { c.name = (name || "").trim() || c.name; write(s); } },
    remove: function (id) {
      var s = read(); s.companies = s.companies.filter(function (c) { return c.id !== id; });
      if (s.activeId === id) s.activeId = s.companies.length ? s.companies[0].id : null;
      write(s);
    },
    getProfile: function () { var c = api.active(); return c ? (c.profile || {}) : {}; },
    setProfile: function (patch) {
      var s = read(); var c = s.companies.find(function (x) { return x.id === s.activeId; });
      if (!c) { c = { id: uid(), name: "Untitled company", profile: {} }; s.companies.push(c); s.activeId = c.id; }
      c.profile = c.profile || {};
      Object.keys(patch).forEach(function (k) {
        var v = patch[k];
        if (v === null || v === undefined || v === "") delete c.profile[k]; else c.profile[k] = v;
      });
      if (Object.prototype.hasOwnProperty.call(patch, "name")) c.name = (patch.name || "").trim() || c.name;
      write(s);
    },
    onChange: function (cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (f) { return f !== cb; }); }; },
  };

  // Cross-tab updates (and updates applied by helm-sync after a pull):
  window.addEventListener("storage", function (e) {
    if (!e.key || e.key === KEY) emit();
  });

  // ---- shared styles --------------------------------------------------------
  var styled = false;
  function injectStyles() {
    if (styled) return; styled = true;
    var css =
      '.hc-switch{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-family:"Outfit",system-ui,sans-serif}' +
      '.hc-sel{appearance:none;-webkit-appearance:none;border:1px solid var(--border,#E5E5DF);background:var(--card,#fff) url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%235C5C58\' stroke-width=\'2.5\' stroke-linecap=\'round\'><polyline points=\'6 9 12 15 18 9\'/></svg>") no-repeat right 11px center;color:var(--text,#1C1C1A);font:600 14px/1 "Outfit",system-ui,sans-serif;padding:10px 30px 10px 12px;border-radius:10px;cursor:pointer;max-width:100%}' +
      '.hc-sel:focus{outline:2px solid var(--brand,#34577C);outline-offset:1px}' +
      '.hc-btn{border:1px solid var(--border,#E5E5DF);background:var(--card,#fff);color:var(--text-2,#5C5C58);font:600 14px/1 "Outfit",system-ui,sans-serif;padding:10px 13px;border-radius:10px;cursor:pointer}' +
      '.hc-btn:hover{background:#f4f4f1}' +
      '.hc-facts{margin-top:14px;border:1px solid var(--border,#E5E5DF);background:var(--card,#fff);border-radius:14px;padding:16px 18px}' +
      '.hc-facts h3{font-family:"Outfit",sans-serif;font-size:.95rem;margin:0 0 2px;color:var(--text,#1C1C1A)}' +
      '.hc-facts .hc-sub{color:var(--text-2,#5C5C58);font-size:.83rem;margin:0 0 14px;font-family:"Manrope",system-ui,sans-serif}' +
      '.hc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px 16px}' +
      '.hc-f label{display:block;font:600 11px/1 "Outfit",sans-serif;color:var(--text-2,#5C5C58);margin:0 0 5px;text-transform:none}' +
      '.hc-f input[type=text],.hc-f input[type=date],.hc-f select{width:100%;box-sizing:border-box;border:1px solid var(--border,#E5E5DF);background:var(--input-bg,#F2F2F0);border-radius:9px;padding:9px 10px;font:500 14px/1.2 "Manrope",system-ui,sans-serif;color:var(--text,#1C1C1A)}' +
      '.hc-ye{display:flex;gap:8px}.hc-ye select{flex:1}' +
      '.hc-toggles{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}' +
      '.hc-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border,#E5E5DF);background:var(--input-bg,#F2F2F0);color:var(--text-2,#5C5C58);font:600 12.5px/1 "Outfit",sans-serif;padding:8px 12px;border-radius:999px;cursor:pointer;user-select:none}' +
      '.hc-chip[aria-pressed=true]{background:var(--brand,#34577C);border-color:var(--brand,#34577C);color:#fff}' +
      '.hc-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--border,#E5E5DF);background:var(--card,#fff);border-radius:12px;padding:9px 12px;margin:0 0 18px;font-family:"Manrope",system-ui,sans-serif}' +
      '.hc-banner .hc-eyebrow{font:600 11px/1 "Outfit",sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#8A8A85)}' +
      '.hc-banner .hc-facts-mini{color:var(--text-2,#5C5C58);font-size:.82rem;margin-left:auto}' +
      '.hc-banner a{color:var(--brand,#34577C);font:600 13px/1 "Outfit",sans-serif;text-decoration:none}' +
      '.hc-empty{color:var(--text-2,#5C5C58);font-size:.9rem;font-family:"Manrope",system-ui,sans-serif}';
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }

  // ---- helpers for facts ----------------------------------------------------
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function factsSummary(p) {
    if (!p) return "";
    var bits = [];
    if (p.yearEndDay && p.yearEndMonth) bits.push("year-end " + p.yearEndDay + " " + MONTHS[p.yearEndMonth - 1].slice(0, 3));
    bits.push(p.vatRegistered ? "VAT registered" : "not VAT registered");
    if (p.employsStaff) bits.push("employer");
    return bits.join(" · ");
  }

  // ---- UI: switcher ---------------------------------------------------------
  api.mountSwitcher = function (el, opts) {
    opts = opts || {};
    injectStyles();
    function render() {
      var s = read();
      var options = s.companies.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === s.activeId ? " selected" : "") + '>' + esc(c.name || "Untitled company") + '</option>';
      }).join("");
      el.innerHTML =
        '<div class="hc-switch">' +
          (s.companies.length
            ? '<select class="hc-sel" id="hc-sel" aria-label="Active company">' + options + '</select>'
            : '<span class="hc-empty">No companies yet.</span>') +
          '<button type="button" class="hc-btn" id="hc-add">' + (s.companies.length ? "＋ Add company" : "＋ Add your company") + '</button>' +
        '</div>';
      var sel = el.querySelector("#hc-sel");
      if (sel) sel.addEventListener("change", function () { api.setActive(sel.value); if (opts.onChange) opts.onChange(); });
      el.querySelector("#hc-add").addEventListener("click", function () {
        var name = window.prompt("Company name");
        if (name === null) return;
        api.create(name || "Untitled company");
        render();
        if (opts.onChange) opts.onChange();
      });
    }
    render();
    api.onChange(render);
  };

  // ---- UI: Key facts editor -------------------------------------------------
  var TOGGLES = [
    { k: "employsStaff", label: "Employs staff / runs payroll" },
    { k: "vatRegistered", label: "VAT registered" },
    { k: "multiOwner", label: "Multiple shareholders" },
    { k: "products", label: "Sells products" },
    { k: "advice", label: "Professional services / advice" },
    { k: "publicFacing", label: "Clients or public visit" },
    { k: "handlesData", label: "Holds personal data" },
    { k: "online", label: "Takes online / card payments" },
    { k: "construction", label: "Works in construction" },
    { k: "importExport", label: "Imports / exports goods" },
  ];
  api.mountKeyFacts = function (el) {
    injectStyles();
    function render() {
      var c = api.active();
      if (!c) { el.innerHTML = ""; return; }
      var p = c.profile || {};
      var dayOpts = '<option value="">Day</option>'; for (var d = 1; d <= 31; d++) dayOpts += '<option value="' + d + '"' + (p.yearEndDay == d ? " selected" : "") + '>' + d + '</option>';
      var monOpts = '<option value="">Month</option>'; for (var m = 1; m <= 12; m++) monOpts += '<option value="' + m + '"' + (p.yearEndMonth == m ? " selected" : "") + '>' + MONTHS[m - 1] + '</option>';
      var dirOpts = ""; for (var n = 1; n <= 4; n++) dirOpts += '<option value="' + n + '"' + ((p.directors || 1) == n ? " selected" : "") + '>' + n + (n === 4 ? "+" : "") + '</option>';
      el.innerHTML =
        '<div class="hc-facts">' +
          '<h3>Key facts</h3>' +
          '<p class="hc-sub">Set these once for <b>' + esc(c.name || "this company") + '</b> and every tool below uses them.</p>' +
          '<div class="hc-grid">' +
            '<div class="hc-f"><label>Company name</label><input type="text" id="hc-name" value="' + esc(c.name) + '" /></div>' +
            '<div class="hc-f"><label>Date of incorporation</label><input type="date" id="hc-inc" value="' + esc(p.incorporationDate || "") + '" /></div>' +
            '<div class="hc-f"><label>Financial year-end</label><div class="hc-ye"><select id="hc-yed">' + dayOpts + '</select><select id="hc-yem">' + monOpts + '</select></div></div>' +
            '<div class="hc-f"><label>Number of directors</label><select id="hc-dir">' + dirOpts + '</select></div>' +
          '</div>' +
          '<div class="hc-toggles" id="hc-toggles">' +
            TOGGLES.map(function (t) { return '<button type="button" class="hc-chip" data-k="' + t.k + '" aria-pressed="' + (p[t.k] ? "true" : "false") + '">' + esc(t.label) + '</button>'; }).join("") +
          '</div>' +
        '</div>';
      el.querySelector("#hc-name").addEventListener("change", function (e) { api.setProfile({ name: e.target.value }); });
      el.querySelector("#hc-inc").addEventListener("change", function (e) { api.setProfile({ incorporationDate: e.target.value }); });
      el.querySelector("#hc-yed").addEventListener("change", function (e) { api.setProfile({ yearEndDay: e.target.value ? parseInt(e.target.value, 10) : "" }); });
      el.querySelector("#hc-yem").addEventListener("change", function (e) { api.setProfile({ yearEndMonth: e.target.value ? parseInt(e.target.value, 10) : "" }); });
      el.querySelector("#hc-dir").addEventListener("change", function (e) { api.setProfile({ directors: parseInt(e.target.value, 10) }); });
      el.querySelectorAll(".hc-chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          var on = chip.getAttribute("aria-pressed") !== "true";
          chip.setAttribute("aria-pressed", on ? "true" : "false");
          var patch = {}; patch[chip.getAttribute("data-k")] = on ? true : ""; api.setProfile(patch);
        });
      });
    }
    render();
    // Re-render when the active company changes (e.g. via the switcher), but not
    // on every keystroke-driven setProfile from within this editor.
    api.onChange(function () { render(); });
  };

  // ---- UI: context banner (for tool pages) ----------------------------------
  api.mountBanner = function (el, opts) {
    opts = opts || {};
    injectStyles();
    function render() {
      var s = read();
      var c = api.active();
      if (!c) {
        el.innerHTML = '<div class="hc-banner"><span class="hc-eyebrow">Company</span>' +
          '<span class="hc-empty">No company selected.</span>' +
          '<a href="' + (opts.hubHref || "../../index.html") + '" style="margin-left:auto">Set up on the hub →</a></div>';
        return;
      }
      var options = s.companies.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === c.id ? " selected" : "") + '>' + esc(x.name || "Untitled company") + '</option>'; }).join("");
      var summary = factsSummary(c.profile);
      el.innerHTML =
        '<div class="hc-banner">' +
          '<span class="hc-eyebrow">Showing</span>' +
          '<select class="hc-sel" id="hc-bsel" aria-label="Active company">' + options + '</select>' +
          (summary ? '<span class="hc-facts-mini">' + esc(summary) + '</span>' : '') +
          '<a href="' + (opts.hubHref || "../../index.html") + '"' + (summary ? '' : ' style="margin-left:auto"') + '>Edit facts →</a>' +
        '</div>';
      var sel = el.querySelector("#hc-bsel");
      sel.addEventListener("change", function () {
        api.setActive(sel.value);
        if (opts.onSwitch) opts.onSwitch(api.active());
        else { try { location.reload(); } catch (e) {} }   // re-init the tool with the new company
      });
    }
    render();
    api.onChange(render);
  };

  window.HelmCompany = api;
})();
