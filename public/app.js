"use strict";
/* Gurmeet Motors collections UI. No inline script; every value from the server is inserted as text, never as markup. */
const root = document.getElementById("app");
let me = null, csrf = null;

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const inr = s => (s === null || s === undefined || s === "") ? "-" :
  "₹" + Number(s).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = s => s ? s.slice(8, 10) + "-" + s.slice(5, 7) + "-" + s.slice(0, 4) : "-";
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const STATUS = { SUBMITTED: ["Awaiting Accounts", "warn"], UNDER_VERIFICATION: ["Under review", "warn"], RETURNED: ["Returned", "bad"],
  REJECTED: ["Rejected", "bad"], POSTED: ["Approved", ""], APPROVED: ["Approved", ""], EXPORTED: ["Sent to Tally", ""],
  RECONCILED: ["Reconciled", ""], REVERSED: ["Reversed", "bad"], IMPORTED_UNRECONCILED: ["In Tally, not yet checked", ""] };
const ADJ = { GOODS_RETURN: "Goods return", DISCOUNT: "Discount", RATE_DIFFERENCE: "Rate difference", SHORT_SUPPLY: "Short supply",
  CREDIT_NOTE: "Credit note", WRITE_OFF: "Write-off", OTHER: "Other", ADVANCE_ADJ: "Advance used" };
const ADJ_REQUESTABLE = Object.entries(ADJ).filter(([k]) => k !== "ADVANCE_ADJ");
const pill = st => { const [t, c] = STATUS[st] || [st, "grey"]; return h("span", { class: "pill " + c }, t); };
const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toast(msg, error) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast-msg" + (error ? " error" : ""); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, error ? 6000 : 2500);
}

async function api(method, url, body) {
  const opt = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  if (csrf) opt.headers["X-CSRF-Token"] = csrf;
  let r;
  try { r = await fetch(url, opt); } catch (e) { throw new Error("No connection. Nothing was lost; try again."); }
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty body */ }
  if (r.status === 401 && !url.includes("/auth/login")) { me = null; csrf = null; renderLogin(); throw new Error("Please sign in again"); }
  if (!r.ok) {
    let d = data && data.detail;
    if (Array.isArray(d)) d = d.map(x => (x.loc ? x.loc.slice(1).join(".") + ": " : "") + x.msg).join("; ");
    const err = new Error(d || "Something went wrong"); err.status = r.status; throw err;
  }
  return data;
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function ask(title, fields, okText) {            // small dialog form -> Promise(values | null)
  return new Promise(resolve => {
    const inputs = fields.map(f => {
      const el = f.type === "select" ? h("select", { class: "form-select" }, f.options.map(([v, l]) => h("option", { value: v }, l)))
        : f.type === "textarea" ? h("textarea", { class: "form-control", rows: 3, maxlength: 500 })
        : h("input", { class: "form-control", type: f.type || "text", value: f.value || "", maxlength: 200 });
      el.name = f.name; return h("div", { class: "mb-3" }, h("label", { class: "form-label" }, f.label), el);
    });
    const dlg = h("dialog", {}, h("h5", {}, title), ...inputs,
      h("div", { class: "d-flex gap-2 justify-content-end" },
        h("button", { class: "btn btn-outline-secondary", type: "button", onclick: () => { dlg.close(); resolve(null); } }, "Cancel"),
        h("button", { class: "btn btn-brand", type: "button", onclick: () => {
          const v = {}; inputs.forEach(d => { const e = d.querySelector("input,textarea,select"); v[e.name] = e.value.trim(); });
          dlg.close(); resolve(v); } }, okText || "OK")));
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg); dlg.showModal();
  });
}

// ---------- shell ----------
function shell(title, content, navActive) {
  const isSales = me.role === "SALESMAN";
  const allNav = isSales ? [["#/today", "Today", "today"], ["#/customers", "Customers", "customers"], ["#/mine", "Receipts", "mine"], ["#/adjustments", "Returns", "adj"], ["#/reports", "Dues", "reports"]]
    : [["#/home", "Overview", "home"], ["#/queue", "To approve", "queue"], ["#/adjustments", "Returns & discounts", "adj"], ["#/all", "All receipts", "all"], ["#/cheques", "Cheques", "cheques"], ["#/cash", "Cash", "cash"], ["#/routes", "Routes", "routes"], ["#/import", "Import", "import"], ["#/tally", "Tally", "tally"], ["#/reports", "Reports", "reports"], ["#/audit", "Audit", "audit"]];
  const nav = allNav.filter(n => (n[2] !== "import" || me.permissions.includes("import.run")) && (n[2] !== "routes" || me.permissions.includes("master.manage")) && (n[2] !== "cash" || me.permissions.includes("cash.manage") || me.permissions.includes("report.view")) && (n[2] !== "audit" || me.permissions.includes("audit.view")) && (n[2] !== "home" || me.permissions.includes("report.view")));
  root.replaceChildren(
    h("div", { class: "topbar" }, h("div", { class: "title" }, title),
      h("div", { class: "who" }, me.full_name, h("br"), me.role.replace("_", " ").toLowerCase()),
      h("button", { class: "btn btn-sm btn-outline-light", onclick: guard(async () => { await api("POST", "/api/auth/logout"); me = null; csrf = null; renderLogin(); }) }, "Sign out")),
    content,
    h("nav", { class: "bottomnav" }, nav.map(([href, label, key]) => h("a", { href, class: key === navActive ? "active" : "" }, label))));
}

// ---------- login ----------
function renderLogin(message) {
  const user = h("input", { class: "form-control form-control-lg", autocomplete: "username", autocapitalize: "none", required: true });
  const pass = h("input", { class: "form-control form-control-lg", type: "password", autocomplete: "current-password", required: true });
  const form = h("form", { class: "card card-body mt-5 mx-auto", onsubmit: guard(async ev => {
      ev.preventDefault();
      const r = await api("POST", "/api/auth/login", { login_id: user.value.trim(), password: pass.value });
      csrf = r.csrf_token; await boot();
    }) },
    h("h4", { class: "mb-1" }, "Gurmeet Motors"), h("p", { class: "text-muted" }, "Collections"),
    message ? h("div", { class: "alert alert-warning" }, message) : null,
    h("label", { class: "form-label" }, "User ID"), user, h("label", { class: "form-label mt-3" }, "Password"), pass,
    h("button", { class: "btn btn-brand btn-lg mt-4", type: "submit" }, "Sign in"));
  form.style.maxWidth = "380px";
  root.replaceChildren(form);
}

function renderChangePassword() {
  const cur = h("input", { class: "form-control", type: "password", autocomplete: "current-password" });
  const nw = h("input", { class: "form-control", type: "password", autocomplete: "new-password" });
  root.replaceChildren(h("form", { class: "card card-body mt-5", onsubmit: guard(async ev => {
      ev.preventDefault();
      await api("POST", "/api/auth/change-password", { current_password: cur.value, new_password: nw.value });
      toast("Password changed"); await boot();
    }) }, h("h5", {}, "Choose a new password"), h("p", { class: "text-muted" }, "You must change your password before continuing."),
    h("label", { class: "form-label" }, "Current password"), cur, h("label", { class: "form-label mt-3" }, "New password (at least 10 characters)"), nw,
    h("button", { class: "btn btn-brand mt-3", type: "submit" }, "Change password")));
}

// ---------- salesman: customers ----------
async function viewCustomers() {
  const box = h("div"); const search = h("input", { class: "form-control mb-3", type: "search", placeholder: "Search customer" });
  const todayNo = (new Date().getDay() + 6) % 7 + 1;                      // Monday = 1 ... Sunday = 7
  let all = [];
  const draw = () => {
    const t = search.value.trim().toLowerCase();
    const rows = all.filter(c => !t || c.name.toLowerCase().includes(t));
    const mine = rows.filter(c => c.collection_day === todayNo), rest = rows.filter(c => c.collection_day !== todayNo);
    const list = cs => h("div", { class: "card mb-3" }, cs.map(c => h("a", { class: "list-row", href: "#/customer/" + c.id },
      h("div", {}, h("div", {}, c.name), h("small", {}, c.collection_day ? DAYS[c.collection_day] : "no day set")),
      h("div", { class: "money" }, inr(c.outstanding)))));
    box.replaceChildren(
      mine.length ? h("h6", { class: "text-muted" }, "Today's customers (" + DAYS[todayNo] + ")") : null, mine.length ? list(mine) : null,
      h("h6", { class: "text-muted" }, mine.length ? "Other customers" : "Customers"), rest.length ? list(rest) : h("p", { class: "text-muted" }, "No customers found."));
  };
  search.addEventListener("input", draw);
  shell("Customers", h("div", {}, search, box), "customers");
  all = (await api("GET", "/api/customers?limit=200")).items; draw();
}

async function viewCustomer(id) {
  const d = await api("GET", `/api/customers/${id}/open-invoices`);
  const rows = d.invoices.map(i => h("tr", {}, h("td", {}, i.bill_ref), h("td", {}, dmy(i.invoice_date)),
    h("td", { class: "money" }, inr(i.available)),
    h("td", { class: "text-end" }, h("button", { class: "btn btn-sm btn-link p-0", onclick: guard(() => requestAdjustment(id, i)) }, "Return / discount"),
      d.advances.length && Number(i.available) > 0 ? [h("br"), h("button", { class: "btn btn-sm btn-link p-0", onclick: guard(() => useAdvance(id, i, d.advances)) }, "Use advance")] : null)));
  shell(d.customer.name, h("div", {},
    h("a", { href: "#/customers", class: "small" }, "← Customers"),
    h("div", { class: "card card-body my-3" }, h("div", { class: "text-muted small" }, "Collectable now"),
      h("div", { class: "fs-3 fw-bold" }, inr(d.total_available)),
      h("div", { class: "small text-muted" }, "Tally data as on " + dmy(d.invoice_data_as_of) + ". Receipts awaiting approval are already held back.")),
    d.advances.length ? h("div", { class: "alert alert-info" }, "Advance available: ", d.advances.map(a => `Ref ${a.advance_ref} ${inr(a.balance)}`).join(", ")) : null,
    h("a", { class: "btn btn-brand btn-lg w-100 mb-2", href: "#/collect/" + id }, "Collect payment"),
    h("div", { class: "d-flex gap-2 mb-3" },
      h("a", { class: "btn btn-outline-secondary flex-fill", href: "#/statement/" + id }, "Statement"),
      h("button", { class: "btn btn-outline-secondary flex-fill", onclick: guard(() => recordVisit({ customer_id: Number(id), name: d.customer.name })) }, "Record a visit")),
    h("div", { class: "card table-wrap" }, h("table", { class: "table mb-0" },
      h("thead", {}, h("tr", {}, h("th", {}, "Bill"), h("th", {}, "Date"), h("th", { class: "text-end" }, "Pending"), h("th", {}))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 4, class: "text-muted" }, "Nothing outstanding")))))), "customers");
}

