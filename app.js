// Click-through demo of the product master, CRM and quoting. Runs entirely in the browser:
// demo data comes from data.json and changes are kept in this browser's IndexedDB.
"use strict";

const KEY = "crm-build-demo-v6";
let db;

const store = {
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("crm-build-demo", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn) {
    const conn = await this.open();
    return new Promise((resolve, reject) => {
      const req = fn(conn.transaction("kv", mode).objectStore("kv"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  get: (k) => store.run("readonly", (os) => os.get(k)),
  set: (k, v) => store.run("readwrite", (os) => os.put(v, k)),
  del: (k) => store.run("readwrite", (os) => os.delete(k)),
};

async function loadFresh() {
  const res = await fetch("data.json", { cache: "no-store" });
  return res.json();
}
async function load() {
  try {
    const saved = await store.get(KEY);
    if (saved) return (db = saved);
  } catch {}
  db = await loadFresh();
}
let saveTimer;
function save() {
  // Batch quick successive saves into one write.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(KEY, db).catch(() => toast("Couldn't save in this browser; changes last until you reload.")), 150);
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

const ui = { crmManager: "", crmSort: "territory", crmDir: 1, itemType: "", itemQ: "", varMin: 2, crmTerritory: "", crmType: "", crmQ: "", quoteStatus: "", noteFilter: "", capFilter: "" };
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

const flagship = () => {
  const counts = {};
  for (const u of db.units) counts[u.productId] = (counts[u.productId] ?? 0) + 1;
  return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]);
};

function homeView() {
  const fp = flagship();
  const fpName = esc(productTitle(byId(db.products, fp), parent().id));
  const fpGroup = esc(byId(db.groups, byId(db.products, fp).groupId).name);
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
        <li>Open <a href="#/master">Product master</a> › ${fpGroup} › <a href="#/master/product/${fp}/units">${fpName} › Units</a>. Each part number is built from capacity, input voltage and output voltage; N1 or T1 at the end is added automatically (T1 when a transformer is needed because the voltages differ). Each unit has a price for OLP, CPP and PPS.</li>
        <li>Change a price and press Save. Then open that part in the <a href="#/master/items">Item master</a> to see the price history.</li>
        <li>Look at <a href="#/master/product/${fp}/options">Options</a>: breakers, monitoring, testing, output circuits, batteries and more, each down to an assigned part number. <a href="#/master/product/${fp}/batteries">Batteries</a> come in runtimes from 90 to 240 minutes and in VRLA, NiCd and lithium.</li>
        <li>Open <a href="#/crm">CRM</a>, filter by NEMRA territory, and open a company to see its activity, quotes, orders and employees. Add a note for one employee.</li>
        <li>On that company, start a <b>New quote</b>. Type what the customer needs into the <b>Quote assistant</b> (or use the dropdowns), then press <b>Add to quote</b>.</li>
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
  return (
    pageHead("Product groups") +
    `<div class="grid side">${card("", table("<th>Product group</th><th class='num'>Products</th>", rows))}${card(
      "New product group",
      `<form data-form="newGroup" class="stack"><label class="field"><span>Name</span><input name="name" required placeholder="Central Lighting Inverters UL 924"></label><button class="btn primary">Add group</button></form>`,
    )}</div>`
  );
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
  const newProduct = card(
    "New product in this group",
    `<form data-form="newProduct" data-group="${id}" class="stack">
      <p class="hint" style="margin:0">Each company sells it under its own name and part-number prefix.</p>
      ${db.companies
        .map((c) => `<div class="row"><label class="field" style="flex:1 1 160px"><span>${coChip(c)} product name</span><input name="n${c.id}" ${c.isParent ? "required" : ""} placeholder="${c.isParent ? "LumaGuard 2" : ""}"></label><label class="field" style="flex:0 0 90px"><span>Prefix</span><input name="x${c.id}" class="mono" placeholder="${c.isParent ? "L2" : ""}"></label></div>`)
        .join("")}
      <div class="row"><label class="field" style="flex:0 0 90px"><span>Phase</span><select name="phase"><option>1</option><option>3</option></select></label>
      <label class="check" style="padding-bottom:8px"><input type="checkbox" name="tx" checked> Battery inverter (adds N1/T1 for the transformer)</label></div>
      <button class="btn primary">Add product</button>
    </form>`,
  );
  return (
    pageHead(esc(g.name), [["#/master", "Product groups"]]) +
    `<div class="grid side">${card("", `<p class="hint">Each product has its own name and part-number prefix for each company.</p>` + (rows ? table(`<th class="num">Phase</th>${db.companies.map((c) => `<th>${coChip(c)} product</th>`).join("")}<th class="num">Units</th>`, rows) : `<div class="empty">No products in this group yet. Add the first one.</div>`))}${newProduct}</div>`
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
    tab === "configure" ? card("Quote assistant", assistantBox({ productId: p.id })) + `<div style="height:18px"></div>` + configurator(p, {}) :
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
  const firstIn = valuesOf(axes.find((a) => a.role === "input") ?? {})[0];
  const firstOut = valuesOf(axes.find((a) => a.role === "output") ?? {})[0];
  const tx = usesTransformerSuffix(p) && firstIn && firstOut ? (firstIn.label === firstOut.label ? "N1" : "T1") : "";
  const example = (p.names[parent().id]?.prefix || "") + axes.map((a) => valuesOf(a)[0]?.code ?? "").join("") + tx;
  const cards = axes
    .map((a) =>
      card(
        esc(a.name),
        (valuesOf(a).length
          ? table("<th>" + (a.role === "capacity" ? "Capacity (UL listed)" : "Voltage") + "</th><th>Code</th>", valuesOf(a).map((v) => `<tr><td>${esc(v.label)}</td><td class="mono">${esc(v.code)}</td></tr>`).join(""))
          : `<div class="empty">None yet.</div>`) + addValueForm(a),
      ),
    )
    .join("");
  return `
    ${card("How the part number is built", `<p class="hint">Company prefix, then each segment's code in order. Example for ${esc(parent().code)}:</p><div class="pn-big">${esc(example)}</div>
      <p class="hint" style="margin-top:10px">${axes.map((a) => esc(a.name)).join(" → ")}${usesTransformerSuffix(p) ? " → N1/T1 (added automatically: T1 when input and output voltages differ)" : ""}. Each company gets the same codes with its own prefix (${db.companies.map((c) => `${esc(c.code)} ${esc(p.names[c.id]?.prefix || "—")}`).join(", ")}).</p>`)}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:18px">${cards}</div>
    <div style="margin-top:18px">${createUnitsCard(p)}</div>`;
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
      (rows ? table(`<th>Capacity</th><th>Runtime</th><th>Type</th>${db.companies.map((c) => `<th>${coChip(c)} part number</th>`).join("")}<th class="num">Cost</th>${db.companies.map((c) => `<th class="num">${coChip(c)} sell $</th>`).join("")}`, rows) : `<div class="empty">No batteries yet.</div>`) +
      `<form data-form="newBattery" data-product="${p.id}" class="row" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
        <label class="field" style="flex:0 1 140px"><span>Capacity</span><select name="cap"><option value="">All capacities</option>${(axesOf(p).find((a) => a.role === "capacity") ? valuesOf(axesOf(p).find((a) => a.role === "capacity")) : []).map((v) => `<option value="${v.id}">${esc(v.label)}</option>`).join("")}</select></label>
        <label class="field" style="flex:0 1 110px"><span>Runtime</span><select name="runtime"><option>90 min</option><option>120 min</option><option>180 min</option><option>240 min</option></select></label>
        <label class="field" style="flex:1 1 170px"><span>Battery type</span><select name="type"><option>VRLA, 5-year</option><option>VRLA, 10-year design life</option><option>Nickel-cadmium (NiCd)</option><option>Lithium iron phosphate</option></select></label>
        <label class="field" style="flex:1 1 150px"><span>${esc(parent().code)} part number</span><input name="pn" required class="mono" placeholder="7BL-050-090-V5"></label>
        <label class="field" style="flex:0 1 110px"><span>${esc(parent().code)} price</span><input name="price" inputmode="decimal"></label>
        <button class="btn primary">Add battery</button>
      </form>`,
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
        const add = `<form data-form="newSubOption" data-group="${g.id}" class="row" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
          <label class="field" style="flex:0 1 150px"><span>Category</span><input name="category" placeholder="A. Network" list="cats${g.id}"><datalist id="cats${g.id}">${[...new Set(subs.map((x) => x.category))].map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist></label>
          <label class="field" style="flex:1 1 170px"><span>Sub-option</span><input name="name" required placeholder="LonWorks gateway"></label>
          <label class="field" style="flex:0 1 140px"><span>Part number</span><input name="pn" required class="mono" placeholder="9500-3001-01"></label>
          ${db.companies.map((c) => `<label class="field" style="flex:0 1 90px"><span>${esc(c.code)} $</span><input name="p${c.id}" inputmode="decimal" placeholder="${c.isParent ? "" : "same"}"></label>`).join("")}
          <button class="btn primary">Add</button>
        </form>`;
        return card(`${gi + 1}. ${esc(g.name)}`, (subs.length ? table(`<th>Category</th><th>Sub-option</th><th>Assigned part number</th><th class="num">Cost</th>${db.companies.map((c) => `<th class="num">${coChip(c)} sell $</th>`).join("")}`, rows) : `<div class="empty">No sub-options yet.</div>`) + add);
      })
      .join("") +
    card("New option group", `<form data-form="newOptionGroup" data-product="${p.id}" class="row"><label class="field"><span>Name</span><input name="name" required placeholder="Monitoring"></label><button class="btn primary">Add option group</button></form>`) +
    `</div>`
  );
}

// ── Quote assistant ────────────────────────────────────────────
// Reads a plain-language request ("10 kW, 277 in 120 out, 120 min lithium, BACnet, seismic rack")
// and sets the configurator's choices. Keyword rules only; anything it can't place is reported back.

const chats = {};

const OPTION_RULES = [
  [/bacnet/, "bacnet"],
  [/snmp|web card|network card/, "snmp"],
  [/modbus/, "modbus"],
  [/cloud|cellular|remote monitoring/, "cloud monitoring"],
  [/dry contact|relay contacts?|form c/, "dry contact"],
  [/annunciator|remote status/, "remote status panel"],
  [/circuit monitor|per.circuit|branch monitor|lamp fail/, "per-circuit"],
  [/cell monitor|battery monitor/, "cell monitoring"],
  [/self.?test|auto.?test|nfpa/, "automatic monthly"],
  [/remote test|test switch/, "remote test switch"],
  [/printer|printed (test )?log/, "printed test log"],
  [/data ?logger|event log/, "data logger"],
  [/normally.?off|emergency.?only/, "normally-off"],
  [/normally.?on/, "normally-on"],
  [/mixed|split output/, "mixed"],
  [/fast transfer|no.?break|\bhid\b/, "fast transfer"],
  [/standard transfer|off.?line transfer/, "standard transfer"],
  [/\b24\b[^,.;]*(branch|circuit)/, "24 circuits"],
  [/\b16\b[^,.;]*(branch|circuit)/, "16 circuits"],
  [/\b8\b[^,.;]*(branch|circuit)/, "8 circuits"],
  [/high(er)? kaic|high interrupting/, "higher kaic"],
  [/input breaker|main breaker/, "standard kaic"],
  [/output breaker/, "main output breaker"],
  [/shunt/, "shunt trip"],
  [/ground fault|\bgfp\b/, "ground fault"],
  [/lockable|lock.?out/, "lockable"],
  [/wrap.?around|external bypass/, "wraparound"],
  [/bypass/, "internal manual bypass"],
  [/heater|cold weather/, "heater"],
  [/battery disconnect|dc disconnect/, "battery disconnect"],
  [/seismic|oshpd/, "seismic battery rack"],
  [/spill/, "spill containment"],
  [/\+ ?120|120 more|extra 120/, "+120 min"],
  [/add.?on battery|extra battery cabinet|\+ ?60|60 more/, "+60 min"],
  [/65 ?kaic|65,?000/, "65 kaic"],
  [/22 ?kaic|22,?000/, "22 kaic"],
  [/nema ?3r|outdoor|rainproof/, "nema 3r"],
  [/nema ?4x|stainless/, "nema 4x"],
  [/nema ?12|dust/, "nema 12"],
  [/wall.?mount/, "wall-mount"],
  [/caster|floor stand/, "floor stand"],
  [/custom paint|paint color/, "custom paint"],
  [/anchor/, "anchoring"],
  [/100 ?ka\b/, "100 ka"],
  [/surge|tvss|\bspd\b/, "50 ka"],
  [/(4|four)[- ]zone/, "4 zones"],
  [/\blcr\b|load control|control relay/, "1 zone"],
  [/dimm|0.?10 ?v/, "dimming"],
  [/witness/, "witness"],
  [/load bank/, "load bank"],
  [/submittal/, "submittal"],
  [/5.?(yr|year) (extended )?warranty|warranty[^,.;]*5/, "5 years"],
  [/2.?(yr|year) (extended )?warranty|warranty[^,.;]*2/, "2 years"],
  [/battery warranty/, "prorated battery"],
  [/spare fuse|fuse kit/, "fuse"],
  [/spare (control )?board/, "control board"],
  [/spare batter/, "spare battery"],
  [/after.?hours|weekend/, "after-hours"],
  [/start.?up|commission/, "start-up and commissioning"],
  [/preventive|maintenance (plan|visit|contract)/, "preventive"],
  [/battery replacement/, "replacement labor"],
  [/delta/, "delta"],
  [/frequency conv|60 ?hz in/, "conversion"],
  [/50 ?hz/, "50 hz output"],
];

const parseKw = (t) => {
  const m = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:k\s?w|kva|kilowatt|kilo)/);
  return m ? Number(m[1]) : null;
};

