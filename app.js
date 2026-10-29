// Click-through demo of the product master, CRM and quoting. Runs entirely in the browser:
// demo data comes from data.json and changes are kept in this browser's localStorage.
"use strict";

const KEY = "crm-build-demo-v1";
let db;

async function loadFresh() {
  const res = await fetch("data.json", { cache: "no-store" });
  return res.json();
}
async function load() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return (db = JSON.parse(saved));
  } catch {}
  db = await loadFresh();
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n) => (n == null ? '<span class="muted">—</span>' : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));
const moneyText = (n) => (n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));
const shortDate = (d) => new Date(d).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" });
const longDate = (d) => new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const dateTime = (d) => new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const numOrNull = (v) => {
  const s = String(v ?? "").replace(/[$,%\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
const byId = (list, id) => list.find((x) => x.id === Number(id));
const quoteNo = (id) => `Q-${String(id).padStart(5, "0")}`;

const parent = () => db.companies.find((c) => c.isParent) ?? db.companies[0];
const itemOf = (id) => byId(db.items, id);
const productTitle = (p, companyId) => p.names[companyId]?.name || p.names[parent().id]?.name || "Untitled product";
const coChip = (c) => `<span class="co ${c.isParent ? "parent" : ""}">${esc(c.code)}</span>`;

function variance(price, ref) {
  if (price == null || ref == null || ref === 0) return null;
  return round2(((price - ref) / ref) * 100);
}
function varTag(price, ref) {
  const v = variance(price, ref);
  if (v == null || v === 0) return "";
  return `<span class="var ${Math.abs(v) >= 5 ? "big" : ""}">${v > 0 ? "+" : ""}${v}%</span>`;
}
function margin(price, cost) {
  if (price == null || cost == null || price === 0) return null;
  return round2(((price - cost) / price) * 100);
}
function transferPrice(item, company) {
  if (company.isParent) return null;
  const base = item.companies[parent().id]?.price;
  const pct = item.transferPct ?? company.transferPct;
  return base == null || pct == null ? null : round2((base * pct) / 100);
}

const TYPES = { unit: "Units", battery: "Batteries", option: "Options", breaker: "Breakers", service: "Services", other: "Other" };
const STATUS = {
  none: "No status",
  engineer_spec: "Engineer generic spec",
  sales_progress: "Sales progress",
  late: "Late",
  no_activity: "No activity",
  non_performing: "Non-performing rep",
};
const QSTATUS = { draft: "Draft", sent: "Sent", won: "Won", lost: "Lost", dropped: "Dropped" };

function setPrice(item, companyId, value, note = "") {
  const entry = (item.companies[companyId] ??= { partNumber: "", description: "", price: null });
  if (entry.price === value) return;
  db.priceHistory.push({ id: nextId(db.priceHistory), itemId: item.id, companyId, oldValue: entry.price, newValue: value, note, at: new Date().toISOString() });
  entry.price = value;
}
function setCost(item, value, note = "") {
  if (item.cost === value) return;
  db.priceHistory.push({ id: nextId(db.priceHistory), itemId: item.id, companyId: null, oldValue: item.cost, newValue: value, note, at: new Date().toISOString() });
  item.cost = value;
}

let toastTimer;
function toast(msg) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2200);
}

const card = (title, body, actions = "") => `<section class="card">${title ? `<header><h2>${title}</h2>${actions}</header>` : ""}<div class="body">${body}</div></section>`;
const table = (head, rows) => `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
const crumbs = (list) => `<div class="crumbs">${list.map(([href, label]) => `<a href="${href}">${esc(label)}</a> /`).join(" ")}</div>`;
const pageHead = (title, crumbList = [], right = "") => `<div class="ph"><div>${crumbList.length ? crumbs(crumbList) : ""}<h1>${title}</h1></div>${right}</div>`;

// ── Pricing a quote line (same rules as the app) ───────────────
// Price = the quoting company's price, or with a private label: base company's price × the product's multiplier.
function priceLine(quote, itemId, productId) {
  const item = itemOf(itemId);
  const seller = byId(db.companies, quote.sellerId);
  const mine = item.companies[seller.id] ?? {};
  let price = mine.price ?? null;
  let multiplier = null;
  const label = quote.privateLabelId ? byId(db.privateLabels, quote.privateLabelId) : null;
  if (label) {
    multiplier = (productId != null ? label.multipliers[productId] : undefined) ?? label.defaultMultiplier;
    const base = item.companies[label.baseCompanyId]?.price;
    price = base == null ? null : round2(base * multiplier);
  }
  return { partNumber: mine.partNumber ?? "", description: mine.description ?? "", price, cost: item.cost, transfer: transferPrice(item, seller), multiplier };
}
function productOfItem(itemId) {
  return (
    db.units.find((u) => u.itemId === itemId)?.productId ??
    db.batteries.find((b) => b.itemId === itemId)?.productId ??
    byId(db.optionGroups, db.subOptions.find((s) => s.itemId === itemId)?.groupId)?.productId ??
    null
  );
}

// ── Router ─────────────────────────────────────────────────────

const ui = { itemType: "", itemQ: "", varMin: 2, crmTerritory: "", crmType: "", crmQ: "", quoteStatus: "", noteFilter: "", capFilter: "" };
// Configurator state, per product.
let cfg = { productId: null, companyId: null, values: {}, battery: "", picks: {} };

let lastRoute = "";
function render() {
  const hash = location.hash || "#/";
  const parts = hash.slice(2).split("/").filter(Boolean);
  const [app = "", ...rest] = parts;
  document.querySelectorAll("#apps a").forEach((a) => a.classList.toggle("on", a.dataset.app === (app === "quote" ? "quotes" : app)));
  let html;
  try {
    html =
      app === "master" ? masterView(rest) :
      app === "crm" ? crmView(rest) :
      app === "quotes" ? quotesListView() :
      app === "quote" ? quoteView(rest) :
      homeView();
  } catch (err) {
    console.error(err);
    html = `<div class="empty">That page couldn't be shown. <a href="#/">Go home</a></div>`;
  }
  const el = document.getElementById("app");
  el.innerHTML = html;
  if (hash !== lastRoute) window.scrollTo(0, 0);
  lastRoute = hash;
}

// ── Home ───────────────────────────────────────────────────────

function homeView() {
  const tile = (href, letter, color, title, text) =>
    `<a class="tile" href="${href}"><span class="ic" style="background:${color}">${letter}</span><b>${title}</b><p>${text}</p></a>`;
  return `
  <div class="hero">
    <h1>Product master, CRM and quoting</h1>
    <p>A working example of the system we need: one product master with prices for our three companies (OLP, CPP, PPS), a CRM organized by territory, and quotes built from the master. Click anything; you can't break it.</p>
  </div>
  <div class="tiles">
    ${tile("#/master", "M", "#1f6f74", "Product master", "Product groups, products, capacities and voltages that build the part number, batteries, options and prices for each company.")}
    ${tile("#/crm", "C", "#0369a1", "CRM", "Companies by territory and type, their contacts, and notes on a company or one person.")}
    ${tile("#/quotes", "Q", "#047857", "Quotes", "Quotes configured from the master, priced per company or private label, with the customer-facing quote document.")}
  </div>
  <div class="grid side" style="margin-top:22px">
    ${card(
      "Suggested walkthrough",
      `<ol class="steps">
        <li>Open <a href="#/master">Product master</a> › Emergency Lighting Inverter UL924 › <a href="#/master/product/3/units">Power Wave 1 › Units</a>. Each part number is built from capacity, input voltage, output voltage and transformer, with a price for OLP, CPP and PPS.</li>
        <li>Change a price and press Save. Then open that part in the <a href="#/master/items">Item master</a> to see the price history.</li>
        <li>Look at <a href="#/master/product/3/options">Options</a>: group › category › sub-option › assigned part number.</li>
        <li>Open <a href="#/crm">CRM</a>, filter by territory, open a company and add a note for one of its contacts.</li>
        <li>On that company, start a <b>New quote</b>, configure a unit with battery and options, and add it.</li>
        <li>Press <b>View quote document</b> to see what the customer receives.</li>
        <li>Try a private label: <a href="#/master/companies">Companies &amp; private labels</a>, then quote Lumacore Systems with its multiplier.</li>
      </ol>`,
    )}
    ${card(
      "Our three companies",
      `<div class="stack">${db.companies
        .map((c) => `<div>${coChip(c)} <b>${esc(c.name)}</b><div class="muted" style="font-size:13.5px">${c.isParent ? "Parent and manufacturer" : `Buys from ${esc(parent().code)} at ${c.transferPct}% of ${esc(parent().code)} price`}</div></div>`)
        .join("")}</div>`,
    )}
  </div>`;
}

// ── Product master ─────────────────────────────────────────────

function masterNav(on) {
  const tabs = [
    ["groups", "#/master", "Product groups"],
    ["items", "#/master/items", "Item master"],
    ["variance", "#/master/variance", "Variance"],
    ["history", "#/master/history", "Price history"],
    ["companies", "#/master/companies", "Companies & private labels"],
  ];
  return `<nav class="subnav"><span>Product master</span>${tabs.map(([k, h, l]) => `<a href="${h}" class="${k === on ? "on" : ""}">${l}</a>`).join("")}</nav>`;
}