// ---------- salesman: collect ----------
async function viewCollect(id, reviseId) {
  const d = await api("GET", `/api/customers/${id}/open-invoices`);
  const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "");
  const amount = h("input", { class: "form-control big-input", inputmode: "decimal", placeholder: "0.00", autocomplete: "off" });
  const mode = h("select", { class: "form-select" }, ["CASH", "CHEQUE", "UPI", "NEFT", "RTGS", "IMPS"].map(m => h("option", { value: m }, m)));
  const date = h("input", { class: "form-control", type: "date", value: today(), max: today() });
  const chNo = h("input", { class: "form-control", placeholder: "Cheque number" }), chDate = h("input", { class: "form-control", type: "date", value: today() }),
    chBank = h("input", { class: "form-control", placeholder: "Bank name" }), utr = h("input", { class: "form-control", placeholder: "UTR / transaction reference" }),
    remarks = h("input", { class: "form-control", placeholder: "Remarks (optional)", maxlength: 500 });
  const chequeBox = h("div", { class: "border rounded p-3 mb-3", hidden: true }, h("label", { class: "form-label" }, "Cheque"), chNo,
    h("label", { class: "form-label mt-2" }, "Cheque date (a later date is a post-dated cheque)"), chDate, h("label", { class: "form-label mt-2" }, "Bank"), chBank);
  const utrBox = h("div", { class: "mb-3", hidden: true }, h("label", { class: "form-label" }, "Transaction reference"), utr);
  const allocBox = h("div"), msg = h("div"), submit = h("button", { class: "btn btn-brand btn-lg w-100", type: "submit", disabled: true }, "Submit for approval");
  let edited = false, inputs = {}, timer = null, valid = false;

  mode.addEventListener("change", () => { chequeBox.hidden = mode.value !== "CHEQUE"; utrBox.hidden = !["UPI", "NEFT", "RTGS", "IMPS"].includes(mode.value); });
  const currentAllocs = () => Object.entries(inputs).map(([iid, el]) => ({ invoice_id: Number(iid), amount: el.value.trim() || "0" }))
    .filter(a => Number(a.amount) !== 0);
  async function preview() {
    valid = false; submit.disabled = true; msg.replaceChildren();
    if (!/^\d+(\.\d{1,2})?$/.test(amount.value.trim()) || Number(amount.value) <= 0) { allocBox.replaceChildren(); return; }
    try {
      const body = { customer_id: Number(id), amount: amount.value.trim() };
      if (edited) body.allocations = currentAllocs();
      const p = await api("POST", "/api/collections/preview", body);
      if (!edited) draw(p.allocations);
      msg.replaceChildren(
        Number(p.advance_amount) > 0 ? h("div", { class: "alert alert-info" }, `${inr(p.advance_amount)} is more than the customer owes${edited ? " on the bills chosen" : ""}. It will be kept as an advance for future bills.`) : null,
        p.override_used ? h("div", { class: "alert alert-secondary" }, "You changed the usual oldest-first order. Accounts will see this.") : null);
      valid = true; submit.disabled = false;
    } catch (e) { msg.replaceChildren(h("div", { class: "alert alert-danger" }, e.message)); }
  }
  function draw(allocs) {
    const given = Object.fromEntries(allocs.map(a => [a.invoice_id, a.amount]));
    inputs = {};
    allocBox.replaceChildren(h("h6", { class: "mt-3" }, "Which bills this pays"), h("div", { class: "card table-wrap mb-2" }, h("table", { class: "table mb-0 align-middle" },
      h("thead", {}, h("tr", {}, h("th", {}, "Bill"), h("th", { class: "text-end" }, "Pending"), h("th", { class: "text-end" }, "Paying"))),
      h("tbody", {}, d.invoices.map(i => {
        const el = h("input", { class: "form-control form-control-sm alloc-input", inputmode: "decimal", value: given[i.id] && given[i.id] !== "0.00" ? given[i.id] : "" });
        inputs[i.id] = el;
        el.addEventListener("input", () => { edited = true; clearTimeout(timer); timer = setTimeout(guard(preview), 350); });
        return h("tr", {}, h("td", {}, i.bill_ref, h("div", { class: "small text-muted" }, dmy(i.invoice_date))), h("td", { class: "money" }, inr(i.available)), h("td", {}, el));
      })))), h("div", { class: "small text-muted mb-2" }, "Edit the amounts if the customer wants to pay particular bills. No approval is needed for this."));
  }
  amount.addEventListener("input", () => { clearTimeout(timer); edited = false; timer = setTimeout(guard(preview), 350); });
  const form = h("form", { class: "card card-body", onsubmit: guard(async ev => {
      ev.preventDefault(); if (!valid) return;
      submit.disabled = true;
      const m = mode.value;
      const body = { customer_id: Number(id), amount: amount.value.trim(), payment_mode: m, collection_date: date.value, idempotency_key: key,
        remarks: remarks.value.trim() || null };
      if (reviseId) body.supersedes_id = Number(reviseId);
      if (edited) body.allocations = currentAllocs();
      if (m === "CHEQUE") body.cheque = { cheque_no: chNo.value.trim(), cheque_date: chDate.value, bank_name: chBank.value.trim() };
      if (["UPI", "NEFT", "RTGS", "IMPS"].includes(m)) body.utr = utr.value.trim();
      try { const r = await api("POST", "/api/collections", body); toast("Submitted: " + r.reference); location.hash = "#/c/" + r.id; }
      catch (e) { submit.disabled = false; throw e; }
    }) }, h("label", { class: "form-label" }, "Amount received"), amount, h("label", { class: "form-label mt-3" }, "Payment mode"), mode,
    h("label", { class: "form-label mt-3" }, "Date received"), date, h("div", { class: "mt-3" }, chequeBox, utrBox), allocBox, msg, remarks, h("div", { class: "mt-3" }, submit));
  shell("Collect payment", h("div", {}, h("a", { href: "#/customer/" + id, class: "small" }, "← " + d.customer.name),
    h("div", { class: "my-3 text-muted small" }, "Nothing counts as collected until Accounts approves it."), form), "customers");
}

// ---------- collections: lists and detail ----------
async function listView(title, nav, query, emptyText, top) {
  const d = await api("GET", "/api/collections?limit=100" + query);
  shell(title, h("div", {}, top || null, h("div", { class: "card" }, d.items.length ? d.items.map(c => h("a", { class: "list-row", href: "#/c/" + c.id },
    h("div", {}, h("div", {}, c.customer_name), h("small", {}, `${c.reference} · ${dmy(c.collection_date)} · ${c.payment_mode}`)),
    h("div", { class: "text-end" }, h("div", { class: "money" }, inr(c.declared_amount)), pill(c.status), c.override_used ? h("div", { class: "small text-muted" }, "bills changed") : null)))
    : h("div", { class: "p-4 text-muted" }, emptyText))), nav);
}