function capsOf(p) {
  const a = axesOf(p).find((x) => x.role === "capacity");
  return a ? valuesOf(a) : [];
}

/** Pick the product line that best fits the request. */
function pickProduct(text) {
  const t = text.toLowerCase();
  const products = db.products.filter((p) => db.units.some((u) => u.productId === p.id));
  for (const p of products) {
    for (const c of db.companies) {
      const n = p.names[c.id]?.name?.toLowerCase();
      if (n && t.includes(n)) return p;
    }
  }
  // The product type named in the request wins; NEMA 3R alone is an enclosure option, not the outdoor line.
  const groupWords = [
    [/lighting|ul ?924|egress/, "Emergency Lighting"],
    [/fire alarm|1481/, "Fire Alarm"],
    [/elevator|lift/, "Elevator"],
    [/\bups\b|1778/, "UPS"],
    [/traffic|telecom/, "Traffic"],
    [/outdoor (battery|backup|unit|inverter)/, "Outdoor"],
    [/medical|hospital isolation/, "Medical"],
    [/isolation transformer/, "Isolation"],
    [/regulator/, "Voltage Regulators"],
    [/distribution panel/, "Power Distribution"],
  ];
  const group = groupWords.find(([re]) => re.test(t))?.[1] ?? "Emergency Lighting";
  let cands = products.filter((p) => byId(db.groups, p.groupId).name.includes(group));
  const narrow = (fn) => {
    const next = cands.filter(fn);
    if (next.length) cands = next;
  };
  const three = /3[\s-]?(phase|ph)\b|three[\s-]?phase/.test(t);
  narrow((p) => (p.phase === 3) === three);
  const seismic = /seismic|oshpd/.test(t);
  narrow((p) => /seismic|oshpd/i.test(p.names[parent().id]?.name ?? "") === seismic);
  if (/micro|wall/.test(t)) narrow((p) => /micro|wall/i.test(p.names[parent().id]?.name ?? ""));
  const kw = parseKw(t);
  if (kw) {
    narrow((p) => capsOf(p).some((v) => Math.abs(parseFloat(v.label) - kw) < 0.01));
    narrow((p) => capsOf(p).some((v) => parseFloat(v.label) >= kw));
  }
  return cands[0] ?? products[0];
}

