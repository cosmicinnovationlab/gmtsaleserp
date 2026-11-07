"use client";
import { useState, useEffect, useRef, Fragment } from "react";
import * as XLSX from "xlsx";
import JSZip from "jszip";

/* ================= constants & helpers ================= */
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const LOCS = ["Ranchi (HO)", "Barhi", "Jamshedpur", "Palamu"];
const ALIAS = { boss: "Ajay", "head office": "Ajay" };
const PRIMARY_GROUPS = new Set(["Fixed Assets", "Investments", "Misc. Expenses (ASSET)", "Liabilities", "Branch / Divisions", "Capital Account", "Reserves & Surplus", "Current Liabilities", "Duties & Taxes", "Provisions", "Sundry Creditors", "Loans (Liability)", "Bank OD A/c", "Secured Loans", "Unsecured Loans", "Suspense A/c", "Expenses", "Direct Expenses", "Indirect Expenses", "Purchase Accounts", "Income", "Direct Incomes", "Indirect Incomes", "Sales Accounts"]);
const SYNC_KEYS = ["users", "parties", "bills", "allocs", "collections", "advAdj", "audit", "tombstones", "expBatches", "logs"];
const MODES = { cash: "Cash", cheque: "Cheque", online: "Bank / UPI" };
const ADJ = { return: "Goods Return", discount: "Discount", other: "Other Adjustment" };
const OPEN_COLS = ["Party Name", "Bill No", "Bill Date", "Pending Amount"];

const p2 = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const noon = (s) => new Date(s + "T12:00:00");
const todayDay = () => (new Date().getDay() + 6) % 7;                // Mon=0
const addDays = (s, n) => { const d = noon(s); d.setDate(d.getDate() + n); return iso(d); };
const dmy = (s) => s ? s.split("-").reverse().join("-") : "";
const diffDays = (a, b) => (noon(a) - noon(b)) / 864e5;
const ageOf = (s) => Math.floor(diffDays(iso(new Date()), s));
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => r2(Number(v) || 0);
const L = (v) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v) => { v = Number(v || 0); return (v < 0 ? "-" : "") + "₹" + L(Math.abs(v)); };
const rsf = (v) => "Rs. " + L(Number(v || 0));
const sumBy = (l, f = (x) => x) => l.reduce((a, x) => a + f(x), 0);
const sumOf = (l, f) => r2(sumBy(l, f));
const sumAmt = (l) => sumOf(l, (c) => c.amount);
const d3 = (i) => DAYS[i].slice(0, 3);
const daysTxt = (d) => d?.length ? d.map(d3).join(", ") : "No fixed day";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const now = () => new Date().toLocaleString("en-IN");
const dt = (s) => new Date(s).toLocaleString("en-IN");
const nm = (l, id) => l.find((x) => x.id === id)?.name || "";
const pty = (n) => (n === 1 ? "party" : "parties");
const rangeOf = (k, t) => {
  const d = new Date(), y = addDays(t, -1);
  return { today: [t, t], yest: [y, y], week: [addDays(t, -6), t], month: [iso(new Date(d.getFullYear(), d.getMonth(), 1)), t], all: ["", ""] }[k];
};
let seq = Date.now() + Math.floor(Math.random() * 4000000);
const uid = () => ++seq;
const locFromCompany = (c) => { const s = (c || "").split("-").pop().trim().toLowerCase(); return (s && LOCS.find((l) => l.toLowerCase().startsWith(s))) || null; };

/* ================= state ================= */
const defaultTally = () => ({ company: "Gurmeet Motors Pvt Ltd - Ranchi", cash: "Cash", bank: "Bank", cheque: "Cheque in Hand", salesReturn: "Sales Return", discount: "Discount Allowed", other: "Other Adjustments", bankAlloc: true });
const fromState = (j) => ({ ...Object.fromEntries(SYNC_KEYS.map((k) => [k, j[k] || []])), advSeq: j.advSeq || 0, tally: { ...defaultTally(), ...(j.tally || {}) } });

/* ================= server connection & saving ================= */
const API = {
  async req(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body && JSON.stringify(body), credentials: "same-origin" });
    let j = null; try { j = await r.json(); } catch (e) { }
    if (!r.ok) throw Object.assign(new Error(j?.error || "Server error " + r.status), { status: r.status });
    return j;
  }
};
function diffOps(a, b) {
  const ops = SYNC_KEYS.flatMap((k) => {
    if (a[k] === b[k]) return [];
    const am = new Map(a[k].map((x) => [x.id, x])), up = [];
    b[k].forEach((x) => { const y = am.get(x.id); if (!y || (y !== x && JSON.stringify(y) !== JSON.stringify(x))) up.push(x); am.delete(x.id); });
    const del = [...am.keys()];
    return up.length || del.length ? [{ c: k, upsert: up, del }] : [];
  });
  if (a.tally !== b.tally && !same(a.tally, b.tally)) ops.push({ tally: b.tally });
  return ops;
}

/* ================= calculations ================= */
function billCalc(db, b) {
  const al = db.allocs.filter((a) => a.billId === b.id), tot = (s) => sumBy(al.filter((a) => a.status === s), (a) => a.amount);
  const settled = tot("confirmed"), prov = tot("provisional"), p = r2(b.amount - settled - prov);
  return { ...b, settled, prov, pending: p, open: p, age: ageOf(b.date) };
}
const partyBills = (db, pid, only = true) =>
  db.bills.filter((b) => b.partyId === pid).map((b) => billCalc(db, b)).filter((b) => !only || b.pending > 0.005).sort((a, b) => a.date.localeCompare(b.date));
function advanceInfo(db, pid) {
  const used = {}; (db.advAdj || []).filter((a) => a.partyId === pid).forEach((a) => a.advances.forEach((x) => { used[x.advRef] = (used[x.advRef] || 0) + x.amount; }));
  const rem = db.collections.filter((c) => c.partyId === pid && c.status !== "rejected" && c.advance > 0)
    .map((c) => ({ c, advRef: c.advRef, remaining: r2(c.advance - (used[c.advRef] || 0)) })).filter((r) => r.remaining > 0.005);
  const parts = rem.filter((r) => r.c.status === "confirmed").sort((a, b) => (a.c.postDate || a.c.date).localeCompare(b.c.postDate || b.c.date) || a.c.id - b.c.id);
  const sm = (l) => sumOf(l, (r) => r.remaining);
  return { total: sm(rem), adjustable: sm(parts), parts };
}
function partySummary(db, p) {
  const bs = partyBills(db, p.id), by = (k) => sumBy(bs, (b) => b[k]);
  return { ...p, advance: advanceInfo(db, p.id).total, outstanding: by("pending"), prov: by("prov"), open: bs.length, oldest: bs[0]?.date };
}

/* ================= Tally MASTER (xlsx "List of Ledgers") ================= */
// "Lohardaga(1/6)" -> [0,5] ; "Ranchi(Dk)-1/4" -> [0,3] ; "Kujju(2&5)" -> [1,4] ; "(All)" / none -> []
function parseDays(name) {
  const m = name.replace(/\([A-Za-z\s.]*\)/g, "").match(/(\d[\d\s\/&,\-]*)\)?\s*$/);
  return m ? [...new Set((m[1].match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= 7).map((n) => n - 1))].sort() : [];
}
function salesmanOf(name) {
  const k = name.trim().toLowerCase(); if (ALIAS[k]) return ALIAS[k];
  return name.match(/^(.+?)\s*\(\s*all\s*\)\s*$/i)?.[1].trim() || null;
}
async function readMasterFile(file) {
  const buf = await file.arrayBuffer();
  const ws = XLSX.read(buf, { type: "array" }); const sheet = ws.Sheets[ws.SheetNames[0]];
  const ref = XLSX.utils.decode_range(sheet["!ref"]);
  const vals = Array.from({ length: ref.e.r + 1 }, (_, r) => { const c = sheet[XLSX.utils.encode_cell({ r, c: 0 })]; return c && c.v != null ? String(c.v).trim() : ""; });
  // Tally prints groups in bold – SheetJS community build ignores styles, so read bold flags straight from the xlsx.
  const zip = await JSZip.loadAsync(buf), P = (t) => new DOMParser().parseFromString(t, "text/xml");
  const st = P(await zip.file("xl/styles.xml").async("string"));
  const fontBold = [...st.getElementsByTagName("fonts")[0].children].map((f) => { const b = f.getElementsByTagName("b")[0]; return !!b && b.getAttribute("val") !== "0"; });
  const xfFont = [...st.getElementsByTagName("cellXfs")[0].children].map((x) => +(x.getAttribute("fontId") || 0));
  const sheetFile = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  const sh = P(await zip.file(sheetFile).async("string")), bold = [];
  [...sh.getElementsByTagName("c")].forEach((c) => { const r = c.getAttribute("r") || ""; if (/^A\d+$/.test(r)) bold[+r.slice(1) - 1] = !!fontBold[xfFont[+(c.getAttribute("s") || 0)]]; });
  return { vals, bold };
}
function buildMaster({ vals, bold }) {
  const start = vals.findIndex((v, i) => bold[i] && v === "Sundry Debtors");
  if (start < 0) throw new Error("'Sundry Debtors' group not found. Please export 'List of Ledgers' from Tally.");
  const parties = [], salesmen = new Set(); let sm = null, group = null, gdays = [], parentDays = null, noBeats = false;
  for (let i = start + 1; i < vals.length; i++) {
    const v = vals[i]; if (!v) continue;
    if ((bold[i] && PRIMARY_GROUPS.has(v)) || /^\d+ Group/.test(v)) break;
    if (!bold[i]) { parties.push({ name: v, group, sm, days: noBeats ? [] : gdays }); continue; }
    const s = salesmanOf(v);
    if (s) { sm = s; noBeats = !!ALIAS[v.trim().toLowerCase()]; salesmen.add(s); group = v; gdays = []; parentDays = null; continue; }
    const own = parseDays(v);
    if (bold[i + 1] && own.length) parentDays = own;              // empty heading that carries days for the groups below it
    group = v; gdays = own.length ? own : (parentDays || []);
  }
  const used = new Set(parties.map((p) => p.sm).filter(Boolean));
  return { company: vals[0] || "", parties, salesmen: [...salesmen].filter((x) => used.has(x)) };
}
function applyMaster(db, m) {
  const loc = locFromCompany(m.company) || "Ranchi (HO)";
  const users = [...db.users], creds = [], smId = {};
  m.salesmen.forEach((n) => {
    const un = n.toLowerCase().replace(/\s+/g, "");
    let u = users.find((x) => x.username === un);
    if (!u) { u = { id: uid(), username: un, password: un + "123", name: n, role: "salesman", active: true, loc }; users.push(u); creds.push(`${un} / ${un}123`); }
    smId[n] = u.id;
  });
  const parties = [...db.parties]; let added = 0, updated = 0;
  m.parties.forEach((p) => {
    const f = { loc, group: p.group || "", salesmanId: p.sm ? smId[p.sm] : null, days: p.days };
    const ex = parties.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (ex) { Object.assign(ex, f); updated++; } else { parties.push({ id: uid(), name: p.name, phone: "", active: true, ...f }); added++; }
  });
  return { users, parties, res: { added, updated, creds, loc, salesmen: m.salesmen, groups: new Set(m.parties.map((p) => p.group)).size } };
}

/* ================= Tally SALES BOOK (xml) ================= */
const unesc = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]).trim();
const tag = (s, t) => { const m = s.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? unesc(m[1]) : ""; };
async function readSalesXml(file) {
  const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf);
  const enc = u8[0] === 0xFF && u8[1] === 0xFE ? "utf-16le" : u8[0] === 0xFE && u8[1] === 0xFF ? "utf-16be" : "utf-8";
  const txt = new TextDecoder(enc).decode(buf);
  if (!txt.includes("<VOUCHER ")) throw new Error("No vouchers found. Export Day Book / Sales Register from Tally as XML.");
  const out = { company: tag(txt, "SVCURRENTCOMPANY"), vouchers: [], cancelled: 0, other: {}, noParty: 0 };
  txt.split("<VOUCHER ").slice(1).forEach((ch) => {
    ch = ch.split("</VOUCHER>")[0]; const head = ch.slice(0, ch.indexOf(">"));
    const type = (head.match(/VCHTYPE="([^"]*)"/) || [])[1] || "", action = (head.match(/ACTION="([^"]*)"/) || [])[1] || "";
    if (action === "Cancel" || tag(ch, "ISCANCELLED") === "Yes" || tag(ch, "ISOPTIONAL") === "Yes") { out.cancelled++; return; }
    if (type !== "Sales") { out.other[type] = (out.other[type] || 0) + 1; return; }
    const party = tag(ch, "PARTYLEDGERNAME"), no = tag(ch, "VOUCHERNUMBER"), d = tag(ch, "DATE"); let amt = null;
    ch.split(/<(?:ALL)?LEDGERENTRIES\.LIST>/).slice(1).forEach((b) => { if (amt === null && tag(b, "LEDGERNAME") === party) { const a = parseFloat(tag(b, "AMOUNT")); if (!isNaN(a)) amt = Math.abs(a); } });
    if (!party || !no || !/^\d{8}$/.test(d) || !amt) { out.noParty++; return; }
    out.vouchers.push({ party, no, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, amount: r2(amt) });
  });
  return out;
}
const newParty = (name, loc) => ({ id: uid(), name, loc, group: "", salesmanId: null, days: [], phone: "", active: true });
const findParty = (parties, name) => parties.find((q) => q.name.toLowerCase() === name.toLowerCase());
function applySales(db, x) {
  const loc = locFromCompany(x.company) || "Ranchi (HO)", parties = [...db.parties], bills = [...db.bills];
  const res = { added: 0, skipped: [], created: [], total: 0, loc, cancelled: x.cancelled, other: x.other, bad: x.noParty };
  x.vouchers.forEach((v) => {
    let p = findParty(parties, v.party);
    if (!p) { p = newParty(v.party, loc); parties.push(p); res.created.push(v.party); }
    if (bills.some((b) => b.partyId === p.id && b.no === v.no)) { res.skipped.push(v.no); return; }
    bills.push({ id: uid(), partyId: p.id, no: v.no, date: v.date, due: addDays(v.date, 30), amount: v.amount, source: "sales" }); res.added++; res.total += v.amount;
  });
  return { parties, bills, res };
}

/* ================= opening outstanding (Excel, optional) ================= */
function pDate(v) {
  if (v === "" || v == null) return null;
  if (v instanceof Date) { const d = new Date(v.getTime() + 12 * 36e5); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; }
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  throw new Error(`bad date '${s}'`);
}
async function importOpening(db, file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  if (!json.length) throw new Error("The file is empty");
  const have = Object.keys(json[0]).map((h) => h.trim().toLowerCase());
  const miss = OPEN_COLS.find((c) => !have.includes(c.toLowerCase())); if (miss) throw new Error(`Column '${miss}' not found. Needed: ${OPEN_COLS.join(", ")}`);
  const parties = [...db.parties], bills = [...db.bills], res = { added: 0, skipped: [], errors: [], created: [] };
  json.forEach((raw, i) => {
    const r = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), v]));
    try {
      const name = String(r["party name"]).trim(), no = String(r["bill no"]).trim(), amt = Number(String(r["pending amount"]).replace(/,/g, "")), dtv = pDate(r["bill date"]);
      if (!name || !no || !(amt > 0) || !dtv) throw new Error("Party / Bill No / Date / Pending Amount missing");
      let p = findParty(parties, name);
      if (!p) { p = newParty(name, "Ranchi (HO)"); parties.push(p); res.created.push(name); }
      if (bills.some((b) => b.partyId === p.id && b.no === no)) { res.skipped.push(no); return; }
      bills.push({ id: uid(), partyId: p.id, no, date: dtv, due: addDays(dtv, 30), amount: amt, source: "opening" }); res.added++;
    } catch (e) { res.errors.push(`Row ${i + 2}: ${e.message}`); }
  });
  return { parties, bills, res };
}

/* ================= downloads & PDF helpers ================= */
const download = (filename, data) => {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 15000);
};
let PDF;   // jsPDF + autoTable, loaded on first use (browser only)
const loadPdf = async () => { if (!PDF) { const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]); PDF = { jsPDF, autoTable }; } };
const savePdf = async (filename, build, flash) => { try { await loadPdf(); download(filename, build()); } catch (e) { flash("err", "Could not create PDF: " + (e.message || e.code || "error")); } };
const PdfBtn = ({ label = "Download PDF", onClick, cls = "sec sm", style }) => <button className={cls} style={style} onClick={onClick}>⬇ {label}</button>;
const safeName = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
const AT = { styles: { fontSize: 8 }, headStyles: { fillColor: [11, 92, 173] }, footStyles: { fillColor: [240, 240, 240], textColor: 0 } };
const right = (...i) => Object.fromEntries(i.map((x) => [x, { halign: "right" }]));
function pdfHeader(doc, title, lines) {
  doc.setFontSize(16); doc.text(title, 14, 16); doc.setFontSize(10);
  lines.forEach((l, i) => doc.text(l, 14, 24 + i * 6)); return 24 + lines.length * 6;
}
function finishPdf(doc) {
  const n = doc.getNumberOfPages(), { pageSize: ps } = doc.internal;
  for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8); doc.text(`Page ${i} of ${n}`, ps.getWidth() - 30, ps.getHeight() - 8); }
  return doc.output("blob");
}
function ledgerRows(db, id) {
  const bs = db.bills.filter((b) => b.partyId === id), e = [], R = (date, k, kind, ref, dr, cr, t, eid) => e.push({ date, k, kind, ref, dr, cr, t, eid });
  bs.forEach((b) => R(b.date, b.id, b.source === "opening" ? "Opening Balance" : b.source === "manual" ? "Bill (added by admin)" : "Sales Bill", b.no, b.amount, 0, "bill", b.id));
  db.allocs.filter((a) => a.status !== "rejected" && a.kind !== "advadj" && bs.some((b) => b.id === a.billId)).forEach((a) => {
    const c = db.collections.find((x) => x.id === a.collectionId);
    R(a.date, a.id + 1e9, (ADJ[a.kind] || ("Receipt" + (c ? ` (${modeLabel(c)})` : ""))) + (a.status === "confirmed" ? "" : " (not yet posted)"), bs.find((b) => b.id === a.billId).no, 0, a.amount, c ? "coll" : "", c?.id);
  });
  db.collections.filter((c) => c.partyId === id && c.status !== "rejected" && c.advance > 0).forEach((c) =>
    R(c.postDate || c.date, c.id + 2e9, `Advance received (${modeLabel(c)})` + (c.status === "confirmed" ? "" : " (not yet posted)"), c.advRef, 0, c.advance, "coll", c.id));
  (db.advAdj || []).filter((a) => a.partyId === id).forEach((a) => {
    R(a.date, a.id + 3e9, "Journal: advance adjusted (from advance)", a.advances.map((x) => x.advRef).join(", "), a.total, 0, "adj", a.id);
    R(a.date, a.id + 3e9 + 1, "Journal: advance adjusted against bill", a.bills.map((x) => x.no).join(", "), 0, a.total, "adj", a.id);
  });
  e.sort((x, y) => x.date.localeCompare(y.date) || x.k - y.k); let bal = 0; e.forEach((r) => { bal += r.dr - r.cr; r.bal = bal; });
  return { rows: e, bal };
}
function makeLedgerPdf(db, p) {
  const doc = new PDF.jsPDF(), { rows, bal } = ledgerRows(db, p.id), sm = db.users.find((u) => u.id === p.salesmanId);
  const y = pdfHeader(doc, "Gurmeet Motors - Party Ledger", [`Party: ${p.name}`, `${p.loc || ""}${p.group ? " | " + p.group : ""}${sm ? " | Salesman: " + sm.name : ""}`, `As on: ${dmy(iso(new Date()))}   (generated ${now()})`]);
  PDF.autoTable(doc, {
    ...AT, startY: y, head: [["Date", "Particulars", "Bill No", "Debit", "Credit", "Balance"]],
    body: rows.map((r) => [dmy(r.date), r.kind, r.ref, r.dr ? rsf(r.dr) : "", r.cr ? rsf(r.cr) : "", rsf(r.bal)]),
    foot: [["", "Closing balance", "", "", "", rsf(Math.abs(bal)) + (bal > 0 ? " Dr" : bal < 0 ? " Cr" : "")]], columnStyles: right(3, 4, 5)
  });
  return finishPdf(doc);
}
function makePendingPdf(db, parties, title, filterLines) {
  const doc = new PDF.jsPDF(), body = []; let grand = 0, nb = 0;
  parties.forEach((p) => {
    const bs = partyBills(db, p.id); if (!bs.length) return; const tot = sumBy(bs, (b) => b.pending); grand += tot; nb += bs.length;
    body.push([{ content: `${p.name}${p.group ? "   [" + p.group + "]" : ""}`, colSpan: 5, styles: { fontStyle: "bold", fillColor: [235, 243, 251] } }]);
    bs.forEach((b) => body.push([b.no, dmy(b.date), String(b.age), rsf(b.amount), rsf(b.pending)]));
    body.push([{ content: "Party total", colSpan: 4, styles: { fontStyle: "bold", halign: "right" } }, { content: rsf(tot), styles: { fontStyle: "bold", halign: "right" } }]);
  });
  const y = pdfHeader(doc, title, [...filterLines, `${parties.length} ${pty(parties.length)} | ${nb} bill${nb === 1 ? "" : "s"} | Total pending: ${rsf(grand)}`, `Generated: ${now()}`]);
  PDF.autoTable(doc, {
    ...AT, startY: y, head: [["Bill No", "Bill Date", "Days", "Bill Amount", "Pending"]], body,
    foot: [[{ content: "GRAND TOTAL", colSpan: 4, styles: { halign: "right" } }, { content: rsf(grand), styles: { halign: "right" } }]], columnStyles: right(2, 3, 4)
  });
  return finishPdf(doc);
}