async function viewCollection(id) {
  const c = await api("GET", "/api/collections/" + id);
  const reviewer = me.role !== "SALESMAN" && ["SUBMITTED", "UNDER_VERIFICATION"].includes(c.status) && c.salesman_id !== me.id;
  const ver = h("input", { class: "form-control", inputmode: "decimal", value: c.declared_amount }), rem = h("input", { class: "form-control", placeholder: "Remarks", maxlength: 500 }),
    ev = h("input", { class: "form-control", placeholder: "Bank statement reference" }), bd = h("input", { class: "form-control", type: "date", value: today() });
  const electronic = ["UPI", "NEFT", "RTGS", "IMPS"].includes(c.payment_mode);
  const needsBank = electronic || c.payment_mode === "CHEQUE";
  const banks = reviewer && needsBank ? (await api("GET", "/api/bank-accounts")).items.filter(b => b.branch_id === c.branch_id) : [];
  const bankSel = h("select", { class: "form-select" }, banks.length === 1 ? [] : h("option", { value: "" }, "Choose bank account"),
    banks.map(b => h("option", { value: b.id }, c.payment_mode === "CHEQUE" ? `${b.display_name} (${b.cheque_in_hand_ledger || "no Cheque in Hand ledger set"})` : `${b.display_name} (${b.tally_ledger_name})`)));
  const act = (path, body, ok) => guard(async () => { await api("POST", `/api/collections/${id}/${path}`, body); toast(ok); await route(); });
  const panel = reviewer ? h("div", { class: "card card-body mb-3" }, h("h6", {}, "Accounts decision"),
    h("label", { class: "form-label" }, "Amount verified"), ver,
    h("div", { class: "form-text mb-2" }, "Change this if you received a different amount (for example a cash shortfall). A remark is then required and the bills are re-allocated oldest first."),
    needsBank ? [h("label", { class: "form-label" }, electronic ? "Bank account it was received in" : "Bank this cheque will be deposited in (its Cheque in Hand ledger is used)"),
      banks.length ? bankSel : h("div", { class: "alert alert-warning" }, "No bank account is set up for this branch. Add one under the Tally tab first.")] : null,
    electronic ? [h("label", { class: "form-label mt-2" }, "Bank statement reference"), ev, h("label", { class: "form-label mt-2" }, "Bank credit date"), bd] : null,
    h("label", { class: "form-label mt-2" }, "Remarks"), rem,
    h("div", { class: "d-flex gap-2 mt-3" },
      h("button", { class: "btn btn-brand flex-fill", onclick: guard(async ev2 => {
        const body = { verified_amount: ver.value.trim(), remarks: rem.value.trim() || null };
        if (electronic) { body.evidence_ref = ev.value.trim(); body.bank_credit_date = bd.value; }
        if (needsBank && bankSel.value) body.bank_account_id = Number(bankSel.value);
        ev2.target.disabled = true;
        try { await api("POST", `/api/collections/${id}/approve`, body); toast("Approved"); await route(); } catch (e) { ev2.target.disabled = false; throw e; } }) }, "Approve"),
      h("button", { class: "btn btn-outline-secondary", onclick: guard(async () => { const v = await ask("Return to salesman", [{ name: "remarks", label: "What needs clarifying?", type: "textarea" }], "Return"); if (v && v.remarks) await act("return", v, "Returned")(); }) }, "Return"),
      h("button", { class: "btn btn-outline-danger", onclick: guard(async () => { const v = await ask("Reject collection", [{ name: "remarks", label: "Reason", type: "textarea" }], "Reject"); if (v && v.remarks) await act("reject", v, "Rejected")(); }) }, "Reject"))) : null;
  const corr = (await api("GET", "/api/corrections?collection_id=" + id)).items;
  const openCorr = corr.find(x => x.status === "PENDING");
  const canDecide = openCorr && me.permissions.includes("correction.approve") && openCorr.requested_by !== me.id;
  const corrRem = h("input", { class: "form-control", placeholder: "Remarks (needed to reject)", maxlength: 500 });
  const corrBox = openCorr ? h("div", { class: "alert alert-warning" }, h("strong", {}, "Cancellation requested"), h("div", {}, `${openCorr.requested_by_name}: ${openCorr.reason}`),
      canDecide ? h("div", { class: "mt-2" }, h("div", { class: "small mb-2" }, "Approving cancels this receipt: the bills it paid reopen and any advance from it is withdrawn. It can then be entered again correctly."), corrRem,
        h("div", { class: "d-flex gap-2 mt-2" },
          h("button", { class: "btn btn-sm btn-brand", onclick: guard(async () => { await api("POST", `/api/corrections/${openCorr.id}/approve`, { remarks: corrRem.value.trim() || null }); toast("Receipt cancelled"); await route(); }) }, "Approve cancellation"),
          h("button", { class: "btn btn-sm btn-outline-danger", onclick: guard(async () => { if (!corrRem.value.trim()) { toast("Write the reason in Remarks first", true); return; }
            await api("POST", `/api/corrections/${openCorr.id}/reject`, { remarks: corrRem.value.trim() }); toast("Request declined"); await route(); }) }, "Decline"))) : null)
    : (c.status === "POSTED" && me.permissions.includes("correction.request") ? h("button", { class: "btn btn-outline-secondary w-100 mb-3", onclick: guard(async () => {
        const v = await ask("Cancel this receipt", [{ name: "reason", label: "What is wrong with it?", type: "textarea" }], "Send to Accounts");
        if (!v || !v.reason) return; await api("POST", "/api/corrections", { collection_id: Number(id), reason: v.reason }); toast("Sent to Accounts"); await route(); }) }, "Something is wrong: ask to cancel this receipt") : null);
  const rows = c.allocations.map(a => h("tr", {}, h("td", {}, a.bill_ref), h("td", {}, dmy(a.invoice_date)), h("td", { class: "money" }, inr(a.amount))));
  const i = c.instrument;
  shell(c.reference, h("div", {},
    h("a", { href: me.role === "SALESMAN" ? "#/mine" : "#/queue", class: "small" }, "← Back"),
    h("div", { class: "card card-body my-3" }, h("div", { class: "d-flex justify-content-between" }, h("div", { class: "fs-5 fw-bold" }, h("a", { href: "#/statement/" + c.customer_id, class: "text-reset" }, c.customer_name)), pill(c.status)),
      h("dl", { class: "kv mt-2 mb-0" },
        h("dt", {}, "Amount recorded"), h("dd", {}, inr(c.declared_amount)),
        c.verified_amount ? [h("dt", {}, "Approved amount"), h("dd", {}, inr(c.verified_amount))] : null,
        h("dt", {}, "Mode / date"), h("dd", {}, c.payment_mode + " · " + dmy(c.collection_date)),
        h("dt", {}, "Salesman"), h("dd", {}, c.salesman_name),
        i && i.cheque_no ? [h("dt", {}, "Cheque"), h("dd", {}, `${i.cheque_no} · ${i.bank_name} · dated ${dmy(i.cheque_date)}${i.is_post_dated ? " (post-dated)" : ""} · ${i.status}`)] : null,
        i && i.utr ? [h("dt", {}, "UTR"), h("dd", {}, i.utr)] : null,
        c.advance ? [h("dt", {}, "Advance"), h("dd", {}, `Ref ${c.advance.advance_ref} · ${inr(c.advance.amount)} · ${c.advance.status === "AVAILABLE" ? "available" : c.advance.status === "CANCELLED" ? "cancelled" : "after approval"}`)] : null,
        c.remarks ? [h("dt", {}, "Remarks"), h("dd", {}, c.remarks)] : null)),
    c.override_used ? h("div", { class: "alert alert-secondary" }, "The salesman changed the usual oldest-first allocation.") : null,
    corrBox,
    panel,
    h("h6", {}, "Bills paid"), h("div", { class: "card table-wrap mb-3" }, h("table", { class: "table mb-0" },
      h("thead", {}, h("tr", {}, h("th", {}, "Bill"), h("th", {}, "Date"), h("th", { class: "text-end" }, "Amount"))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 3, class: "text-muted" }, "Whole amount is an advance"))))),
    me.role === "SALESMAN" && c.status === "RETURNED" ? h("a", { class: "btn btn-brand w-100 mb-3", href: "#/collect/" + c.customer_id + "?revise=" + c.id }, "Re-enter as a corrected collection") : null,
    h("h6", {}, "History"), h("div", { class: "card" }, c.history.map(x => h("div", { class: "list-row" },
      h("div", {}, h("div", {}, x.action.replace(/_/g, " ").toLowerCase()), x.remarks ? h("small", {}, x.remarks) : null),
      h("small", {}, new Date(x.created_at).toLocaleString("en-IN")))))), me.role === "SALESMAN" ? "mine" : "queue");
}


// ---------- goods returns, discounts and other credits ----------
async function requestAdjustment(customerId, inv) {
  const v = await ask("Return / discount on " + inv.bill_ref, [
    { name: "adj_type", label: "What is it?", type: "select", options: ADJ_REQUESTABLE },
    { name: "amount", label: "Amount (at most " + inr(inv.available) + ")", type: "text" },
    { name: "reason", label: "Reason", type: "textarea" }], "Send to Accounts");
  if (!v) return;
  if (!v.amount || !v.reason) { toast("Amount and reason are required", true); return; }
  const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "");
  const r = await api("POST", "/api/adjustments", { customer_id: Number(customerId), invoice_id: inv.id, adj_type: v.adj_type, amount: v.amount,
    adj_date: today(), reason: v.reason, idempotency_key: key });
  toast("Sent to Accounts: " + r.reference);
  location.hash = "#/adj/" + r.id;
}

async function useAdvance(customerId, inv, advances) {
  const v = await ask("Use advance on " + inv.bill_ref, [
    { name: "advance_id", label: "Which advance", type: "select", options: advances.map(a => [a.id, `Ref ${a.advance_ref} (${inr(a.balance)} left)`]) },
    { name: "amount", label: "Amount (bill has " + inr(inv.available) + " open)", type: "text" }], "Send to Accounts");
  if (!v) return;
  if (!v.amount) { toast("Enter the amount", true); return; }
  const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "");
  const r = await api("POST", "/api/adjustments", { customer_id: Number(customerId), invoice_id: inv.id, adj_type: "ADVANCE_ADJ", amount: v.amount,
    advance_id: Number(v.advance_id), adj_date: today(), idempotency_key: key });
  toast("Sent to Accounts: " + r.reference);
  location.hash = "#/adj/" + r.id;
}

async function viewAdjustments() {
  const d = await api("GET", "/api/adjustments?limit=100");
  const isAcc = me.role !== "SALESMAN";
  shell("Returns & discounts", h("div", { class: "card" }, d.items.length ? d.items.map(a => h("a", { class: "list-row", href: "#/adj/" + a.id },
    h("div", {}, h("div", {}, a.customer_name), h("small", {}, `${a.reference} · ${ADJ[a.adj_type] || a.adj_type} · ${a.bill_ref} · ${dmy(a.adj_date)}`)),
    h("div", { class: "text-end" }, h("div", { class: "money" }, inr(a.amount)), pill(a.status))))
    : h("div", { class: "p-4 text-muted" }, isAcc ? "No returns or discounts yet." : "Open a customer and use 'Return / discount' beside a bill.")), "adj");
}