function matchVoltage(values, n) {
  return values.find((v) => v.label === n) ?? values.find((v) => v.label.startsWith(n));
}

/** Apply a request to the configurator state for product p. Returns what was set and what wasn't. */
function applyRequest(p, text) {
  const t = " " + text.toLowerCase().replace(/[–—]/g, "-") + " ";
  const set = [];
  const missed = [];
  const axes = axesOf(p);
  const axis = (role) => axes.find((a) => a.role === role);

  const kw = parseKw(t);
  if (kw && axis("capacity")) {
    const caps = valuesOf(axis("capacity"));
    const exact = caps.find((v) => Math.abs(parseFloat(v.label) - kw) < 0.01);
    const up = caps.filter((v) => parseFloat(v.label) >= kw).sort((a, b) => parseFloat(a.label) - parseFloat(b.label))[0];
    const pickCap = exact ?? up;
    if (pickCap) {
      cfg.values[axis("capacity").id] = pickCap.id;
      set.push(`Capacity ${pickCap.label}${exact ? "" : ` (next size up from ${kw})`}`);
    } else missed.push(`${kw} capacity (largest is ${caps.at(-1)?.label})`);
  }

  // Voltages: "277 in 120 out", "input 480 output 277", "277 to 120", "120 volt".
  let vin = t.match(/(\d{3})\s*v?(?:olts?)?\s*(?:in\b|input)/)?.[1] ?? t.match(/input\s*(?:of\s*|voltage\s*)?(\d{3})/)?.[1];
  let vout = t.match(/(\d{3})\s*v?(?:olts?)?\s*(?:out\b|output)/)?.[1] ?? t.match(/output\s*(?:of\s*|voltage\s*)?(\d{3})/)?.[1];
  const pair = t.match(/(\d{3})\s*v?\s*(?:to|->|→|into)\s*(\d{3})/);
  if (pair) {
    vin ??= pair[1];
    vout ??= pair[2];
  }
  const single = t.match(/(\d{3})\s*v(?:olts?)?\b/);
  if (!vin && !vout && single) vin = vout = single[1];
  if (vin && !vout && !pair) vout = vin;
  if (axis("input") && vin) {
    const v = matchVoltage(valuesOf(axis("input")), vin);
    if (v) (cfg.values[axis("input").id] = v.id), set.push(`Input ${v.label} V`);
    else missed.push(`${vin} V input`);
  }
  if (axis("output")) {
    const outs = valuesOf(axis("output"));
    const multi = /multi|120\/240|multiple output/.test(t) ? outs.find((v) => v.label.includes(",")) : null;
    const v = multi ?? (vout ? matchVoltage(outs, vout) : null);
    if (v) (cfg.values[axis("output").id] = v.id), set.push(`Output ${v.label} V`);
    else if (vout) missed.push(`${vout} V output`);
  }

  // Battery: runtime and type.
  const hours = t.match(/(\d(?:\.\d)?)\s*(?:hr|hour)/);
  const minutes = t.match(/(\d{2,3})\s*-?\s*min/);
  const runtime = minutes ? Number(minutes[1]) : hours ? Math.round(Number(hours[1]) * 60) : null;
  const type = /lithium|li-?ion|\blfp\b|lifepo/.test(t) ? "lithium" : /nicd|nickel/.test(t) ? "nickel" : /10.?(yr|year) (battery|design|vrla)|10.?year life/.test(t) ? "10-year" : /vrla|lead.?acid|sealed/.test(t) ? "vrla" : null;
  if (runtime || type) {
    const capAxis = axis("capacity");
    const cap = capAxis ? cfg.values[capAxis.id] : null;
    const list = db.batteries.filter((b) => b.productId === p.id && (b.capacityValueId == null || !cap || b.capacityValueId === cap));
    const fits = list.filter((b) => (!runtime || parseInt(b.runtime) === runtime) && (!type || b.batteryType.toLowerCase().includes(type)));
    const pick = fits[0] ?? list.filter((b) => !runtime || parseInt(b.runtime) === runtime)[0];
    if (pick) {
      cfg.battery = String(pick.id);
      set.push(`Battery ${pick.runtime}, ${pick.batteryType}`);
      if (!fits.length && type) missed.push(`${type} battery at ${runtime} min`);
    } else if (list.length) missed.push(`battery ${runtime ? runtime + " min" : ""} ${type ?? ""}`.trim());
  }

  // Options.
  const subs = db.subOptions.filter((s) => s.itemId && db.optionGroups.some((g) => g.id === s.groupId && g.productId === p.id));
  const taken = new Set();
  for (const [re, name] of OPTION_RULES) {
    if (!re.test(t)) continue;
    const s = subs.find((x) => x.name.toLowerCase().includes(name));
    if (!s) {
      missed.push(name);
      continue;
    }
    const key = `${s.groupId}|${s.category}`;
    if (taken.has(key)) continue;
    taken.add(key);
    cfg.picks[key] = String(s.id);
    set.push(s.name);
  }
  // Options added in the product master: match on the distinctive words of their names.
  const common = new Set(["input", "output", "breaker", "battery", "circuit", "circuits", "years", "standard", "panel", "with", "main", "higher", "extended", "remote", "monthly", "annual", "system", "rating", "enclosure", "transfer", "service", "services", "spare"]);
  for (const s of subs) {
    const key = `${s.groupId}|${s.category}`;
    if (taken.has(key)) continue;
    const words = s.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5 && !common.has(w));
    if (words.some((w) => t.includes(w))) {
      taken.add(key);
      cfg.picks[key] = String(s.id);
      set.push(s.name);
    }
  }
  return { set, missed };
}