function masterView([page, id, tab]) {
  if (page === "group") return masterNav("groups") + groupView(Number(id));
  if (page === "product") return masterNav("groups") + productView(Number(id), tab || "setup");
  if (page === "items") return masterNav("items") + itemsView();
  if (page === "item") return masterNav("items") + itemView(Number(id));
  if (page === "variance") return masterNav("variance") + varianceView();
  if (page === "history") return masterNav("history") + historyView();
  if (page === "companies") return masterNav("companies") + companiesView();
  if (page === "label") return masterNav("companies") + labelView(Number(id));
  return masterNav("groups") + groupsView();
}

function groupsView() {
  const rows = db.groups
    .map((g) => {
      const n = db.products.filter((p) => p.groupId === g.id).length;
      return `<tr class="click" data-go="#/master/group/${g.id}"><td><a href="#/master/group/${g.id}"><b>${esc(g.name)}</b></a></td><td class="num">${n}</td></tr>`;
    })
    .join("");
  return pageHead("Product groups") + card("", table("<th>Product group</th><th class='num'>Products</th>", rows));
}

function groupView(id) {
  const g = byId(db.groups, id);
  if (!g) return `<div class="empty">Not found.</div>`;
  const products = db.products.filter((p) => p.groupId === id);
  const rows = products
    .map((p) => {
      const units = db.units.filter((u) => u.productId === p.id).length;
      return `<tr class="click" data-go="#/master/product/${p.id}"><td class="num">${p.phase}</td>${db.companies
        .map((c, i) => `<td>${i === 0 ? `<a href="#/master/product/${p.id}"><b>${esc(p.names[c.id]?.name || "—")}</b></a>` : esc(p.names[c.id]?.name || "—")} <span class="mono muted">${esc(p.names[c.id]?.prefix || "")}</span></td>`)
        .join("")}<td class="num">${units}</td></tr>`;
    })
    .join("");
  return (
    pageHead(esc(g.name), [["#/master", "Product groups"]]) +
    card("", `<p class="hint">Each product has its own name and part-number prefix for each company.</p>` + table(`<th class="num">Phase</th>${db.companies.map((c) => `<th>${coChip(c)} product</th>`).join("")}<th class="num">Units</th>`, rows))
  );
}

function productView(id, tab) {
  const p = byId(db.products, id);
  if (!p) return `<div class="empty">Not found.</div>`;
  const g = byId(db.groups, p.groupId);
  const base = `#/master/product/${id}`;
  const tabs = [
    ["setup", "Setup"],
    ["units", "Units"],
    ["batteries", "Batteries"],
    ["options", "Options"],
    ["configure", "Configure & price"],
  ];
  const right = `<div class="chips">${db.companies.map((c) => (p.names[c.id]?.prefix ? `<span class="badge">${coChip(c)} <span class="mono">${esc(p.names[c.id].prefix)}</span></span>` : "")).join("")}</div>`;
  const body =
    tab === "units" ? unitsTab(p) :
    tab === "batteries" ? batteriesTab(p) :
    tab === "options" ? optionsTab(p) :
    tab === "configure" ? configurator(p, {}) :
    setupTab(p);
  return (
    pageHead(esc(productTitle(p, parent().id)), [["#/master", "Product groups"], [`#/master/group/${g.id}`, g.name]], right) +
    `<nav class="subnav">${tabs.map(([k, l]) => `<a href="${base}/${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>` +
    body
  );
}

const axesOf = (p) => db.axes.filter((a) => a.productId === p.id).sort((a, b) => a.sequence - b.sequence);
const valuesOf = (axis) => db.axisValues.filter((v) => v.axisId === axis.id);

function setupTab(p) {
  const axes = axesOf(p);
  const example = (p.names[parent().id]?.prefix || "") + axes.map((a) => valuesOf(a)[0]?.code ?? "").join("");
  const cards = axes
    .map((a) =>
      card(
        esc(a.name),
        valuesOf(a).length
          ? table("<th>" + (a.role === "capacity" ? "Capacity (UL listed)" : "Label") + "</th><th>Code</th><th>Suffix</th>", valuesOf(a).map((v) => `<tr><td>${esc(v.label)}</td><td class="mono">${esc(v.code)}</td><td class="mono">${esc(v.suffix)}</td></tr>`).join(""))
          : `<div class="empty">No values yet.</div>`,
      ),
    )
    .join("");
  return `
    ${card("How the part number is built", `<p class="hint">Company prefix, then each segment's code in order. Example for ${esc(parent().code)}:</p><div class="pn-big">${esc(example)}</div>
      <p class="hint" style="margin-top:10px">${axes.map((a) => esc(a.name)).join(" → ")}. Each company gets the same codes with its own prefix (${db.companies.map((c) => `${esc(c.code)} ${esc(p.names[c.id]?.prefix || "—")}`).join(", ")}).</p>`)}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:18px">${cards}</div>`;
}

function unitsTab(p) {
  const P = parent();
  const capAxis = axesOf(p).find((a) => a.role === "capacity");
  const caps = capAxis ? valuesOf(capAxis) : [];
  const cap = Number(ui.capFilter) || null;
  const label = new Map(db.axisValues.map((v) => [v.id, v.label]));
  const units = db.units
    .filter((u) => u.productId === p.id && (!cap || u.valueIds.includes(cap)))
    .map((u) => ({ ...u, item: itemOf(u.itemId) }))
    .sort((a, b) => (a.item.companies[P.id]?.partNumber ?? "").localeCompare(b.item.companies[P.id]?.partNumber ?? "", undefined, { numeric: true }));
  const chips = `<div class="chips" style="margin-bottom:12px"><button class="chip ${cap ? "" : "on"}" data-act="cap" data-v="">All</button>${caps
    .map((v) => `<button class="chip ${cap === v.id ? "on" : ""}" data-act="cap" data-v="${v.id}">${esc(v.label)}</button>`)
    .join("")}</div>`;
  const kids = db.companies.filter((c) => !c.isParent);
  const rows = units
    .map((u) => {
      const it = u.item;
      const f = `u${it.id}`;
      return `<tr>
        ${db.companies.map((c, i) => `<td class="mono">${i === 0 ? `<a href="#/master/item/${it.id}">${esc(it.companies[c.id]?.partNumber)}</a>` : esc(it.companies[c.id]?.partNumber)}</td>`).join("")}
        <td><input class="w-m" form="${f}" name="cost" value="${it.cost ?? ""}" inputmode="decimal" aria-label="Cost"></td>
        ${db.companies
          .map((c) => `<td style="white-space:nowrap"><input class="w-m" form="${f}" name="p${c.id}" value="${it.companies[c.id]?.price ?? ""}" inputmode="decimal" aria-label="${esc(c.code)} price">${c.isParent ? "" : varTag(it.companies[c.id]?.price, it.companies[P.id]?.price)}</td>`)
          .join("")}
        ${kids.map((c) => `<td class="num muted">${money(transferPrice(it, c))}</td>`).join("")}
        <td class="muted" style="font-size:12.5px;white-space:nowrap">${u.valueIds.map((v) => esc(label.get(v))).join(" · ")}</td>
        <td><form id="${f}" data-form="itemPrices" data-item="${it.id}"><button class="btn secondary sm">Save</button></form></td>
      </tr>`;
    })
    .join("");
  return card(
    `Units (${units.length})`,
    `<p class="hint">One unit per UL-listed combination. Edit cost or any company's price and press Save; every change is recorded in the price history. Percentages show how far CPP and PPS are from OLP.</p>${chips}` +
      (units.length
        ? table(
            `${db.companies.map((c) => `<th>${coChip(c)} part number</th>`).join("")}<th>Cost</th>${db.companies.map((c) => `<th>${coChip(c)} sell $</th>`).join("")}${kids.map((c) => `<th class="num">${coChip(c)} transfer</th>`).join("")}<th>Specs</th><th></th>`,
            rows,
          )
        : `<div class="empty">No units for this capacity yet.</div>`),
  );
}

function batteriesTab(p) {
  const P = parent();
  const label = new Map(db.axisValues.map((v) => [v.id, v.label]));
  const rows = db.batteries
    .filter((b) => b.productId === p.id)
    .map((b) => {
      const it = itemOf(b.itemId);
      return `<tr><td>${b.capacityValueId ? esc(label.get(b.capacityValueId)) : "All"}</td><td>${esc(b.runtime)}</td><td>${esc(b.batteryType)}</td>
        ${db.companies.map((c, i) => `<td class="mono">${i === 0 ? `<a href="#/master/item/${it.id}">${esc(it.companies[c.id]?.partNumber)}</a>` : esc(it.companies[c.id]?.partNumber)}</td>`).join("")}
        <td class="num">${money(it.cost)}</td>
        ${db.companies.map((c) => `<td class="num">${money(it.companies[c.id]?.price)}${c.isParent ? "" : varTag(it.companies[c.id]?.price, it.companies[P.id]?.price)}</td>`).join("")}</tr>`;
    })
    .join("");
  return card(
    "Batteries",
    `<p class="hint">Batteries are offered per capacity, by runtime and type, each with its own part number for each company.</p>` +
      table(`<th>Capacity</th><th>Runtime</th><th>Type</th>${db.companies.map((c) => `<th>${coChip(c)} part number</th>`).join("")}<th class="num">Cost</th>${db.companies.map((c) => `<th class="num">${coChip(c)} sell $</th>`).join("")}`, rows),
  );
}