async function viewAdjustment(id) {
  const a = await api("GET", "/api/adjustments/" + id);
  const reviewer = me.role !== "SALESMAN" && a.status === "SUBMITTED" && a.requested_by !== me.id;
  const rem = h("input", { class: "form-control", placeholder: "Remarks", maxlength: 500 });
  const panel = reviewer ? h("div", { class: "card card-body mb-3" }, h("h6", {}, "Accounts decision"),
    h("div", { class: "form-text mb-2" }, (a.advance_ref ? "Approving uses up the advance and reduces the bill. The Journal (advance " + a.advance_ref + " against this bill) goes to Tally with the next export file." : "There is no amount limit. Approving posts a credit to the customer's bill; it is then sent to Tally as a Credit Note.")),
    h("label", { class: "form-label" }, "Remarks (needed to reject)"), rem,
    h("div", { class: "d-flex gap-2 mt-3" },
      h("button", { class: "btn btn-brand flex-fill", onclick: guard(async e => { e.target.disabled = true;
        try { await api("POST", `/api/adjustments/${id}/approve`, { remarks: rem.value.trim() || null }); toast("Approved"); await route(); } catch (x) { e.target.disabled = false; throw x; } }) }, "Approve"),
      h("button", { class: "btn btn-outline-danger", onclick: guard(async () => { if (!rem.value.trim()) { toast("Write the reason in Remarks first", true); return; }
        await api("POST", `/api/adjustments/${id}/reject`, { remarks: rem.value.trim() }); toast("Rejected"); await route(); }) }, "Reject"))) : null;
  const undo = a.adj_type === "ADVANCE_ADJ" && a.status === "POSTED" && me.permissions.includes("adjustment.approve") ? h("button", { class: "btn btn-outline-danger w-100 mb-3", onclick: guard(async () => {
    const v = await ask("Undo this use of the advance", [{ name: "remarks", label: "Why? (the advance becomes available again and the bill opens again)", type: "textarea" }], "Undo");
    if (!v || !v.remarks) return; await api("POST", `/api/adjustments/${id}/undo`, { remarks: v.remarks }); toast("Undone"); await route(); }) }, "Undo this use of the advance") : null;
  shell(a.reference, h("div", {},
    h("a", { href: "#/adjustments", class: "small" }, "← Back"),
    h("div", { class: "card card-body my-3" }, h("div", { class: "d-flex justify-content-between" }, h("div", { class: "fs-5 fw-bold" }, a.customer_name), pill(a.status)),
      h("dl", { class: "kv mt-2 mb-0" },
        h("dt", {}, "Type"), h("dd", {}, ADJ[a.adj_type] || a.adj_type),
        h("dt", {}, "Bill"), h("dd", {}, a.bill_ref),
        a.advance_ref ? [h("dt", {}, "Advance"), h("dd", {}, "Ref " + a.advance_ref + (a.auto_applied ? " (applied automatically when this bill was imported)" : ""))] : null,
        h("dt", {}, "Amount"), h("dd", {}, inr(a.amount)),
        h("dt", {}, "Date"), h("dd", {}, dmy(a.adj_date)),
        h("dt", {}, "Requested by"), h("dd", {}, a.requested_by_name),
        h("dt", {}, "Reason"), h("dd", {}, a.reason),
        a.reviewer_remarks ? [h("dt", {}, "Accounts remarks"), h("dd", {}, a.reviewer_remarks)] : null)),
    panel, undo,
    h("h6", {}, "History"), h("div", { class: "card" }, a.history.map(x => h("div", { class: "list-row" },
      h("div", {}, h("div", {}, x.action.replace(/_/g, " ").toLowerCase()), x.remarks ? h("small", {}, x.remarks) : null),
      h("small", {}, new Date(x.created_at).toLocaleString("en-IN")))))), "adj");
}

// ---------- accounts: cheques ----------
async function viewCheques() {
  const d = await api("GET", "/api/cheques");
  const bankList = (await api("GET", "/api/bank-accounts")).items;
  const doit = (path, id, ok, body) => guard(async () => { await api("POST", `/api/cheques/${id}/${path}`, body); toast(ok); await route(); })();
  const rows = d.items.map(c => {
    const live = ["RECEIVED", "DEPOSITED"].includes(c.status);
    return h("div", { class: "list-row d-block" }, h("div", { class: "d-flex justify-content-between" },
      h("div", {}, h("div", {}, c.customer_name), h("small", {}, `${c.cheque_no} · ${c.bank_name} · dated ${dmy(c.cheque_date)}`)),
      h("div", { class: "text-end" }, h("div", { class: "money" }, inr(c.amount)), h("span", { class: "pill " + (c.is_post_dated && live ? "warn" : c.status === "DISHONOURED" ? "bad" : "") }, c.status.toLowerCase() + (c.is_post_dated && live ? " · post-dated" : "")))),
      live ? h("div", { class: "d-flex gap-2 mt-2" },
        c.status === "RECEIVED" ? h("button", { class: "btn btn-sm btn-outline-secondary", onclick: guard(async () => { const v = await ask("Mark deposited", [{ name: "deposited_date", label: "Deposit date", type: "date", value: today() }]); if (v) doit("deposit", c.collection_id, "Marked deposited", v); }) }, "Deposited") : null,
        h("button", { class: "btn btn-sm btn-brand", onclick: guard(async () => { const v = await ask("Cheque cleared", [{ name: "bank_credit_date", label: "Date it passed in the bank", type: "date", value: today() }, { name: "bank_account_id", label: "Bank account", type: "select", options: bankList.map(b => [b.id, `${b.display_name} (${b.tally_ledger_name})`]) }], "Mark cleared");
          if (v) doit("clear", c.collection_id, "Marked cleared", { bank_credit_date: v.bank_credit_date, bank_account_id: v.bank_account_id ? Number(v.bank_account_id) : null }); }) }, "Cleared"),
        h("button", { class: "btn btn-sm btn-outline-danger", onclick: guard(async () => { const v = await ask("Cheque dishonoured", [{ name: "remarks", label: "Reason", type: "textarea" }], "Dishonour"); if (v && v.remarks) doit("dishonour", c.collection_id, "Receipt reversed", v); }) }, "Dishonoured"),
        h("a", { class: "btn btn-sm btn-link", href: "#/c/" + c.collection_id }, "Open")) : null);
  });
  shell("Cheques", h("div", { class: "card" }, rows.length ? rows : h("div", { class: "p-4 text-muted" }, "No approved cheques yet.")), "cheques");
}

// ---------- accounts: Tally export ----------
const BATCH = { PREVIEW: ["File ready, not downloaded", "warn"], EXPORTED: ["Downloaded, waiting for Tally result", "warn"],
  IMPORTED_UNRECONCILED: ["Imported in Tally, not yet checked", "warn"], IMPORT_FAILED: ["Tally rejected it", "bad"], CANCELLED: ["Cancelled", "grey"], RECONCILED: ["Reconciled", ""] };