/* ================= small UI parts ================= */
const BAD = { color: "var(--bad)", borderColor: "var(--bad)" };
const Top = ({ title, back, user, logout, onPw }) => (
  <div className="top">{back && <div className="back" onClick={back}>‹</div>}<h1>{title}</h1>
    {user && <><span onClick={onPw}>{user.name.split(" ")[0]}</span><span onClick={logout}>Logout</span></>}</div>);
const Flash = ({ f }) => f ? <div className={"flash " + f.t}>{f.m}</div> : null;
const ageCls = (a) => a > 60 ? "bad" : a > 30 ? "warn" : "ok";
const Gap = () => <div style={{ height: 8 }} />;
const H3 = ({ m, children }) => <h3 style={{ margin: m }}>{children}</h3>;
const DayChips = ({ days, onChange }) => <div className="dchips">{DAYS.map((d, i) =>
  <a key={i} className={days.includes(i) ? "on" : ""} onClick={() => onChange(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>{d3(i)}</a>)}</div>;
const Tabs = ({ items, cur, pick, style }) => <div className="tabs" style={style}>{items.map(([k, v]) => <a key={k} className={cur === k ? "on" : ""} onClick={() => pick(k)}>{v}</a>)}</div>;
const dayTabs = (all) => [all, ...DAYS.map((d, i) => [i, d3(i)])];
const locOpts = LOCS.map((l) => <option key={l}>{l}</option>);
const UserOpts = ({ users }) => users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>);
const Stat = ({ t, v, s, cls = "" }) => <div className="card" style={{ margin: 0 }}><div className="sub">{t}</div><div className={"amt" + cls}>{v}</div><div className="sub">{s}</div></div>;
const bind = (f, set) => (k) => ({ value: f[k], onChange: (e) => set(k, e.target.value) });
const salesmen = (db, all) => db.users.filter((u) => u.role === "salesman" && (all || u.active));

/* ================= salesman screens ================= */
const hasBeats = (db, me) => db.parties.some((p) => p.active && p.salesmanId === me.id && p.days.length);
const effDay = (db, me, day) => day !== null ? day : (hasBeats(db, me) ? todayDay() : -1);   // -1 = "All"
const isAdj = (c) => !!c.kind && c.kind !== "receipt";
const modeLabel = (c) => isAdj(c) ? ADJ[c.kind] : MODES[c.mode];
const postingDate = (c) => c.enteredOn || c.date;      // date the entry was made in the system (cannot be edited)
const breakdownTxt = (l) => {
  const r = l.filter((c) => !isAdj(c)), a = l.filter(isAdj);
  const part = (list, map, fld, keep = () => true) => Object.entries(map).filter(([k]) => keep(k)).map(([k, v]) => `${v}: ${money(sumAmt(list.filter((c) => c[fld] === k)))}`).join("  ·  ");
  return part(r, MODES, "mode") + (a.length ? "  |  " + part(a, ADJ, "kind", (k) => a.some((c) => c.kind === k)) : "");
};
function PartyCard({ r, go, showDays }) {
  return <div className="card tap" onClick={() => go({ page: "party", id: r.id })}>
    <div className="row"><div className="name">{r.name}</div><div className={"amt " + (r.outstanding > 0 ? "red" : "")}>{money(r.outstanding)}</div></div>
    <div className="sub">{r.group ? `${r.group} · ` : ""}{r.open} open bill{r.open === 1 ? "" : "s"}{r.oldest ? ` · oldest ${dmy(r.oldest)}` : ""}{showDays ? ` · ${daysTxt(r.days)}` : ""}</div>
    {r.advance > 0 && <div className="green sub">Advance on account: {money(r.advance)}</div>}</div>;
}
function SMHome({ db, me, go, day, setDay }) {
  const [q, setQ] = useState(""), [showZero, setSZ] = useState(false);
  const mine = db.parties.filter((p) => p.active && p.salesmanId === me.id).map((p) => partySummary(db, p));
  const s = q.trim().toLowerCase(); let rows, zero = [];
  if (s) rows = mine.filter((r) => r.name.toLowerCase().includes(s)).sort((a, b) => a.name.localeCompare(b.name));
  else {
    const base = day >= 0 ? mine.filter((r) => r.days.includes(day)) : mine;
    rows = base.filter((r) => r.outstanding > 0.005); zero = base.filter((r) => r.outstanding <= 0.005);
    if (day < 0) rows.sort((a, b) => b.outstanding - a.outstanding);
  }
  const todayColl = sumBy(db.collections.filter((c) => c.salesmanId === me.id && !isAdj(c) && c.status !== "rejected" && postingDate(c) === iso(new Date())), (c) => c.amount);
  return <>
    <button className="block" style={{ fontSize: 20, padding: 16 }} onClick={() => go({ page: "pick" })}>＋ Collect Payment</button>
    <Gap />
    <div className="row" style={{ gap: 8 }}><button className="sec" style={{ flex: 1 }} onClick={() => go({ page: "mycoll" })}>My Collections{todayColl > 0 ? ` · ${money(todayColl)}` : ""}</button>
      <button className="sec" style={{ flex: 1 }} onClick={() => go({ page: "pbreport", day })}>Pending Bills Report</button></div>
    <Gap /><button className="sec block" onClick={() => go({ page: "pick", adj: true })}>↩ Goods Return / Discount</button>
    <input placeholder="🔍 Search any party…" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: "12px 0" }} />
    {!s && <Tabs items={dayTabs([-1, "All"])} cur={day} pick={setDay} />}
    <div className="card row"><div><div className="sub">{s ? "Search results (all parties)" : day < 0 ? "Pending with all my parties" : `To collect on ${DAYS[day]}`}</div><div className="big">{money(sumBy(rows, (r) => r.outstanding))}</div></div><div className="sub">{rows.length} parties</div></div>
    {rows.map((r) => <PartyCard key={r.id} r={r} go={go} showDays={day < 0 || !!s} />)}
    {!rows.length && <div className="card empty">{s ? "No party found." : day < 0 ? "No pending balances." : `No pending balances for ${DAYS[day]}.`}</div>}
    {zero.length > 0 && <><button className="sec block" style={{ marginBottom: 12 }} onClick={() => setSZ(!showZero)}>{showZero ? "Hide" : "Show"} {zero.length} {pty(zero.length)} with zero balance</button>
      {showZero && zero.map((r) => <PartyCard key={r.id} r={r} go={go} showDays={day < 0} />)}</>}
  </>;
}
function PendingReport({ db, me, flash, day0 }) {
  const isSM = me.role === "salesman";
  const [day, setDay] = useState(day0 === undefined ? "all" : day0), [smf, setSmf] = useState(""), [loc, setLoc] = useState("");
  const parties = db.parties.filter((p) => p.active && (isSM ? p.salesmanId === me.id : (!smf || p.salesmanId === +smf)) && (!loc || p.loc === loc) && (day === "all" || p.days.includes(day)))
    .map((p) => partySummary(db, p)).filter((r) => r.outstanding > 0.005).sort((a, b) => a.name.localeCompare(b.name));
  const bills = parties.flatMap((p) => partyBills(db, p.id)), bucket = (lo, hi) => sumBy(bills.filter((b) => b.age >= lo && b.age <= hi), (b) => b.pending);
  const lines = [`Salesman: ${isSM ? me.name : (smf ? db.users.find((u) => u.id === +smf)?.name : "All")}`, `Location: ${loc || "All"}   |   Day: ${day === "all" ? "All days" : DAYS[day]}`];
  return <>
    <div className="card"><h3 style={{ marginTop: 0 }}>Pending Bills Report</h3>
      {!isSM && <div className="row" style={{ gap: 8 }}><div style={{ flex: 1 }}><label style={{ marginTop: 0 }}>Salesman</label><select value={smf} onChange={(e) => setSmf(e.target.value)}><option value="">All</option><UserOpts users={salesmen(db, true)} /></select></div>
        <div style={{ flex: 1 }}><label style={{ marginTop: 0 }}>Location</label><select value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">All</option>{locOpts}</select></div></div>}
      <label>Visit day</label><Tabs items={dayTabs(["all", "All days"])} cur={day} pick={setDay} style={{ marginBottom: 0 }} /></div>
    <div className="card"><div className="sub">Total pending</div><div className="big red">{money(sumBy(bills, (b) => b.pending))}</div>
      <div className="sub">{parties.length} parties · {bills.length} bills</div>
      <div className="sub" style={{ marginTop: 6 }}>0-30 days: {money(bucket(0, 30))} · 31-60: {money(bucket(31, 60))} · 61+: {money(bucket(61, 99999))}</div>
      {parties.length > 0 && <PdfBtn label="Download / Print PDF" cls="" style={{ marginTop: 10 }} onClick={() => savePdf(`PendingBills_${day === "all" ? "All" : DAYS[day]}_${iso(new Date())}.pdf`, () => makePendingPdf(db, parties, "Gurmeet Motors - Pending Bills Report", lines), flash)} />}</div>
    <div className="card scroll"><table><thead><tr><th>Party</th><th className="n">Bills</th><th className="n">Pending</th></tr></thead><tbody>
      {parties.slice(0, 150).map((r) => <tr key={r.id}><td>{r.name}<div className="sub">{r.group}</div></td><td className="n">{r.open}</td><td className="n">{money(r.outstanding)}</td></tr>)}
      {!parties.length && <tr><td colSpan="3" className="empty">No pending bills for this selection.</td></tr>}</tbody></table>
      {parties.length > 150 && <div className="sub" style={{ padding: 8 }}>Showing first 150 – the PDF has all {parties.length}.</div>}</div>
  </>;
}

/* ================= accounts: confirm collections ================= */
function confirmEntries(db, me, items) {      // items: [{id, postDate, bankDate}]
  const m = Object.fromEntries(items.map((i) => [i.id, i])), at = new Date().toISOString();
  return {
    ...db,
    collections: db.collections.map((c) => m[c.id] ? { ...c, status: "confirmed", confirmedBy: me.id, confirmedAt: at, postDate: m[c.id].postDate, bankDate: m[c.id].bankDate || "" } : c),
    allocs: db.allocs.map((a) => m[a.collectionId] && a.status === "provisional" ? { ...a, status: "confirmed", date: m[a.collectionId].postDate } : a)
  };
}
const rejectEntry = (db, me, id, reason) => ({
  ...db,
  collections: db.collections.map((c) => c.id === id ? { ...c, status: "rejected", reason, rejectedBy: me.id, rejectedAt: new Date().toISOString() } : c),
  allocs: db.allocs.map((a) => a.collectionId === id && a.status !== "rejected" ? { ...a, status: "rejected" } : a)
});
function ConfirmCollections({ db, setDb, me, flash }) {
  const t = iso(new Date());
  const [tab, setTab] = useState("pending"), [smf, setSmf] = useState(""), [off, setOff] = useState({}), [onlyFlag, setOnlyFlag] = useState(false);
  const [dates, setDates] = useState({}), [rej, setRej] = useState(null), [reason, setReason] = useState(""), [from, setFrom] = useState(t), [to, setTo] = useState(t);
  const pname = (id) => nm(db.parties, id), sname = (id) => nm(db.users, id);
  const byTab = (st) => db.collections.filter((c) => c.status === st && (!smf || c.salesmanId === +smf));
  const flaggedN = db.collections.filter((c) => c.status === "provisional" && c.dateChanged).length;
  const dflag = (c) => (c.dateChanged || c.adminEdited) ? <div style={{ marginTop: 4 }}>
    {c.dateChanged && <><span className="pill bad">📅 Receipt date differs</span> <span className="sub">receipt dated {dmy(c.date)}, entered {dmy(c.enteredOn)} </span></>}
    {c.adminEdited && <span className="pill"> ✎ Edited by admin</span>}</div> : null;
  const dline = (c) => `Posting date ${dmy(postingDate(c))}${c.date !== postingDate(c) ? ` · Receipt date ${dmy(c.date)}` : ""}`;
  const pend = byTab("provisional").filter((c) => !onlyFlag || c.dateChanged).sort((a, b) => postingDate(a).localeCompare(postingDate(b)) || a.id - b.id);
  const adjL = pend.filter(isAdj), [cash, online, chq] = ["cash", "online", "cheque"].map((m) => pend.filter((c) => c.mode === m));
  const groups = {}; cash.forEach((c) => (groups[c.salesmanId + "|" + postingDate(c)] ??= []).push(c));
  const doConfirm = (items) => { if (!items.length) return flash("err", "Nothing selected"); setDb(confirmEntries(db, me, items)); flash("ok", `${items.length} collection(s) confirmed and posted to ledgers`); };
  const doReject = () => {
    if (!reason.trim()) return flash("err", "Please write a reason for rejecting"); const c0 = db.collections.find((x) => x.id === rej);
    if (c0.advance > 0 && (db.advAdj || []).some((a) => a.advances.some((x) => x.advRef === c0.advRef))) return flash("err", "The advance from this entry is already adjusted against a bill. Reverse that first.");
    setDb(rejectEntry(db, me, rej, reason.trim())); setRej(null); setReason(""); flash("ok", "Entry rejected / reversed – the amount is added back to the party's balance");
  };
  const rejBox = (id) => rej === id ? <div style={{ marginTop: 8 }}><input placeholder="Reason (e.g. cheque bounced, cash not received)" value={reason} onChange={(e) => setReason(e.target.value)} />
    <div className="row" style={{ marginTop: 6 }}><button className="sm danger" onClick={doReject}>Reject entry</button><a onClick={() => { setRej(null); setReason(""); }}>Cancel</a></div></div> : null;
  const rejBtn = (c, label = "Reject") => <button className="sm sec" style={BAD} onClick={() => { setRej(c.id); setReason(""); }}>{label}</button>;
  const dIn = (k, def) => <input type="date" value={dates[k] || def} onChange={(e) => setDates({ ...dates, [k]: e.target.value })} />;
  const head = (c, sub, cls = "") => <div className="row"><div><div className="name">{pname(c.partyId)}</div><div className="sub">{sub}</div></div><div className={"amt" + cls}>{money(c.amount)}</div></div>;
  const advLine = (c) => c.advance > 0 && <div className="green sub">Includes advance {money(c.advance)} ({c.advRef})</div>;
  const acts = (c, ok, label, rl) => <><div className="row" style={{ marginTop: 8 }}><button className="sm" onClick={ok}>{label}</button>{rejBtn(c, rl)}</div>{rejBox(c.id)}</>;
  const sub2 = (c) => `${sname(c.salesmanId)} · ${dline(c)}`;
  const advPill = (c) => c.advance > 0 ? <span className="pill ok" style={{ marginLeft: 6 }}>+ advance {money(c.advance)}</span> : null;
  const sms = salesmen(db, true);
  const done = db.collections.filter((c) => c.status === "confirmed" && (!smf || c.salesmanId === +smf) && postingDate(c) >= from && postingDate(c) <= to).sort((a, b) => (b.postDate || b.date).localeCompare(a.postDate || a.date) || b.id - a.id);
  const rejected = byTab("rejected").sort((a, b) => b.id - a.id);
  const advRows = db.parties.filter((p) => p.active).map((p) => ({ p, info: advanceInfo(db, p.id), bills: partyBills(db, p.id) })).filter((r) => r.info.total > 0.005 && (!smf || r.p.salesmanId === +smf));
  const planOf = (r) => {
    const cap = r2(Math.min(r.info.adjustable, sumBy(r.bills, (b) => b.pending)));
    const take = (items, key, mk) => { let c = cap; return items.flatMap((it) => { if (!(c > 0.005)) return []; const x = r2(Math.min(c, it[key])); c = r2(c - x); return [mk(it, x)]; }); };
    return { total: cap, bills: take(r.bills, "pending", (b, x) => ({ billId: b.id, no: b.no, amount: x })), advances: take(r.info.parts, "remaining", (pt, x) => ({ advRef: pt.advRef, amount: x })) };
  };
  const advReady = advRows.filter((r) => planOf(r).total > 0.005);
  const postAdv = (r) => {
    const pl = planOf(r), date = dates["adv" + r.p.id] || t, aid = uid();
    setDb({
      ...db, advAdj: [...db.advAdj, { id: aid, partyId: r.p.id, date, postedOn: t, total: pl.total, bills: pl.bills, advances: pl.advances, by: me.id, at: new Date().toISOString() }],
      allocs: [...db.allocs, ...pl.bills.map((b) => ({ id: uid(), billId: b.billId, amount: b.amount, kind: "advadj", status: "confirmed", collectionId: null, advAdjId: aid, date }))]
    });
    flash("ok", `Advance of ${money(pl.total)} adjusted against ${pl.bills.length} bill(s) – journal entry ready for Tally`);
  };
  const pickRange = (k) => { const [a, b] = rangeOf(k, t); setFrom(a); setTo(b); };
  const cardsSum = (l) => sumBy(l, (c) => c.amount);
  return <>
    <div className="row" style={{ gap: 8, marginBottom: 10 }}>
      <Tabs style={{ margin: 0, flex: 1 }} cur={tab} pick={setTab} items={[["pending", `To confirm (${db.collections.filter((c) => c.status === "provisional").length})`], ["adv", `Advances${advReady.length ? ` (${advReady.length})` : ""}`], ["done", "Confirmed"], ["rejected", "Rejected"]]} />
      <select value={smf} onChange={(e) => setSmf(e.target.value)} style={{ maxWidth: 170 }}><option value="">All salesmen</option><UserOpts users={sms} /></select></div>

    {tab === "pending" && <>
      <div className="grid" style={{ marginBottom: 12 }}>
        {[["Cash to confirm", cash, "entries"], ["Bank / UPI to confirm", online, "entries"], ["Cheques in hand", chq, "cheques"], ["Returns / discounts", adjL, "journal entries"]].map(([h, l, u]) => <Stat key={h} t={h} v={money(cardsSum(l))} s={`${l.length} ${u}`} />)}</div>
      {pend.length > 0 && <div style={{ marginBottom: 10 }}><button className="sec sm" onClick={() => { try { download(`Pending_Approvals_${iso(new Date())}.xlsx`, makeReportXlsx(buildReport(db, "approvals", { from: "", to: "", sm: smf, loc: "" }))); } catch (e) { flash("err", "Could not create Excel"); } }}>⬇ Pending approval list (Excel)</button></div>}
      {flaggedN > 0 && <div className="flash err row"><span>📅 {flaggedN} entr{flaggedN === 1 ? "y has" : "ies have"} a changed date – please check.</span>
        <label style={{ margin: 0, color: "inherit", display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" style={{ width: 20, height: 20 }} checked={onlyFlag} onChange={(e) => setOnlyFlag(e.target.checked)} />Only these</label></div>}
      {!pend.length && <div className="card empty">{onlyFlag ? "No date-changed entries." : "Everything is confirmed. 🎉"}</div>}

      {Object.keys(groups).length > 0 && <H3 m="8px 4px">Cash received by salesmen</H3>}
      {Object.entries(groups).map(([k, l]) => {
        const chosen = l.filter((c) => !off[c.id]); return <div key={k} className="card">
          <div className="row"><div><div className="name">{sname(l[0].salesmanId)}</div><div className="sub">Entered on {dmy(postingDate(l[0]))} · {l.length} entries</div></div><div className="amt">{money(cardsSum(l))}</div></div>
          {l.map((c) => <div key={c.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <div className="row"><label style={{ margin: 0, display: "flex", gap: 10, alignItems: "center", color: "var(--ink)", fontSize: 16, flex: 1 }}>
              <input type="checkbox" style={{ width: 22, height: 22 }} checked={!off[c.id]} onChange={(e) => setOff({ ...off, [c.id]: !e.target.checked })} />{pname(c.partyId)}{advPill(c)}</label>
              <b>{money(c.amount)}</b>{rejBtn(c, "Reject")}</div>
            {dflag(c)}{rejBox(c.id)}</div>)}
          <button className="block" style={{ marginTop: 8 }} onClick={() => doConfirm(chosen.map((c) => ({ id: c.id, postDate: c.date })))}>✔ Confirm cash received ({chosen.length} · {money(cardsSum(chosen))})</button></div>;
      })}

      {online.length > 0 && <H3 m="14px 4px 8px">Bank / UPI receipts</H3>}
      {online.map((c) => <div key={c.id} className="card">
        {head(c, <>{sname(c.salesmanId)} · {dline(c)} {c.ref ? ` · Ref ${c.ref}` : " · no UTR given"}{c.bank ? ` · ${c.bank}` : ""}</>)}
        {advLine(c)}{dflag(c)}
        <label>Credited in bank on (bank / credit date)</label>{dIn(c.id, c.date)}
        {acts(c, () => doConfirm([{ id: c.id, postDate: dates[c.id] || c.date, bankDate: dates[c.id] || c.date }]), "✔ Confirm receipt", "Reject")}</div>)}

      {chq.length > 0 && <H3 m="14px 4px 8px">Cheques</H3>}
      {chq.map((c) => <div key={c.id} className="card">
        {head(c, sub2(c))}
        {advLine(c)}{dflag(c)}
        <div style={{ marginTop: 6 }}>Cheque <b>{c.chequeNo}</b> dated <b>{dmy(c.chequeDate)}</b>{c.bank ? ` · ${c.bank}` : ""} {c.chequeDate > t && <span className="pill warn">Post-dated</span>}</div>
        <label>Received in bank on (date of deposit / credit)</label>{dIn(c.id, t)}
        {acts(c, () => doConfirm([{ id: c.id, postDate: dates[c.id] || t, bankDate: dates[c.id] || t }]), "✔ Accept – received in bank", "Bounced / Reject")}</div>)}

      {adjL.length > 0 && <H3 m="14px 4px 8px">Goods return / discount / other (journal entries)</H3>}
      {adjL.map((c) => <div key={c.id} className="card">
        {head(c, sub2(c), " amber")}
        <div style={{ marginTop: 6 }}><span className="pill warn">{ADJ[c.kind]}</span>{c.ref ? ` · Ref ${c.ref}` : ""}</div>
        {c.note && <div className="sub">Reason: {c.note}</div>}{dflag(c)}
        {db.allocs.filter((a) => a.collectionId === c.id).map((a) => <div key={a.id} className="sub">• {db.bills.find((b) => b.id === a.billId)?.no} — {money(a.amount)}</div>)}
        <label>Journal date</label>{dIn(c.id, c.date)}
        {acts(c, () => doConfirm([{ id: c.id, postDate: dates[c.id] || c.date }]), "✔ Confirm & post journal", "Reject")}</div>)}
    </>}

    {tab === "adv" && <>
      <p className="sub">Excess receipts are kept as advance. When a new bill exists, post a journal entry: debit the party against the advance, credit the same party against the bill. Only <b>confirmed</b> advances can be adjusted.</p>
      {!advRows.length && <div className="card empty">No advances on hand.</div>}
      {advRows.map((r) => {
        const pl = planOf(r), openT = sumBy(r.bills, (b) => b.pending), nmS = r.p.name.slice(0, 22); return <div key={r.p.id} className="card">
          <div className="row"><div><div className="name">{r.p.name}</div><div className="sub">{sname(r.p.salesmanId) || "No salesman"}</div></div><div style={{ textAlign: "right" }}><div className="sub">Advance</div><div className="amt green">{money(r.info.total)}</div></div></div>
          <div className="sub">Confirmed &amp; adjustable: {money(r.info.adjustable)} · Pending bills: {money(openT)}</div>
          {pl.total > 0.005 ? <>
            <div style={{ margin: "8px 0", fontSize: 15 }}><b>Journal entry to post ({money(pl.total)}):</b>
              {pl.advances.map((x, i) => <div key={i} className="row"><span>Dr {nmS} – against advance <b>{x.advRef}</b></span><span>{money(x.amount)}</span></div>)}
              {pl.bills.map((x, i) => <div key={i} className="row"><span>Cr {nmS} – against bill <b>{x.no}</b></span><span>{money(x.amount)}</span></div>)}</div>
            <label>Journal date</label>{dIn("adv" + r.p.id, t)}
            <button className="sm" style={{ marginTop: 8 }} onClick={() => postAdv(r)}>✔ Post advance adjustment</button></>
            : <div className="amber sub" style={{ marginTop: 6 }}>{r.info.adjustable < 0.005 ? "Advance receipt not yet confirmed – confirm it first." : "No pending bill yet – will be adjusted when a new bill arrives."}</div>}</div>;
      })}
      {db.advAdj.length > 0 && <><H3 m="14px 4px 8px">Adjustments done</H3><div className="card scroll"><table><thead><tr><th>Date</th><th>Party</th><th>Advance ref → Bills</th><th className="n">Amount</th></tr></thead><tbody>
        {[...db.advAdj].reverse().slice(0, 30).map((a) => <tr key={a.id}><td>{dmy(a.date)}</td><td>{pname(a.partyId)}</td><td className="sub">{a.advances.map((x) => x.advRef).join(", ")} → {a.bills.map((x) => x.no).join(", ")}</td><td className="n">{money(a.total)}</td></tr>)}</tbody></table></div></>}
    </>}

    {tab === "done" && <>
      <Tabs items={[["today", "Today"], ["week", "Last 7 days"], ["month", "This month"]]} pick={pickRange} />
      <div className="card row" style={{ alignItems: "flex-end" }}><div style={{ flex: 1 }}><label style={{ marginTop: 0 }}>From</label><input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></div>
        <div style={{ flex: 1 }}><label style={{ marginTop: 0 }}>To</label><input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></div></div>
      <div className="card"><div className="sub">Receipts confirmed · posting date {dmy(from)}{to !== from ? ` to ${dmy(to)}` : ""}</div><div className="big green">{money(sumAmt(done.filter((c) => !isAdj(c))))}</div>
        <div className="sub">{done.length} entries · {breakdownTxt(done)}</div></div>
      <div className="card scroll"><table><thead><tr><th>Posting date</th><th>Party / Salesman</th><th>Mode</th><th className="n">Amount</th><th></th></tr></thead><tbody>
        {done.map((c) => <tr key={c.id}><td>{dmy(postingDate(c))}<div className="sub">ledger date {dmy(c.postDate || c.date)}</div>{c.dateChanged ? <div><span className="pill bad">📅 receipt date differs</span></div> : null}</td><td>{pname(c.partyId)}{advPill(c)}<div className="sub">{sname(c.salesmanId)} · confirmed by {sname(c.confirmedBy) || "—"}</div></td>
          <td>{modeLabel(c)}{c.chequeNo ? <div className="sub">Chq {c.chequeNo} ({dmy(c.chequeDate)})</div> : null}{c.ref ? <div className="sub">{c.ref}</div> : null}</td><td className="n">{isAdj(c) ? "− " : ""}{money(c.amount)}</td>
          <td style={{ minWidth: 90 }}>{me.role === "admin" && (rej === c.id ? rejBox(c.id) : rejBtn(c, "Reverse"))}</td></tr>)}
        {!done.length && <tr><td colSpan="5" className="empty">Nothing confirmed in this period.</td></tr>}</tbody></table></div></>}

    {tab === "rejected" && (rejected.length ? rejected.map((c) => <div key={c.id} className="card"><div className="row"><div className="name">{pname(c.partyId)}</div><div className="amt red">{money(c.amount)}</div></div>
      <div className="sub">{sname(c.salesmanId)} · {modeLabel(c)} · {dline(c)}</div><div className="red sub">Reason: {c.reason}</div></div>) : <div className="card empty">No rejected entries.</div>)}
  </>;
}

/* ================= collect payment ================= */
function CollectPick({ db, me, go, adj }) {
  const [q, setQ] = useState(""), s = q.trim().toLowerCase(), td = todayDay();
  const mine = db.parties.filter((p) => p.active && p.salesmanId === me.id).map((p) => partySummary(db, p));
  const rows = (s ? mine.filter((r) => r.name.toLowerCase().includes(s)) : mine.filter((r) => r.outstanding > 0.005))
    .sort((a, b) => (b.days.includes(td) - a.days.includes(td)) || a.name.localeCompare(b.name));
  return <>
    <input autoFocus placeholder="🔍 Type party name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
    <p className="sub">{s ? "All matching parties" : "Parties with balance – today's beat first"}</p>
    {rows.map((r) => <div key={r.id} className="card tap" onClick={() => go({ page: "collect", id: r.id, adj })}>
      <div className="row"><div className="name">{r.name}</div><div className={"amt " + (r.outstanding > 0 ? "red" : "")}>{money(r.outstanding)}</div></div>
      <div className="sub">{r.group || ""}{r.days.includes(td) ? " · Today's beat" : ""}</div></div>)}
    {!rows.length && <div className="card empty">No party found.</div>}
  </>;
}
function CollectForm({ db, id, onSave, adj }) {
  const p = db.parties.find((x) => x.id === id), today = iso(new Date());
  const bills = partyBills(db, id).filter((b) => b.open > 0.005), totalOpen = sumOf(bills, (b) => b.open);
  const [amount, setAmount] = useState(""), [mode, setMode] = useState("cash"), [manual, setManual] = useState(false), [man, setMan] = useState({});
  const [chq, setChq] = useState({ no: "", date: today, bank: "" }), [ref, setRef] = useState(""), [bank, setBank] = useState(""), [note, setNote] = useState("");
  const [err, setErr] = useState(""), [review, setReview] = useState(false), [kind, setKind] = useState("return"), [slip, setSlip] = useState(""), [cdate, setCdate] = useState(today);
  const amt = num(amount);
  let left = amt; const auto = {}; bills.forEach((b) => { const a = r2(Math.min(left, b.open)); auto[b.id] = a; left = r2(left - a); });
  const alloc = manual ? Object.fromEntries(bills.map((b) => [b.id, Number(man[b.id]) || 0])) : auto;
  const allocSum = sumOf(Object.values(alloc), (v) => v), advance = adj ? 0 : Math.max(0, r2(amt - allocSum)), dateChanged = cdate !== today;
  const check = () => {
    if (!(amt > 0)) return adj ? "Enter the amount" : "Enter the amount received";
    if (!cdate || cdate > today) return "Date cannot be in the future";
    if (adj && amt > totalOpen + 0.005) return `Amount is more than the pending ${money(totalOpen)}`;
    if (manual && bills.some((b) => alloc[b.id] > b.open + 0.005)) return "A bill amount is more than its pending";
    if (manual && allocSum > amt + 0.005) return "Bill-wise amounts add up to more than the amount received";
    if (adj && kind === "other" && !note.trim()) return "Please write what this adjustment is for";
    if (!adj && mode === "cheque" && (!chq.no.trim() || !chq.date)) return "Enter cheque number and cheque date";
    return "";
  };
  const next = () => { const e = check(); setErr(e); if (!e) setReview(true); };
  const detail = adj ? (slip ? `Ref ${slip}` : "") : mode === "cheque" ? `Cheque ${chq.no}${chq.bank ? ` · ${chq.bank}` : ""} · dated ${dmy(chq.date)}` : mode === "online" ? `${ref ? "Ref " + ref : ""}${bank ? (ref ? " · " : "") + bank : ""}` : "";
  const lines = bills.filter((b) => alloc[b.id] > 0), isChq = !adj && mode === "cheque", advTot = advanceInfo(db, id).total;
  if (review) return <>
    <div className="card"><div className="sub">Please check before saving</div><div className="name">{p.name}</div>
      <div className={"big " + (adj ? "amber" : "green")}>{money(amt)}</div><div>{adj ? ADJ[kind] : MODES[mode]}{detail ? ` · ${detail}` : ""}</div>
      <div className="sub">Receipt date: {dmy(cdate)} · Posting date: {dmy(today)}</div>
      {dateChanged && <div className="amber">📅 Date changed from today – accounts will see this flagged.</div>}
      {note && <div className="sub">Note: {note}</div>}</div>
    <div className="card"><div className="sub" style={{ marginBottom: 6 }}>Against bills</div>
      {lines.map((b) => <div key={b.id} className="row"><span>{b.no} <span className="sub">({dmy(b.date)})</span></span><b>{money(alloc[b.id])}</b></div>)}
      {!lines.length && <div className="sub">No pending bill</div>}
      {advance > 0 && <div className="row" style={{ marginTop: 6 }}><span className="amber">Advance (excess) – to be adjusted against future bills</span><b className="amber">{money(advance)}</b></div>}</div>
    <p className="sub">Your balance reduces as soon as you save.{adj ? " Accounts will post it as a journal entry." : ""} Once saved, a change needs admin approval. The accounts department later confirms the entry for posting to the ledger.</p>
    <button className="block" onClick={() => onSave({ partyId: id, mode: adj ? "adjust" : mode, kind: adj ? kind : "receipt", amount: amt, advance, date: cdate, dateChanged, chequeNo: isChq ? chq.no.trim() : "", chequeDate: isChq ? chq.date : "", bank: adj ? "" : mode === "cheque" ? chq.bank : bank, ref: adj ? slip.trim() : mode === "online" ? ref.trim() : "", note }, lines.map((b) => ({ billId: b.id, amount: alloc[b.id] })))}>✔ Confirm &amp; Save</button>
    <Gap /><button className="sec block" onClick={() => setReview(false)}>‹ Change</button>
  </>;
  const choice = (map, cur, set, pad) => <div className="row" style={{ gap: 6 }}>{Object.entries(map).map(([k, v]) => <button key={k} className={cur === k ? "" : "sec"} style={{ flex: 1, padding: pad, ...(adj ? { fontSize: 15 } : {}) }} onClick={() => set(k)}>{v}</button>)}</div>;
  return <>
    <div className="card row"><div><div className="sub">Total pending</div><div className="amt red">{money(totalOpen)}</div>{advTot > 0 && <div className="sub green">Advance already with us: {money(advTot)}</div>}</div>
      {totalOpen > 0 && <button className="sec sm" onClick={() => setAmount(String(totalOpen))}>Full amount</button>}</div>
    {adj && !bills.length ? <div className="card empty">Nothing pending – there is no bill to reduce.</div> : <>
      <div className="card"><label style={{ marginTop: 0 }}>{adj ? "Amount to reduce (₹)" : "Amount received (₹)"}</label>
        <input type="number" inputMode="decimal" style={{ fontSize: 28, fontWeight: 700 }} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        {advance > 0 && <div className="flash" style={{ background: "#fff3e0", color: "var(--warn)", margin: "8px 0 0" }}>{money(advance)} is more than the bills selected – it will be kept as <b>ADVANCE</b> for this party.</div>}
        <label>Receipt date {adj ? "(date of return / discount)" : "(date money was received)"}</label><input type="date" value={cdate} max={today} onChange={(e) => e.target.value && setCdate(e.target.value)} />
        <div className="sub" style={{ marginTop: 4 }}>Posting date: <b>{dmy(today)}</b> (today – fixed, cannot be changed)</div>
        {dateChanged && <div className="amber sub">📅 Receipt date is not today – accounts will see this entry flagged for checking.</div>}
        {adj ? <><label>Type of adjustment</label>{choice(ADJ, kind, setKind, "12px 4px")}
          <label>{kind === "return" ? "Return slip / credit note no. (optional)" : "Reference (optional)"}</label><input value={slip} onChange={(e) => setSlip(e.target.value)} /></> : <>
          <label>Received as</label>{choice(MODES, mode, setMode, "12px 4px")}
          {mode === "cheque" && <><label>Cheque number</label><input inputMode="numeric" value={chq.no} onChange={(e) => setChq({ ...chq, no: e.target.value })} />
            <label>Cheque date (post-dated? enter the date on cheque)</label><input type="date" value={chq.date} onChange={(e) => setChq({ ...chq, date: e.target.value })} />
            <label>Bank (optional)</label><input value={chq.bank} onChange={(e) => setChq({ ...chq, bank: e.target.value })} /></>}
          {mode === "online" && <><label>UTR / Reference number (optional)</label><input value={ref} onChange={(e) => setRef(e.target.value)} />
            <label>Bank (optional)</label><input value={bank} onChange={(e) => setBank(e.target.value)} /></>}
        </>}
        <label>{adj && kind === "other" ? "What is this for? (required)" : adj ? "Reason (optional)" : "Note (optional)"}</label><input value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {bills.length > 0 && <div className="card"><div className="row"><b>{adj ? "Reduce which bills?" : "Against which bills?"}</b><a onClick={() => { setManual(!manual); setMan(manual ? {} : { ...auto }); }}>{manual ? "Auto (oldest first)" : "Choose bills myself"}</a></div>
        {bills.map((b) => <div key={b.id} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
          <div><div>{b.no}</div><div className="sub">{dmy(b.date)} · pending {money(b.open)}</div></div>
          {manual ? <input type="number" inputMode="decimal" style={{ width: 120 }} value={man[b.id] ?? ""} onChange={(e) => setMan({ ...man, [b.id]: e.target.value })} /> : <b className={auto[b.id] > 0 ? "green" : "sub"}>{auto[b.id] > 0 ? money(auto[b.id]) : "—"}</b>}</div>)}</div>}
      {!bills.length && !adj && <div className="card sub">No pending bill – the full amount will be kept as advance.</div>}
      {err && <div className="flash err">{err}</div>}
      <button className="block" style={{ fontSize: 19, padding: 15 }} onClick={next}>Review &amp; Save ›</button></>}
  </>;
}
function CollectDone({ db, cid, go, home }) {
  const c = db.collections.find((x) => x.id === cid), p = db.parties.find((x) => x.id === c.partyId), aj = isAdj(c);
  return <>
    <div className="card" style={{ textAlign: "center" }}><div style={{ fontSize: 46 }}>✅</div><div className="name">{aj ? ADJ[c.kind] + " saved" : "Collection saved"}</div>
      <div className={"big " + (aj ? "amber" : "green")}>{money(c.amount)}</div><div>{p.name}</div><div className="sub">{modeLabel(c)} · Receipt date {dmy(c.date)}</div><div className="sub">Posting date {dmy(postingDate(c))}</div>
      {c.advance > 0 && <p className="amber">{money(c.advance)} kept as advance ({c.advRef}) – it will be adjusted against the party's next bills.</p>}
      {c.dateChanged && <p className="amber sub">📅 Receipt date is not today – flagged for accounts.</p>}
      <p className="green">Balance updated. Accounts will confirm &amp; post it{aj ? " as a journal entry" : " to the ledger"}.</p></div>
    <button className="block" onClick={() => go({ page: "pick", adj: aj })}>{aj ? "＋ Another return / discount" : "＋ Collect from another party"}</button><Gap />
    <button className="sec block" onClick={home}>Back to home</button>
  </>;
}
function makeCollectionPdf(me, list, from, to, partyName) {
  const doc = new PDF.jsPDF(); doc.setFontSize(16); doc.text("Gurmeet Motors - Collection Report", 14, 16); doc.setFontSize(10);
  doc.text(`Salesman: ${me.name}`, 14, 24); doc.text(`Period: ${dmy(from)}${to !== from ? " to " + dmy(to) : ""}`, 14, 30); doc.text(`Generated: ${now()}`, 14, 36);
  const rc = list.filter((c) => !isAdj(c)), ad = list.filter(isAdj), row = (v, l, sfx = "") => [v + sfx, l.length, rsf(sumAmt(l))];
  PDF.autoTable(doc, {
    ...AT, styles: { fontSize: 9 }, startY: 42, head: [["Type", "Entries", "Amount"]],
    body: [...Object.entries(MODES).map(([k, v]) => row(v, rc.filter((c) => c.mode === k))), row("Total collected", rc),
    ...Object.entries(ADJ).filter(([k]) => ad.some((c) => c.kind === k)).map(([k, v]) => row(v, ad.filter((c) => c.kind === k), " (adjustment)"))],
    columnStyles: right(1, 2), didParseCell: (d) => { if (d.row.index === 3 && d.section === "body") d.cell.styles.fontStyle = "bold"; }
  });
  PDF.autoTable(doc, {
    ...AT, startY: doc.lastAutoTable.finalY + 8, head: [["Posting date", "Receipt date", "Party", "Mode", "Details", "Status", "Amount"]],
    body: list.map((c) => [dmy(postingDate(c)), dmy(c.date), partyName(c.partyId), modeLabel(c), c.chequeNo ? `Chq ${c.chequeNo} (${dmy(c.chequeDate)})` : (c.ref || ""), c.status === "confirmed" ? "Posted" : "Not yet posted", rsf(c.amount)]),
    foot: [["", "", "", "", "", "Total collected", rsf(sumAmt(rc))]], columnStyles: right(6)
  });
  return doc.output("blob");
}
function MyCollections({ db, me, go, flash }) {
  const t = iso(new Date());
  const [from, setFrom] = useState(t), [to, setTo] = useState(t), [preset, setPreset] = useState("today");
  const pick = (k) => { setPreset(k); if (k !== "custom") { const [a, b] = rangeOf(k, t); setFrom(a); setTo(b); } };
  const list = db.collections.filter((c) => c.salesmanId === me.id && postingDate(c) >= from && postingDate(c) <= to).sort((a, b) => postingDate(b).localeCompare(postingDate(a)) || b.id - a.id);
  const valid = list.filter((c) => c.status !== "rejected"), receipts = valid.filter((c) => !isAdj(c));
  const pname = (id) => nm(db.parties, id), days = [...new Set(list.map(postingDate))];
  const pdf = () => savePdf(`Collections_${me.username}_${from}${to !== from ? "_to_" + to : ""}.pdf`, () => makeCollectionPdf(me, valid, from, to, pname), flash);
  return <>
    <Tabs cur={preset} pick={pick} items={[["today", "Today"], ["yest", "Yesterday"], ["week", "Last 7 days"], ["month", "This month"], ["custom", "Choose dates"]]} />
    {preset === "custom" && <div className="card row" style={{ alignItems: "flex-end" }}>
      <div style={{ flex: 1 }}><label style={{ marginTop: 0 }}>From</label><input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></div>
      <div style={{ flex: 1 }}><label style={{ marginTop: 0 }}>To</label><input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></div></div>}
    <div className="card"><div className="sub">Cash / cheque / bank collected · posting date {dmy(from)}{to !== from ? ` to ${dmy(to)}` : ""}</div><div className="big green">{money(sumAmt(receipts))}</div>
      <div className="sub">{receipts.length} receipt(s) · {breakdownTxt(valid)}</div>
      {list.length > 0 && <button className="sec sm" style={{ marginTop: 10 }} onClick={pdf}>⬇ Download PDF</button>}</div>
    {days.map((d) => {
      const ofDay = valid.filter((c) => postingDate(c) === d), adjD = ofDay.filter(isAdj); return <div key={d}>
        <div className="row sub" style={{ margin: "10px 4px 6px" }}><b>{dmy(d)}{d === t ? " (Today)" : ""}</b><b>{money(sumAmt(ofDay.filter((c) => !isAdj(c))))}{adjD.length ? ` + adj ${money(sumAmt(adjD))}` : ""}</b></div>
        {list.filter((c) => postingDate(c) === d).map((c) => <div key={c.id} className="card tap" onClick={() => go({ page: "ledger", id: c.partyId })}>
          <div className="row"><div className="name">{pname(c.partyId)}</div><div className={"amt " + (isAdj(c) ? "amber" : "green")}>{isAdj(c) ? "− " : ""}{money(c.amount)}</div></div>
          <div className="row sub"><span>{modeLabel(c)}{c.chequeNo ? ` · chq ${c.chequeNo} (${dmy(c.chequeDate)})` : ""}{c.ref ? ` · ${c.ref}` : ""}{isAdj(c) && c.note ? ` · ${c.note}` : ""}{c.advance > 0 ? ` · advance ${money(c.advance)}` : ""}{c.dateChanged ? ` · 📅 receipt dated ${dmy(c.date)}` : ""}</span>
            <span className={"pill " + (c.status === "confirmed" ? "ok" : c.status === "rejected" ? "bad" : "warn")}>{c.status === "confirmed" ? "Posted" : c.status === "rejected" ? "Rejected" : "Not yet posted"}</span></div>
          {c.status === "rejected" && <div className="red sub">Rejected by accounts: {c.reason || "no reason given"} – amount added back to balance</div>}
          {c.adminEdited && <div style={{ marginTop: 4 }}><span className="pill">✎ Corrected by admin</span></div>}
          <div className="sub" style={{ marginTop: 4 }}>Tap to open ledger ›</div></div>)}</div>;
    })}
    {!list.length && <div className="card empty">No collections in this period.</div>}
  </>;
}

/* ================= party / bill / ledger views ================= */
function PartyView({ db, id, go, canCollect, flash }) {
  const p = db.parties.find((x) => x.id === id), sm = db.users.find((u) => u.id === p.salesmanId);
  const bills = partyBills(db, id), total = sumBy(bills, (b) => b.pending), adv = advanceInfo(db, id).total;
  return <>
    <div className="card"><div className="sub">Total outstanding</div><div className={"big " + (total > 0 ? "red" : "")}>{money(total)}</div>
      {adv > 0 && <div className="green" style={{ marginTop: 4 }}>Advance on account: <b>{money(adv)}</b> – will be adjusted against new bills</div>}
      <div className="sub" style={{ marginTop: 6 }}>{p.loc}{p.group ? ` · ${p.group}` : ""}{sm ? ` · ${sm.name}` : ""} · {daysTxt(p.days)}{p.phone ? ` · ${p.phone}` : ""}</div></div>
    {canCollect && <button className="block" style={{ fontSize: 20, padding: 16, marginBottom: 8 }} onClick={() => go({ page: "collect", id })}>＋ Collect Payment</button>}
    {canCollect && <button className="sec block" style={{ marginBottom: 8 }} onClick={() => go({ page: "collect", id, adj: true })}>↩ Goods Return / Discount</button>}
    <h3 style={{ margin: "16px 4px 8px" }}>Pending bills</h3>
    {bills.map((b) => <div key={b.id} className="card tap" onClick={() => go({ page: "bill", id: b.id })}>
      <div className="row"><div className="name">{b.no}</div><div className="amt">{money(b.pending)}</div></div>
      <div className="row sub"><span>{dmy(b.date)}{b.pending !== b.amount ? ` · bill ${money(b.amount)}` : ""}</span><span className={"pill " + ageCls(b.age)}>{b.age} days</span></div>
    </div>)}
    {!bills.length && <div className="card empty">No pending bills. All clear 👍</div>}
    <button className="sec block" onClick={() => go({ page: "ledger", id })}>View Ledger</button>
    {bills.length > 0 && <><Gap /><button className="sec block" onClick={() => savePdf(`PendingBills_${safeName(p.name)}.pdf`, () => makePendingPdf(db, [p], "Gurmeet Motors - Pending Bills", [`Party: ${p.name}`]), flash)}>⬇ Pending bills PDF</button></>}
  </>;
}
function BillView({ db, id }) {
  const b = billCalc(db, db.bills.find((b) => b.id === id)), p = db.parties.find((x) => x.id === b.partyId);
  const rec = db.allocs.filter((a) => a.billId === id && a.status !== "rejected").map((a) => ({ ...a, c: db.collections.find((c) => c.id === a.collectionId) }))
    .sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id);
  const got = sumBy(rec, (r) => r.amount);
  return <>
    <div className="card"><div className="name">{p.name}</div>
      <div className="sub">{b.source === "opening" ? "Opening balance" : "Sales bill"} · Bill date {dmy(b.date)}{b.due ? ` · Due ${dmy(b.due)}` : ""} · {b.age} days old</div>
      <div className="row" style={{ marginTop: 10 }}><div><div className="sub">Bill amount</div><div className="amt">{money(b.amount)}</div></div>
        <div style={{ textAlign: "center" }}><div className="sub">Received / adjusted</div><div className="amt green">{money(got)}</div></div>
        <div style={{ textAlign: "right" }}><div className="sub">Pending</div><div className="amt red">{money(b.pending)}</div></div></div></div>
    <h3 style={{ margin: "16px 4px 8px" }}>Receipts &amp; adjustments against this bill</h3>
    <div className="card scroll">{rec.length ? <table><thead><tr><th>Date</th><th>Mode</th><th className="n">Amount</th></tr></thead><tbody>
      {rec.map((r) => <tr key={r.id}><td>{dmy(r.date)}</td>
        <td>{r.kind === "advadj" ? "Advance adjusted (journal)" : r.c ? modeLabel(r.c) : "Receipt"}{r.c?.chequeNo ? <div className="sub">Chq {r.c.chequeNo} · {dmy(r.c.chequeDate)}</div> : null}{r.c?.ref ? <div className="sub">{r.c.ref}</div> : null}
          <div className="sub">{r.status === "confirmed" ? "Posted" : "Not yet posted"}</div></td>
        <td className="n">{money(r.amount)}</td></tr>)}
      <tr><td colSpan="2"><b>Total received</b></td><td className="n"><b>{money(got)}</b></td></tr></tbody></table>
      : <div className="empty">No receipts yet against this bill.</div>}</div>
  </>;
}
function Ledger({ db, id, flash, me, setDb }) {
  const p = db.parties.find((x) => x.id === id), { rows: e, bal } = ledgerRows(db, id), isAdmin = me?.role === "admin", [ed, setEd] = useState(null);
  const close = () => setEd(null), ctx = { db, me, setDb, flash, onDone: close };
  const panel = !ed ? null : ed.t === "bill" ? <BillEditor key={"b" + ed.id} {...ctx} partyId={id} bill={ed.id === "new" ? null : db.bills.find((b) => b.id === ed.id)} />
    : ed.t === "coll" ? <CollEditor key={"c" + ed.id} {...ctx} c={db.collections.find((c) => c.id === ed.id)} />
      : <AdvAdjEditor key={"a" + ed.id} {...ctx} a={db.advAdj.find((x) => x.id === ed.id)} />;
  const hist = (db.audit || []).filter((x) => x.partyId === id).reverse();
  return <>
    <div className="card"><div className="name">{p.name}</div><div className="sub">Closing balance</div><div className={"big " + (bal > 0 ? "red" : "")}>{money(Math.abs(bal))} {bal > 0 ? "Dr" : bal < 0 ? "Cr" : ""}</div>
      <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <PdfBtn label="Print / Download Ledger PDF" onClick={() => savePdf(`Ledger_${safeName(p.name)}.pdf`, () => makeLedgerPdf(db, p), flash)} />
        {isAdmin && <button className="sm" onClick={() => setEd({ t: "bill", id: "new" })}>＋ Add bill</button>}</div>
      {isAdmin && <div className="sub" style={{ marginTop: 6 }}>Admin: tap ✎ on any line to correct the bill or the receipt.</div>}</div>
    {panel}
    <div className="card scroll"><table><thead><tr><th>Date</th><th>Particulars</th><th className="n">Debit</th><th className="n">Credit</th><th className="n">Balance</th>{isAdmin && <th></th>}</tr></thead><tbody>
      {e.map((r, i) => <tr key={i}><td>{dmy(r.date)}</td><td>{r.kind}<div className="sub">{r.ref}</div></td><td className="n">{r.dr ? money(r.dr) : ""}</td><td className="n">{r.cr ? money(r.cr) : ""}</td><td className="n">{money(r.bal)}</td>
        {isAdmin && <td>{r.t && r.eid ? <a style={{ fontSize: 20 }} onClick={() => setEd({ t: r.t, id: r.eid })}>✎</a> : null}</td>}</tr>)}
      {!e.length && <tr><td colSpan={isAdmin ? 6 : 5} className="empty">No entries yet.</td></tr>}</tbody></table></div>
    <p className="sub">Receipts marked "not yet posted" are collected by the salesman and awaiting accounts confirmation.</p>
    {isAdmin && hist.length > 0 && <div className="card"><b>Changes made to this ledger</b>{hist.slice(0, 15).map((h) => <div key={h.id} className="sub" style={{ marginTop: 6 }}>{dt(h.at)} · {h.entity} {h.ref}: {h.changes.map((c) => `${c.field}${c.from ? " " + c.from : ""}${c.to ? " → " + c.to : ""}`).join("; ")}</div>)}</div>}
  </>;
}

/* ================= admin: edit anything from the ledger ================= */
const addAudit = (db, me, e) => ({ ...db, audit: [...(db.audit || []), { id: uid(), at: new Date().toISOString(), by: me.id, ...e }] });
const diffOf = (o, n, fields) => fields.filter(([k]) => String(o[k] ?? "") !== String(n[k] ?? "")).map(([k, label, fmt]) => ({ field: label, from: (fmt || String)(o[k] ?? ""), to: (fmt || String)(n[k] ?? "") }));
const mMoney = (v) => v === "" ? "" : money(v), mDate = (v) => v ? dmy(v) : "";
const Editor = ({ children }) => <div className="card" style={{ border: "2px solid var(--brand)" }}>{children}</div>;
const Half = ({ label, children }) => <div style={{ flex: 1 }}><label>{label}</label>{children}</div>;

function BillEditor({ db, me, setDb, partyId, bill, onDone, flash }) {
  const allocated = bill ? sumOf(db.allocs.filter((a) => a.billId === bill.id && a.status !== "rejected"), (a) => a.amount) : 0;
  const [f, setF] = useState({ no: bill?.no || "", date: bill?.date || iso(new Date()), due: bill?.due || "", amount: bill ? String(bill.amount) : "" }), [del, setDel] = useState(false);
  const set = (k, v) => setF({ ...f, [k]: v }), bf = bind(f, set);
  const log = (nd, changes, ref) => setDb(addAudit(nd, me, { entity: "Bill", ref, partyId, changes }));
  const save = () => {
    const no = f.no.trim(), amt = num(f.amount);
    if (!no) return flash("err", "Bill number is required"); if (!f.date) return flash("err", "Bill date is required"); if (!(amt > 0)) return flash("err", "Enter the bill amount");
    if (db.bills.some((b) => b.partyId === partyId && b.no === no && b.id !== bill?.id)) return flash("err", "This party already has a bill with that number");
    if (amt < allocated - 0.005) return flash("err", `Receipts / adjustments of ${money(allocated)} are already applied to this bill – amount cannot be lower than that`);
    const nb = { ...(bill || { id: uid(), partyId, source: "manual", imported_at: null }), no, date: f.date, due: f.due || addDays(f.date, 30), amount: amt };
    if (bill) {
      const ch = diffOf(bill, nb, [["no", "Bill number"], ["date", "Bill date", mDate], ["due", "Due date", mDate], ["amount", "Bill amount", mMoney]]); if (!ch.length) return onDone();
      log({ ...db, bills: db.bills.map((b) => b.id === bill.id ? nb : b) }, ch, no);
    }
    else log({ ...db, bills: [...db.bills, nb] }, [{ field: "Bill added", from: "", to: `${no} · ${dmy(f.date)} · ${money(amt)}` }], no);
    flash("ok", "Bill saved"); onDone();
  };
  const remove = () => {
    if (allocated > 0.005) return flash("err", "Receipts are applied to this bill – reverse them first"); if (!del) { setDel(true); flash("err", "Tap 'Delete bill' once more to confirm"); return; }
    log({ ...db, bills: db.bills.filter((b) => b.id !== bill.id) }, [{ field: "Bill deleted", from: `${bill.no} · ${money(bill.amount)}`, to: "" }], bill.no); flash("ok", "Bill deleted"); onDone();
  };
  return <Editor><b>{bill ? "✎ Edit bill" : "＋ Add bill"}</b>
    <label>Bill number</label><input {...bf("no")} />
    <div className="row" style={{ gap: 8 }}><Half label="Bill date"><input type="date" {...bf("date")} /></Half><Half label="Due date"><input type="date" {...bf("due")} /></Half></div>
    <label>Bill amount (₹)</label><input type="number" inputMode="decimal" {...bf("amount")} />
    {bill && <div className="sub" style={{ marginTop: 6 }}>Already applied against this bill: {money(allocated)}</div>}
    <div className="row" style={{ marginTop: 12, justifyContent: "flex-start", gap: 10 }}><button className="sm" onClick={save}>Save</button><button className="sm sec" onClick={onDone}>Cancel</button>
      {bill && <button className="sm sec" style={{ ...BAD, marginLeft: "auto" }} onClick={remove}>Delete bill</button>}</div></Editor>;
}

function CollEditor({ db, me, setDb, c, onDone, flash }) {
  const adj = isAdj(c), own = (bid) => sumBy(db.allocs.filter((a) => a.collectionId === c.id && a.billId === bid && a.status !== "rejected"), (a) => a.amount);
  const bills = partyBills(db, c.partyId, false).map((b) => ({ ...b, own: own(b.id), open: r2(b.open + own(b.id)) })).filter((b) => b.open > 0.005 || b.own > 0);
  const [f, setF] = useState({ amount: String(c.amount), date: c.date, mode: adj ? "cash" : c.mode, kind: adj ? c.kind : "return", ref: c.ref || "", chqNo: c.chequeNo || "", chqDate: c.chequeDate || "", bank: c.bank || "", note: c.note || "", postDate: c.postDate || c.date });
  const [man, setMan] = useState(Object.fromEntries(bills.map((b) => [b.id, b.own ? String(b.own) : ""]))), [rj, setRj] = useState(false), [reason, setReason] = useState("");
  const set = (k, v) => setF({ ...f, [k]: v }), bf = bind(f, set), mv = (b) => Number(man[b.id]) || 0;
  const amt = num(f.amount), allocSum = sumOf(bills, mv), advance = adj ? 0 : Math.max(0, r2(amt - allocSum));
  const usedAdv = c.advRef ? sumBy(db.advAdj || [], (a) => sumBy(a.advances.filter((x) => x.advRef === c.advRef), (x) => x.amount)) : 0;
  const confirmed = c.status === "confirmed", ent = adj ? ADJ[c.kind] : "Receipt";
  const save = () => {
    if (!(amt > 0)) return flash("err", "Enter the amount"); if (!f.date) return flash("err", "Enter the date");
    if (bills.some((b) => mv(b) > b.open + 0.005)) return flash("err", "A bill-wise amount is more than that bill's pending");
    if (allocSum > amt + 0.005) return flash("err", "Bill-wise amounts add up to more than the amount");
    if (adj && Math.abs(allocSum - amt) > 0.005) return flash("err", "For returns / discounts the full amount must be applied to bills");
    if (advance < usedAdv - 0.005) return flash("err", `${money(usedAdv)} of this entry's advance is already adjusted against bills – reverse that adjustment first`);
    if (!adj && f.mode === "cheque" && !f.chqNo.trim()) return flash("err", "Enter the cheque number");
    const mode = adj ? "adjust" : f.mode, kind = adj ? f.kind : "receipt", isChq = !adj && mode === "cheque"; let sq = db.advSeq || 0, advRef = c.advRef || "";
    if (advance > 0 && !advRef) { sq++; advRef = "ADV-" + String(sq).padStart(4, "0"); } if (!(advance > 0) && usedAdv < 0.005) advRef = "";
    const pd = confirmed ? f.postDate : c.postDate;
    const nc = { ...c, amount: amt, advance, advRef, date: f.date, dateChanged: f.date !== c.enteredOn, mode, kind, ref: f.ref.trim(), chequeNo: isChq ? f.chqNo.trim() : "", chequeDate: isChq ? f.chqDate : "", bank: f.bank.trim(), note: f.note.trim(), postDate: pd, bankDate: confirmed && (mode === "cheque" || mode === "online") ? pd : c.bankDate, adminEdited: true };
    const lines = bills.filter((b) => mv(b) > 0).map((b) => ({ billId: b.id, amount: r2(Number(man[b.id])) }));
    const txt = (ls) => ls.map((l) => `${db.bills.find((b) => b.id === l.billId)?.no}: ${money(l.amount)}`).join(", ") || "—";
    const oldLines = db.allocs.filter((a) => a.collectionId === c.id && a.status !== "rejected").map((a) => ({ billId: a.billId, amount: a.amount }));
    const ch = [...diffOf(c, nc, [["amount", "Amount", mMoney], ["date", "Receipt date", mDate], ["mode", "Mode", (v) => MODES[v] || ADJ[kind] || v], ["kind", "Type", (v) => ADJ[v] || "Receipt"], ["ref", "UTR / Ref"], ["chequeNo", "Cheque no."], ["chequeDate", "Cheque date", mDate], ["bank", "Bank"], ["note", "Note"], ["postDate", "Bank / credit date", mDate], ["advance", "Advance", mMoney]]),
    ...(txt(oldLines) !== txt(lines) ? [{ field: "Bill-wise split", from: txt(oldLines), to: txt(lines) }] : [])];
    if (!ch.length) return onDone();
    const st = confirmed ? "confirmed" : "provisional", ad = confirmed ? pd : f.date;
    const nd = {
      ...db, advSeq: sq, collections: db.collections.map((x) => x.id === c.id ? nc : x),
      allocs: [...db.allocs.filter((a) => !(a.collectionId === c.id && a.status !== "rejected")), ...lines.map((l) => ({ id: uid(), billId: l.billId, amount: l.amount, kind, status: st, collectionId: c.id, date: ad }))]
    };
    setDb(addAudit(nd, me, { entity: ent, ref: c.advRef || modeLabel(c), partyId: c.partyId, changes: ch, status: c.status })); flash("ok", "Entry updated"); onDone();
  };
  const reverse = () => {
    if (!reason.trim()) return flash("err", "Write the reason for reversing");
    if (usedAdv > 0.005) return flash("err", "The advance from this entry is already adjusted against a bill. Reverse that first.");
    setDb(addAudit(rejectEntry(db, me, c.id, reason.trim()), me, { entity: ent, ref: modeLabel(c), partyId: c.partyId, changes: [{ field: "Entry reversed", from: `${money(c.amount)} on ${dmy(c.date)}`, to: reason.trim() }] })); flash("ok", "Entry reversed"); onDone();
  };
  const opts = (map) => Object.entries(map).map(([k, v]) => <option key={k} value={k}>{v}</option>);
  return <Editor>
    <b>✎ Edit {adj ? ADJ[c.kind] : "receipt"}</b> <span className={"pill " + (confirmed ? "ok" : "warn")}>{confirmed ? "Posted" : "Not yet posted"}</span>
    <div className="sub">Entered by {nm(db.users, c.salesmanId)} · {c.advRef || ""}</div>
    <div className="sub">Posting date (fixed): <b>{dmy(postingDate(c))}</b></div>
    <div className="row" style={{ gap: 8 }}><Half label="Amount (₹)"><input type="number" inputMode="decimal" {...bf("amount")} /></Half><Half label="Receipt date"><input type="date" {...bf("date")} /></Half></div>
    {adj ? <><label>Type</label><select {...bf("kind")}>{opts(ADJ)}</select></> : <><label>Mode of receipt</label><select {...bf("mode")}>{opts(MODES)}</select></>}
    {!adj && f.mode === "cheque" && <div className="row" style={{ gap: 8 }}><Half label="Cheque no."><input {...bf("chqNo")} /></Half><Half label="Cheque date"><input type="date" {...bf("chqDate")} /></Half></div>}
    <label>{adj ? "Reference / return slip" : "UTR / Reference no."}</label><input {...bf("ref")} />
    <label>Bank</label><input {...bf("bank")} />
    {confirmed && <><label>Bank / credit date (ledger date)</label><input type="date" {...bf("postDate")} /></>}
    <label>Note</label><input {...bf("note")} />
    <label>Applied against bills</label>
    {bills.map((b) => <div key={b.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}><div><div>{b.no}</div><div className="sub">{dmy(b.date)} · can take up to {money(b.open)}</div></div>
      <input type="number" inputMode="decimal" style={{ width: 120 }} value={man[b.id]} onChange={(e) => setMan({ ...man, [b.id]: e.target.value })} /></div>)}
    {!adj && advance > 0 && <div className="amber sub" style={{ marginTop: 6 }}>{money(advance)} will be kept as advance</div>}
    <div className="row" style={{ marginTop: 12, justifyContent: "flex-start", gap: 10 }}><button className="sm" onClick={save}>Save changes</button><button className="sm sec" onClick={onDone}>Cancel</button>
      <button className="sm sec" style={{ ...BAD, marginLeft: "auto" }} onClick={() => setRj(!rj)}>Reverse entry</button></div>
    {rj && <div style={{ marginTop: 8 }}><input placeholder="Reason for reversing" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="sm danger" style={{ marginTop: 6 }} onClick={reverse}>Confirm reverse</button></div>}
  </Editor>;
}
function AdvAdjEditor({ db, me, setDb, a, onDone, flash }) {
  const [ok, setOk] = useState(false), refs = a.advances.map((x) => x.advRef).join(", "), bnos = a.bills.map((b) => b.no).join(", ");
  const undo = () => {
    if (!ok) { setOk(true); flash("err", "Tap 'Reverse adjustment' once more to confirm"); return; }
    setDb(addAudit({ ...db, tombstones: a.exp ? [...db.tombstones, { id: a.id, type: "a", date: a.date, ref: "GMCM-J-" + String(a.id).slice(-8) }] : db.tombstones, advAdj: db.advAdj.filter((x) => x.id !== a.id), allocs: db.allocs.filter((x) => x.advAdjId !== a.id) }, me,
      { entity: "Advance adjustment", ref: refs, partyId: a.partyId, changes: [{ field: "Adjustment reversed", from: `${money(a.total)} against ${bnos}`, to: "" }] })); flash("ok", "Adjustment reversed – the advance is available again"); onDone();
  };
  return <Editor><b>Journal: advance adjustment</b>
    <div className="sub">{dmy(a.date)} · {money(a.total)} · {refs} → {bnos}</div>
    <div className="row" style={{ marginTop: 10, justifyContent: "flex-start", gap: 10 }}><button className="sm sec" style={BAD} onClick={undo}>Reverse adjustment</button><button className="sm sec" onClick={onDone}>Close</button></div></Editor>;
}
function AuditLog({ db }) {
  const rows = [...(db.audit || [])].reverse().slice(0, 300);
  return <div className="card scroll"><h3 style={{ marginTop: 0 }}>Change history</h3><table><thead><tr><th>When / who</th><th>What</th><th>Changes</th></tr></thead><tbody>
    {rows.map((r) => <tr key={r.id}><td>{dt(r.at)}<div className="sub">{nm(db.users, r.by)}</div></td><td>{r.entity} <b>{r.ref}</b><div className="sub">{nm(db.parties, r.partyId)}</div></td>
      <td>{r.changes.map((c, i) => <div key={i} className="sub"><b>{c.field}:</b> {c.from ? <s>{c.from}</s> : null}{c.from && c.to ? " → " : ""}{c.to}</div>)}</td></tr>)}
    {!rows.length && <tr><td colSpan="3" className="empty">No changes made yet.</td></tr>}</tbody></table></div>;
}

/* ================= Tally XML export ================= */
const xe = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const tdate = (d) => String(d).replace(/-/g, "");
const tamt = (v) => r2(v).toFixed(2);
const guidOf = (k, id) => "6d636d00-0000-4000-8000-" + k.charCodeAt(0).toString(16).padStart(2, "0") + Number(id).toString(16).padStart(10, "0").slice(-10);
const refOf = (k, id) => "GMCM-" + k + "-" + String(id).slice(-8);
const leXml = (name, pos, amt, inner = "", party = false) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xe(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${pos ? "Yes" : "No"}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>${party ? "Yes" : "No"}</ISPARTYLEDGER><AMOUNT>${tamt(amt)}</AMOUNT>${inner}</ALLLEDGERENTRIES.LIST>`;
const baXml = (name, type, amt) => `<BILLALLOCATIONS.LIST><NAME>${xe(name)}</NAME><BILLTYPE>${type}</BILLTYPE><AMOUNT>${tamt(amt)}</AMOUNT></BILLALLOCATIONS.LIST>`;
const vchXml = (o) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${o.guid}" VCHTYPE="${o.type}" ACTION="${o.action}" OBJVIEW="Accounting Voucher View"><DATE>${tdate(o.date)}</DATE><GUID>${o.guid}</GUID><VOUCHERTYPENAME>${o.type}</VOUCHERTYPENAME><REFERENCE>${xe(o.ref)}</REFERENCE>`
  + (o.action === "Delete" ? "" : `<NARRATION>${xe(o.narr)}</NARRATION><PARTYLEDGERNAME>${xe(o.party)}</PARTYLEDGERNAME><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><EFFECTIVEDATE>${tdate(o.date)}</EFFECTIVEDATE>${o.entries}`) + `</VOUCHER></TALLYMESSAGE>`;
const collSig = (db, c) => JSON.stringify([c.partyId, c.amount, c.advance || 0, c.advRef || "", c.date, c.postDate || "", c.mode, c.kind || "", c.ref || "", c.chequeNo || "", c.chequeDate || "", c.bank || "", c.note || "",
db.allocs.filter((a) => a.collectionId === c.id && a.status === "confirmed").map((a) => [a.billId, a.amount]).sort()]);
function collVoucher(db, c, action) {
  const T = db.tally, party = nm(db.parties, c.partyId), sm = nm(db.users, c.salesmanId);
  const date = c.postDate || c.date, guid = guidOf("c", c.id), adj = isAdj(c), type = adj ? "Journal" : "Receipt", ref = refOf(adj ? "J" : "R", c.id);
  if (action === "Delete") return { guid, type, action, date, ref, party, amount: c.amount, xml: vchXml({ guid, type, action, date, ref }) };
  const bills = db.allocs.filter((a) => a.collectionId === c.id && a.status === "confirmed").map((a) => baXml(db.bills.find((b) => b.id === a.billId)?.no || "", "Agst Ref", a.amount)).join("");
  const det = [c.chequeNo ? `Cheque ${c.chequeNo} dt ${dmy(c.chequeDate)}` : "", c.ref ? `Ref ${c.ref}` : "", c.bank || "", c.note || ""].filter(Boolean).join(" | ");
  const narr = `${adj ? ADJ[c.kind] : MODES[c.mode]} entered by ${sm} on ${dmy(postingDate(c))}${c.date !== postingDate(c) ? " (receipt dated " + dmy(c.date) + ")" : ""}${det ? " | " + det : ""}${c.advance > 0 ? " | Advance " + c.advRef : ""}`;
  let entries, drName;
  if (adj) {
    drName = c.kind === "return" ? T.salesReturn : c.kind === "discount" ? T.discount : T.other;
    entries = leXml(drName, true, -c.amount) + leXml(party, false, c.amount, bills, true);
  } else {
    drName = c.mode === "cash" ? T.cash : c.mode === "cheque" ? T.cheque : T.bank;
    const adv = c.advance > 0 ? baXml(c.advRef, "Advance", c.advance) : "";
    const ba = (inner) => `<BANKALLOCATIONS.LIST><DATE>${tdate(date)}</DATE>${inner}<AMOUNT>${tamt(-c.amount)}</AMOUNT></BANKALLOCATIONS.LIST>`;
    const inner = !T.bankAlloc ? "" : c.mode === "cheque" ? ba(`<INSTRUMENTDATE>${tdate(c.chequeDate || date)}</INSTRUMENTDATE><INSTRUMENTNUMBER>${xe(c.chequeNo)}</INSTRUMENTNUMBER><TRANSACTIONTYPE>Cheque/DD</TRANSACTIONTYPE>`)
      : c.mode === "online" && c.ref ? ba(`<TRANSACTIONTYPE>Others</TRANSACTIONTYPE><UNIQUEREFERENCENUMBER>${xe(c.ref)}</UNIQUEREFERENCENUMBER>`) : "";
    entries = leXml(party, false, c.amount, bills + adv, true) + leXml(drName, true, -c.amount, inner);
  }
  return { guid, type, action, date, ref, party, amount: c.amount, dr: drName, cr: party, xml: vchXml({ guid, type, action, date, ref, narr, party, entries }) };
}
function advVoucher(db, a, action) {
  const party = nm(db.parties, a.partyId), guid = guidOf("a", a.id), ref = refOf("J", a.id), base = { guid, type: "Journal", action, date: a.date, ref };
  if (action === "Delete") return { ...base, party, amount: a.total, xml: vchXml(base) };
  const refs = a.advances.map((x) => x.advRef), nos = a.bills.map((x) => x.no);
  const dr = a.advances.map((x) => baXml(x.advRef, "Agst Ref", -x.amount)).join(""), cr = a.bills.map((x) => baXml(x.no, "Agst Ref", x.amount)).join("");
  const entries = leXml(party, true, -a.total, dr, true) + leXml(party, false, a.total, cr, true);
  return {
    ...base, party, amount: a.total, dr: party + " (advance " + refs.join(",") + ")", cr: party + " (bill " + nos.join(",") + ")",
    xml: vchXml({ ...base, narr: `Advance ${refs.join(", ")} adjusted against bill ${nos.join(", ")}`, party, entries })
  };
}
function tallyPlan(db, from, to, again, againAction) {
  const out = [], ok = (d) => (!from || d >= from) && (!to || d <= to), sorted = () => out.sort((x, y) => x.v.date.localeCompare(y.v.date) || x.id - y.id);
  const addC = (c, action, label) => out.push({ k: "c", id: c.id, posted: postingDate(c), v: collVoucher(db, c, action), label });
  const addA = (a, action, label) => out.push({ k: "a", id: a.id, posted: a.postedOn || a.date, v: advVoucher(db, a, action), label });
  if (again) {   // re-export everything confirmed in the posting-date range, whether exported before or not
    db.collections.forEach((c) => { if (c.status === "confirmed" && ok(postingDate(c))) addC(c, c.exp ? againAction : "Create", c.exp ? "Re-export" : "New"); });
    db.advAdj.forEach((a) => { if (ok(a.postedOn || a.date)) addA(a, a.exp ? againAction : "Create", a.exp ? "Re-export" : "New"); });
    return sorted();
  }
  db.collections.forEach((c) => {
    if (c.status === "confirmed") { if (!c.exp) { if (ok(postingDate(c))) addC(c, "Create", "New"); } else if (c.exp.sig !== collSig(db, c)) addC(c, "Alter", "Changed"); }
    else if (c.status === "rejected" && c.exp && !c.exp.deleted) addC(c, "Delete", "Reversed");
  });
  db.advAdj.forEach((a) => { if (!a.exp && ok(a.postedOn || a.date)) addA(a, "Create", "New"); });
  db.tombstones.forEach((t) => out.push({ k: "t", id: t.id, posted: t.date, v: advVoucher(db, { id: t.id, partyId: 0, date: t.date, total: 0, advances: [], bills: [] }, "Delete"), label: "Reversed" }));
  return sorted();
}
const tallyXml = (db, plan) => `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xe(db.tally.company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>\n`
  + plan.map((p) => p.v.xml).join("\n") + `\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
function TallyExport({ db, setDb, me, flash }) {
  const isAdmin = me.role === "admin", T = db.tally;
  const [pfrom, setPfrom] = useState(""), [pto, setPto] = useState(""), [busy, setBusy] = useState(false), [showXml, setShowXml] = useState(false), [msg, setMsg] = useState(null), [zip, setZip] = useState(null), [again, setAgain] = useState(false), [againAct, setAgainAct] = useState("Create");
  const plan = tallyPlan(db, pfrom, pto, again, againAct), xml = tallyXml(db, plan);
  useEffect(() => { let on = true; setZip(null); if (!plan.length) return; const z = new JSZip(); z.file("GMCM_Tally_Vouchers.xml", xml); z.generateAsync({ type: "blob" }).then((b) => { if (on) setZip(b); }).catch(() => { }); return () => { on = false; }; }, [xml]);
  const rcp = (p) => p.v.type === "Receipt" && p.v.action !== "Delete", jrn = (p) => p.v.type === "Journal" && p.v.action !== "Delete", lbl = (l) => (p) => p.label === l;
  const cnt = (f) => plan.filter(f).length, sumP = (f) => sumOf(plan.filter(f), (p) => p.v.amount);
  const setT = (k, v) => setDb({ ...db, tally: { ...T, [k]: v } });
  const manualBill = db.allocs.some((a) => a.status === "confirmed" && db.bills.find((b) => b.id === a.billId)?.source === "manual");
  const ids = (k, del) => new Set(plan.filter((p) => p.k === k && (del === undefined || (p.v.action === "Delete") === del)).map((p) => p.id));
  const mark = (fileName) => {
    const at = new Date().toISOString(), cs = ids("c", false), cd = ids("c", true), as = ids("a");
    setDb({
      ...db,
      collections: db.collections.map((c) => cs.has(c.id) ? { ...c, exp: { sig: collSig(db, c), at } } : cd.has(c.id) ? { ...c, exp: { ...c.exp, deleted: true } } : c),
      advAdj: db.advAdj.map((a) => as.has(a.id) ? { ...a, exp: { at } } : a), tombstones: again ? db.tombstones : [],
      expBatches: [...db.expBatches, { id: uid(), at, by: me.id, file: fileName + (again ? ` (re-export ${pfrom ? dmy(pfrom) : "start"} to ${pto ? dmy(pto) : "end"})` : ""), vouchers: plan.length, receipts: cnt(rcp), journals: cnt(jrn), changed: cnt(lbl("Changed")), reversed: cnt(lbl("Reversed")) }]
    });
  };
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1_");
  const go = async (how) => {
    if (!plan.length) return; if (!T.company) { setMsg({ t: "err", m: "Enter the Tally company name in the settings box above first." }); return; } setBusy(true); setMsg(null);
    try {
      const base = `GMCM_Tally_Vouchers_${stamp()}`;
      if (how === "copy") { await navigator.clipboard.writeText(xml); mark(base + " (copied)"); setMsg({ t: "ok", m: "XML copied – paste it into a text file and save it as .xml" }); }
      else if (how === "zip") { if (!zip) { setMsg({ t: "err", m: "The ZIP is still being prepared – try again in a moment, or use the .txt button." }); setBusy(false); return; } download(base + ".zip", zip); mark(base + ".zip"); setMsg({ t: "ok", m: "Saved. Unzip it to get the .xml file for Tally." }); }
      else { download(base + ".xml", new Blob([xml], { type: "application/xml" })); mark(base + ".xml"); setMsg({ t: "ok", m: "Saved. Import this .xml file in Tally." }); }
    } catch (e) { setMsg({ t: "err", m: "Could not export (" + (e && (e.code || e.message) || "error") + "). Try the .txt or Copy XML button." }); }
    setBusy(false);
  };
  const fld = (k, label) => <div style={{ flex: "1 1 200px" }}><label>{label}</label><input value={T[k]} disabled={!isAdmin} onChange={(e) => setT(k, e.target.value)} /></div>;
  const none = busy || !plan.length, lab = { display: "flex", gap: 8, alignItems: "center", color: "var(--ink)" };
  return <>
    <details className="card"><summary>Tally ledger names &amp; company {isAdmin ? "" : "(view only)"}</summary>
      <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>{[["company", "Tally company name (exact)"], ["cash", "Cash receipts → ledger"], ["bank", "Bank / UPI receipts → ledger"], ["cheque", "Cheques → ledger"], ["salesReturn", "Goods return → debit ledger"], ["discount", "Discount → debit ledger"], ["other", "Other adjustment → debit ledger"]].map(([k, l]) => <Fragment key={k}>{fld(k, l)}</Fragment>)}</div>
      <label style={lab}><input type="checkbox" style={{ width: 20, height: 20 }} disabled={!isAdmin} checked={T.bankAlloc} onChange={(e) => setT("bankAlloc", e.target.checked)} />Include cheque no./date and UTR as bank details in the voucher</label></details>
    <div className="grid" style={{ marginBottom: 12 }}>
      <Stat t="Receipt vouchers" v={cnt(rcp)} s={money(sumP(rcp))} />
      <Stat t="Journal vouchers" v={cnt(jrn)} s="returns / discounts / advance adjustments" />
      <Stat t="Changed after earlier export" v={cnt(lbl("Changed"))} s="exported again as Alter" cls=" amber" />
      <Stat t="Reversed after export" v={cnt(lbl("Reversed"))} s="exported as Delete" cls=" red" /></div>
    {manualBill && <div className="flash err">Some receipts are against bills added manually by admin – those bills must exist in Tally too, or the import will fail for them.</div>}
    <div className="card"><div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
      <div><label style={{ marginTop: 0 }}>Posting date from</label><input type="date" value={pfrom} onChange={(e) => setPfrom(e.target.value)} /></div>
      <div><label style={{ marginTop: 0 }}>Posting date to</label><input type="date" value={pto} onChange={(e) => setPto(e.target.value)} /></div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}><button disabled={none} onClick={() => go("zip")}>⬇ Download ZIP (contains .xml)</button>
        <button className="sec" disabled={none} onClick={() => go("txt")}>⬇ XML file (for Tally)</button>
        <button className="sec" disabled={none} onClick={() => go("copy")}>Copy XML</button></div></div>
      <div className="row sub" style={{ justifyContent: "flex-start", gap: 10, marginTop: 6 }}><a onClick={() => { const d = iso(new Date()); setPfrom(d); setPto(d); }}>Today only</a><a onClick={() => { setPfrom(""); setPto(""); }}>Clear dates</a></div>
      <div style={{ marginTop: 10, padding: 10, background: again ? "#fff3e0" : "#fafbfc", borderRadius: 10 }}>
        <label style={{ ...lab, fontSize: 16, margin: 0 }}><input type="checkbox" style={{ width: 20, height: 20 }} checked={again} onChange={(e) => setAgain(e.target.checked)} /><b>Export again for these dates</b> – include entries already exported before</label>
        {again && <><div className="sub" style={{ margin: "6px 0" }}>Picks every confirmed entry whose posting date is within the dates above{!pfrom && !pto ? " (no dates set – this means everything)" : ""}.</div>
          {[["Create", " – use if those vouchers are not in Tally (new company / data restored). Importing over vouchers already in Tally may duplicate them."], ["Alter", " – use to refresh vouchers already imported (no duplicates)."]].map(([k, txt]) =>
            <label key={k} style={{ ...lab, fontSize: 15, margin: "4px 0" }}><input type="radio" style={{ width: 18, height: 18 }} checked={againAct === k} onChange={() => setAgainAct(k)} />Send as <b>{k}</b>{txt}</label>)}
          <div className="sub">Entries never exported before are always sent as Create. Reversed entries are left out.</div></>}</div>
      {msg && <div className={"flash " + msg.t} style={{ marginTop: 10, marginBottom: 0 }}>{msg.m}</div>}
      {!plan.length && <div className="sub" style={{ marginTop: 8 }}>Nothing to export. Only entries confirmed by accounts are exported, and each is exported once (tick “Export again for these dates” to repeat an earlier export). Entries are picked by their <b>posting date</b> (the day they were entered), so back-dated receipts are never missed.</div>}
      {plan.length > 0 && <div className="sub" style={{ marginTop: 8 }}>Marks these {plan.length} voucher(s) as exported only after the file is saved. Import in Tally: Gateway → Import → Vouchers.</div>}</div>
    {plan.length > 0 && <div className="card scroll"><table><thead><tr><th>Posting date</th><th>Voucher date</th><th>Type</th><th>Party</th><th>Debit / Credit</th><th className="n">Amount</th></tr></thead><tbody>
      {plan.slice(0, 200).map((p, i) => <tr key={i}><td>{dmy(p.posted)}</td><td>{dmy(p.v.date)}</td><td>{p.v.type} <span className={"pill " + (p.label === "New" ? "ok" : p.label === "Changed" || p.label === "Re-export" ? "warn" : "bad")}>{p.label}</span></td><td>{p.v.party}</td>
        <td className="sub">{p.v.dr ? <>Dr {p.v.dr}<br />Cr {p.v.cr}</> : "—"}</td><td className="n">{money(p.v.amount)}</td></tr>)}</tbody></table>
      {plan.length > 200 && <div className="sub" style={{ padding: 8 }}>Showing first 200 of {plan.length}.</div>}
      <div style={{ padding: 8 }}><a onClick={() => setShowXml(!showXml)}>{showXml ? "Hide" : "Preview"} XML</a>{showXml && <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12, maxHeight: 300, overflow: "auto", background: "#fafbfc", padding: 8 }}>{xml.slice(0, 6000)}{xml.length > 6000 ? "\n…" : ""}</pre>}</div></div>}
    <div className="card scroll"><h3 style={{ marginTop: 0 }}>Export history</h3><table><thead><tr><th>When</th><th>File</th><th className="n">Vouchers</th><th className="n">Receipts</th><th className="n">Journals</th><th>By</th></tr></thead><tbody>
      {[...db.expBatches].reverse().map((b) => <tr key={b.id}><td>{dt(b.at)}</td><td className="sub">{b.file}</td><td className="n">{b.vouchers}</td><td className="n">{b.receipts}</td><td className="n">{b.journals}</td><td>{nm(db.users, b.by)}</td></tr>)}
      {!db.expBatches.length && <tr><td colSpan="6" className="sub">No export yet.</td></tr>}</tbody></table></div>
  </>;
}

/* ================= management reports (screen + Excel + PDF) ================= */
const C = { txt: (h, k) => ({ h, k }), m: (h, k) => ({ h, k, t: "m" }), d: (h, k) => ({ h, k, t: "d" }), n: (h, k) => ({ h, k, t: "n" }) };   // column helpers: t = m money | d date | n number | (text)
const cellTxt = (c, v) => c.t === "m" ? money(v) : c.t === "d" ? dmy(v) : c.t === "n" ? String(v ?? "") : (v ?? "");
const pdfTxt = (c, v) => c.t === "m" ? rsf(v) : c.t === "d" ? dmy(v) : String(v ?? "");
const isNum = (c) => c.t === "m" || c.t === "n";
function aggColl(list) {
  const live = list.filter((c) => c.status !== "rejected"), r = live.filter((c) => !isAdj(c)), a = live.filter(isAdj), by = (l, k, v) => sumAmt(l.filter((c) => c[k] === v));
  return {
    entries: r.length, cash: by(r, "mode", "cash"), cheque: by(r, "mode", "cheque"), online: by(r, "mode", "online"), total: sumAmt(r),
    ret: by(a, "kind", "return"), disc: by(a, "kind", "discount"), other: by(a, "kind", "other"), adv: sumOf(r, (c) => c.advance || 0),
    confirmed: sumAmt(r.filter((c) => c.status === "confirmed")), awaiting: sumAmt(r.filter((c) => c.status === "provisional"))
  };
}
function buildReport(db, kind, f) {
  const today = iso(new Date()), uname = (id) => nm(db.users, id), party = (id) => db.parties.find((p) => p.id === id);
  const inR = (c) => (!f.from || postingDate(c) >= f.from) && (!f.to || postingDate(c) <= f.to);
  const okC = (c) => inR(c) && (!f.sm || c.salesmanId === +f.sm) && (!f.loc || party(c.partyId)?.loc === f.loc);
  const okP = (p) => p.active && (!f.sm || p.salesmanId === +f.sm) && (!f.loc || p.loc === f.loc);
  const per = `${f.from ? dmy(f.from) : "start"}${f.to && f.to !== f.from ? " to " + dmy(f.to) : ""}`, asOn = `As on ${dmy(today)}`;
  const sub = [`Salesman: ${f.sm ? uname(+f.sm) : "All"}   |   Location: ${f.loc || "All"}`];
  const status = (c) => c.status === "confirmed" ? "Posted" : c.status === "rejected" ? "Rejected" : "Awaiting accounts";
  const detail = (c) => [c.chequeNo ? `Chq ${c.chequeNo} (${dmy(c.chequeDate)})` : "", c.ref ? `Ref ${c.ref}` : "", c.bank || ""].filter(Boolean).join(" · ");
  const flags = (c) => [c.dateChanged ? "Receipt date differs" : "", c.adminEdited ? "Edited by admin" : ""].filter(Boolean);
  const pname = (c) => party(c.partyId)?.name || "";
  const sumCols = [C.n("Entries", "entries"), C.m("Cash", "cash"), C.m("Cheque", "cheque"), C.m("Bank / UPI", "online"), C.m("Total collected", "total"), C.m("Goods return", "ret"), C.m("Discount", "disc"), C.m("Other adj.", "other"), C.m("of which Advance", "adv"), C.m("Posted", "confirmed"), C.m("Awaiting accounts", "awaiting")];
  const totOf = (cols, rows) => Object.fromEntries(cols.map((c) => [c.k, sumOf(rows, (r) => r[c.k])]));
  const out = (title, file, subtitle, tables) => ({ title, file, subtitle, tables });
  if (kind === "summary") {
    const list = db.collections.filter(okC);
    const by = (keyOf, nameOf = (k) => k, sortKeys) => { const ks = [...new Set(list.map(keyOf))]; if (sortKeys) ks.sort(); return ks.map((k) => ({ name: nameOf(k), ...aggColl(list.filter((c) => keyOf(c) === k)) })); };
    const bySm = by((c) => c.salesmanId, uname).sort((a, b) => a.name.localeCompare(b.name)), byLoc = by((c) => party(c.partyId)?.loc || "—"), byDay = by(postingDate, undefined, true);
    const tbl = (name, label, ch, rows) => ({ name, cols: [ch(label, "name"), ...sumCols], rows, foot: { name: "Total", ...totOf(sumCols, rows) } });
    return out("Collection Summary", "Collection_Summary", [`Posting date: ${per}`, ...sub], [tbl("Salesman-wise", "Salesman", C.txt, bySm), tbl("Location-wise", "Location", C.txt, byLoc), tbl("Day-wise (posting date)", "Posting date", C.d, byDay)]);
  }
  if (kind === "register") {
    const list = db.collections.filter(okC).sort((a, b) => postingDate(a).localeCompare(postingDate(b)) || a.id - b.id);
    const rows = list.map((c) => ({
      pd: postingDate(c), rd: c.date, sm: uname(c.salesmanId), party: pname(c), loc: party(c.partyId)?.loc || "", type: modeLabel(c), det: detail(c), amt: c.amount, adv: c.advance || 0, st: status(c), ld: c.status === "confirmed" ? (c.postDate || c.date) : "", by: c.confirmedBy ? uname(c.confirmedBy) : "",
      note: [c.note, c.dateChanged ? "Receipt date differs" : "", c.adminEdited ? "Edited by admin" : "", c.status === "rejected" ? "Rejected: " + (c.reason || "") : ""].filter(Boolean).join(" | ")
    }));
    const rcp = list.filter((c) => c.status !== "rejected" && !isAdj(c));
    return out("Collection Register", "Collection_Register", [`Posting date: ${per}`, ...sub], [{
      cols: [C.d("Posting date", "pd"), C.d("Receipt date", "rd"), C.txt("Salesman", "sm"), C.txt("Party", "party"), C.txt("Location", "loc"), C.txt("Type / Mode", "type"), C.txt("Cheque / UTR / Bank", "det"), C.m("Amount", "amt"), C.m("Advance", "adv"), C.txt("Status", "st"), C.d("Ledger / bank date", "ld"), C.txt("Confirmed by", "by"), C.txt("Remarks", "note")],
      rows, foot: { party: "Total receipts (excl. adjustments & rejected)", amt: sumAmt(rcp), adv: sumOf(rcp, (c) => c.advance || 0) }
    }]);
  }
  if (kind === "cheques") {
    const stOk = { hand: "provisional", bank: "confirmed", rej: "rejected" }[f.cst];
    const list = db.collections.filter((c) => c.mode === "cheque" && !isAdj(c) && okC(c) && (!f.cst || c.status === stOk)).sort((a, b) => (a.chequeDate || "").localeCompare(b.chequeDate || ""));
    const days = (c) => c.status === "provisional" ? Math.round(diffDays(c.chequeDate, today)) : "";
    const rows = list.map((c) => ({ cd: c.chequeDate, no: c.chequeNo, party: pname(c), sm: uname(c.salesmanId), bank: c.bank || "", amt: c.amount, pd: postingDate(c), st: c.status === "provisional" ? "In hand (not yet in bank)" : c.status === "confirmed" ? "Received in bank" : "Returned / rejected", bd: c.status === "confirmed" ? (c.postDate || c.date) : "", dd: days(c), flag: c.status === "provisional" ? (days(c) > 0 ? "Post-dated" : days(c) < 0 ? "Cheque date passed – deposit" : "Due today") : "" }));
    return out("Cheque Register", "Cheque_Register", [`Posting date: ${per}`, ...sub, `Status: ${f.cst === "hand" ? "In hand" : f.cst === "bank" ? "Received in bank" : f.cst === "rej" ? "Returned" : "All"}`], [{
      cols: [C.d("Cheque date", "cd"), C.txt("Cheque no.", "no"), C.txt("Party", "party"), C.txt("Salesman", "sm"), C.txt("Bank", "bank"), C.m("Amount", "amt"), C.d("Posting date", "pd"), C.txt("Status", "st"), C.d("Received in bank", "bd"), C.n("Days to cheque date", "dd"), C.txt("Note", "flag")],
      rows, foot: { party: "Total (excl. returned)", amt: sumAmt(list.filter((c) => c.status !== "rejected")) }
    }]);
  }
  if (kind === "approvals") {
    const list = db.collections.filter((c) => c.status === "provisional" && okC(c)).sort((a, b) => postingDate(a).localeCompare(postingDate(b)) || a.id - b.id);
    const rows = list.map((c) => ({ pd: postingDate(c), rd: c.date, sm: uname(c.salesmanId), party: pname(c), type: modeLabel(c), det: detail(c), amt: c.amount, adv: c.advance || 0, wait: Math.round(diffDays(today, postingDate(c))), flag: flags(c).join(" | ") }));
    const byMode = [...["cash", "online", "cheque"].map((m) => [MODES[m], list.filter((c) => !isAdj(c) && c.mode === m)]), ...Object.entries(ADJ).map(([k, v]) => [v + " (journal)", list.filter((c) => c.kind === k)])].map(([name, l]) => ({ name, n: l.length, amt: sumAmt(l) }));
    const adv = db.parties.filter(okP).map((p) => ({ p, i: advanceInfo(db, p.id), pend: sumOf(partyBills(db, p.id), (x) => x.pending) })).filter((r) => r.i.total > 0.005)
      .map((r) => ({ party: r.p.name, sm: uname(r.p.salesmanId), adv: r.i.total, conf: r.i.adjustable, pend: r.pend, st: r.i.adjustable < 0.005 ? "Advance not yet confirmed" : r.pend < 0.005 ? "Waiting for new bill" : "Ready to adjust" }));
    return out("Pending Approval Report (awaiting accounts confirmation)", "Pending_Approvals", [`${asOn}   |   Posting date: ${per || "all"}`, ...sub], [
      { name: "Summary by type", cols: [C.txt("Type", "name"), C.n("Entries", "n"), C.m("Amount", "amt")], rows: byMode, foot: { name: "Total", n: sumBy(byMode, (r) => r.n), amt: sumOf(byMode, (r) => r.amt) } },
      { name: "Entries awaiting confirmation", cols: [C.d("Posting date", "pd"), C.d("Receipt date", "rd"), C.txt("Salesman", "sm"), C.txt("Party", "party"), C.txt("Type / Mode", "type"), C.txt("Cheque / UTR / Bank", "det"), C.m("Amount", "amt"), C.m("Advance", "adv"), C.n("Days waiting", "wait"), C.txt("Flags", "flag")], rows, foot: { party: "Total", amt: sumAmt(list) } },
      { name: "Advances awaiting adjustment", cols: [C.txt("Party", "party"), C.txt("Salesman", "sm"), C.m("Advance held", "adv"), C.m("Confirmed (adjustable)", "conf"), C.m("Pending bills", "pend"), C.txt("Status", "st")], rows: adv, foot: { party: "Total", adv: sumOf(adv, (r) => r.adv) } }]);
  }
  if (kind === "ageing") {
    const BK = ["b1", "b2", "b3", "b4"], bk = (b) => BK[b.age <= 30 ? 0 : b.age <= 60 ? 1 : b.age <= 90 ? 2 : 3];
    const rows = db.parties.filter(okP).map((p) => {
      const o = { party: p.name, sm: uname(p.salesmanId), loc: p.loc || "", grp: p.group || "", b1: 0, b2: 0, b3: 0, b4: 0, total: 0 };
      partyBills(db, p.id).forEach((b) => { o[bk(b)] += b.pending; o.total += b.pending; }); Object.keys(o).forEach((k) => { if (typeof o[k] === "number") o[k] = r2(o[k]); }); return o;
    }).filter((r) => r.total > 0.005).sort((a, b) => b.total - a.total);
    const cols = [C.m("0-30 days", "b1"), C.m("31-60 days", "b2"), C.m("61-90 days", "b3"), C.m("Over 90 days", "b4"), C.m("Total", "total")];
    const bySm = [...new Set(rows.map((r) => r.sm))].sort().map((n) => ({ name: n || "—", ...totOf(cols, rows.filter((r) => r.sm === n)) }));
    return out("Ageing Analysis (age from bill date)", "Ageing", [asOn, ...sub], [
      { name: "Salesman-wise", cols: [C.txt("Salesman", "name"), ...cols], rows: bySm, foot: { name: "Total", ...totOf(cols, rows) } },
      { name: "Party-wise", cols: [C.txt("Party", "party"), C.txt("Salesman", "sm"), C.txt("Location", "loc"), C.txt("Route group", "grp"), ...cols], rows, foot: { party: "Total", ...totOf(cols, rows) } }]);
  }
  if (kind === "outstanding") {
    const [lbl, key] = f.grp === "loc" ? ["Location", (p) => p.loc || "—"] : f.grp === "route" ? ["Route group", (p) => p.group || "—"] : ["Salesman", (p) => uname(p.salesmanId) || "Unassigned"];
    const ps = db.parties.filter(okP).map((p) => ({ p, bs: partyBills(db, p.id), adv: advanceInfo(db, p.id).total }));
    const rows = [...new Set(ps.map((x) => key(x.p)))].sort().map((n) => {
      const g = ps.filter((x) => key(x.p) === n), o = sumOf(g.flatMap((x) => x.bs), (b) => b.pending), adv = sumOf(g, (x) => x.adv);
      return { name: n, parties: g.filter((x) => x.bs.length).length, bills: sumBy(g, (x) => x.bs.length), out: o, adv, net: r2(o - adv) };
    });
    const ft = { name: "Total", parties: sumBy(rows, (r) => r.parties), bills: sumBy(rows, (r) => r.bills), out: sumOf(rows, (r) => r.out), adv: sumOf(rows, (r) => r.adv), net: sumOf(rows, (r) => r.net) };
    return out("Outstanding Summary", "Outstanding_Summary", [asOn, `Grouped by ${lbl.toLowerCase()}`, ...sub], [{ cols: [C.txt(lbl, "name"), C.n("Parties with balance", "parties"), C.n("Open bills", "bills"), C.m("Outstanding", "out"), C.m("Advance held", "adv"), C.m("Net", "net")], rows, foot: ft }]);
  }
  // bill-wise pending
  const allDays = f.day === "all" || f.day === undefined, rows = [];
  db.parties.filter((p) => okP(p) && (allDays || p.days.includes(f.day))).sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => partyBills(db, p.id).forEach((b) => rows.push({ sm: uname(p.salesmanId), grp: p.group || "", party: p.name, no: b.no, bd: b.date, age: b.age, amt: b.amount, pend: b.pending })));
  return out("Pending Bills (bill-wise)", "Pending_Bills", [`${asOn}   |   Visit day: ${allDays ? "All" : DAYS[f.day]}`, ...sub], [{ cols: [C.txt("Salesman", "sm"), C.txt("Route group", "grp"), C.txt("Party", "party"), C.txt("Bill no.", "no"), C.d("Bill date", "bd"), C.n("Days", "age"), C.m("Bill amount", "amt"), C.m("Pending", "pend")], rows, foot: { party: "Total pending", pend: sumOf(rows, (r) => r.pend) } }]);
}
function makeReportXlsx(rep) {
  const wb = XLSX.utils.book_new(), serial = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5) + 25569;
  rep.tables.forEach((t, i) => {
    const head = [[rep.title], ...rep.subtitle.map((x) => [x]), []]; if (t.name) head.push([t.name]);
    const aoa = [...head, t.cols.map((c) => c.h), ...t.rows.map((r) => t.cols.map((c) => c.t === "d" ? (r[c.k] ? serial(r[c.k]) : "") : isNum(c) ? (r[c.k] === "" || r[c.k] == null ? "" : Number(r[c.k])) : (r[c.k] ?? "")))];
    if (t.foot) aoa.push(t.cols.map((c) => t.foot[c.k] === undefined ? "" : isNum(c) ? Number(t.foot[c.k]) : t.foot[c.k]));
    const ws = XLSX.utils.aoa_to_sheet(aoa), hr = head.length;
    ws["!cols"] = t.cols.map((c) => ({ wch: { m: 16, d: 13, n: 10 }[c.t] ?? Math.min(40, Math.max(14, c.h.length + 4, ...t.rows.slice(0, 60).map((r) => String(r[c.k] ?? "").length + 2))) }));
    t.cols.forEach((c, ci) => { for (let r = hr + 1; r < aoa.length; r++) { const cell = ws[XLSX.utils.encode_cell({ r, c: ci })]; if (!cell) continue; if (c.t === "m") cell.z = "#,##0.00"; if (c.t === "d") cell.z = "dd-mm-yyyy"; } });
    const n = (t.name || rep.title).replace(/[\\\/\?\*\[\]:]/g, "").slice(0, 28) || ("Sheet" + (i + 1));
    XLSX.utils.book_append_sheet(wb, ws, n + (wb.SheetNames.includes(n) ? i : ""));
  });
  return new Blob([XLSX.write(wb, { type: "array", bookType: "xlsx" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
function makeReportPdf(rep) {
  const wide = Math.max(...rep.tables.map((t) => t.cols.length)) > 7, doc = new PDF.jsPDF({ orientation: wide ? "landscape" : "portrait" });
  let y = pdfHeader(doc, "Gurmeet Motors - " + rep.title, [...rep.subtitle, `Generated: ${now()}`]);
  rep.tables.forEach((t) => {
    if (t.name) { doc.setFontSize(11); doc.text(t.name, 14, y + 4); y += 2; }
    PDF.autoTable(doc, {
      ...AT, startY: y + 4, head: [t.cols.map((c) => c.h)], body: t.rows.map((r) => t.cols.map((c) => pdfTxt(c, r[c.k]))),
      foot: t.foot ? [t.cols.map((c) => t.foot[c.k] === undefined ? "" : pdfTxt(c, t.foot[c.k]))] : undefined, styles: { fontSize: wide ? 7 : 8 },
      columnStyles: Object.fromEntries(t.cols.map((c, i) => [i, { halign: isNum(c) ? "right" : "left" }]))
    });
    y = doc.lastAutoTable.finalY + 8;
  });
  return finishPdf(doc);
}
const KINDS = [["summary", "Collection Summary"], ["register", "Collection Register"], ["approvals", "Pending Approvals"], ["cheques", "Cheque Register"], ["ageing", "Ageing"], ["outstanding", "Outstanding Summary"], ["bills", "Pending Bills"]];
function ReportsHub({ db, me, flash }) {
  const t0 = iso(new Date());
  const [kind, setKind] = useState("summary"), [from, setFrom] = useState(t0), [to, setTo] = useState(t0), [preset, setPreset] = useState("today");
  const [sm, setSm] = useState(""), [loc, setLoc] = useState(""), [cst, setCst] = useState(""), [grp, setGrp] = useState("sm"), [day, setDay] = useState("all");
  const usesDates = ["summary", "register", "cheques", "approvals"].includes(kind);
  const pick = (k) => { setPreset(k); if (k !== "custom") { const [a, b] = rangeOf(k, t0); setFrom(a); setTo(b); } };
  const rep = buildReport(db, kind, { from: usesDates ? from : "", to: usesDates ? to : "", sm, loc, cst, grp, day });
  const rows = sumBy(rep.tables, (x) => x.rows.length), fname = `${rep.file}${usesDates && from ? "_" + from + (to !== from ? "_to_" + to : "") : "_" + t0}`;
  const xlsx = () => { try { download(fname + ".xlsx", makeReportXlsx(rep)); } catch (e) { flash("err", "Could not create Excel: " + (e.message || e.code || "error")); } };
  const sel = (label, value, set, opts) => <div style={{ flex: "1 1 150px" }}><label>{label}</label><select value={value} onChange={(e) => set(e.target.value)}>{opts}</select></div>;
  return <>
    <Tabs items={KINDS} cur={kind} pick={setKind} />
    <div className="card">
      {usesDates && <><Tabs style={{ marginBottom: 4 }} cur={preset} pick={pick} items={[["today", "Today"], ["yest", "Yesterday"], ["week", "Last 7 days"], ["month", "This month"], ["all", "All dates"], ["custom", "Choose dates"]]} />
        <div className="sub">By <b>posting date</b> (the day the entry was made){kind === "approvals" ? "; all dates shows everything still waiting" : ""}</div>
        {preset === "custom" && <div className="row" style={{ gap: 8 }}><div style={{ flex: 1 }}><label>From</label><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div><div style={{ flex: 1 }}><label>To</label><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div></div>}</>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {sel("Salesman", sm, setSm, <><option value="">All</option><UserOpts users={salesmen(db, true)} /></>)}
        {sel("Location", loc, setLoc, <><option value="">All</option>{locOpts}</>)}
        {kind === "cheques" && sel("Cheque status", cst, setCst, <><option value="">All</option><option value="hand">In hand (not in bank)</option><option value="bank">Received in bank</option><option value="rej">Returned</option></>)}
        {kind === "outstanding" && sel("Group by", grp, setGrp, <><option value="sm">Salesman</option><option value="loc">Location</option><option value="route">Route group</option></>)}
        {kind === "bills" && sel("Visit day", day, (v) => setDay(v === "all" ? "all" : +v), <><option value="all">All days</option>{DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}</>)}</div>
      <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button disabled={!rows} onClick={xlsx}>⬇ Excel</button>
        <PdfBtn cls="sec" label="PDF" onClick={() => rows && savePdf(fname + ".pdf", () => makeReportPdf(rep), flash)} /></div></div>
    <div className="card"><div className="name">{rep.title}</div>{rep.subtitle.map((x, i) => <div key={i} className="sub">{x}</div>)}</div>
    {rep.tables.map((t, i) => <div key={i} className="card scroll">{t.name && <h3 style={{ marginTop: 0 }}>{t.name}</h3>}
      <table><thead><tr>{t.cols.map((c) => <th key={c.k} className={isNum(c) ? "n" : ""}>{c.h}</th>)}</tr></thead><tbody>
        {t.rows.slice(0, 300).map((r, j) => <tr key={j}>{t.cols.map((c) => <td key={c.k} className={isNum(c) ? "n" : ""}>{cellTxt(c, r[c.k])}</td>)}</tr>)}
        {!t.rows.length && <tr><td colSpan={t.cols.length} className="empty">Nothing to show for this selection.</td></tr>}
        {t.foot && t.rows.length > 0 && <tr style={{ fontWeight: 700, background: "#fafbfc" }}>{t.cols.map((c) => <td key={c.k} className={isNum(c) ? "n" : ""}>{t.foot[c.k] === undefined ? "" : cellTxt(c, t.foot[c.k])}</td>)}</tr>}</tbody></table>
      {t.rows.length > 300 && <div className="sub" style={{ padding: 8 }}>Showing first 300 of {t.rows.length} rows – the Excel / PDF has all of them.</div>}</div>)}
  </>;
}

/* ================= admin screens ================= */
const SumTable = ({ title, head, rows, empty }) => <div className="card scroll"><h3 style={{ marginTop: 0 }}>{title}</h3><table><thead><tr><th>{head}</th><th className="n">Parties</th><th className="n">Outstanding</th></tr></thead><tbody>
  {rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="n">{r.n}</td><td className="n">{money(r.o)}</td></tr>)}
  {empty && !rows.length && <tr><td colSpan="3" className="sub">{empty}</td></tr>}</tbody></table></div>;
function Dashboard({ db, setTab }) {
  const sums = db.parties.filter((p) => p.active).map((p) => partySummary(db, p));
  const agg = (f) => { const l = sums.filter(f); return { n: l.length, o: sumBy(l, (s) => s.outstanding) }; };
  const byLoc = LOCS.map((l) => ({ name: l, ...agg((s) => s.loc === l) })), sms = salesmen(db).map((u) => ({ name: u.name, ...agg((s) => s.salesmanId === u.id) }));
  const un = sums.filter((s) => s.salesmanId == null).length, prov = db.collections.filter((c) => c.status === "provisional");
  return <>
    <div className="card row"><div><div className="sub">Total outstanding (all locations)</div><div className="big red">{money(sumBy(sums, (s) => s.outstanding))}</div></div>
      <div className="sub" style={{ textAlign: "right" }}>{db.bills.length} bills<br />{sums.length} parties{sums.some((x) => x.advance > 0) ? <><br /><span className="green">Advances held {money(sumBy(sums, (x) => x.advance))}</span></> : null}</div></div>
    {prov.length > 0 && <div className="flash" style={{ background: "#fff3e0", color: "var(--warn)" }}>{prov.length} collection(s) worth {money(sumBy(prov, (c) => c.amount))} waiting for confirmation. <a onClick={() => setTab("coll")}>Confirm now</a></div>}
    {un > 0 && <div className="flash err">{un} {pty(un)} not assigned to any salesman. <a onClick={() => setTab("parties:unassigned")}>Fix now</a></div>}
    {!db.parties.length && <div className="flash err">No data yet. Go to <a onClick={() => setTab("import")}>Import</a>: first the Master, then the Sales Book.</div>}
    <div className="grid"><SumTable title="Location-wise" head="Location" rows={byLoc} /><SumTable title="Salesman-wise" head="Salesman" rows={sms} empty="No salesman created yet." /></div>
    <p className="sub">More summary reports will be added here in the next steps.</p>
  </>;
}
function PartyForm({ db, p, onSave }) {
  const [f, setF] = useState(p || { name: "", loc: "Ranchi (HO)", group: "", salesmanId: null, days: [], phone: "" });
  const set = (k, v) => setF({ ...f, [k]: v });
  return <div style={{ minWidth: 250 }}>
    <label>Party name (same as Tally ledger name)</label><input value={f.name} onChange={(e) => set("name", e.target.value)} />
    <label>Location</label><select value={f.loc || ""} onChange={(e) => set("loc", e.target.value)}><option value="">—</option>{locOpts}</select>
    <label>Salesman</label><select value={f.salesmanId ?? ""} onChange={(e) => set("salesmanId", e.target.value ? +e.target.value : null)}><option value="">— Unassigned —</option><UserOpts users={salesmen(db)} /></select>
    <label>Visit days (none = no fixed day)</label><DayChips days={f.days || []} onChange={(d) => set("days", d)} />
    <label>Phone</label><input value={f.phone || ""} onChange={(e) => set("phone", e.target.value)} />
    <br /><button className="sm" onClick={() => onSave(f)}>Save</button></div>;
}
function AdminParties({ db, setDb, flt, setFlt, flash, go }) {
  const [q, setQ] = useState(""), [edit, setEdit] = useState(null), [lim, setLim] = useState(100);
  const all = db.parties.filter((p) => p.active && p.name.toLowerCase().includes(q.toLowerCase())).map((p) => partySummary(db, p)).filter((s) => flt !== "unassigned" || s.salesmanId == null), rows = all.slice(0, lim);
  const save = (f) => {
    if (!f.name.trim()) return flash("err", "Party name is required");
    if (db.parties.some((p) => p.id !== f.id && p.name.toLowerCase() === f.name.trim().toLowerCase())) return flash("err", "A party with this name already exists");
    const parties = f.id ? db.parties.map((p) => p.id === f.id ? { ...p, ...f, name: f.name.trim() } : p) : [...db.parties, { ...f, name: f.name.trim(), id: uid(), active: true }];
    setDb({ ...db, parties }); setEdit(null); flash("ok", "Party saved");
  };
  return <>
    <div className="row" style={{ marginBottom: 12 }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search party…" />
      <select value={flt} onChange={(e) => setFlt(e.target.value)} style={{ maxWidth: 200 }}><option value="">All</option><option value="unassigned">Unassigned only</option></select>
      <button onClick={() => setEdit("new")}>+ Add</button></div>
    {edit === "new" && <div className="card"><PartyForm db={db} onSave={save} /></div>}
    <div className="card scroll"><table><thead><tr><th>Party</th><th>Route group</th><th>Salesman</th><th>Days</th><th className="n">Outstanding</th><th></th></tr></thead><tbody>
      {rows.map((r) => <Fragment key={r.id}>
        <tr><td><a onClick={() => go({ page: "party", id: r.id })}>{r.name}</a></td><td>{r.group || "—"}</td><td>{nm(db.users, r.salesmanId) || "—"}</td>
          <td>{r.days.length ? daysTxt(r.days) : "—"}</td><td className="n">{money(r.outstanding)}</td>
          <td><a onClick={() => setEdit(edit === r.id ? null : r.id)}>{edit === r.id ? "Close" : "Edit"}</a></td></tr>
        {edit === r.id && <tr><td colSpan="6"><PartyForm db={db} p={db.parties.find((p) => p.id === r.id)} onSave={save} /></td></tr>}
      </Fragment>)}
      {!rows.length && <tr><td colSpan="6" className="empty">No parties.</td></tr>}</tbody></table>
      {all.length > lim && <div style={{ textAlign: "center", padding: 10 }}><button className="sec sm" onClick={() => setLim(lim + 200)}>Show more ({all.length - lim} left)</button></div>}</div>
  </>;
}
function AdminRoutes({ db, setDb }) {
  const sms = salesmen(db), groups = {}, key = (p) => p.group || "(no group)";
  db.parties.filter((p) => p.active).forEach((p) => (groups[key(p)] ??= []).push(p));
  const list = Object.entries(groups).map(([g, ps]) => ({ g, ps, sm: ps[0].salesmanId, days: ps[0].days, mixed: ps.some((p) => p.salesmanId !== ps[0].salesmanId || !same(p.days, ps[0].days)), out: sumBy(ps, (p) => partySummary(db, p).outstanding) }))
    .sort((a, b) => (nm(db.users, a.sm) || "~").localeCompare(nm(db.users, b.sm) || "~") || a.g.localeCompare(b.g));
  const upd = (g, patch) => setDb({ ...db, parties: db.parties.map((p) => key(p) === g ? { ...p, ...patch } : p) });
  return <>
    <p className="sub">Each Tally group is one beat. Changing salesman or days here updates every party in that group.</p>
    <div className="card scroll"><table><thead><tr><th>Route group (Tally)</th><th className="n">Parties</th><th>Salesman</th><th>Visit days</th><th className="n">Outstanding</th></tr></thead><tbody>
      {list.map((r) => <tr key={r.g}><td>{r.g}{r.mixed && <div className="sub amber">individual overrides inside</div>}</td><td className="n">{r.ps.length}</td>
        <td><select value={r.sm ?? ""} onChange={(e) => upd(r.g, { salesmanId: e.target.value ? +e.target.value : null })}><option value="">— none —</option><UserOpts users={sms} /></select></td>
        <td><DayChips days={r.days} onChange={(d) => upd(r.g, { days: d })} /></td><td className="n">{money(r.out)}</td></tr>)}
      {!list.length && <tr><td colSpan="5" className="empty">Import the Master first.</td></tr>}</tbody></table></div>
  </>;
}
function AdminUsers({ db, setDb, flash }) {
  const [edit, setEdit] = useState(null), [f, setF] = useState({});
  const open = (u) => { setEdit(u ? u.id : "new"); setF(u ? { id: u.id, username: u.username, name: u.name, role: u.role, loc: u.loc, active: u.active, password: "" } : { username: "", name: "", role: "salesman", loc: "", password: "", active: true }); };
  const set = (k, v) => setF({ ...f, [k]: v }), bf = bind(f, set), isNew = edit === "new";
  const save = () => {
    if (!f.name.trim()) return flash("err", "Name is required");
    if (isNew) {
      const un = (f.username || "").trim().toLowerCase();
      if (!un) return flash("err", "Username is required");
      if (db.users.some((u) => u.username === un)) return flash("err", "This username already exists");
      if ((f.password || "").length < 6) return flash("err", "Password must be at least 6 characters");
      setDb({ ...db, users: [...db.users, { id: uid(), username: un, password: f.password, name: f.name.trim(), role: f.role, loc: f.loc, active: true }] });
    } else {
      if (f.password && f.password.length < 6) return flash("err", "Password must be at least 6 characters");
      setDb({ ...db, users: db.users.map((u) => u.id === edit ? { ...u, name: f.name.trim(), role: f.role, loc: f.loc, active: f.active, ...(f.password ? { password: f.password } : {}) } : u) });
    }
    setEdit(null); flash("ok", "User saved");
  };
  const form = <div style={{ minWidth: 250 }}>
    {isNew && <><label>Username (for login)</label><input {...bf("username")} autoCapitalize="none" /></>}
    <label>Full name</label><input {...bf("name")} />
    <label>Role</label><select {...bf("role")}><option value="salesman">Salesman</option><option value="accounts">Accounts</option><option value="admin">Admin</option></select>
    <label>Home location</label><select value={f.loc || ""} onChange={(e) => set("loc", e.target.value)}><option value="">—</option>{locOpts}</select>
    <label>{isNew ? "Password (min 6 characters)" : "New password (leave blank to keep)"}</label><input {...bf("password")} />
    {!isNew && <label><input type="checkbox" style={{ width: "auto" }} checked={!!f.active} onChange={(e) => set("active", e.target.checked)} /> Active</label>}
    <br /><button className="sm" onClick={save}>Save</button></div>;
  return <>
    <div style={{ marginBottom: 12 }}><button onClick={() => open(null)}>+ Add user</button></div>
    {isNew && <div className="card">{form}</div>}
    <div className="card scroll"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Parties</th><th>Status</th><th></th></tr></thead><tbody>
      {db.users.map((u) => <Fragment key={u.id}>
        <tr><td>{u.username}</td><td>{u.name}</td><td style={{ textTransform: "capitalize" }}>{u.role}</td><td>{u.role === "salesman" ? db.parties.filter((p) => p.salesmanId === u.id).length : "—"}</td>
          <td><span className={"pill " + (u.active ? "ok" : "bad")}>{u.active ? "Active" : "Disabled"}</span></td>
          <td><a onClick={() => edit === u.id ? setEdit(null) : open(u)}>{edit === u.id ? "Close" : "Edit"}</a></td></tr>
        {edit === u.id && <tr><td colSpan="6">{form}</td></tr>}
      </Fragment>)}</tbody></table></div>
  </>;
}

const Done = ({ title, children }) => <div className="card"><h3 style={{ marginTop: 0 }}>{title}</h3>{children}</div>;
function AdminImport({ db, setDb, me, setTab }) {
  const [res, setRes] = useState(null), [busy, setBusy] = useState("");
  const log = (kind, file, added, skipped, errors, dbx) => ({ ...dbx, logs: [{ id: uid(), at: now(), kind, file: file.name, added, skipped, errors, who: me.name }, ...db.logs].slice(0, 10) });
  const run = async (kind, file) => {
    if (!file) return; setBusy(kind); setRes(null);
    try {
      if (kind === "master") {
        const a = applyMaster(db, buildMaster(await readMasterFile(file)));
        setDb(log("Master", file, a.res.added + a.res.updated, 0, 0, { ...db, users: a.users, parties: a.parties })); setRes({ kind, ...a.res });
      } else if (kind === "sales") {
        const x = await readSalesXml(file), a = applySales(db, x);
        setDb(log("Sales Book", file, a.res.added, a.res.skipped.length, a.res.bad, { ...db, parties: a.parties, bills: a.bills, tally: { ...db.tally, company: x.company || db.tally.company } })); setRes({ kind, ...a.res });
      } else {
        const a = await importOpening(db, file);
        setDb(log("Opening", file, a.res.added, a.res.skipped.length, a.res.errors.length, { ...db, parties: a.parties, bills: a.bills })); setRes({ kind, ...a.res });
      }
    } catch (e) { setRes({ fatal: e.message }); }
    setBusy("");
  };
  const Box = ({ kind, title, sub, accept }) => <div className="card"><h3 style={{ marginTop: 0 }}>{title}</h3><p className="sub">{sub}</p>
    <input type="file" accept={accept} disabled={!!busy} onChange={(e) => { run(kind, e.target.files[0]); e.target.value = ""; }} />
    {busy === kind && <p className="amber">Reading file… please wait.</p>}</div>;
  return <>
    {res?.fatal && <div className="flash err">{res.fatal}</div>}
    {res?.kind === "master" && <Done title="Master imported">
      <p className="green"><b>{res.added}</b> parties added, <b>{res.updated}</b> updated · location <b>{res.loc}</b> · <b>{res.groups}</b> route groups</p>
      <p>Salesmen found: <b>{res.salesmen.join(", ") || "none"}</b></p>
      {res.creds.length > 0 && <p className="amber">New logins created (username / password) — ask them to change it:<br /><b>{res.creds.join("   •   ")}</b></p>}
      <p><a onClick={() => setTab("routes")}>Check beats &amp; visit days →</a></p></Done>}
    {res?.kind === "sales" && <Done title="Sales Book imported">
      <p className="green"><b>{res.added}</b> bills added · total {money(res.total)} · location {res.loc}</p>
      {res.skipped.length > 0 && <p className="sub"><b>{res.skipped.length}</b> already existed (skipped): {res.skipped.slice(0, 8).join(", ")}{res.skipped.length > 8 ? " …" : ""}</p>}
      {res.cancelled > 0 && <p className="sub">{res.cancelled} cancelled voucher(s) ignored.</p>}
      {Object.keys(res.other).length > 0 && <p className="amber">Not imported (not Sales): {Object.entries(res.other).map(([k, v]) => `${v} × ${k || "unknown"}`).join(", ")}</p>}
      {res.bad > 0 && <p className="red">{res.bad} voucher(s) had no party/amount and were skipped.</p>}
      {res.created.length > 0 && <p className="amber"><b>{res.created.length}</b> customer(s) were not in the Master and were created without a salesman — <a onClick={() => setTab("parties:unassigned")}>assign them</a>:<br /><span className="sub">{res.created.join(", ")}</span></p>}</Done>}
    {res?.kind === "open" && <Done title="Opening outstanding imported"><p className="green"><b>{res.added}</b> bills added.</p>
      {res.skipped.length > 0 && <p className="sub">{res.skipped.length} already existed.</p>}{res.created.length > 0 && <p className="amber">{res.created.length} new {pty(res.created.length)} created.</p>}
      {res.errors.length > 0 && <ul className="red">{res.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul>}</Done>}
    <div className="grid">
      <Box kind="master" title="1. Master (customers & beats)" accept=".xlsx" sub="Tally → List of Ledgers → Excel (.xlsx). Run this first. Re-importing refreshes group, salesman and days." />
      <Box kind="sales" title="2. Sales Book (XML)" accept=".xml" sub="Tally → Sales Register / Day Book → Export XML. Takes Bill No, Date, Customer and Amount. Safe to re-import: existing bills are skipped." />
      <Box kind="open" title="3. Opening outstanding (optional)" accept=".xlsx,.xls,.csv" sub={"Excel with columns: " + OPEN_COLS.join(", ") + ". Only if you want older pending bills."} />
    </div>
    <div className="card scroll"><h3 style={{ marginTop: 0 }}>Recent imports</h3><table><thead><tr><th>When</th><th>Type</th><th>File</th><th className="n">Added</th><th className="n">Skipped</th><th className="n">Errors</th><th>By</th></tr></thead><tbody>
      {db.logs.map((l) => <tr key={l.id}><td>{l.at}</td><td>{l.kind}</td><td>{l.file}</td><td className="n">{l.added}</td><td className="n">{l.skipped}</td><td className="n">{l.errors}</td><td>{l.who}</td></tr>)}
      {!db.logs.length && <tr><td colSpan="7" className="sub">Nothing imported yet.</td></tr>}</tbody></table></div>
  </>;
}
function Password({ me, flash, back, refresh, forced }) {
  const [o, setO] = useState(""), [n, setN] = useState(""), [n2, setN2] = useState(""), [busy, setBusy] = useState(false);
  const save = async () => {
    if (n.length < 6) return flash("err", "New password must be at least 6 characters"); if (n !== n2) return flash("err", "The two new passwords do not match");
    setBusy(true); try { await API.req("POST", "/api/password", { oldPassword: o, newPassword: n }); flash("ok", "Password changed"); await refresh(); if (back) back(); } catch (e) { flash("err", e.message); } setBusy(false);
  };
  const pw = (label, v, set) => <><label>{label}</label><input type="password" value={v} onChange={(e) => set(e.target.value)} /></>;
  return <div className="card">{forced && <p className="amber">Please set your own password before you continue.</p>}
    {pw("Current password", o, setO)}{pw("New password (min 6 characters)", n, setN)}{pw("New password again", n2, setN2)}<br /><button className="block" disabled={busy} onClick={save}>Save</button></div>;
}

/* ================= app shell ================= */
function Login({ onLogin }) {
  const [u, setU] = useState(""), [p, setP] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const go = async () => {
    if (!u.trim() || !p) return setErr("Enter username and password"); setBusy(true); setErr("");
    try { await API.req("POST", "/api/login", { username: u.trim(), password: p }); await onLogin(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  const enter = (e) => e.key === "Enter" && go();
  return <div className="login">
    <h1 style={{ textAlign: "center", color: "var(--brand)", marginBottom: 2 }}>Gurmeet Motors</h1>
    <p className="sub" style={{ textAlign: "center", marginTop: 0 }}>Collection Management</p>
    {err && <div className="flash err">{err}</div>}
    <div className="card"><label>Username</label><input value={u} onChange={(e) => setU(e.target.value)} autoCapitalize="none" autoComplete="username" onKeyDown={enter} />
      <label>Password</label><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" onKeyDown={enter} /><br /><button className="block" disabled={busy} onClick={go}>{busy ? "Please wait…" : "Login"}</button></div>
  </div>;
}

function Root() {
  const [st, setSt] = useState({ s: "loading" });
  const boot = async () => { try { setSt({ s: "ready", j: await API.req("GET", "/api/state") }); } catch (e) { setSt(e.status === 401 ? { s: "login" } : { s: "error", msg: e.message }); } };
  useEffect(() => { boot(); }, []);
  if (st.s === "loading") return <div className="login"><p className="sub" style={{ textAlign: "center" }}>Loading…</p></div>;
  if (st.s === "error") return <div className="login"><div className="flash err">Cannot reach the server: {st.msg}</div><button className="block" onClick={() => { setSt({ s: "loading" }); boot(); }}>Try again</button></div>;
  if (st.s === "login") return <Login onLogin={boot} />;
  return <App key={st.j.me.id} j={st.j} onLogout={() => setSt({ s: "login" })} />;
}

function App({ j, onLogout }) {
  const [db, setDbRaw] = useState(() => fromState(j)), meId = j.me.id;
  const dbRef = useRef(db), q = useRef({ ops: [], busy: false }), lastSrv = useRef(JSON.stringify(j));
  const [sync, setSync] = useState({ n: 0, err: "" }), [stack, setStack] = useState([]), [tab, setTab] = useState("dash"), [dayRaw, setDay] = useState(null), [fl, setFl] = useState(null);
  const put = (nd) => { dbRef.current = nd; setDbRaw(nd); };
  const refresh = async (force) => {
    const Q = q.current; if (Q.busy || Q.ops.length) return; if (force) lastSrv.current = "";
    try {
      const sj = await API.req("GET", "/api/state"); if (Q.busy || Q.ops.length) return; const str = JSON.stringify(sj);
      if (str !== lastSrv.current) { lastSrv.current = str; put(fromState(sj)); }
    } catch (e) { if (e.status === 401) onLogout(); }
  };
  const flush = async () => {
    const Q = q.current; if (Q.busy) return; Q.busy = true;
    while (Q.ops.length) {
      const batch = Q.ops; Q.ops = []; setSync({ n: batch.length, err: "" });
      try {
        const r = await API.req("POST", "/api/sync", { ops: batch });
        if (r.patched?.collections?.length) { const m = new Map(r.patched.collections.map((c) => [c.id, c])); put({ ...dbRef.current, collections: dbRef.current.collections.map((c) => m.get(c.id) || c) }); }
        if (r.errors?.length) flash("err", "Some changes were not accepted: " + r.errors.slice(0, 2).join("; "));
      } catch (e) {
        if (e.status === 401) { Q.busy = false; return onLogout(); }
        Q.ops = [...batch, ...Q.ops]; setSync({ n: Q.ops.length, err: "No connection – your entries are kept and will be saved automatically" }); Q.busy = false; setTimeout(flush, 5000); return;
      }
    }
    Q.busy = false; setSync({ n: 0, err: "" }); refresh(true);
  };
  const setDb = (d) => { const ops = diffOps(dbRef.current, d); put(d); if (ops.length) { q.current.ops.push(...ops); setSync((x) => ({ ...x, n: x.n || 1 })); flush(); } };
  useEffect(() => {
    const t = setInterval(() => refresh(), 20000), v = () => { if (!document.hidden) refresh(); };
    const bu = (e) => { if (q.current.ops.length || q.current.busy) { e.preventDefault(); e.returnValue = ""; } };
    document.addEventListener("visibilitychange", v); window.addEventListener("beforeunload", bu);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", v); window.removeEventListener("beforeunload", bu); };
  }, []);
  const flash = (t, m) => { try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { } setFl({ t, m }); setTimeout(() => setFl(null), 3500); };
  const me = db.users.find((u) => u.id === meId) || j.me;
  const saveColl = (c, al) => {
    const cid = uid(), today = iso(new Date()), d = c.date || today, n = (db.advSeq || 0) + (c.advance > 0 ? 1 : 0);
    setDb({
      ...db, advSeq: n, collections: [...db.collections, { ...c, id: cid, salesmanId: me.id, date: d, enteredOn: today, dateChanged: d !== today, advRef: c.advance > 0 ? "ADV-" + String(n).padStart(4, "0") : "", status: "provisional", at: new Date().toISOString() }],
      allocs: [...db.allocs, ...al.map((a) => ({ id: uid(), billId: a.billId, amount: a.amount, kind: c.kind || "receipt", status: "provisional", collectionId: cid, date: d }))]
    });
    setStack([...stack.slice(0, -1), { page: "done", id: cid }]);
  };
  const logout = async () => { try { await API.req("POST", "/api/logout"); } catch (e) { } setFl(null); onLogout(); };
  if (me.mustChange) return <><Top title="Set your password" user={me} logout={logout} /><div className="wrap"><Flash f={fl} /><Password me={me} flash={flash} refresh={() => refresh(true)} forced /></div></>;

  const go = (p) => setStack([...stack, p]), back = () => setStack(stack.slice(0, -1));
  const pendingN = db.collections.filter((c) => c.status === "provisional").length;
  const cur = stack[stack.length - 1], isSM = me.role === "salesman", isAdmin = me.role === "admin";
  let title, body;
  if (cur) {
    const { id, adj } = cur, party = db.parties.find((p) => p.id === id);
    [title, body] = ({
      party: () => [party.name, <PartyView db={db} id={id} go={go} canCollect={isSM} flash={flash} />],
      bill: () => [db.bills.find((b) => b.id === id).no, <BillView db={db} id={id} />],
      ledger: () => ["Ledger", <Ledger db={db} id={id} flash={flash} me={me} setDb={setDb} />],
      pick: () => [adj ? "Return / Discount – choose party" : "Collect Payment – choose party", <CollectPick db={db} me={me} go={go} adj={adj} />],
      collect: () => [(adj ? "Return / Discount: " : "Collect: ") + party.name, <CollectForm key={id + (adj ? "a" : "")} db={db} id={id} onSave={saveColl} adj={adj} />],
      done: () => ["Saved", <CollectDone db={db} cid={id} go={go} home={() => setStack([])} />],
      pbreport: () => ["Pending Bills Report", <PendingReport db={db} me={me} flash={flash} day0={cur.day >= 0 ? cur.day : "all"} />],
      mycoll: () => ["My Collections", <MyCollections db={db} me={me} go={go} flash={flash} />],
      pw: () => ["Change Password", <Password me={me} flash={flash} back={back} refresh={() => refresh(true)} />],
    })[cur.page]?.() || [];
  } else if (isSM) { const day = effDay(db, me, dayRaw); title = day < 0 ? "All my parties" : DAYS[day] + (day === todayDay() ? " (Today)" : ""); body = <SMHome db={db} me={me} go={go} day={day} setDay={setDay} />; }
  else {
    const [t, f] = tab.split(":"), P = { db, setDb, me, flash }; title = "Management Console";
    const tabs = [["dash", "Dashboard"], ["coll", "Confirm Collections" + (pendingN > 0 ? ` (${pendingN})` : "")], ["reports", "Reports"], ["tally", "Tally Export"], ...(isAdmin ? [["audit", "Audit Log"], ["parties", "Parties"], ["routes", "Beats"], ["import", "Import"], ["users", "Users"]] : [])];
    const adminOnly = { audit: <AuditLog db={db} />, parties: <AdminParties {...P} flt={f || ""} setFlt={(v) => setTab(v ? "parties:" + v : "parties")} go={go} />, routes: <AdminRoutes {...P} />, import: <AdminImport {...P} setTab={setTab} />, users: <AdminUsers {...P} /> };
    body = <>
      <div className="nav">{tabs.map(([k, v]) => <a key={k} className={t === k ? "on" : ""} onClick={() => setTab(k)}>{v}</a>)}</div>
      {t === "dash" && <Dashboard db={db} setTab={setTab} />}
      {t === "coll" && <ConfirmCollections {...P} />}
      {t === "tally" && <TallyExport {...P} />}
      {t === "reports" && <ReportsHub {...P} />}
      {isAdmin && adminOnly[t]}
    </>;
  }
  return <>
    {(sync.n > 0 || sync.err) && <div className="demo">{sync.err || "Saving…"}</div>}
    <Top title={title} back={cur ? (cur.page === "done" ? () => setStack([]) : back) : null} user={me} logout={logout} onPw={() => go({ page: "pw" })} />
    <div className={"wrap " + (!isSM && !cur ? "wide" : "")}><Flash f={fl} />{body}</div>
  </>;
}

export default function Page() { return <Root />; }