function optionsTab(p) {
  const P = parent();
  const groups = db.optionGroups.filter((g) => g.productId === p.id);
  return (
    `<p class="hint">Options are shared by every capacity of this product: option group › category › sub-option › assigned part number. The assigned part number carries the price for each company.</p><div class="grid">` +
    groups
      .map((g, gi) => {
        const subs = db.subOptions.filter((s) => s.groupId === g.id);
        const rows = subs
          .map((s) => {
            const it = s.itemId ? itemOf(s.itemId) : null;
            return `<tr><td class="muted">${esc(s.category)}</td><td>${esc(s.name)}</td><td class="mono">${it ? `<a href="#/master/item/${it.id}">${esc(it.companies[P.id]?.partNumber)}</a>` : "—"}</td><td class="num">${money(it?.cost)}</td>${db.companies
              .map((c) => `<td class="num">${money(it?.companies[c.id]?.price)}${c.isParent || !it ? "" : varTag(it.companies[c.id]?.price, it.companies[P.id]?.price)}</td>`)
              .join("")}</tr>`;
          })
          .join("");
        return card(`${gi + 1}. ${esc(g.name)}`, subs.length ? table(`<th>Category</th><th>Sub-option</th><th>Assigned part number</th><th class="num">Cost</th>${db.companies.map((c) => `<th class="num">${coChip(c)} sell $</th>`).join("")}`, rows) : `<div class="empty">No sub-options yet.</div>`);
      })
      .join("") +
    `</div>`
  );
}

// ── Configurator (product page and quote builder) ──────────────

function configurator(p, { quote } = {}) {
  if (cfg.productId !== p.id) cfg = { productId: p.id, companyId: quote ? quote.sellerId : parent().id, values: {}, battery: "", picks: {} };
  if (quote) cfg.companyId = quote.sellerId;
  const company = byId(db.companies, cfg.companyId);
  const axes = axesOf(p);
  const units = db.units.filter((u) => u.productId === p.id);
  const chosen = axes.map((a) => cfg.values[a.id]).filter(Boolean);
  const reachable = (axisId, valueId) =>
    units.some((u) => u.valueIds.includes(valueId) && axes.every((a) => a.id === axisId || !cfg.values[a.id] || u.valueIds.includes(cfg.values[a.id])));
  const complete = chosen.length === axes.length;
  const unit = complete ? units.find((u) => chosen.every((v) => u.valueIds.includes(v))) : null;
  const capAxis = axes.find((a) => a.role === "capacity");
  const cap = capAxis ? cfg.values[capAxis.id] : null;
  const batteries = db.batteries.filter((b) => b.productId === p.id && (b.capacityValueId == null || b.capacityValueId === cap));
  const groups = db.optionGroups.filter((g) => g.productId === p.id);

  const lines = [];
  if (unit) lines.push({ kind: "Unit", itemId: unit.itemId });
  const battery = batteries.find((b) => b.id === Number(cfg.battery));
  if (battery) lines.push({ kind: "Battery", itemId: battery.itemId });
  for (const g of groups) {
    for (const s of db.subOptions.filter((x) => x.groupId === g.id && x.itemId)) {
      if (Number(cfg.picks[`${g.id}|${s.category}`]) === s.id) lines.push({ kind: g.name, itemId: s.itemId });
    }
  }
  const pseudoQuote = quote ?? { sellerId: company.id, privateLabelId: null };
  const priced = lines.map((l) => ({ ...l, ...priceLine(pseudoQuote, l.itemId, p.id) }));
  const total = priced.reduce((s, l) => s + (l.price ?? 0), 0);
  const cost = priced.reduce((s, l) => s + (l.cost ?? 0), 0);
  const transfer = company.isParent ? null : priced.reduce((s, l) => s + (l.transfer ?? 0), 0);

  const sel = (key, label, options, value, extra = "") =>
    `<label class="field"><span>${label}</span><select data-cfg="${key}" ${extra}>${options}</select></label>`;
  const left = `<div class="stack">
    ${quote ? "" : sel("company", "Quote as", db.companies.map((c) => `<option value="${c.id}" ${c.id === company.id ? "selected" : ""}>${esc(c.code)} · ${esc(c.name)}</option>`).join(""), company.id)}
    ${axes
      .map((a) =>
        sel(
          `axis:${a.id}`,
          esc(a.name),
          `<option value="">—</option>` +
            valuesOf(a).map((v) => `<option value="${v.id}" ${cfg.values[a.id] === v.id ? "selected" : ""} ${reachable(a.id, v.id) ? "" : "disabled"}>${esc(v.label)}</option>`).join(""),
        ),
      )
      .join("")}
    ${sel(
      "battery",
      "Battery",
      `<option value="">None</option>` +
        batteries.map((b) => `<option value="${b.id}" ${Number(cfg.battery) === b.id ? "selected" : ""}>${esc(itemOf(b.itemId).companies[company.id]?.partNumber)} · ${esc(b.runtime)}, ${esc(b.batteryType)}</option>`).join(""),
    )}
    ${groups
      .map((g) => {
        const subs = db.subOptions.filter((s) => s.groupId === g.id && s.itemId);
        return [...new Set(subs.map((s) => s.category))]
          .map((cat) =>
            sel(
              `pick:${g.id}|${cat}`,
              `${esc(g.name)}${cat ? ` <span class="muted" style="font-weight:400">› ${esc(cat)}</span>` : ""}`,
              `<option value="">None</option>` +
                subs.filter((s) => s.category === cat).map((s) => `<option value="${s.id}" ${Number(cfg.picks[`${g.id}|${cat}`]) === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join(""),
            ),
          )
          .join("");
      })
      .join("")}
  </div>`;

  const label = quote?.privateLabelId ? byId(db.privateLabels, quote.privateLabelId) : null;
  const right = !complete
    ? `<div class="empty">Choose ${axes.map((a) => esc(a.name.toLowerCase())).join(", ")} on the left to find the unit.</div>`
    : !unit
      ? `<div class="empty">That combination isn't a listed unit.</div>`
      : `${label ? `<p class="hint">Priced with the ${esc(label.name)} private-label multiplier.</p>` : ""}${table(
          `<th>Line</th><th>Part number</th><th>Description</th><th class="num">Cost</th><th class="num">Price</th>`,
          priced.map((l) => `<tr><td class="muted">${esc(l.kind)}</td><td class="mono">${esc(l.partNumber)}</td><td>${esc(l.description)}</td><td class="num muted">${money(l.cost)}</td><td class="num">${money(l.price)}</td></tr>`).join(""),
        )}
        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:14px;flex-wrap:wrap">
          <dl class="kv" style="min-width:240px"><dt class="strong">Total</dt><dd class="strong">${money(total)}</dd>${transfer != null ? `<dt>Transfer from ${esc(parent().code)}</dt><dd>${money(transfer)}</dd>` : ""}<dt>Cost</dt><dd>${money(cost)}</dd><dt>Margin</dt><dd>${margin(total, cost) ?? "—"}%</dd></dl>
          ${quote ? `<button class="btn primary" data-act="addConfigured" data-quote="${quote.id}" data-product="${p.id}" data-items="${priced.map((l) => l.itemId).join(",")}" data-kinds="${esc(JSON.stringify(priced.map((l) => l.kind)))}">Add to quote</button>` : ""}
        </div>`;

  return `<div class="grid cfg">${card("Configure", left)}${card(`Quote lines · ${esc(company.name)}`, right)}</div>`;
}

// ── Item master ────────────────────────────────────────────────

function itemsView() {
  const P = parent();
  const q = ui.itemQ.trim().toLowerCase();
  const matches = db.items.filter((it) => !q || Object.values(it.companies).some((c) => (c.partNumber + " " + c.description).toLowerCase().includes(q)));
  const counts = Object.fromEntries(Object.keys(TYPES).map((t) => [t, matches.filter((i) => i.type === t).length]));
  const shown = matches.filter((i) => !ui.itemType || i.type === ui.itemType);
  const sections = Object.keys(TYPES)
    .map((t) => ({ t, rows: shown.filter((i) => i.type === t).sort((a, b) => (a.companies[P.id]?.partNumber ?? "").localeCompare(b.companies[P.id]?.partNumber ?? "", undefined, { numeric: true })) }))
    .filter((s) => s.rows.length);
  const cols = db.companies.length * 2 + 2;
  const body = sections
    .map(
      (s) =>
        (ui.itemType ? "" : `<tr class="band"><td colspan="${cols}">${TYPES[s.t]} <span style="font-weight:400">${s.rows.length}</span></td></tr>`) +
        s.rows
          .map((it) => {
            const m = margin(it.companies[P.id]?.price, it.cost);
            return `<tr class="click" data-go="#/master/item/${it.id}">${db.companies
              .map((c, i) => `<td class="mono">${i === 0 ? `<a href="#/master/item/${it.id}">${esc(it.companies[c.id]?.partNumber)}</a>` : esc(it.companies[c.id]?.partNumber)}</td>`)
              .join("")}<td class="num">${money(it.cost)}</td>${db.companies
              .map((c) => `<td class="num">${money(it.companies[c.id]?.price)}${c.isParent ? "" : varTag(it.companies[c.id]?.price, it.companies[P.id]?.price)}</td>`)
              .join("")}<td class="num muted">${m == null ? "—" : m + "%"}</td></tr>`;
          })
          .join(""),
    )
    .join("");
  const chips = `<div class="chips"><button class="chip ${ui.itemType ? "" : "on"}" data-act="itemType" data-v="">All<span class="n">${matches.length}</span></button>${Object.entries(TYPES)
    .map(([t, l]) => `<button class="chip ${ui.itemType === t ? "on" : ""}" data-act="itemType" data-v="${t}">${l}<span class="n">${counts[t]}</span></button>`)
    .join("")}</div>`;
  return (
    pageHead("Item master") +
    card(
      "",
      `<div class="row" style="margin-bottom:12px;justify-content:space-between">${chips}<form data-form="itemSearch" class="row" style="flex:0 1 360px"><input name="q" value="${esc(ui.itemQ)}" placeholder="Search part number or description" aria-label="Search"><button class="btn secondary">Search</button></form></div>` +
        (body
          ? `<div class="tablewrap"><table><thead><tr>${db.companies.map((c) => `<th>${coChip(c)} part number</th>`).join("")}<th class="num">Cost</th>${db.companies.map((c) => `<th class="num">${coChip(c)} sell $</th>`).join("")}<th class="num">Margin</th></tr></thead><tbody>${body}</tbody></table></div>`
          : `<div class="empty">No items match.</div>`),
    )
  );
}