function assistantBox({ quoteId = null, productId = null }) {
  const key = quoteId ? `q${quoteId}` : `p${productId}`;
  const log = chats[key] ?? [];
  const msgs = log.length
    ? log.map((m) => `<div class="msg ${m.from}">${m.html}</div>`).join("")
    : `<div class="msg bot">Tell me what the customer needs, for example: <i>“10 kW lighting inverter, 277 in 120 out, 120 minute lithium battery, BACnet, automatic self-test, NEMA 3R, start-up”</i>. I'll pick the product and fill in the choices below. You can change anything with the dropdowns.</div>`;
  return `<div class="assistant">
    <div class="chat">${msgs}</div>
    <form data-form="assist" data-quote="${quoteId ?? ""}" data-product="${productId ?? ""}" class="row">
      <label class="field" style="flex:1 1 260px"><span class="sr">Request</span><input name="text" required placeholder="Describe the unit, battery and options…" autocomplete="off"></label>
      <button class="btn primary">Apply</button>
    </form>
  </div>`;
}

function runAssistant(form, fd) {
  const text = String(fd.get("text") || "").trim();
  if (!text) return;
  const quote = form.dataset.quote ? byId(db.quotes, form.dataset.quote) : null;
  const key = quote ? `q${quote.id}` : `p${form.dataset.product}`;
  const log = (chats[key] ??= []);
  log.push({ from: "me", html: esc(text) });

  let p = form.dataset.product ? byId(db.products, form.dataset.product) : null;
  let picked = false;
  if (quote) {
    const current = Number(ui[`q${quote.id}product`]) || null;
    const chosen = current ? byId(db.products, current) : null;
    const suggested = pickProduct(text);
    p = chosen && !/fire alarm|elevator|\bups\b|traffic|telecom|outdoor|medical|isolation|regulator|distribution|seismic|3.?phase|micro|wall/i.test(text) ? chosen : suggested;
    picked = !chosen || chosen.id !== p.id;
    ui[`q${quote.id}product`] = String(p.id);
  }
  if (cfg.productId !== p.id || picked) cfg = { productId: p.id, companyId: quote ? quote.sellerId : cfg.companyId ?? parent().id, values: {}, battery: "", picks: {} };
  const { set, missed } = applyRequest(p, text);
  const sellerId = quote ? quote.sellerId : cfg.companyId;
  const lines = [];
  if (picked) lines.push(`Product: <b>${esc(productTitle(p, sellerId))}</b>`);
  if (set.length) lines.push(`Set: ${set.map(esc).join(" · ")}`);
  const unit = findUnit(p);
  if (unit) lines.push(`Unit <span class="mono">${esc(itemOf(unit.itemId).companies[sellerId]?.partNumber)}</span>${transformerNote(p) ? ` · ${transformerNote(p)}` : ""}`);
  else if (axesOf(p).every((a) => cfg.values[a.id])) {
    // Say which outputs are listed for this capacity and input, so the next try works.
    const ax = (role) => axesOf(p).find((a) => a.role === role);
    const fits = db.units.filter((u) => u.productId === p.id && u.valueIds.includes(cfg.values[ax("capacity").id]) && u.valueIds.includes(cfg.values[ax("input").id]));
    const outs = [...new Set(fits.flatMap((u) => u.valueIds.map((v) => byId(db.axisValues, v)).filter((v) => v.axisId === ax("output").id).map((v) => v.label)))];
    lines.push(outs.length ? `That combination isn't a listed unit. With this capacity and input, the listed outputs are: ${outs.map(esc).join(" · ")}.` : "That capacity and input aren't a listed unit. Try another input voltage.");
  }
  else lines.push(`Still needed: ${axesOf(p).filter((a) => !cfg.values[a.id]).map((a) => a.name.toLowerCase()).join(", ")}.`);
  if (missed.length) lines.push(`Not available on this product: ${missed.map(esc).join(", ")}.`);
  log.push({ from: "bot", html: lines.join("<br>") });
}

function findUnit(p) {
  const axes = axesOf(p);
  const chosen = axes.map((a) => cfg.values[a.id]).filter(Boolean);
  if (chosen.length !== axes.length) return null;
  return db.units.find((u) => u.productId === p.id && chosen.every((v) => u.valueIds.includes(v))) ?? null;
}

/** Transformer is automatic: required whenever input and output voltage differ. */
function transformerNote(p) {
  const inA = axesOf(p).find((a) => a.role === "input");
  const outA = axesOf(p).find((a) => a.role === "output");
  const vin = inA && byId(db.axisValues, cfg.values[inA.id]);
  const vout = outA && byId(db.axisValues, cfg.values[outA.id]);
  if (!vin || !vout) return "";
  const unitPn = db.items.find((i) => db.units.some((u) => u.productId === p.id && u.itemId === i.id))?.companies[parent().id]?.partNumber ?? "";
  if (!/[NT]1$/.test(unitPn)) return "";
  return vin.label.trim() === vout.label.trim() ? "No transformer needed (N1)" : "Transformer required, input and output differ (T1)";
}