async function viewTally() {
  const [br, batches, maps, bankRes] = await Promise.all([api("GET", "/api/branches"), api("GET", "/api/exports"), api("GET", "/api/tally/ledger-mappings"), api("GET", "/api/bank-accounts")]);
  const branches = br.items.filter(b => b.tally_company_name);
  const pick = h("select", { class: "form-select mb-3" }, branches.map(b => h("option", { value: b.id }, b.name)));
  const pv = h("div");
  async function loadPreview() {
    pv.replaceChildren(h("p", { class: "text-muted" }, "Checking..."));
    try {
      const p = await api("GET", "/api/exports/preview?branch_id=" + pick.value);
      pv.replaceChildren(h("div", { class: "card card-body mb-3" },
        h("div", {}, `${p.receipts} receipt(s) totalling ${inr(p.total_receipts)}, ${p.contras} cheque Contra(s), ${p.credit_notes || 0} credit note(s), ${p.journals || 0} advance Journal(s) and ${p.reversals || 0} reversal(s) of dishonoured cheques are ready.`),
        p.blocked.length ? h("div", { class: "alert alert-warning mt-3 mb-0" }, h("strong", {}, "Not ready:"), p.blocked.map(b => h("div", {}, `${b.reference}: ${b.reasons.join("; ")}`))) : null,
        p.items.length ? h("button", { class: "btn btn-brand mt-3", onclick: guard(async () => { const r = await api("POST", "/api/exports", { branch_id: Number(pick.value) }); toast("Export file created"); await route(); }) }, "Create export file") : null));
    } catch (e) { pv.replaceChildren(h("div", { class: "alert alert-danger" }, e.message)); }
  }
  pick.addEventListener("change", guard(loadPreview));
  const download = async id => {
    const r = await fetch(`/api/exports/${id}/download`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } });
    if (!r.ok) { let m = "Download failed"; try { m = (await r.json()).detail; } catch (e) { /* ignore */ } throw new Error(m); }
    const url = URL.createObjectURL(await r.blob()), a = h("a", { href: url, download: `tally_export_${id}.xml` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("Downloaded. Import it in Tally, then record the result here."); await route();
  };
  const result = (id, ok) => guard(async () => {
    const v = await ask(ok ? "Tally accepted the file" : "Tally rejected the file", [{ name: "note", label: ok ? "Note (optional)" : "What did Tally say?", type: "textarea" }], "Save");
    if (!v || (!ok && !v.note)) return;
    await api("POST", `/api/exports/${id}/result`, { outcome: ok ? "SUCCESS" : "FAILED", note: v.note || null }); toast("Recorded"); await route();
  })();
  const rows = batches.items.map(b => { const [t, c] = BATCH[b.status] || [b.status, "grey"];
    return h("div", { class: "list-row d-block" }, h("div", { class: "d-flex justify-content-between" },
      h("div", {}, h("div", {}, "Batch " + b.id), h("small", {}, `${b.txn_count} voucher(s) \u00B7 ${inr(b.total_amount)} \u00B7 ${new Date(b.created_at).toLocaleDateString("en-IN")}`)), h("span", { class: "pill " + c }, t)),
      b.tally_result_note ? h("small", {}, b.tally_result_note) : null,
      h("div", { class: "d-flex gap-2 mt-2 flex-wrap" },
        ["PREVIEW", "EXPORTED"].includes(b.status) ? h("button", { class: "btn btn-sm btn-brand", onclick: guard(() => download(b.id)) }, b.status === "PREVIEW" ? "Download XML" : "Download again") : null,
        b.status === "PREVIEW" ? h("button", { class: "btn btn-sm btn-outline-secondary", onclick: guard(async () => { await api("POST", `/api/exports/${b.id}/cancel`); toast("Cancelled"); await route(); }) }, "Cancel") : null,
        b.status === "EXPORTED" ? [h("button", { class: "btn btn-sm btn-outline-success", onclick: () => result(b.id, true) }, "Tally accepted it"), h("button", { class: "btn btn-sm btn-outline-danger", onclick: () => result(b.id, false) }, "Tally rejected it")] : null)); });
  const canConfig = me.permissions.includes("tally.configure");
  const mapRows = maps.items.map(m => h("div", { class: "list-row" }, h("div", {}, h("div", {}, m.tally_ledger_name), h("small", {}, `${m.purpose.replace(/_/g, " ").toLowerCase()} \u00B7 ${m.branch || "all branches"}${m.payment_mode ? " \u00B7 " + m.payment_mode : ""}`))));
  shell("Tally export", h("div", {},
    h("p", { class: "text-muted small" }, "Approved receipts and cleared cheques go to Tally as an XML file. A receipt counts as done in Tally only after you record that Tally accepted the file."),
    branches.length ? [pick, pv] : h("div", { class: "alert alert-warning" }, "No branch has a Tally company name configured yet."),
    h("h6", { class: "mt-4" }, "Check against Tally"),
    h("div", { class: "card card-body mb-3" }, h("p", { class: "small text-muted" }, "Export the Receipt and Contra vouchers from Tally (XML) and upload them. Each voucher we sent is matched on customer, date, amount, ledger and bills. Anything that differs is flagged, never changed."),
      (() => { const f = h("input", { class: "form-control mb-2", type: "file", accept: ".xml" }), out = h("div");
        const btn = h("button", { class: "btn btn-outline-secondary", onclick: guard(async () => {
          if (!f.files.length) throw new Error("Choose the Tally XML file first");
          const fd = new FormData(); fd.append("branch_id", pick.value); fd.append("file", f.files[0]);
          const r = await fetch("/api/exports/reconcile", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf }, body: fd });
          const d = await r.json(); if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Could not read the file");
          out.replaceChildren(h("div", { class: "alert alert-" + (d.exceptions.length ? "warning" : "success") + " mt-3 mb-0" },
            h("div", {}, `${d.matched.length} matched, ${d.exceptions.length} with differences, ${d.not_in_file.length} not found in the file, ${d.other_vouchers} other Tally vouchers ignored.`),
            d.exceptions.map(e => h("div", { class: "mt-2" }, h("strong", {}, e.reference + ": "), e.problems.join("; "))),
            d.not_in_file.length ? h("div", { class: "mt-2 small" }, "Not found: " + d.not_in_file.join(", ")) : null));
        }) }, "Check against Tally");
        return [f, btn, out]; })()),
    h("h6", { class: "mt-4" }, "Export batches"), h("div", { class: "card mb-4" }, rows.length ? rows : h("div", { class: "p-3 text-muted" }, "None yet.")),
    h("h6", {}, "Bank accounts"), h("div", { class: "card mb-2" }, bankRes.items.length ? bankRes.items.map(b => h("div", { class: "list-row" },
      h("div", {}, h("div", {}, b.display_name), h("small", {}, b.tally_ledger_name + " \u00B7 Cheque in Hand: " + (b.cheque_in_hand_ledger || "not set") + " \u00B7 " + (branches.find(x => x.id === b.branch_id) || {}).name)),
      me.permissions.includes("bank.manage") && !b.cheque_in_hand_ledger ? h("button", { class: "btn btn-sm btn-outline-secondary me-2", onclick: guard(async () => { const v = await ask("Cheque in Hand ledger for " + b.display_name, [{ name: "l", label: "Exact ledger name in Tally (cannot be changed later)" }], "Save"); if (!v || !v.l) return; await api("POST", `/api/bank-accounts/${b.id}/cheque-ledger`, { cheque_in_hand_ledger: v.l }); toast("Saved"); await route(); }) }, "Set cheque ledger") : null,
      me.permissions.includes("bank.manage") ? h("button", { class: "btn btn-sm btn-outline-secondary", onclick: guard(async () => { await api("POST", `/api/bank-accounts/${b.id}/deactivate`); toast("Bank account switched off"); await route(); }) }, "Switch off") : null))
      : h("div", { class: "p-3 text-muted" }, "No bank account yet. Add one so electronic payments and cleared cheques can be posted.")),
    me.permissions.includes("bank.manage") ? h("button", { class: "btn btn-outline-secondary btn-sm mb-4", onclick: guard(async () => {
      const v = await ask("Add a bank account", [{ name: "display_name", label: "Name you will recognise (e.g. HDFC main)" }, { name: "tally_ledger_name", label: "Exact bank ledger name in Tally" }, { name: "cheque_in_hand_ledger", label: "This bank's 'Cheque in Hand' ledger in Tally (needed for cheques)" }], "Add");
      if (!v || !v.display_name || !v.tally_ledger_name) return;
      await api("POST", "/api/bank-accounts", { branch_id: Number(pick.value), display_name: v.display_name, tally_ledger_name: v.tally_ledger_name, cheque_in_hand_ledger: v.cheque_in_hand_ledger || null });
      toast("Bank account added"); await route(); }) }, "Add a bank account to the selected branch") : null,
    h("h6", {}, "Cash and credit-note ledgers"), h("div", { class: "card mb-2" }, mapRows.length ? mapRows : h("div", { class: "p-3 text-muted" }, "No ledger has been set. Cash receipts and credit notes cannot be exported until they are.")),
    canConfig ? h("button", { class: "btn btn-outline-secondary btn-sm", onclick: guard(async () => {
      const v = await ask("Set a Tally ledger", [{ name: "purpose", label: "For", type: "select", options: [["CASH", "Cash receipts"], ["SALES_RETURN", "Goods returns (debited on the Credit Note)"], ["DISCOUNT", "Discounts (debited on the Credit Note)"], ["OTHER_ADJ", "Other credits and write-offs"]] }, { name: "name", label: "Exact ledger name in Tally" }], "Save");
      if (!v || !v.name) return;
      await api("PUT", "/api/tally/ledger-mappings", { purpose: v.purpose, branch_id: Number(pick.value), tally_ledger_name: v.name });
      toast("Saved"); await route(); }) }, "Set a ledger for the selected branch") : null), "tally");
  if (branches.length) await loadPreview();
}

// ---------- customer statement ----------
async function viewStatement(id) {
  const d = await api("GET", `/api/customers/${id}/statement`);
  const T = d.totals, sales = me.role === "SALESMAN";
  shell(d.customer.name, h("div", {},
    h("a", { href: sales ? "#/customer/" + id : "#/queue", class: "small" }, "← Back"),
    h("div", { class: "card card-body my-3" }, h("div", { class: "text-muted small" }, "Outstanding per Tally, after approved receipts (Tally data as on " + dmy(d.tally_data_as_of) + ")"),
      h("div", { class: "fs-3 fw-bold" }, inr(T.official_outstanding)),
      h("div", { class: "small text-muted" }, `Tally shows ${inr(T.tally_outstanding)}. ${inr(T.awaiting_approval)} is collected but not yet approved.`)),
    d.advances.length ? h("div", { class: "alert alert-info" }, "Advances: ", d.advances.map(a => `Ref ${a.advance_ref} ${inr(a.balance)} left of ${inr(a.amount)}${a.status === "PENDING_APPROVAL" ? " (after approval)" : ""}`).join("; ")) : null,
    h("h6", {}, "Bills"), h("div", { class: "card table-wrap mb-3" }, h("table", { class: "table table-sm mb-0" },
      h("thead", {}, h("tr", {}, ["Bill", "Date", "Tally", "Approved, not in Tally", "Awaiting approval", "Collectable"].map((t, i) => h("th", { class: i > 1 ? "text-end" : "" }, t)))),
      h("tbody", {}, d.bills.length ? d.bills.map(b => h("tr", {}, h("td", {}, b.bill_ref), h("td", {}, dmy(b.invoice_date)), h("td", { class: "money" }, inr(b.source_outstanding)),
        h("td", { class: "money" }, b.approved_not_in_tally === "0.00" ? "" : inr(b.approved_not_in_tally)), h("td", { class: "money" }, b.awaiting_approval === "0.00" ? "" : inr(b.awaiting_approval)),
        h("td", { class: "money fw-bold" }, inr(b.collectable)))) : h("tr", {}, h("td", { colspan: 6, class: "text-muted" }, "Nothing outstanding.")))),),
    h("h6", {}, "Receipts and credits recorded here"), h("div", { class: "card" }, d.activity.length ? d.activity.map(a => h("div", { class: "list-row" },
      h("div", {}, h("div", {}, `${a.voucher_type} ${a.voucher_ref}${a.is_reversal ? " (reversal)" : ""}`), h("small", {}, `${dmy(a.txn_date)}${a.bill_ref ? " · " + a.bill_ref : ""}${a.particulars ? " · " + a.particulars : ""}`)),
      h("div", { class: "text-end" }, h("div", { class: "money" }, a.credit !== "0.00" ? "+" + inr(a.credit) : "-" + inr(a.debit)), a.status ? pill(a.status) : null)))
      : h("div", { class: "p-3 text-muted" }, "Nothing recorded yet."))), sales ? "customers" : "queue");
}

// ---------- import centre ----------
const IMPORT_NAME = { OUTSTANDING: "Bills Receivable", INVOICES: "Sales invoices", CUSTOMERS: "Customer master", OPENING_BALANCES: "Opening balances" };
const COUNT_LABEL = { NEW: "to add", UPDATED: "to update", UNCHANGED: "unchanged", REVIEW: "need review", REJECTED: "rejected", DUPLICATE: "duplicates" };