function itemView(id) {
  const it = itemOf(id);
  if (!it) return `<div class="empty">Not found.</div>`;
  const P = parent();
  const cards = db.companies
    .map((c) => {
      const e = it.companies[c.id] ?? {};
      const tr = transferPrice(it, c);
      return card(
        `${coChip(c)} ${esc(c.name)}`,
        `<div class="stack">
          <label class="field"><span>Part number</span><input form="item" name="pn${c.id}" value="${esc(e.partNumber)}" class="mono"></label>
          <label class="field"><span>Description</span><textarea form="item" name="d${c.id}" rows="3">${esc(e.description)}</textarea></label>
          <label class="field"><span>Sell price</span><input form="item" name="p${c.id}" value="${e.price ?? ""}" inputmode="decimal"></label>
          <dl class="kv" style="font-size:13px">${
            c.isParent
              ? `<dt>Margin over cost</dt><dd>${margin(e.price, it.cost) ?? "—"}%</dd>`
              : `<dt>vs ${esc(P.code)}</dt><dd>${variance(e.price, it.companies[P.id]?.price) ?? "—"}%</dd><dt>Transfer (${it.transferPct ?? c.transferPct}% of ${esc(P.code)})</dt><dd>${money(tr)}</dd><dt>Margin over transfer</dt><dd>${margin(e.price, tr) ?? "—"}%</dd>`
          }</dl>
        </div>`,
      );
    })
    .join("");
  const hist = db.priceHistory
    .filter((h) => h.itemId === id)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
    .map((h) => {
      const v = variance(h.newValue, h.oldValue);
      const c = h.companyId ? byId(db.companies, h.companyId) : null;
      return `<tr><td class="muted" style="white-space:nowrap">${dateTime(h.at)}</td><td>${c ? coChip(c) + " sell price" : "Cost"}</td><td class="num">${money(h.oldValue)}</td><td class="num">${money(h.newValue)}</td><td class="num" style="color:${v == null ? "inherit" : v > 0 ? "#166534" : "#b42318"}">${v == null ? "new" : (v > 0 ? "+" : "") + v + "%"}</td><td class="muted">${esc(h.note)}</td></tr>`;
    })
    .join("");
  const usedIn = [
    ...db.units.filter((u) => u.itemId === id).map((u) => [u.productId, "Unit"]),
    ...db.batteries.filter((b) => b.itemId === id).map((b) => [b.productId, "Battery"]),
    ...db.subOptions.filter((s) => s.itemId === id).map((s) => {
      const g = byId(db.optionGroups, s.groupId);
      return [g.productId, `Option: ${g.name} › ${s.name}`];
    }),
  ];
  return `
    ${pageHead(`<span class="mono" style="font-size:22px">${esc(it.companies[P.id]?.partNumber)}</span>`, [["#/master/items", "Item master"]], `<span class="badge">${esc(TYPES[it.type] ?? it.type)}</span>`)}
    <form id="item" data-form="item" data-item="${id}"></form>
    <div class="grid side">
      <div class="grid">
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">${cards}</div>
        ${card("Price history", hist ? table("<th>When</th><th>What</th><th class='num'>Was</th><th class='num'>Now</th><th class='num'>Change</th><th>Note</th>", hist) : `<div class="empty">No price changes yet.</div>`)}
      </div>
      <div class="grid" style="align-content:start">
        ${card(
          "Item details",
          `<div class="stack">
            <label class="field"><span>Cost (from MRP later)</span><input form="item" name="cost" value="${it.cost ?? ""}" inputmode="decimal"></label>
            <label class="field"><span>Transfer % override</span><input form="item" name="transferPct" value="${it.transferPct ?? ""}" placeholder="Company default" inputmode="decimal"></label>
            <label class="field"><span>Reason for price change</span><input form="item" name="note" placeholder="2027 price increase"></label>
            <button class="btn primary" form="item">Save item</button>
          </div>`,
        )}
        ${card("Used in", usedIn.length ? `<ul style="margin:0;padding-left:1.1em">${usedIn.map(([pid, as]) => `<li><a href="#/master/product/${pid}">${esc(productTitle(byId(db.products, pid), P.id))}</a> <span class="muted">· ${esc(as)}</span></li>`).join("")}</ul>` : `<div class="empty">Not attached to a product.</div>`)}
      </div>
    </div>`;
}

function varianceView() {
  const P = parent();
  const rows = db.items
    .map((it) => {
      const prices = db.companies.map((c) => it.companies[c.id]?.price).filter((x) => x != null && x > 0);
      return { it, spread: prices.length > 1 ? variance(Math.max(...prices), Math.min(...prices)) : null };
    })
    .filter((r) => r.spread != null && r.spread >= ui.varMin)
    .sort((a, b) => b.spread - a.spread)
    .map(
      ({ it, spread }) =>
        `<tr class="click" data-go="#/master/item/${it.id}"><td><span class="badge">${esc(TYPES[it.type])}</span></td><td class="mono"><a href="#/master/item/${it.id}">${esc(it.companies[P.id]?.partNumber)}</a></td><td class="num">${money(it.cost)}</td>${db.companies
          .map((c) => `<td class="num">${money(it.companies[c.id]?.price)}${c.isParent ? "" : varTag(it.companies[c.id]?.price, it.companies[P.id]?.price)}</td>`)
          .join("")}<td class="num"><b>${spread}%</b></td></tr>`,
    )
    .join("");
  return (
    pageHead("Price variance") +
    card(
      "",
      `<form data-form="variance" class="row" style="margin-bottom:12px"><label class="field" style="flex:0 0 auto"><span>Show items where company prices differ by at least (%)</span><input name="min" value="${ui.varMin}" class="w-s"></label><button class="btn secondary">Update</button></form>` +
        (rows ? table(`<th>Type</th><th>${esc(P.code)} part number</th><th class="num">Cost</th>${db.companies.map((c) => `<th class="num">${coChip(c)} sell $</th>`).join("")}<th class="num">Spread</th>`, rows) : `<div class="empty">No items differ by that much.</div>`),
    )
  );
}

function historyView() {
  const P = parent();
  const rows = [...db.priceHistory]
    .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
    .slice(0, 150)
    .map((h) => {
      const it = itemOf(h.itemId);
      const c = h.companyId ? byId(db.companies, h.companyId) : null;
      const v = variance(h.newValue, h.oldValue);
      return `<tr><td class="muted" style="white-space:nowrap">${dateTime(h.at)}</td><td class="mono"><a href="#/master/item/${it.id}">${esc(it.companies[P.id]?.partNumber)}</a></td><td>${c ? coChip(c) : "Cost"}</td><td class="num">${money(h.oldValue)}</td><td class="num">${money(h.newValue)}</td><td class="num">${v == null ? "new" : (v > 0 ? "+" : "") + v + "%"}</td><td class="muted">${esc(h.note)}</td></tr>`;
    })
    .join("");
  return pageHead("Price history") + card("", `<p class="hint">Every price and cost change is recorded automatically. Showing the latest 150.</p>` + table("<th>When</th><th>Part number</th><th>What</th><th class='num'>Was</th><th class='num'>Now</th><th class='num'>Change</th><th>Note</th>", rows));
}