// ── Editing the product master ─────────────────────────────────

/** Does this product put N1/T1 (transformer) at the end of its unit part numbers? */
function usesTransformerSuffix(p) {
  if (p.transformerSuffix != null) return p.transformerSuffix;
  const unit = db.units.find((u) => u.productId === p.id);
  return unit ? /[NT]1$/.test(itemOf(unit.itemId).companies[parent().id]?.partNumber ?? "") : true;
}

/** New item with a part number, description and price per company. Reuses the item if the OLP part number exists. */
function createItem(type, partNumbers, descriptions, prices = []) {
  const P = parent();
  const existing = db.items.find((i) => i.companies[P.id]?.partNumber.toUpperCase() === partNumbers[0].toUpperCase());
  if (existing) return existing;
  const item = { id: nextId(db.items), type, cost: null, transferPct: null, companies: {} };
  db.companies.forEach((c, i) => {
    item.companies[c.id] = { partNumber: partNumbers[i] ?? partNumbers[0], description: descriptions[i] ?? descriptions[0], price: null };
  });
  db.items.push(item);
  db.companies.forEach((c, i) => {
    const price = prices[i] ?? prices[0] ?? null;
    if (price != null) setPrice(item, c.id, price, "New item");
  });
  return item;
}

/** Create a unit for every combination of the ticked values. Returns how many were new. */
function generateUnits(p, pickedValueIds) {
  const axes = axesOf(p);
  const perAxis = axes.map((a) => valuesOf(a).filter((v) => pickedValueIds.includes(v.id)));
  const empty = axes.filter((_, i) => !perAxis[i].length).map((a) => a.name.toLowerCase());
  if (empty.length) return { error: `Tick at least one ${empty.join(", ")}.` };
  const combos = perAxis.reduce((acc, list) => acc.flatMap((combo) => list.map((v) => [...combo, v])), [[]]);
  const role = (combo, r) => combo[axes.findIndex((a) => a.role === r)];
  let created = 0;
  for (const combo of combos) {
    const ids = combo.map((v) => v.id);
    if (db.units.some((u) => u.productId === p.id && ids.every((id) => u.valueIds.includes(id)) && u.valueIds.length === ids.length)) continue;
    const vin = role(combo, "input");
    const vout = role(combo, "output");
    const tx = usesTransformerSuffix(p) && vin && vout ? (vin.label.trim() === vout.label.trim() ? "N1" : "T1") : "";
    const code = combo.map((v) => v.code).join("") + tx + combo.map((v) => v.suffix || "").join("");
    const specs = combo.map((v) => {
      const a = axes.find((x) => x.id === v.axisId);
      return a.role === "input" ? `${v.label} V in` : a.role === "output" ? `${v.label} V out` : v.label;
    }).join(", ") + (tx === "T1" ? ", with transformer" : "");
    const item = createItem(
      "unit",
      db.companies.map((c) => (p.names[c.id]?.prefix ?? "") + code),
      db.companies.map((c) => `${productTitle(p, c.id)} – ${specs}`),
    );
    db.units.push({ id: nextId(db.units), productId: p.id, itemId: item.id, valueIds: ids });
    created++;
  }
  return { created };
}

const addValueForm = (axis) => `<form data-form="addValue" data-axis="${axis.id}" class="row" style="margin-top:10px">
  <label class="field" style="flex:1 1 120px"><span>${axis.role === "capacity" ? "New capacity" : "New voltage"}</span><input name="label" required placeholder="${axis.role === "capacity" ? "12.5 KW" : "277"}"></label>
  <label class="field" style="flex:0 0 90px"><span>Code</span><input name="code" required placeholder="${axis.role === "capacity" ? "012" : "R"}" class="mono"></label>
  <button class="btn primary">Add</button>
</form>`;

function createUnitsCard(p) {
  const axes = axesOf(p);
  return card(
    "Create units",
    `<form data-form="createUnits" data-product="${p.id}" class="stack">
      <p class="hint" style="margin:0">Tick the values to combine. One unit is created for every combination that doesn't exist yet${usesTransformerSuffix(p) ? "; N1 or T1 is added automatically from the voltages" : ""}. Prices can be filled in on the Units tab.</p>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">${axes
        .map(
          (a) =>
            `<fieldset class="ticks"><legend>${esc(a.name)}</legend>${
              valuesOf(a).length
                ? valuesOf(a).map((v) => `<label class="check"><input type="checkbox" name="v" value="${v.id}"> ${esc(v.label)} <span class="mono muted">${esc(v.code)}</span></label>`).join("")
                : `<span class="muted" style="font-size:13px">Add values first.</span>`
            }</fieldset>`,
        )
        .join("")}</div>
      <div><button class="btn primary">Create units</button></div>
    </form>`,
  );
}