async function viewImport() {
  const [br, st, list] = await Promise.all([api("GET", "/api/branches"), api("GET", "/api/imports/status"), api("GET", "/api/imports?limit=15")]);
  const branches = br.items.filter(b => b.tally_company_name);
  const pick = h("select", { class: "form-select mb-2" }, branches.map(b => h("option", { value: b.id }, b.name)));
  const can = me.permissions;
  const kinds = [["outstanding", "Bills Receivable (outstanding by bill): run this daily", "import.run"],
    ["sales", "Day Book / Sales Register (adds Tally voucher number, GST and items to bills)", "import.run"],
    ["opening-balances", "Opening balances as on 01-04-2025 (Excel / CSV)", "import.run"],
    ["customers", "Customer master (Excel / CSV)", "master.manage"]].filter(k => can.includes(k[2]));
  const kind = h("select", { class: "form-select mb-2" }, kinds.map(([v, l]) => h("option", { value: v }, l)));
  const file = h("input", { class: "form-control mb-2", type: "file", accept: ".xml,.xlsx,.csv" });
  const btn = h("button", { class: "btn btn-brand w-100", onclick: guard(async e => {
    if (!file.files.length) throw new Error("Choose the file first");
    const fd = new FormData(); fd.append("file", file.files[0]);
    if (["outstanding", "sales"].includes(kind.value)) fd.append("branch_id", pick.value);
    e.target.disabled = true;
    try {
      const r = await fetch(`/api/imports/${kind.value}/preview`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf }, body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : (d.detail && d.detail.message) || "Could not read the file");
      location.hash = "#/import/" + d.batch_id;
    } finally { e.target.disabled = false; }
  }) }, "Check the file");
  shell("Import", h("div", {},
    h("h6", {}, "How fresh is the data"), h("div", { class: "card mb-3" }, st.items.map(x => h("div", { class: "list-row" },
      h("div", {}, h("div", {}, x.branch), h("small", {}, x.message)), h("span", { class: "pill " + (x.stale ? "warn" : "") }, x.stale ? "Out of date" : "Up to date")))),
    h("h6", {}, "Upload a file"), h("div", { class: "card card-body mb-3" }, branches.length || kinds.length ? [h("div", { class: "small text-muted mb-1" }, "Branch (for the two Tally files)"), pick, kind, file, btn,
      h("div", { class: "form-text mt-2" }, "Nothing is saved until you have seen the preview and pressed Confirm."),
      h("div", { class: "mt-3 d-flex gap-2 flex-wrap" },
        can.includes("master.manage") ? h("button", { class: "btn btn-sm btn-outline-secondary", onclick: guard(() => downloadFile("/api/imports/templates/customers.xlsx", "customers.xlsx")) }, "Customer master template") : null,
        can.includes("import.run") ? h("button", { class: "btn btn-sm btn-outline-secondary", onclick: guard(() => downloadFile("/api/imports/templates/opening-balances.xlsx", "opening-balances.xlsx")) }, "Opening balances template") : null)]
      : h("div", { class: "alert alert-warning mb-0" }, "No branch has a Tally company name configured yet.")),
    h("h6", {}, "Recent imports"), h("div", { class: "card" }, list.items.length ? list.items.map(b => h("a", { class: "list-row", href: "#/import/" + b.id },
      h("div", {}, h("div", {}, IMPORT_NAME[b.import_type] || b.import_type), h("small", {}, `${b.file_name} · data as on ${dmy(b.as_of_date)}`)),
      h("span", { class: "pill " + (b.status === "PREVIEW" ? "warn" : "") }, b.status === "PREVIEW" ? "Not confirmed" : b.status.toLowerCase())))
      : h("div", { class: "p-3 text-muted" }, "No imports yet."))), "import");
}

async function viewImportBatch(id) {
  const b = await api("GET", "/api/imports/" + id);
  const sales = b.import_type !== "OUTSTANDING";
  const bad = ["CUSTOMERS", "OPENING_BALANCES"].includes(b.import_type) ? "REJECTED" : "REVIEW";
  const review = (await api("GET", `/api/imports/${id}/rows?classification=${bad}&limit=100`)).items;
  const rowsHtml = review.map(r => h("div", { class: "list-row d-block" },
    h("div", { class: "d-flex justify-content-between" }, h("div", {}, h("div", {}, r.party || r.raw_data.code || "-"), h("small", {}, (r.bill_ref || "") + (r.raw_data.row ? " (row " + r.raw_data.row + ")" : ""))),
      r.decision ? h("span", { class: "pill " + (r.decision === "ACCEPTED" ? "" : "grey") }, r.decision.toLowerCase()) : null),
    h("div", { class: "small text-muted" }, (r.reasons || []).join("; ")),
    !sales && b.status === "PREVIEW" && !r.decision ? h("div", { class: "d-flex gap-2 mt-2" },
      ["ACCEPTED", "DECLINED"].map(dec => h("button", { class: "btn btn-sm " + (dec === "ACCEPTED" ? "btn-outline-success" : "btn-outline-secondary"), onclick: guard(async () => {
        const v = await ask(dec === "ACCEPTED" ? "Accept this row" : "Leave this row out", [{ name: "remarks", label: "Why?", type: "textarea" }], "Save");
        if (!v || v.remarks.length < 3) return;
        await api("POST", `/api/imports/${id}/rows/${r.id}/decision`, { decision: dec, remarks: v.remarks }); toast("Saved"); await route(); }) }, dec === "ACCEPTED" ? "Accept" : "Leave out"))) : null));
  const confirmPath = { INVOICES: `/api/imports/sales/${id}/confirm`, CUSTOMERS: `/api/imports/customers/${id}/confirm`, OPENING_BALANCES: `/api/imports/opening-balances/${id}/confirm` }[b.import_type] || `/api/imports/${id}/confirm`;
  shell((IMPORT_NAME[b.import_type] || "Import") + " import", h("div", {},
    h("a", { href: "#/import", class: "small" }, "← Import"),
    h("div", { class: "card card-body my-3" }, h("div", { class: "fw-bold" }, b.file_name), h("div", { class: "small text-muted" }, `${b.source_company} · data as on ${dmy(b.as_of_date)}`),
      h("div", { class: "d-flex flex-wrap gap-2 mt-2" }, Object.entries(b.counts).map(([k, n]) => h("span", { class: "pill " + (k === "REVIEW" ? "warn" : k === "REJECTED" ? "bad" : "") }, `${n} ${COUNT_LABEL[k] || k.toLowerCase()}`))),
      b.repeat_of ? h("div", { class: "alert alert-warning mt-3 mb-0" }, "This exact file was already imported before (batch " + b.repeat_of + ").") : null),
    review.length ? [h("h6", {}, bad === "REJECTED" ? "Rows that will not be imported" : "Needs a look"), h("div", { class: "card mb-3" }, rowsHtml)] : null,
    b.status === "PREVIEW" ? h("button", { class: "btn btn-brand w-100 mb-3", onclick: guard(async e => { e.target.disabled = true;
      try { const r = await api("POST", confirmPath); toast("Imported"); await route(); } catch (x) { e.target.disabled = false; throw x; } }) }, "Confirm and import")
      : h("div", { class: "alert alert-success" }, "Status: " + b.status.toLowerCase() + (b.confirmed_at ? " on " + new Date(b.confirmed_at).toLocaleString("en-IN") : "")),
    !sales && b.status === "CONFIRMED" ? h("button", { class: "btn btn-outline-secondary w-100", onclick: guard(async () => {
      const open = b.counts.REVIEW || 0;
      await api("POST", `/api/imports/${id}/finalise`, { acknowledge_unresolved: open > 0 }); toast("Finalised"); await route(); }) }, "Finalise this import") : null), "import");
}

// ---------- today's route and visits ----------
const OUTCOME = { COLLECTED: "Payment collected", NO_PAYMENT: "No payment", UNAVAILABLE: "Customer unavailable", PROMISED: "Payment promised",
  RESCHEDULED: "Visit rescheduled", OTHER: "Other reason" };

async function recordVisit(c) {
  const v = await ask("Visit: " + c.name, [
    { name: "outcome", label: "What happened?", type: "select", options: Object.entries(OUTCOME) },
    { name: "remarks", label: "Remarks (needed unless payment was collected or promised)", type: "textarea" },
    { name: "promised_amount", label: "If promised: amount" },
    { name: "promised_date", label: "If promised: date", type: "date" },
    { name: "next_visit_date", label: "Next visit (if rescheduled)", type: "date" }], "Save visit");
  if (!v) return;
  const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "");
  await api("POST", "/api/visits", { customer_id: c.customer_id, outcome: v.outcome, remarks: v.remarks || null, promised_amount: v.promised_amount || null,
    promised_date: v.promised_date || null, next_visit_date: v.next_visit_date || null, idempotency_key: key });
  toast("Visit saved"); await route();
}

async function viewToday() {
  const d = await api("GET", "/api/route/today");
  shell("Today · " + DAYS[d.weekday], h("div", {},
    h("div", { class: "card card-body mb-3" }, h("div", { class: "fs-4 fw-bold" }, `${d.visited} of ${d.total} visited`), h("div", { class: "small text-muted" }, dmy(d.date))),
    d.items.length ? d.items.map(c => h("div", { class: "card card-body mb-2" },
      h("div", { class: "d-flex justify-content-between" },
        h("a", { href: "#/customer/" + c.customer_id, class: "fw-bold text-reset" }, c.name),
        c.collected_today ? h("span", { class: "pill" }, "Receipt entered") : c.visit_today ? h("span", { class: "pill grey" }, OUTCOME[c.visit_today]) : null),
      h("div", { class: "small text-muted" }, [c.route_name, c.reasons.join(", ")].filter(Boolean).join(" · ")),
      c.promised_amount ? h("div", { class: "small" }, "Promised today: " + inr(c.promised_amount)) : null,
      c.instructions ? h("div", { class: "small fst-italic" }, c.instructions) : null,
      h("div", { class: "d-flex justify-content-between align-items-center mt-2" }, h("div", {}, h("div", { class: "text-muted small" }, "Outstanding"), h("div", { class: "fw-bold" }, inr(c.outstanding))),
        h("div", { class: "d-flex gap-2" },
          c.mobile ? h("a", { class: "btn btn-sm btn-outline-secondary", href: "tel:" + c.mobile }, "Call") : null,
          h("button", { class: "btn btn-sm btn-outline-secondary", onclick: guard(() => recordVisit(c)) }, "Visit"),
          h("a", { class: "btn btn-sm btn-brand", href: "#/collect/" + c.customer_id }, "Collect")))))
      : h("div", { class: "card card-body text-muted" }, "No customers are due today.")), "today");
}

// ---------- reports ----------
async function downloadFile(url, name) { return downloadCsv(url, name); }
async function downloadCsv(url, name) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error("Download failed");
  const u = URL.createObjectURL(await r.blob()), a = h("a", { href: u, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000);
}