function companiesView() {
  const ours = db.companies
    .map((c) =>
      card(
        `${coChip(c)} ${esc(c.name)}`,
        c.isParent
          ? `<p class="hint" style="margin:0">Parent company and manufacturer. Sells to the others at the transfer price.</p>`
          : `<form data-form="transfer" data-company="${c.id}" class="row"><label class="field"><span>Transfer % of ${esc(parent().code)} sell price</span><input name="pct" value="${c.transferPct ?? ""}" inputmode="decimal"></label><button class="btn primary">Save</button></form>`,
      ),
    )
    .join("");
  const labels = db.privateLabels
    .map((l) => `<tr class="click" data-go="#/master/label/${l.id}"><td><a href="#/master/label/${l.id}"><b>${esc(l.name)}</b></a></td><td>${esc(byId(db.companies, l.baseCompanyId).code)} sell price</td><td class="num">× ${l.defaultMultiplier}</td><td class="num">${Object.keys(l.multipliers).length}</td></tr>`)
    .join("");
  return `
    ${pageHead("Our companies")}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">${ours}</div>
    <div class="ph" style="margin-top:30px"><h1>Private labels</h1></div>
    <div class="grid side">
      ${card("", `<p class="hint">OEM and private-label customers buy at one of our companies' prices × a multiplier, set for each product. Products without their own multiplier use the default.</p>` + table("<th>Private label</th><th>Priced from</th><th class='num'>Default</th><th class='num'>Product multipliers</th>", labels))}
      ${card(
        "New private label",
        `<form data-form="newLabel" class="stack"><label class="field"><span>Name</span><input name="name" required placeholder="Acme Lighting OEM"></label><label class="field"><span>Default multiplier</span><input name="mult" value="0.9" inputmode="decimal"></label><button class="btn primary">Create</button></form>`,
      )}
    </div>`;
}

function labelView(id) {
  const l = byId(db.privateLabels, id);
  if (!l) return `<div class="empty">Not found.</div>`;
  const groups = db.groups
    .map((g) => {
      const products = db.products.filter((p) => p.groupId === g.id);
      if (!products.length) return "";
      return card(
        esc(g.name),
        table(
          `${db.companies.map((c) => `<th>${coChip(c)} product</th>`).join("")}<th>Multiplier</th>`,
          products
            .map(
              (p) =>
                `<tr>${db.companies.map((c, i) => `<td${i === 0 ? ' style="font-weight:600"' : ""}>${esc(p.names[c.id]?.name || "—")}</td>`).join("")}<td><input form="label" name="m${p.id}" value="${l.multipliers[p.id] ?? ""}" placeholder="× ${l.defaultMultiplier}" class="w-m" inputmode="decimal" aria-label="Multiplier"></td></tr>`,
            )
            .join(""),
        ),
      );
    })
    .join("");
  return `
    ${pageHead(esc(l.name), [["#/master/companies", "Companies & private labels"]])}
    <form id="label" data-form="label" data-label="${id}"></form>
    <div class="grid side">
      <div class="grid"><p class="hint" style="margin:0">Price = ${esc(byId(db.companies, l.baseCompanyId).code)} sell price × multiplier. Leave a product blank to use the default (× ${l.defaultMultiplier}).</p>${groups}</div>
      <div>${card("Details", `<div class="stack"><label class="field"><span>Name</span><input form="label" name="name" value="${esc(l.name)}"></label><label class="field"><span>Default multiplier</span><input form="label" name="default" value="${l.defaultMultiplier}" inputmode="decimal"></label><button class="btn primary" form="label">Save multipliers</button></div>`)}</div>
    </div>`;
}

// ── CRM ────────────────────────────────────────────────────────

function crmNav(on) {
  return `<nav class="subnav"><span>CRM</span><a href="#/crm" class="${on === "companies" ? "on" : ""}">Companies</a><a href="#/quotes">Quotes</a><a href="#/crm/settings" class="${on === "settings" ? "on" : ""}">Territories &amp; types</a></nav>`;
}

function crmView([page, id]) {
  if (page === "company") return crmNav("companies") + companyView(Number(id));
  if (page === "settings") return crmNav("settings") + crmSettingsView();
  return crmNav("companies") + companiesListView();
}

const territoryNo = (id) => byId(db.territories, id)?.number ?? "—";
const typeName = (id) => byId(db.companyTypes, id)?.name ?? "";

function companiesListView() {
  const q = ui.crmQ.trim().toLowerCase();
  const list = db.customers
    .filter((c) => !ui.crmTerritory || c.territoryId === Number(ui.crmTerritory))
    .filter((c) => !ui.crmType || c.typeId === Number(ui.crmType))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || db.contacts.some((p) => p.companyId === c.id && (p.name + " " + p.email).toLowerCase().includes(q)))
    .sort((a, b) => territoryNo(a.territoryId) - territoryNo(b.territoryId) || a.name.localeCompare(b.name));
  const rows = list
    .map((c) => {
      const quotes = db.quotes.filter((x) => x.customerId === c.id);
      const last = quotes.map((x) => x.at).sort().pop();
      const people = db.contacts.filter((p) => p.companyId === c.id && p.active).length;
      return `<tr class="click s-${c.status}" data-go="#/crm/company/${c.id}"><td class="num">${territoryNo(c.territoryId)}</td><td><a href="#/crm/company/${c.id}" style="color:inherit"><b>${esc(c.name)}</b></a>${c.focus ? `<div class="muted" style="font-size:12.5px">${esc(c.focus)}</div>` : ""}</td><td>${esc(typeName(c.typeId))}</td><td>${esc([c.city, c.state].filter(Boolean).join(", "))}</td><td class="num">${people}</td><td class="num">${quotes.length}</td><td class="num">${last ? shortDate(last) : ""}</td></tr>`;
    })
    .join("");
  const legend = `<div class="chips legend" style="margin-bottom:12px">${["engineer_spec", "sales_progress", "late", "no_activity", "non_performing"]
    .map((s) => `<span class="s-${s}" style="background:var(--s-${{ engineer_spec: "spec", sales_progress: "progress", late: "late", no_activity: "none", non_performing: "bad" }[s]})">${STATUS[s]}</span>`)
    .join("")}</div>`;
  return `
    ${pageHead("Companies")}
    <div class="grid side">
      ${card(
        "",
        `<form data-form="crmFilter" class="row" style="margin-bottom:10px">
          <label class="field" style="flex:0 1 170px"><span>Territory</span><select name="territory"><option value="">All</option>${db.territories.map((t) => `<option value="${t.id}" ${Number(ui.crmTerritory) === t.id ? "selected" : ""}>${t.number}${t.name ? " · " + esc(t.name) : ""}</option>`).join("")}</select></label>
          <label class="field" style="flex:0 1 170px"><span>Company type</span><select name="type"><option value="">All</option>${db.companyTypes.map((t) => `<option value="${t.id}" ${Number(ui.crmType) === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
          <label class="field"><span>Search</span><input name="q" value="${esc(ui.crmQ)}" placeholder="Company, contact name or email"></label>
          <button class="btn secondary">Filter</button>
        </form>${legend}` +
          (rows ? table("<th class='num'>Territory</th><th>Company</th><th>Type</th><th>City</th><th class='num'>Contacts</th><th class='num'>Quotes</th><th class='num'>Last quote</th>", rows) : `<div class="empty">No companies match.</div>`) +
          `<p class="hint" style="margin:10px 0 0">${list.length} companies</p>`,
      )}
      ${card(
        "New company",
        `<form data-form="newCompany" class="stack">
          <label class="field"><span>Company name</span><input name="name" required></label>
          <div class="row"><label class="field"><span>Territory</span><select name="territory">${db.territories.map((t) => `<option value="${t.id}">${t.number}</option>`).join("")}</select></label>
          <label class="field"><span>Type</span><select name="type">${db.companyTypes.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label></div>
          <div class="row"><label class="field"><span>City</span><input name="city"></label><label class="field" style="flex:0 0 70px"><span>State</span><input name="state" maxlength="2"></label></div>
          <button class="btn primary">Create company</button>
        </form>`,
      )}
    </div>`;
}

function companyView(id) {
  const c = byId(db.customers, id);
  if (!c) return `<div class="empty">Not found.</div>`;
  const people = db.contacts.filter((p) => p.companyId === id).sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
  const quotes = db.quotes.filter((x) => x.customerId === id).sort((a, b) => b.at.localeCompare(a.at));
  const total = quotes.reduce((s, x) => s + quoteTotal(x.id), 0);
  const active = quotes.filter((x) => x.status === "draft" || x.status === "sent").length;

  const quotesCard = card(
    `Quotes <span class="muted" style="font-weight:400">· ${active} active of ${quotes.length} · ${moneyText(total)}</span>`,
    `<form data-form="newQuote" data-customer="${id}" class="row" style="margin-bottom:14px">
      <label class="field" style="flex:0 1 110px"><span>Quote from</span><select name="seller">${db.companies.map((x) => `<option value="${x.id}">${esc(x.code)}</option>`).join("")}</select></label>
      <label class="field"><span>Private label pricing</span><select name="label"><option value="">None (standard price)</option>${db.privateLabels.map((l) => `<option value="${l.id}" ${quotes[0]?.privateLabelId === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
      <label class="field"><span>Contact</span><select name="contact"><option value="">—</option>${people.filter((p) => p.active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>
      <label class="field"><span>Project</span><input name="project" placeholder="Job name"></label>
      <button class="btn primary">New quote</button>
    </form>` + (quotes.length ? quotesTable(quotes, false) : `<div class="empty">No quotes yet.</div>`),
  );

  const contactRows = people
    .map((p) => {
      const f = `c${p.id}`;
      return `<tr style="${p.active ? "" : "opacity:.5"}"><td><input form="${f}" name="name" value="${esc(p.name)}" required style="min-width:140px"></td><td><input form="${f}" name="title" value="${esc(p.title)}" style="min-width:140px"></td><td><input form="${f}" name="email" value="${esc(p.email)}" style="min-width:190px"></td><td><input form="${f}" name="phone" value="${esc(p.phone)}" style="min-width:120px"></td><td style="text-align:center"><input form="${f}" type="checkbox" name="active" ${p.active ? "checked" : ""} style="width:16px;height:16px;accent-color:var(--brand)" aria-label="Active"></td><td style="white-space:nowrap"><button class="btn secondary sm" data-act="noteFilter" data-v="${p.id}">Notes</button> <form id="${f}" data-form="contact" data-contact="${p.id}" style="display:inline"><button class="btn secondary sm">Save</button></form></td></tr>`;
    })
    .join("");
  const contactsCard = card(
    `Contacts (${people.length})`,
    table(
      "<th>Name</th><th>Title</th><th>Email</th><th>Phone</th><th>Active</th><th></th>",
      contactRows +
        `<tr style="background:#f8f9f7"><td><input form="cnew" name="name" placeholder="New contact" required></td><td><input form="cnew" name="title" placeholder="Title"></td><td><input form="cnew" name="email" placeholder="Email"></td><td><input form="cnew" name="phone" placeholder="Phone"></td><td></td><td><form id="cnew" data-form="newContact" data-company="${id}"><button class="btn primary sm">Add</button></form></td></tr>`,
    ),
  );

  const f = ui.noteFilter;
  const notes = db.notes
    .filter((n) => n.companyId === id)
    .filter((n) => !f || (f === "company" ? n.contactId == null : n.contactId === Number(f)))
    .sort((a, b) => b.at.localeCompare(a.at));
  const chips = [["", "All"], ["company", "Company only"], ...people.map((p) => [String(p.id), p.name])]
    .map(([k, l]) => `<button class="chip ${String(f) === k ? "on" : ""}" data-act="noteFilter" data-v="${k}">${esc(l)}</button>`)
    .join("");
  const notesCard = card(
    "Notes",
    `<form data-form="note" data-company="${id}" class="stack" style="margin-bottom:12px">
      <textarea name="body" rows="3" required placeholder="Write a note…" aria-label="Note"></textarea>
      <div class="row"><label class="field" style="flex:0 1 220px"><span>About</span><select name="contact"><option value="">Whole company</option>${people.map((p) => `<option value="${p.id}" ${String(f) === String(p.id) ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      <label class="field" style="flex:0 1 140px"><span>Type</span><select name="kind">${["note", "call", "email", "meeting", "visit"].map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}</select></label>
      <button class="btn primary">Add note</button></div>
    </form>
    <div class="chips" style="margin-bottom:8px">${chips}</div>` +
      (notes.length
        ? notes
            .map((n) => {
              const who = n.contactId ? byId(db.contacts, n.contactId)?.name : null;
              return `<div style="padding:10px 0;border-top:1px solid #eef0ed"><div class="muted" style="font-size:12.5px;margin-bottom:3px"><span class="badge" style="${who ? "background:var(--brand-soft);color:var(--brand-dark)" : ""}">${esc(who ?? "Company")}</span> ${esc(n.kind[0].toUpperCase() + n.kind.slice(1))} · ${dateTime(n.at)}</div><div>${esc(n.body)}</div></div>`;
            })
            .join("")
        : `<div class="empty">No notes yet.</div>`),
  );

  const detail = card(
    "Company details",
    `<form data-form="company" data-company="${id}" class="stack">
      <label class="field"><span>Company name</span><input name="name" value="${esc(c.name)}" required></label>
      <div class="row"><label class="field"><span>Territory</span><select name="territory">${db.territories.map((t) => `<option value="${t.id}" ${c.territoryId === t.id ? "selected" : ""}>${t.number}${t.name ? " · " + esc(t.name) : ""}</option>`).join("")}</select></label>
      <label class="field"><span>Type</span><select name="type">${db.companyTypes.map((t) => `<option value="${t.id}" ${c.typeId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label></div>
      <label class="field"><span>Status</span><select name="status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${c.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field"><span>Focus</span><input name="focus" value="${esc(c.focus)}"></label>
      <label class="field"><span>Phone</span><input name="phone" value="${esc(c.phone)}"></label>
      <label class="field"><span>Website</span><input name="website" value="${esc(c.website)}"></label>
      <label class="field"><span>Street</span><input name="street" value="${esc(c.street)}"></label>
      <div class="row"><label class="field"><span>City</span><input name="city" value="${esc(c.city)}"></label><label class="field" style="flex:0 0 64px"><span>State</span><input name="state" value="${esc(c.state)}"></label><label class="field" style="flex:0 0 90px"><span>Zip</span><input name="zip" value="${esc(c.zip)}"></label></div>
      <button class="btn primary">Save</button>
    </form>`,
  );

  const status = c.status !== "none" ? `<span class="badge s-${c.status}" style="background:var(--s-${{ engineer_spec: "spec", sales_progress: "progress", late: "late", no_activity: "none", non_performing: "bad" }[c.status]})">${STATUS[c.status]}</span>` : "";
  return `
    ${pageHead(esc(c.name), [["#/crm", "Companies"]], `<div class="chips"><span class="badge" style="background:var(--brand-soft);color:var(--brand-dark)">Territory ${territoryNo(c.territoryId)}</span><span class="badge">${esc(typeName(c.typeId))}</span>${status}</div>`)}
    <div class="grid side"><div class="grid">${quotesCard}${contactsCard}${notesCard}</div><div>${detail}</div></div>`;
}

function crmSettingsView() {
  return `
    ${pageHead("Territories & company types")}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      ${card("Territories", table("<th class='num'>Number</th><th>Name</th><th class='num'>Companies</th>", db.territories.map((t) => `<tr><td class="num"><b>${t.number}</b></td><td>${esc(t.name)}</td><td class="num">${db.customers.filter((c) => c.territoryId === t.id).length}</td></tr>`).join("")))}
      ${card("Company types", table("<th>Type</th><th class='num'>Companies</th>", db.companyTypes.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${db.customers.filter((c) => c.typeId === t.id).length}</td></tr>`).join("")))}
    </div>`;
}

// ── Quotes ─────────────────────────────────────────────────────

const quoteLines = (id) => db.quoteLines.filter((l) => l.quoteId === id);
const quoteTotal = (id) => quoteLines(id).reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
const statusBadge = (s) => `<span class="badge st-${s}">${QSTATUS[s]}</span>`;

function quotesTable(quotes, showCustomer) {
  return table(
    `<th>Quote</th><th>Date</th>${showCustomer ? "<th>Customer</th>" : ""}<th>Project</th><th>Contact</th><th>From</th><th>Status</th><th class="num">Total</th>`,
    quotes
      .map((x) => {
        const cust = byId(db.customers, x.customerId);
        const label = x.privateLabelId ? byId(db.privateLabels, x.privateLabelId) : null;
        return `<tr class="click" data-go="#/quote/${x.id}"><td class="mono"><a href="#/quote/${x.id}">${quoteNo(x.id)}</a></td><td class="num">${shortDate(x.at)}</td>${showCustomer ? `<td>${esc(cust.name)} <span class="muted" style="font-size:12px">${territoryNo(cust.territoryId)}</span></td>` : ""}<td>${esc(x.project)}</td><td>${esc(byId(db.contacts, x.contactId)?.name ?? "")}</td><td style="white-space:nowrap">${esc(byId(db.companies, x.sellerId).code)}${label ? ` <span class="muted" style="font-size:12px">· ${esc(label.name)}</span>` : ""}</td><td>${statusBadge(x.status)}</td><td class="num">${moneyText(quoteTotal(x.id))}</td></tr>`;
      })
      .join(""),
  );
}

function quotesListView() {
  const list = db.quotes.filter((x) => !ui.quoteStatus || x.status === ui.quoteStatus).sort((a, b) => b.at.localeCompare(a.at));
  const chips = [["", "All"], ...Object.entries(QSTATUS)].map(([k, l]) => `<button class="chip ${ui.quoteStatus === k ? "on" : ""}" data-act="quoteStatus" data-v="${k}">${l}</button>`).join("");
  return `<nav class="subnav"><span>Quotes</span><a href="#/quotes" class="on">All quotes</a><a href="#/crm">Companies</a></nav>${pageHead("Quotes")}<div class="chips" style="margin-bottom:12px">${chips}</div>${card("", list.length ? quotesTable(list, true) : `<div class="empty">No quotes.</div>`)}<p class="hint" style="margin-top:10px">Start a new quote from a company in the <a href="#/crm">CRM</a>.</p>`;
}

function quoteView([id, sub]) {
  const x = byId(db.quotes, id);
  if (!x) return `<div class="empty">Not found.</div>`;
  if (sub === "document") return quoteDocument(x);
  const cust = byId(db.customers, x.customerId);
  const seller = byId(db.companies, x.sellerId);
  const label = x.privateLabelId ? byId(db.privateLabels, x.privateLabelId) : null;
  const lines = quoteLines(x.id);
  const sections = [...new Set(lines.map((l) => l.section))].sort((a, b) => a - b);
  const total = quoteTotal(x.id);
  const cost = lines.reduce((s, l) => s + (l.cost ?? 0) * l.qty, 0);
  const transfer = lines.reduce((s, l) => s + (l.transfer ?? 0) * l.qty, 0);
  const people = db.contacts.filter((p) => p.companyId === cust.id && p.active);

  const body = sections
    .map(
      (s) =>
        `<tr class="band"><td colspan="6">Item ${s}</td><td style="text-align:right"><button class="btn danger sm" data-act="delSection" data-quote="${x.id}" data-v="${s}">Remove item</button></td></tr>` +
        lines
          .filter((l) => l.section === s)
          .map((l) => {
            const f = `l${l.id}`;
            return `<tr><td class="muted" style="font-size:12.5px">${esc(l.kind)}</td><td class="mono">${esc(l.partNumber)}</td><td style="min-width:220px">${esc(l.description)}</td><td><input form="${f}" name="qty" value="${l.qty}" class="w-s" inputmode="decimal" aria-label="Quantity"></td><td style="white-space:nowrap"><input form="${f}" name="price" value="${l.price ?? ""}" class="w-m" inputmode="decimal" aria-label="Unit price">${l.multiplier != null ? `<div class="muted" style="font-size:11.5px">× ${l.multiplier} private label</div>` : ""}</td><td class="num">${money(l.price == null ? null : l.price * l.qty)}</td><td style="white-space:nowrap"><form id="${f}" data-form="line" data-line="${l.id}" style="display:inline"><button class="btn secondary sm">Save</button></form> <button class="btn danger sm" data-act="delLine" data-v="${l.id}" aria-label="Remove line">✕</button></td></tr>`;
          })
          .join(""),
    )
    .join("");

  const productId = Number(ui[`q${x.id}product`]) || null;
  const product = productId ? byId(db.products, productId) : null;
  const productOptions = db.groups
    .map((g) => {
      const ps = db.products.filter((p) => p.groupId === g.id && db.units.some((u) => u.productId === p.id));
      return ps.length ? `<optgroup label="${esc(g.name)}">${ps.map((p) => `<option value="${p.id}" ${productId === p.id ? "selected" : ""}>${esc(productTitle(p, seller.id))}</option>`).join("")}</optgroup>` : "";
    })
    .join("");

  return `
    ${pageHead(`<span class="mono">${quoteNo(x.id)}</span> ${statusBadge(x.status)}`, [["#/quotes", "Quotes"], [`#/crm/company/${cust.id}`, cust.name]], `<div class="row"><span class="muted">From <b>${esc(seller.name)}</b>${label ? ` · private label <b>${esc(label.name)}</b>` : ""}</span><a class="btn primary" href="#/quote/${x.id}/document">View quote document</a></div>`)}
    <div class="grid side">
      <div class="grid">
        ${card(
          "Lines",
          lines.length
            ? table("<th>Line</th><th>Part number</th><th>Description</th><th>Qty</th><th>Unit price</th><th class='num'>Extended</th><th></th>", body) +
                `<dl class="kv" style="max-width:300px;margin:14px 0 0 auto"><dt class="strong">Total</dt><dd class="strong">${money(total)}</dd>${seller.isParent ? "" : `<dt>Transfer from ${esc(parent().code)}</dt><dd>${money(transfer)}</dd>`}<dt>Cost</dt><dd>${money(cost)}</dd><dt>Margin</dt><dd>${margin(total, cost) ?? "—"}%</dd></dl>`
            : `<div class="empty">No lines yet. Configure a unit below.</div>`,
        )}
        ${card(
          "Add a configured unit",
          `<label class="field" style="max-width:420px;margin-bottom:14px"><span>Product</span><select data-act-change="quoteProduct" data-quote="${x.id}"><option value="">Choose a product…</option>${productOptions}</select></label>` +
            (product ? configurator(product, { quote: x }) : `<p class="hint" style="margin:0">Pick a product to configure capacity, voltages, battery and options.</p>`),
        )}
        ${card(
          "Add a part by number",
          `<form data-form="addPart" data-quote="${x.id}" class="row"><label class="field" style="flex:0 1 240px"><span>Part number (any company)</span><input name="pn" required class="mono" placeholder="9500-2008-01"></label><label class="field" style="flex:0 0 80px"><span>Qty</span><input name="qty" value="1"></label><button class="btn primary">Add part</button></form>`,
        )}
      </div>
      <div>${card(
        "Quote details",
        `<form data-form="quote" data-quote="${x.id}" class="stack">
          <label class="field"><span>Status</span><select name="status">${Object.entries(QSTATUS).map(([k, l]) => `<option value="${k}" ${x.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="field"><span>Project</span><input name="project" value="${esc(x.project)}"></label>
          <label class="field"><span>Contact</span><select name="contact"><option value="">—</option>${people.map((p) => `<option value="${p.id}" ${x.contactId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
          <label class="field"><span>Private label pricing</span><select name="label"><option value="">None (standard price)</option>${db.privateLabels.map((l) => `<option value="${l.id}" ${x.privateLabelId === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
          <p class="hint" style="margin:0">Changing the private label reprices every line.</p>
          <button class="btn primary">Save</button>
        </form>
        <div class="row" style="margin-top:14px"><button class="btn secondary" data-act="reprice" data-quote="${x.id}">Reprice from master</button></div>`,
      )}</div>
    </div>`;
}

function quoteDocument(x) {
  const cust = byId(db.customers, x.customerId);
  const seller = byId(db.companies, x.sellerId);
  const contact = byId(db.contacts, x.contactId);
  const lines = quoteLines(x.id);
  const sections = [...new Set(lines.map((l) => l.section))].sort((a, b) => a - b);
  const total = quoteTotal(x.id);
  const body = sections
    .map((s) => {
      const ls = lines.filter((l) => l.section === s);
      const unit = ls.find((l) => l.kind === "Unit") ?? ls[0];
      const title = (unit?.description ?? "").split(/ – |, /)[0] + (unit ? ", " + (unit.description.match(/[\d.]+ KW/)?.[0] ?? "") : "");
      const sub = ls.reduce((t, l) => t + (l.price ?? 0) * l.qty, 0);
      return (
        `<tr class="item"><td colspan="5">Item ${s} · ${esc(title)}</td></tr>` +
        ls.map((l, i) => `<tr class="${i ? "opt" : ""}"><td class="mono">${esc(l.partNumber)}</td><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${moneyText(l.price)}</td><td class="num">${moneyText(l.price == null ? null : l.price * l.qty)}</td></tr>`).join("") +
        `<tr class="sub"><td colspan="4" class="num">Item ${s} subtotal</td><td class="num">${moneyText(sub)}</td></tr>`
      );
    })
    .join("");
  return `
    <div class="row" style="justify-content:space-between;margin-bottom:16px"><div>${crumbs([["#/quotes", "Quotes"], [`#/quote/${x.id}`, quoteNo(x.id)]])}<h1>Quote document</h1></div><a class="btn secondary" href="#/quote/${x.id}">Back to quote</a></div>
    <div class="sheet-wrap"><article class="sheet">
      <div class="head">
        <div><div class="brandname">${esc(seller.name)}</div><div class="muted">Emergency lighting inverters</div></div>
        <div style="text-align:right"><div class="lab">Quotation</div><div class="qno">${quoteNo(x.id)}</div><div>${longDate(x.at)}</div></div>
      </div>
      <div class="parties">
        <div><span class="lab">Prepared for</span><b>${esc(cust.name)}</b><span>${esc(cust.street)}</span><span>${esc([cust.city, cust.state].filter(Boolean).join(", "))}</span></div>
        <div><span class="lab">Attention</span><b>${esc(contact?.name ?? "—")}</b><span>${esc(contact?.title ?? "")}</span><span class="muted">${esc(contact?.email ?? "")}</span></div>
        <div><span class="lab">Project</span><b>${esc(x.project || "—")}</b><span>Valid 30 days</span></div>
      </div>
      ${lines.length ? `<div class="tablewrap"><table class="doc"><thead><tr><th>Part number</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Extended</th></tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty">This quote has no lines yet.</div>`}
      <dl class="kv doc-totals">${sections.map((s) => `<dt>Item ${s}</dt><dd>${moneyText(lines.filter((l) => l.section === s).reduce((t, l) => t + (l.price ?? 0) * l.qty, 0))}</dd>`).join("")}<dt>Freight</dt><dd>Quoted separately</dd><dt class="strong" style="border-top:1.5px solid var(--ink);padding-top:6px">Total</dt><dd class="strong" style="border-top:1.5px solid var(--ink);padding-top:6px">${moneyText(total)}</dd></dl>
      <div class="terms">
        <div><b style="color:var(--ink)">Terms</b><ul><li>Prices valid for 30 days from the quote date.</li><li>Lead time 4 to 6 weeks after approved submittals.</li><li>FOB factory. Payment Net 30 with approved credit.</li></ul></div>
        <div><b style="color:var(--ink)">Notes</b><ul><li>UL 924 listed emergency lighting inverters.</li><li>Start-up must be scheduled two weeks in advance.</li><li>Example terms only.</li></ul></div>
      </div>
      <div class="sign"><div>Accepted by (name, title, date)</div><div>Purchase order number</div></div>
    </article></div>`;
}

// ── Actions ────────────────────────────────────────────────────

function repriceQuote(x) {
  for (const l of quoteLines(x.id)) {
    if (!l.itemId) continue;
    Object.assign(l, priceLine(x, l.itemId, l.productId));
  }
}

const actions = {
  async reset() {
    try {
      localStorage.removeItem(KEY);
    } catch {}
    db = await loadFresh();
    cfg = { productId: null };
    toast("Demo data reset");
    render();
  },
  cap: (d) => ((ui.capFilter = d.v), render()),
  itemType: (d) => ((ui.itemType = d.v), render()),
  quoteStatus: (d) => ((ui.quoteStatus = d.v), render()),
  noteFilter: (d) => ((ui.noteFilter = d.v), render()),
  addConfigured(d) {
    const x = byId(db.quotes, d.quote);
    const productId = Number(d.product);
    const ids = d.items.split(",").map(Number);
    const kinds = JSON.parse(d.kinds);
    const section = quoteLines(x.id).reduce((m, l) => Math.max(m, l.section), 0) + 1;
    ids.forEach((itemId, i) => {
      db.quoteLines.push({ id: nextId(db.quoteLines), quoteId: x.id, itemId, productId, section, kind: kinds[i], qty: 1, ...priceLine(x, itemId, productId) });
    });
    cfg = { productId: null };
    ui[`q${x.id}product`] = "";
    save();
    toast(`Added item ${section} to ${quoteNo(x.id)}`);
    render();
  },
  delLine(d) {
    db.quoteLines = db.quoteLines.filter((l) => l.id !== Number(d.v));
    save();
    render();
  },
  delSection(d) {
    db.quoteLines = db.quoteLines.filter((l) => !(l.quoteId === Number(d.quote) && l.section === Number(d.v)));
    save();
    render();
  },
  reprice(d) {
    repriceQuote(byId(db.quotes, d.quote));
    save();
    toast("Repriced from the master");
    render();
  },
};

const forms = {
  itemPrices(form, fd) {
    const it = itemOf(form.dataset.item);
    for (const c of db.companies) setPrice(it, c.id, numOrNull(fd.get(`p${c.id}`)));
    setCost(it, numOrNull(fd.get("cost")));
    save();
    toast(`Saved ${it.companies[parent().id]?.partNumber}`);
  },
  item(form, fd) {
    const it = itemOf(form.dataset.item);
    const note = String(fd.get("note") || "");
    for (const c of db.companies) {
      const e = (it.companies[c.id] ??= { partNumber: "", description: "", price: null });
      e.partNumber = String(fd.get(`pn${c.id}`) ?? e.partNumber);
      e.description = String(fd.get(`d${c.id}`) ?? e.description);
      setPrice(it, c.id, numOrNull(fd.get(`p${c.id}`)), note);
    }
    setCost(it, numOrNull(fd.get("cost")), note);
    it.transferPct = numOrNull(fd.get("transferPct"));
    save();
    toast("Item saved");
  },
  itemSearch: (form, fd) => (ui.itemQ = String(fd.get("q") || "")),
  variance: (form, fd) => (ui.varMin = numOrNull(fd.get("min")) ?? 0),
  transfer(form, fd) {
    byId(db.companies, form.dataset.company).transferPct = numOrNull(fd.get("pct"));
    save();
    toast("Transfer % saved");
  },
  newLabel(form, fd) {
    const id = nextId(db.privateLabels);
    db.privateLabels.push({ id, name: String(fd.get("name")), baseCompanyId: parent().id, defaultMultiplier: numOrNull(fd.get("mult")) ?? 1, multipliers: {} });
    save();
    location.hash = `#/master/label/${id}`;
  },
  label(form, fd) {
    const l = byId(db.privateLabels, form.dataset.label);
    l.name = String(fd.get("name") || l.name);
    l.defaultMultiplier = numOrNull(fd.get("default")) ?? l.defaultMultiplier;
    for (const p of db.products) {
      const v = numOrNull(fd.get(`m${p.id}`));
      if (v == null) delete l.multipliers[p.id];
      else l.multipliers[p.id] = v;
    }
    save();
    toast("Multipliers saved");
  },
  crmFilter(form, fd) {
    ui.crmTerritory = String(fd.get("territory") || "");
    ui.crmType = String(fd.get("type") || "");
    ui.crmQ = String(fd.get("q") || "");
  },
  newCompany(form, fd) {
    const id = nextId(db.customers);
    db.customers.push({ id, name: String(fd.get("name")), territoryId: Number(fd.get("territory")), typeId: Number(fd.get("type")), status: "none", phone: "", website: "", street: "", city: String(fd.get("city") || ""), state: String(fd.get("state") || "").toUpperCase(), zip: "", focus: "" });
    save();
    location.hash = `#/crm/company/${id}`;
  },
  company(form, fd) {
    const c = byId(db.customers, form.dataset.company);
    Object.assign(c, {
      name: String(fd.get("name")),
      territoryId: Number(fd.get("territory")),
      typeId: Number(fd.get("type")),
      status: String(fd.get("status")),
      focus: String(fd.get("focus")),
      phone: String(fd.get("phone")),
      website: String(fd.get("website")),
      street: String(fd.get("street")),
      city: String(fd.get("city")),
      state: String(fd.get("state")).toUpperCase(),
      zip: String(fd.get("zip")),
    });
    save();
    toast("Company saved");
  },
  contact(form, fd) {
    const p = byId(db.contacts, form.dataset.contact);
    Object.assign(p, { name: String(fd.get("name")), title: String(fd.get("title")), email: String(fd.get("email")), phone: String(fd.get("phone")), active: fd.get("active") === "on" });
    save();
    toast("Contact saved");
  },
  newContact(form, fd) {
    db.contacts.push({ id: nextId(db.contacts), companyId: Number(form.dataset.company), name: String(fd.get("name")), title: String(fd.get("title") || ""), email: String(fd.get("email") || ""), phone: String(fd.get("phone") || ""), active: true });
    save();
    toast("Contact added");
  },
  note(form, fd) {
    const contact = fd.get("contact");
    db.notes.push({ id: nextId(db.notes), companyId: Number(form.dataset.company), contactId: contact ? Number(contact) : null, kind: String(fd.get("kind")), body: String(fd.get("body")), at: new Date().toISOString() });
    save();
    toast("Note added");
  },
  newQuote(form, fd) {
    const id = nextId(db.quotes);
    db.quotes.push({ id, customerId: Number(form.dataset.customer), contactId: fd.get("contact") ? Number(fd.get("contact")) : null, sellerId: Number(fd.get("seller")), privateLabelId: fd.get("label") ? Number(fd.get("label")) : null, project: String(fd.get("project") || ""), status: "draft", at: new Date().toISOString() });
    save();
    location.hash = `#/quote/${id}`;
  },
  quote(form, fd) {
    const x = byId(db.quotes, form.dataset.quote);
    const label = fd.get("label") ? Number(fd.get("label")) : null;
    const changed = label !== x.privateLabelId;
    Object.assign(x, { status: String(fd.get("status")), project: String(fd.get("project")), contactId: fd.get("contact") ? Number(fd.get("contact")) : null, privateLabelId: label });
    if (changed) repriceQuote(x);
    save();
    toast(changed ? "Saved and repriced" : "Quote saved");
  },
  line(form, fd) {
    const l = byId(db.quoteLines, form.dataset.line);
    l.qty = numOrNull(fd.get("qty")) ?? 1;
    l.price = numOrNull(fd.get("price"));
    save();
    toast("Line saved");
  },
  addPart(form, fd) {
    const x = byId(db.quotes, form.dataset.quote);
    const pn = String(fd.get("pn")).trim().toUpperCase();
    const it = db.items.find((i) => i.companies[x.sellerId]?.partNumber.toUpperCase() === pn) ?? db.items.find((i) => Object.values(i.companies).some((c) => c.partNumber.toUpperCase() === pn));
    if (!it) return toast(`No part ${pn} in the master`);
    const productId = productOfItem(it.id);
    const section = quoteLines(x.id).reduce((m, l) => Math.max(m, l.section), 0) + 1;
    db.quoteLines.push({ id: nextId(db.quoteLines), quoteId: x.id, itemId: it.id, productId, section, kind: TYPES[it.type]?.replace(/s$/, "") ?? "Part", qty: numOrNull(fd.get("qty")) ?? 1, ...priceLine(x, it.id, productId) });
    save();
    toast(`Added ${pn}`);
  },
};

// ── Events ─────────────────────────────────────────────────────

document.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (act && actions[act.dataset.act]) {
    e.preventDefault();
    actions[act.dataset.act](act.dataset);
    return;
  }
  const row = e.target.closest("[data-go]");
  if (row && !e.target.closest("a, button, input, select, textarea")) location.hash = row.dataset.go;
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const handler = forms[form.dataset.form];
  if (!handler) return;
  const before = location.hash;
  handler(form, new FormData(form));
  if (location.hash === before) render();
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.cfg) {
    const [kind, key] = el.dataset.cfg.split(/:(.*)/s);
    const v = el.value;
    if (kind === "company") cfg.companyId = Number(v);
    else if (kind === "axis") cfg.values[Number(key)] = v ? Number(v) : undefined;
    else if (kind === "battery") cfg.battery = v;
    else if (kind === "pick") cfg.picks[key] = v;
    render();
  } else if (el.dataset.actChange === "quoteProduct") {
    ui[`q${el.dataset.quote}product`] = el.value;
    cfg = { productId: null };
    render();
  }
});

window.addEventListener("hashchange", () => {
  ui.noteFilter = "";
  ui.capFilter = "";
  render();
});

load().then(render);