const editForms = {
  newGroup(form, fd) {
    const id = nextId(db.groups);
    db.groups.push({ id, name: String(fd.get("name")).trim() });
    save();
    location.hash = `#/master/group/${id}`;
  },
  newProduct(form, fd) {
    const id = nextId(db.products);
    const names = {};
    for (const c of db.companies) names[c.id] = { name: String(fd.get(`n${c.id}`) || "").trim(), prefix: String(fd.get(`x${c.id}`) || "").trim().toUpperCase() };
    db.products.push({ id, groupId: Number(form.dataset.group), phase: Number(fd.get("phase")) || 1, names, transformerSuffix: fd.get("tx") === "on" });
    let seq = 10;
    for (const [role, name] of [["capacity", "Capacity"], ["input", "Input voltage"], ["output", "Output voltage"]]) {
      db.axes.push({ id: nextId(db.axes), productId: id, role, name, sequence: seq });
      seq += 10;
    }
    save();
    toast("Product created. Add capacities and voltages next.");
    location.hash = `#/master/product/${id}/setup`;
  },
  addValue(form, fd) {
    const axis = byId(db.axes, form.dataset.axis);
    const label = String(fd.get("label")).trim();
    const code = String(fd.get("code")).trim().toUpperCase();
    if (valuesOf(axis).some((v) => v.code === code)) return toast(`Code ${code} is already used in ${axis.name.toLowerCase()}.`);
    db.axisValues.push({ id: nextId(db.axisValues), axisId: axis.id, label, code, suffix: "" });
    save();
    toast(`Added ${label}`);
  },
  createUnits(form, fd) {
    const p = byId(db.products, form.dataset.product);
    const result = generateUnits(p, fd.getAll("v").map(Number));
    if (result.error) return toast(result.error);
    save();
    toast(result.created ? `Created ${result.created} unit${result.created === 1 ? "" : "s"}` : "Those units already exist");
  },
  newOptionGroup(form, fd) {
    db.optionGroups.push({ id: nextId(db.optionGroups), productId: Number(form.dataset.product), name: String(fd.get("name")).trim() });
    save();
    toast("Option group added");
  },
  newSubOption(form, fd) {
    const group = byId(db.optionGroups, form.dataset.group);
    const pn = String(fd.get("pn")).trim().toUpperCase();
    const name = String(fd.get("name")).trim();
    const prices = db.companies.map((c) => numOrNull(fd.get(`p${c.id}`)));
    const item = createItem("option", [pn], [String(fd.get("desc") || name).trim()], prices[0] == null ? [] : prices.map((x) => x ?? prices[0]));
    db.subOptions.push({ id: nextId(db.subOptions), groupId: group.id, category: String(fd.get("category") || "").trim(), name, itemId: item.id });
    save();
    toast(`Added ${name}`);
  },
  newBattery(form, fd) {
    const p = byId(db.products, form.dataset.product);
    const pn = String(fd.get("pn")).trim().toUpperCase();
    const runtime = String(fd.get("runtime")).trim();
    const type = String(fd.get("type")).trim();
    const cap = byId(db.axisValues, fd.get("cap"));
    const price = numOrNull(fd.get("price"));
    const desc = `Battery cabinet${cap ? ` for ${cap.label}` : ""}, ${runtime} runtime, ${type}`;
    const item = createItem("battery", db.companies.map((c) => (c.isParent ? pn : `${c.code}${pn}`)), [desc], price == null ? [] : [price]);
    db.batteries.push({ id: nextId(db.batteries), productId: p.id, capacityValueId: cap?.id ?? null, itemId: item.id, runtime, batteryType: type });
    save();
    toast("Battery added");
  },
};

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
    ${transformerNote(p) ? `<div class="txnote">${transformerNote(p)}</div>` : ""}
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
const territoryLabel = (id) => {
  const t = byId(db.territories, id);
  return t ? `${t.number} · ${t.name}` : "—";
};
const typeName = (id) => byId(db.companyTypes, id)?.name ?? "";
const managerOf = (territoryId) => byId(db.territories, territoryId)?.manager ?? "";
const managers = () => [...new Set(db.territories.map((t) => t.manager).filter(Boolean))].sort((a, b) => (a === "Open") - (b === "Open") || a.localeCompare(b));
// Until sales orders exist, a won quote counts as an order.
const ordersOf = (customerId) => db.quotes.filter((x) => x.customerId === customerId && x.status === "won");
const orderNo = (id) => `SO-${String(id).padStart(5, "0")}`;