// ---------- cash register ----------
async function viewCash() {
  const can = me.permissions.includes("cash.manage");
  const [sum, dep, banks] = await Promise.all([api("GET", "/api/cash/summary"), api("GET", "/api/cash/deposits"), can ? api("GET", "/api/bank-accounts") : { items: [] }]);
  const record = b => guard(async () => {
    const mine = banks.items.filter(x => x.branch_id === b.branch.id && x.is_active);
    if (!mine.length) { toast("Add a bank account for this branch first (Tally screen)", true); return; }
    const v = await ask("Cash deposited - " + b.branch.name, [
      { name: "amount", label: "Amount deposited", type: "number" }, { name: "deposit_date", label: "Deposit date", type: "date", value: today() },
      { name: "bank_account_id", label: "Bank account", type: "select", options: mine.map(x => [x.id, x.display_name]) },
      { name: "slip_ref", label: "Deposit slip reference" }, { name: "remarks", label: "Remarks (optional)" }], "Save");
    if (!v || !v.amount || !v.slip_ref) return;
    await api("POST", "/api/cash/deposits", { branch_id: b.branch.id, amount: v.amount, deposit_date: v.deposit_date, bank_account_id: Number(v.bank_account_id),
      slip_ref: v.slip_ref, remarks: v.remarks || null, idempotency_key: "dep-" + crypto.randomUUID() });
    toast("Deposit recorded"); await route(); });
  shell("Cash", h("div", {},
    h("div", { class: "small text-muted mb-2" }, "Approved cash receipts against cash recorded as deposited. This is a record only; nothing is sent to Tally from here."),
    sum.branches.map(b => h("div", { class: "card card-body mb-3" },
      h("div", { class: "fw-bold" }, b.branch.name),
      h("div", { class: "d-flex justify-content-between" }, h("span", {}, "Cash collected (approved)"), h("span", { class: "money" }, inr(b.collected))),
      h("div", { class: "d-flex justify-content-between" }, h("span", {}, "Deposited in bank"), h("span", { class: "money" }, inr(b.deposited))),
      h("div", { class: "d-flex justify-content-between fw-bold" }, h("span", {}, "Not yet deposited"), h("span", { class: "money" }, inr(b.undeposited))),
      Number(b.undeposited) < 0 ? h("div", { class: "alert alert-danger mt-2 mb-0" }, "More was deposited than the approved cash. A receipt was probably cancelled after the deposit; check with the salesman and the bank slip.") : null,
      can ? h("button", { class: "btn btn-sm btn-brand mt-2", onclick: record(b) }, "Record a deposit") : null)),
    h("h6", {}, "Deposits"),
    h("div", { class: "card" }, dep.items.length ? dep.items.map(d => h("div", { class: "list-row" },
      h("div", {}, h("div", {}, `${inr(d.amount)} · ${d.bank}`), h("small", {}, `${dmy(d.deposit_date)} · slip ${d.slip_ref} · ${d.recorded_by_name}` + (d.voided_at ? " · VOIDED: " + d.void_reason : ""))),
      can && !d.voided_at ? h("button", { class: "btn btn-sm btn-outline-danger", onclick: guard(async () => {
        const v = await ask("Void this deposit", [{ name: "reason", label: "Why?" }], "Void"); if (!v || !v.reason) return;
        await api("POST", `/api/cash/deposits/${d.id}/void`, { reason: v.reason }); toast("Voided"); await route(); }) }, "Void") : null))
      : h("p", { class: "p-3 text-muted mb-0" }, "No deposits recorded."))), "cash");
}

// ---------- audit log ----------
async function viewAudit() {
  const qs = new URLSearchParams((location.hash.split("?")[1]) || "");
  const f = { action: qs.get("action") || "", actor: qs.get("actor") || "", offset: Number(qs.get("offset") || 0) };
  const query = new URLSearchParams({ limit: "50", offset: String(f.offset) });
  if (f.action) query.set("action", f.action);
  if (f.actor) query.set("actor", f.actor);
  const d = await api("GET", "/api/audit?" + query);
  const go = (patch) => { const n = new URLSearchParams(); const m = { ...f, ...patch };
    if (m.action) n.set("action", m.action); if (m.actor) n.set("actor", m.actor); if (m.offset) n.set("offset", m.offset); location.hash = "#/audit" + (n.toString() ? "?" + n : ""); };
  const sel = h("select", { class: "form-select form-select-sm" }, h("option", { value: "" }, "All actions"), d.actions.map(a => h("option", { value: a }, a.replace(/_/g, " ").toLowerCase())));
  sel.value = f.action; sel.addEventListener("change", () => go({ action: sel.value, offset: 0 }));
  const who = h("input", { class: "form-control form-control-sm", placeholder: "Login id", value: f.actor });
  who.addEventListener("change", () => go({ actor: who.value.trim(), offset: 0 }));
  const verifyOut = h("div", { class: "small mt-2" });
  shell("Audit log", h("div", {},
    h("div", { class: "d-flex gap-2 mb-2" }, sel, who),
    me.role === "SUPER_ADMIN" || me.role === "MANAGEMENT" ? h("button", { class: "btn btn-sm btn-outline-secondary mb-2", onclick: guard(async () => {
      const v = await api("GET", "/api/audit/verify");
      verifyOut.className = "small mt-2 alert " + (v.intact ? "alert-success" : "alert-danger");
      verifyOut.textContent = v.intact ? `Chain intact: ${v.entries} entries checked.` : `Chain broken at entry ${v.first_bad_id}. Do not rely on the log; investigate.`; }) }, "Verify the whole log") : null,
    verifyOut,
    h("div", { class: "card mb-3" }, d.items.length ? d.items.map(x => h("details", { class: "list-row d-block" },
      h("summary", {}, h("b", {}, x.action.replace(/_/g, " ").toLowerCase()), h("div", { class: "small text-muted" },
        `${new Date(x.created_at).toLocaleString("en-IN")} · ${x.actor_name || x.actor || "system"}${x.entity_type ? " · " + x.entity_type + " " + x.entity_id : ""}`)),
      h("pre", { class: "small mb-0 mt-2" }, JSON.stringify({ before: x.before_data, after: x.after_data, ip: x.ip_address }, null, 1)))) : h("p", { class: "p-3 text-muted mb-0" }, "No entries.")),
    h("div", { class: "d-flex justify-content-between" },
      h("button", { class: "btn btn-sm btn-outline-secondary", disabled: f.offset === 0, onclick: () => go({ offset: Math.max(0, f.offset - 50) }) }, "Newer"),
      h("small", { class: "text-muted" }, `${f.offset + 1}-${Math.min(f.offset + 50, d.total)} of ${d.total}`),
      h("button", { class: "btn btn-sm btn-outline-secondary", disabled: f.offset + 50 >= d.total, onclick: () => go({ offset: f.offset + 50 }) }, "Older"))), "audit");
}

// ---------- overview ----------
async function viewHome() {
  const d = await api("GET", "/api/dashboard");
  const tile = (label, value, sub, href) => h(href ? "a" : "div", { class: "card card-body tile", href: href || null },
    h("div", { class: "text-muted small" }, label), h("div", { class: "fs-4 fw-bold" }, value), sub ? h("div", { class: "small text-muted" }, sub) : null);
  const t = d.tally;
  const alerts = [];
  if (d.awaiting_approval.receipts) alerts.push(["#/queue", `${d.awaiting_approval.receipts} receipt(s) waiting for approval (${inr(d.awaiting_approval.amount)})`]);
  if (d.awaiting_approval.adjustments) alerts.push(["#/adjustments", `${d.awaiting_approval.adjustments} return/discount request(s) waiting`]);
  if (t.awaiting_result) alerts.push(["#/tally", `${t.awaiting_result} export file(s) downloaded but no Tally result recorded`]);
  if (t.awaiting_reconciliation) alerts.push(["#/tally", `${t.awaiting_reconciliation} export file(s) imported but not yet reconciled`]);
  if (t.exceptions || t.voucher_exceptions) alerts.push(["#/tally", `${t.exceptions + t.voucher_exceptions} reconciliation exception(s)`]);
  if (t.bill_differences) alerts.push(["#/import", `${t.bill_differences} bill difference(s) between Tally and approved receipts`]);
  shell("Overview", h("div", {},
    h("div", { class: "small text-muted mb-2" }, "As on " + dmy(d.as_of) + ". Official outstanding = Tally less approved receipts and credits Tally does not show yet."),
    h("div", { class: "tile-grid mb-3" },
      tile("Outstanding", inr(d.outstanding.total), d.outstanding.customers + " customers owe", "#/reports"),
      tile("Collected today", inr(d.collected.today), "This month " + inr(d.collected.month)),
      tile("Awaiting approval", inr(d.awaiting_approval.amount), d.awaiting_approval.receipts + " receipt(s), not yet in the outstanding", "#/queue"),
      tile("Cheques in hand", inr(d.cheques_in_hand.amount), d.cheques_in_hand.count + " cheque(s), " + d.cheques_in_hand.post_dated + " post-dated", "#/cheques"),
      tile("Advances available", inr(d.advances.amount), d.advances.count + " advance(s)")),
    h("h6", {}, "Needs attention"),
    h("div", { class: "card mb-3" }, alerts.length ? alerts.map(([href, text]) => h("a", { class: "list-row", href }, h("div", {}, text))) : h("p", { class: "p-3 text-muted mb-0" }, "Nothing needs attention.")),
    h("h6", {}, "Salesmen"),
    h("div", { class: "card table-wrap mb-3" }, h("table", { class: "table mb-0" },
      h("thead", {}, h("tr", {}, h("th", {}, "Salesman"), h("th", { class: "text-end" }, "Outstanding"), h("th", { class: "text-end" }, "Collected (month)"), h("th", { class: "text-end" }, "Visits today"))),
      h("tbody", {}, d.salesmen.length ? d.salesmen.map(s => h("tr", {}, h("td", {}, s.salesman), h("td", { class: "money" }, inr(s.outstanding)), h("td", { class: "money" }, inr(s.collected_month)), h("td", { class: "text-end" }, s.visits_today)))
        : h("tr", {}, h("td", { colspan: 4, class: "text-muted" }, "No salesmen"))))),
    h("h6", {}, "Largest dues"),
    h("div", { class: "card" }, d.top_customers.length ? d.top_customers.map(c => h("a", { class: "list-row", href: "#/statement/" + c.id },
      h("div", {}, h("div", {}, c.name), h("small", {}, "oldest bill " + dmy(c.oldest_bill))), h("div", { class: "money" }, inr(c.outstanding)))) : h("p", { class: "p-3 text-muted mb-0" }, "Nothing outstanding."))), "home");
}

// ---------- Super Admin: routes ----------
async function viewRoutes() {
  const [rs, bs] = await Promise.all([api("GET", "/api/routes"), api("GET", "/api/branches")]);
  const branchName = id => (bs.items.find(b => b.id === id) || {}).name || "";
  shell("Routes", h("div", {},
    h("div", { class: "card mb-3" }, rs.items.length ? rs.items.map(r => h("a", { class: "list-row", href: "#/routes/" + r.id },
      h("div", {}, h("div", {}, r.name), h("small", {}, `${branchName(r.branch_id)} · ${r.salesman_name || "no salesman"} · ${(r.visit_days || []).map(d => DAYS[d]).join(", ") || "no days"}`)),
      h("div", { class: "money" }, r.customers + " customers"))) : h("p", { class: "p-3 text-muted mb-0" }, "No routes yet.")),
    h("button", { class: "btn btn-brand w-100", onclick: guard(async () => {
      const v = await ask("New route", [
        { name: "branch_id", label: "Branch", type: "select", options: bs.items.map(b => [b.id, b.name]) },
        { name: "name", label: "Route name" },
        { name: "days", label: "Visit days (1 = Monday ... 7 = Sunday, comma separated)" }], "Create");
      if (!v || !v.name) return;
      const days = v.days ? v.days.split(",").map(x => Number(x.trim())).filter(x => x) : [];
      const r = await api("POST", "/api/routes", { name: v.name, branch_id: Number(v.branch_id), visit_days: days });
      toast("Route created"); location.hash = "#/routes/" + r.id; }) }, "Add a route")), "routes");
}

async function viewRoute(id) {
  const r = await api("GET", "/api/routes/" + id);
  let list = r.customers.map(c => ({ id: c.id, name: c.name }));
  const box = h("div", { class: "card mb-3" });
  const draw = () => box.replaceChildren(...(list.length ? list.map((c, i) => h("div", { class: "list-row" },
    h("div", {}, (i + 1) + ". " + c.name),
    h("div", { class: "d-flex gap-1" },
      h("button", { class: "btn btn-sm btn-outline-secondary", disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }, "↑"),
      h("button", { class: "btn btn-sm btn-outline-secondary", disabled: i === list.length - 1, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); } }, "↓"),
      h("button", { class: "btn btn-sm btn-outline-danger", onclick: () => { list.splice(i, 1); draw(); } }, "Remove")))) : [h("p", { class: "p-3 text-muted mb-0" }, "No customers on this route.")]));
  draw();
  const pick = h("select", { class: "form-select" }, h("option", { value: "" }, "Add a customer..."),
    r.unrouted.map(c => h("option", { value: c.id }, c.name)));
  pick.addEventListener("change", () => { const c = r.unrouted.find(x => String(x.id) === pick.value); if (c && !list.some(x => x.id === c.id)) { list.push({ id: c.id, name: c.name }); draw(); } pick.value = ""; });
  shell(r.name, h("div", {},
    h("a", { href: "#/routes", class: "small" }, "← Routes"),
    h("div", { class: "card card-body my-3" },
      h("div", {}, "Salesman: ", h("b", {}, r.salesman_name || "none")),
      h("div", { class: "small text-muted" }, "Visit days: " + ((r.visit_days || []).map(d => DAYS[d]).join(", ") || "none")),
      h("button", { class: "btn btn-sm btn-outline-secondary mt-2 align-self-start", onclick: guard(async () => {
        const v = await ask("Change salesman", [{ name: "salesman_id", label: "New salesman", type: "select", options: r.salesmen.map(s => [s.id, s.full_name]) },
          { name: "reason", label: "Reason" }], "Change");
        if (!v || !v.reason) return;
        const o = await api("POST", `/api/routes/${id}/salesman`, { salesman_id: Number(v.salesman_id), reason: v.reason });
        toast(o.customers_moved + " customers moved"); await route(); }) }, "Change salesman")),
    h("h6", {}, "Customers in visiting order"), box, pick,
    h("button", { class: "btn btn-brand w-100 mt-3", onclick: guard(async () => {
      const o = await api("PUT", `/api/routes/${id}/customers`, { customer_ids: list.map(c => c.id) });
      toast("Saved: " + o.customers + " customers"); await route(); }) }, "Save this order")), "routes");
}

async function viewReports() {
  const isSales = me.role === "SALESMAN";
  const day = h("select", { class: "form-select" }, h("option", { value: "" }, "Any collection day"), [1, 2, 3, 4, 5, 6, 7].map(n => h("option", { value: n }, DAYS[n])));
  const asOf = h("input", { class: "form-control", type: "date", value: today(), max: today() });
  const out = h("div");
  const qs = () => { const p = new URLSearchParams({ as_of: asOf.value }); if (day.value) p.set("collection_day", day.value); return p; };
  const load = guard(async () => {
    const d = await api("GET", "/api/reports/ageing?" + qs());
    const cols = d.buckets, T = d.totals;
    out.replaceChildren(
      h("div", { class: "card card-body mb-3" }, h("div", { class: "text-muted small" }, "Outstanding (Tally data as on " + dmy(d.tally_data_as_of) + ")"),
        h("div", { class: "fs-3 fw-bold" }, inr(T.total)),
        T.awaiting_approval !== "0.00" ? h("div", { class: "small text-muted" }, inr(T.awaiting_approval) + " more is collected but not yet approved; it is not deducted.") : null),
      h("div", { class: "card table-wrap mb-3" }, h("table", { class: "table table-sm mb-0" },
        h("thead", {}, h("tr", {}, h("th", {}, "Customer"), cols.map(c => h("th", { class: "text-end" }, c + " d")), h("th", { class: "text-end" }, "Total"))),
        h("tbody", {}, d.items.length ? d.items.map(c => h("tr", {}, h("td", {}, isSales ? h("a", { href: "#/customer/" + c.customer_id }, c.customer) : c.customer, h("div", { class: "small text-muted" }, `${c.bills} bill(s), oldest ${c.oldest_days} days${c.advance_available !== "0.00" ? ", advance " + inr(c.advance_available) : ""}`)),
          cols.map(b => h("td", { class: "money" }, c[b] === "0.00" ? "" : inr(c[b]))), h("td", { class: "money fw-bold" }, inr(c.total))))
          : h("tr", {}, h("td", { colspan: cols.length + 2, class: "text-muted" }, "Nothing outstanding."))),
        d.items.length ? h("tfoot", {}, h("tr", {}, h("th", {}, "Total"), cols.map(b => h("th", { class: "money" }, inr(T[b]))), h("th", { class: "money" }, inr(T.total)))) : null)),
      h("p", { class: "small text-muted" }, d.note));
  });
  const csv = h("button", { class: "btn btn-outline-secondary", onclick: guard(() => downloadCsv("/api/reports/ageing?format=csv&" + qs(), "ageing.csv")) }, "Download CSV");
  shell(isSales ? "My outstanding" : "Reports", h("div", {},
    h("div", { class: "row g-2 mb-3" }, h("div", { class: "col-6" }, asOf), h("div", { class: "col-6" }, day),
      h("div", { class: "col-12 d-flex gap-2" }, h("button", { class: "btn btn-brand", onclick: load }, "Show"), csv)),
    out), "reports");
  await load();
}

// ---------- routing ----------
// Navigation can fire faster than the server answers. Run one render at a time and re-run for the latest address,
// so a slow earlier page can never overwrite a newer one.
let routing = false, routeAgain = false;
async function route() {
  if (routing) { routeAgain = true; return; }
  routing = true;
  try { do { routeAgain = false; await routeOnce(); } while (routeAgain); } finally { routing = false; }
}

async function routeOnce() {
  if (!me) return renderLogin();
  if (me.must_change_password) return renderChangePassword();
  const [path, qs] = (location.hash || "").slice(1).split("?");
  const revise = new URLSearchParams(qs || "").get("revise");
  const parts = path.split("/").filter(Boolean);
  const sales = me.role === "SALESMAN";
  try {
    if (!parts.length) { location.hash = sales ? "#/today" : me.permissions.includes("collection.approve") ? "#/queue" : "#/home"; return; }
    if (!sales && parts[0] === "home" && me.permissions.includes("report.view")) return await viewHome();
    const [a, b] = parts;
    if (sales && a === "today") return await viewToday();
    if (sales && a === "customers") return await viewCustomers();
    if (sales && a === "customer") return await viewCustomer(b);
    if (sales && a === "collect") return await viewCollect(b, revise);
    if (sales && a === "mine") return await listView("My collections", "mine", "", "You have not recorded any collections yet.");
    if (!sales && a === "queue") {
      const pend = me.permissions.includes("correction.approve") ? (await api("GET", "/api/corrections?status=PENDING")).items : [];
      const top = pend.length ? h("div", { class: "mb-3" }, h("h6", {}, "Cancellation requests"), h("div", { class: "card" }, pend.map(x => h("a", { class: "list-row", href: "#/c/" + x.collection_id },
        h("div", {}, h("div", {}, x.customer_name), h("small", {}, `${x.reference} · ${x.requested_by_name}: ${x.reason}`)), h("div", { class: "money" }, inr(x.verified_amount || x.declared_amount)))))) : null;
      return await listView("To approve", "queue", "&status=SUBMITTED", "Nothing is waiting for approval.", top);
    }
    if (!sales && a === "all") return await listView("All receipts", "all", "", "No receipts yet.");
    if (!sales && a === "cheques") return await viewCheques();
    if (!sales && a === "tally") return await viewTally();
    if (a === "statement") return await viewStatement(b);
    if (!sales && a === "import") return b ? await viewImportBatch(b) : await viewImport();
    if (!sales && a === "routes" && me.permissions.includes("master.manage")) return b ? await viewRoute(b) : await viewRoutes();
    if (!sales && a === "cash") return await viewCash();
    if (!sales && a === "audit" && me.permissions.includes("audit.view")) return await viewAudit();
    if (a === "reports") return await viewReports();
    if (a === "adjustments") return await viewAdjustments();
    if (a === "adj") return await viewAdjustment(b);
    if (a === "c") return await viewCollection(b);
    location.hash = sales ? "#/today" : me.permissions.includes("collection.approve") ? "#/queue" : "#/home";
  } catch (e) { if (me) { shell("Error", h("div", { class: "alert alert-danger" }, e.message)); } }
}
window.addEventListener("hashchange", route);

async function boot() {
  try { const u = await api("GET", "/api/auth/me"); me = u; csrf = u.csrf_token; } catch (e) { me = null; }
  if (!me) return renderLogin();
  await route();
}
boot();