function companiesListView() {
  const q = ui.crmQ.trim().toLowerCase();
  const list = db.customers
    .filter((c) => !ui.crmTerritory || c.territoryId === Number(ui.crmTerritory))
    .filter((c) => !ui.crmType || c.typeId === Number(ui.crmType))
    .filter((c) => !ui.crmManager || managerOf(c.territoryId) === ui.crmManager)
    .filter((c) => !q || c.name.toLowerCase().includes(q) || db.contacts.some((p) => p.companyId === c.id && (p.name + " " + p.email).toLowerCase().includes(q)));
  const keys = {
    territory: (c) => territoryNo(c.territoryId),
    company: (c) => c.name.toLowerCase(),
    type: (c) => typeName(c.typeId).toLowerCase(),
  };
  const key = keys[ui.crmSort] ?? keys.territory;
  list.sort((x, y) => {
    const a = key(x);
    const b = key(y);
    return (a < b ? -1 : a > b ? 1 : 0) * ui.crmDir || x.name.localeCompare(y.name);
  });
  const head = (k, label) =>
    `<th><button type="button" class="sort ${ui.crmSort === k ? "on" : ""}" data-act="crmSort" data-v="${k}" aria-label="Sort by ${label}">${label}<span aria-hidden="true">${ui.crmSort === k ? (ui.crmDir > 0 ? " ▲" : " ▼") : " ↕"}</span></button></th>`;
  const rows = list
    .map(
      (c) =>
        `<tr class="click" data-go="#/crm/company/${c.id}"><td style="white-space:nowrap"><b class="tno">${territoryNo(c.territoryId)}</b> ${esc(byId(db.territories, c.territoryId)?.name ?? "")}</td><td><a href="#/crm/company/${c.id}"><b>${esc(c.name)}</b></a></td><td>${esc(typeName(c.typeId))}</td></tr>`,
    )
    .join("");
  const active = ui.crmTerritory || ui.crmType || ui.crmManager || ui.crmQ;
  return `
    ${pageHead("Companies")}
    <div class="grid side">
      ${card(
        "",
        `<form data-form="crmFilter" class="row" style="margin-bottom:14px">
          <label class="field" style="flex:0 1 230px"><span>Territory</span><select name="territory" data-live="crm"><option value="">All territories</option>${db.territories
            .map((t) => `<option value="${t.id}" ${Number(ui.crmTerritory) === t.id ? "selected" : ""}>${t.number} · ${esc(t.name)}</option>`)
            .join("")}</select></label>
          <label class="field" style="flex:0 1 180px"><span>Company type</span><select name="type" data-live="crm"><option value="">All types</option>${db.companyTypes.map((t) => `<option value="${t.id}" ${Number(ui.crmType) === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
          <label class="field" style="flex:0 1 210px"><span>Regional manager</span><select name="manager" data-live="crm"><option value="">All managers</option>${managers().map((m) => `<option value="${esc(m)}" ${ui.crmManager === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></label>
          <label class="field"><span>Search</span><input name="q" value="${esc(ui.crmQ)}" placeholder="Company, employee name or email" data-live="crm-text"></label>
          ${active ? `<button type="button" class="btn secondary" data-act="crmClear">Clear</button>` : ""}
        </form>` +
          (rows ? table(`${head("territory", "Territory")}${head("company", "Company")}${head("type", "Type")}`, rows) : `<div class="empty">No companies match.</div>`) +
          `<p class="hint" style="margin:10px 0 0">${list.length} of ${db.customers.length} companies</p>`,
      )}
      ${card(
        "New company",
        `<form data-form="newCompany" class="stack">
          <label class="field"><span>Company name</span><input name="name" required></label>
          <label class="field"><span>Territory</span><select name="territory">${db.territories.map((t) => `<option value="${t.id}">${t.number} · ${esc(t.name)}</option>`).join("")}</select></label>
          <label class="field"><span>Type</span><select name="type">${db.companyTypes.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
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
  const orders = ordersOf(id).sort((a, b) => b.at.localeCompare(a.at));
  const open = quotes.filter((x) => x.status === "draft" || x.status === "sent");
  const quoted = quotes.reduce((s, x) => s + quoteTotal(x.id), 0);
  const ordered = orders.reduce((s, x) => s + quoteTotal(x.id), 0);
  const notes = db.notes.filter((n) => n.companyId === id);
  const lastActivity = [...notes.map((n) => n.at), ...quotes.map((x) => x.at)].sort().pop();
  const tab = ui.companyTab || "activity";

  const stat = (label, value, sub = "") => `<div class="stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const stats = `<div class="stats">
    ${stat("Quotes", quotes.length, `${moneyText(quoted)} quoted`)}
    ${stat("Open quotes", open.length, `${moneyText(open.reduce((s, x) => s + quoteTotal(x.id), 0))}`)}
    ${stat("Orders", orders.length, `${moneyText(ordered)} ordered`)}
    ${stat("Employees", people.filter((p) => p.active).length, `${people.length - people.filter((p) => p.active).length} inactive`)}
    ${stat("Last activity", lastActivity ? shortDate(lastActivity) : "—", lastActivity ? daysAgoText(lastActivity) : "")}
  </div>`;

  const tabs = [
    ["activity", "Activity"],
    ["quotes", `Quotes (${quotes.length})`],
    ["orders", `Orders (${orders.length})`],
    ["employees", `Employees (${people.length})`],
    ["details", "Details"],
  ];
  const tabNav = `<nav class="subnav" style="margin:22px 0 16px">${tabs.map(([k, l]) => `<a href="#" data-act="companyTab" data-v="${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>`;

  let body = "";
  if (tab === "activity") {
    const f = ui.noteFilter;
    const events = [
      ...notes.filter((n) => !f || (f === "company" ? n.contactId == null : n.contactId === Number(f))).map((n) => ({ at: n.at, kind: n.kind, who: n.contactId ? byId(db.contacts, n.contactId)?.name : null, text: esc(n.body) })),
      ...(f ? [] : quotes.map((x) => ({ at: x.at, kind: x.status === "won" ? "order" : "quote", who: byId(db.contacts, x.contactId)?.name ?? null, text: `${x.status === "won" ? "Order" : "Quote"} <a href="#/quote/${x.id}" class="mono">${x.status === "won" ? orderNo(x.id) : quoteNo(x.id)}</a> · ${esc(x.project)} · ${moneyText(quoteTotal(x.id))} ${statusBadge(x.status)}` }))),
    ].sort((a, b) => b.at.localeCompare(a.at));
    const chips = [["", "Everything"], ["company", "Company notes"], ...people.map((p) => [String(p.id), p.name])]
      .map(([k, l]) => `<button class="chip ${String(f) === k ? "on" : ""}" data-act="noteFilter" data-v="${k}">${esc(l)}</button>`)
      .join("");
    body = `<div class="grid side">
      ${card(
        "",
        `<div class="chips" style="margin-bottom:6px">${chips}</div>` +
          (events.length
            ? `<ol class="timeline">${events
                .map((e) => `<li><span class="when">${shortDate(e.at)}</span><span class="kind k-${e.kind}">${esc(e.kind[0].toUpperCase() + e.kind.slice(1))}</span><div>${e.who ? `<b>${esc(e.who)}</b> · ` : ""}${e.text}</div></li>`)
                .join("")}</ol>`
            : `<div class="empty">No activity yet.</div>`),
      )}
      ${card(
        "Add a note",
        `<form data-form="note" data-company="${id}" class="stack">
          <label class="field"><span>About</span><select name="contact"><option value="">Whole company</option>${people.map((p) => `<option value="${p.id}" ${String(f) === String(p.id) ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
          <label class="field"><span>Type</span><select name="kind">${["note", "call", "email", "meeting", "visit"].map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}</select></label>
          <textarea name="body" rows="4" required placeholder="What happened?" aria-label="Note"></textarea>
          <button class="btn primary">Add note</button>
        </form>`,
      )}
    </div>`;
  } else if (tab === "quotes") {
    body = card("", quotes.length ? quotesTable(quotes, false) : `<div class="empty">No quotes yet.</div>`);
  } else if (tab === "orders") {
    body = card(
      "",
      `<p class="hint">Won quotes, until sales orders are built.</p>` +
        (orders.length
          ? table(
              "<th>Order</th><th>Date</th><th>Project</th><th>From quote</th><th class='num'>Total</th>",
              orders.map((x) => `<tr class="click" data-go="#/quote/${x.id}"><td class="mono">${orderNo(x.id)}</td><td class="num">${shortDate(x.at)}</td><td>${esc(x.project)}</td><td class="mono"><a href="#/quote/${x.id}">${quoteNo(x.id)}</a></td><td class="num">${moneyText(quoteTotal(x.id))}</td></tr>`).join(""),
            )
          : `<div class="empty">No orders yet.</div>`),
    );
  } else if (tab === "employees") {
    const rows = people
      .map((p) => {
        const f = `c${p.id}`;
        const n = notes.filter((x) => x.contactId === p.id).length;
        const q = quotes.filter((x) => x.contactId === p.id).length;
        return `<tr style="${p.active ? "" : "opacity:.5"}"><td><input form="${f}" name="name" value="${esc(p.name)}" required style="min-width:140px"></td><td><input form="${f}" name="title" value="${esc(p.title)}" style="min-width:150px"></td><td><input form="${f}" name="email" value="${esc(p.email)}" style="min-width:200px"></td><td><input form="${f}" name="phone" value="${esc(p.phone)}" style="min-width:120px"></td><td class="num">${q}</td><td class="num"><a href="#" data-act="personActivity" data-v="${p.id}">${n}</a></td><td style="text-align:center"><input form="${f}" type="checkbox" name="active" ${p.active ? "checked" : ""} style="width:16px;height:16px;accent-color:var(--brand)" aria-label="Active"></td><td><form id="${f}" data-form="contact" data-contact="${p.id}"><button class="btn secondary sm">Save</button></form></td></tr>`;
      })
      .join("");
    body = card(
      "",
      table(
        "<th>Name</th><th>Title</th><th>Email</th><th>Phone</th><th class='num'>Quotes</th><th class='num'>Notes</th><th>Active</th><th></th>",
        rows +
          `<tr style="background:#f8f9f7"><td><input form="cnew" name="name" placeholder="New employee" required></td><td><input form="cnew" name="title" placeholder="Title"></td><td><input form="cnew" name="email" placeholder="Email"></td><td><input form="cnew" name="phone" placeholder="Phone"></td><td></td><td></td><td></td><td><form id="cnew" data-form="newContact" data-company="${id}"><button class="btn primary sm">Add</button></form></td></tr>`,
      ),
    );
  } else {
    body = card(
      "",
      `<form data-form="company" data-company="${id}" class="stack" style="max-width:560px">
        <label class="field"><span>Company name</span><input name="name" value="${esc(c.name)}" required></label>
        <div class="row"><label class="field"><span>Territory</span><select name="territory">${db.territories.map((t) => `<option value="${t.id}" ${c.territoryId === t.id ? "selected" : ""}>${t.number} · ${esc(t.name)}</option>`).join("")}</select></label>
        <label class="field"><span>Type</span><select name="type">${db.companyTypes.map((t) => `<option value="${t.id}" ${c.typeId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label></div>
        <div class="row"><label class="field"><span>Phone</span><input name="phone" value="${esc(c.phone)}"></label><label class="field"><span>Website</span><input name="website" value="${esc(c.website)}"></label></div>
        <label class="field"><span>Street</span><input name="street" value="${esc(c.street)}"></label>
        <div class="row"><label class="field"><span>City</span><input name="city" value="${esc(c.city)}"></label><label class="field" style="flex:0 0 64px"><span>State</span><input name="state" value="${esc(c.state)}"></label><label class="field" style="flex:0 0 90px"><span>Zip</span><input name="zip" value="${esc(c.zip)}"></label></div>
        <label class="field"><span>Focus</span><input name="focus" value="${esc(c.focus)}"></label>
        <div><button class="btn primary">Save</button></div>
      </form>`,
    );
  }

  const newQuote = `<form data-form="newQuote" data-customer="${id}" class="row newquote">
    <label class="field" style="flex:0 1 100px"><span>Quote from</span><select name="seller">${db.companies.map((x) => `<option value="${x.id}">${esc(x.code)}</option>`).join("")}</select></label>
    <label class="field" style="flex:0 1 200px"><span>Private label</span><select name="label"><option value="">None</option>${db.privateLabels.map((l) => `<option value="${l.id}" ${quotes[0]?.privateLabelId === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
    <label class="field" style="flex:0 1 180px"><span>Contact</span><select name="contact"><option value="">—</option>${people.filter((p) => p.active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>
    <label class="field" style="flex:1 1 160px"><span>Project</span><input name="project" placeholder="Job name"></label>
    <button class="btn primary">New quote</button>
  </form>`;

  return `
    ${crumbs([["#/crm", "Companies"]])}
    <div class="company-head">
      <h1>${esc(c.name)}</h1>
      <div class="meta"><span>Territory ${esc(territoryLabel(c.territoryId))}</span>${managerOf(c.territoryId) ? `<span>Manager: ${esc(managerOf(c.territoryId))}</span>` : ""}<span>${esc(typeName(c.typeId))}</span>${c.city ? `<span>${esc([c.city, c.state].filter(Boolean).join(", "))}</span>` : ""}${c.phone ? `<span>${esc(c.phone)}</span>` : ""}</div>
    </div>
    ${stats}
    ${card("", newQuote)}
    ${tabNav}
    ${body}`;
}

function daysAgoText(d) {
  const days = Math.round((Date.now() - new Date(d).getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function crmSettingsView() {
  return `
    ${pageHead("Territories & company types")}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      ${card("Territories", table("<th class='num'>No.</th><th>Territory</th><th>Regional manager</th><th class='num'>Companies</th>", db.territories.map((t) => `<tr class="click" data-act="pickTerritory" data-v="${t.id}"><td class="num"><b>${t.number}</b></td><td>${esc(t.name)}</td><td>${esc(t.manager)}</td><td class="num">${db.customers.filter((c) => c.territoryId === t.id).length}</td></tr>`).join("")))}
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
        return `<tr class="click" data-go="#/quote/${x.id}"><td class="mono"><a href="#/quote/${x.id}">${quoteNo(x.id)}</a></td><td class="num">${shortDate(x.at)}</td>${showCustomer ? `<td>${esc(cust.name)}</td>` : ""}<td>${esc(x.project)}</td><td>${esc(byId(db.contacts, x.contactId)?.name ?? "")}</td><td style="white-space:nowrap">${esc(byId(db.companies, x.sellerId).code)}${label ? ` <span class="muted" style="font-size:12px">· ${esc(label.name)}</span>` : ""}</td><td>${statusBadge(x.status)}</td><td class="num">${moneyText(quoteTotal(x.id))}</td></tr>`;
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
          `<h3 class="mini">Quote assistant</h3>${assistantBox({ quoteId: x.id })}<h3 class="mini" style="margin-top:18px">Or choose from the dropdowns</h3><label class="field" style="max-width:420px;margin-bottom:14px"><span>Product</span><select data-act-change="quoteProduct" data-quote="${x.id}"><option value="">Choose a product…</option>${productOptions}</select></label>` +
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
      await store.del(KEY);
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
  companyTab: (d) => ((ui.companyTab = d.v), render()),
  crmSort(d) {
    if (ui.crmSort === d.v) ui.crmDir *= -1;
    else (ui.crmSort = d.v), (ui.crmDir = 1);
    render();
  },
  crmClear() {
    ui.crmTerritory = ui.crmType = ui.crmManager = ui.crmQ = "";
    render();
  },
  pickTerritory(d) {
    ui.crmTerritory = d.v;
    ui.crmType = ui.crmManager = ui.crmQ = "";
    location.hash = "#/crm";
    render();
  },
  personActivity: (d) => ((ui.companyTab = "activity"), (ui.noteFilter = d.v), render()),
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
  ...editForms,
  assist: runAssistant,
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
    ui.crmManager = String(fd.get("manager") || "");
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
  if (el.dataset.live === "crm") {
    const f = new FormData(el.form);
    forms.crmFilter(el.form, f);
    render();
    return;
  }
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

let searchTimer;
document.addEventListener("input", (e) => {
  if (e.target.dataset.live !== "crm-text") return;
  clearTimeout(searchTimer);
  const value = e.target.value;
  searchTimer = setTimeout(() => {
    ui.crmQ = value;
    render();
    // Keep typing in the search box after the list redraws.
    const box = document.querySelector('[data-live="crm-text"]');
    if (box) {
      box.focus();
      box.setSelectionRange(value.length, value.length);
    }
  }, 250);
});

window.addEventListener("hashchange", () => {
  ui.noteFilter = "";
  ui.companyTab = "";
  ui.capFilter = "";
  render();
});

load().then(render);
