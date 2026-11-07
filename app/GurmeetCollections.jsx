const { useState, useEffect } = React;

/* ================= constants & helpers ================= */
const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const LOCS = ["Ranchi (HO)","Barhi","Jamshedpur","Palamu"];
const STORE = "gurmeet_step2_v1";
// Top-level Tally groups that mean "a salesman". "(All)" groups use the name before "(".
const SALESMAN_ALIASES = { "boss": "Ajay", "head office": "Ajay" };
const PRIMARY_GROUPS = new Set(["Fixed Assets","Investments","Misc. Expenses (ASSET)","Liabilities","Branch / Divisions","Capital Account","Reserves & Surplus","Current Liabilities","Duties & Taxes","Provisions","Sundry Creditors","Loans (Liability)","Bank OD A/c","Secured Loans","Unsecured Loans","Suspense A/c","Expenses","Direct Expenses","Indirect Expenses","Purchase Accounts","Income","Direct Incomes","Indirect Incomes","Sales Accounts"]);

const todayDay = () => (new Date().getDay() + 6) % 7;                // Mon=0
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate()+n); return iso(d); };
const dmy = (s) => s ? s.split("-").reverse().join("-") : "";
const ageOf = (s) => Math.floor((new Date(iso(new Date())+"T12:00:00") - new Date(s+"T12:00:00")) / 864e5);
const money = (v) => { v = Number(v||0); return (v<0?"-":"") + "₹" + Math.abs(v).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}); };
const daysTxt = (d) => d && d.length ? d.map(i=>DAYS[i].slice(0,3)).join(", ") : "No fixed day";
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
let seq = Date.now() + Math.floor(Math.random()*4000000); const uid = () => ++seq;
const locFromCompany = (c) => { const s=(c||"").split("-").pop().trim().toLowerCase(); return s && LOCS.find(l=>l.toLowerCase().startsWith(s)) || null; };

/* ================= state ================= */
const baseUsers = () => [];
const defaultTally = () => ({company:"Gurmeet Motors Pvt Ltd - Ranchi", cash:"Cash", bank:"Bank", cheque:"Cheque in Hand", salesReturn:"Sales Return", discount:"Discount Allowed", other:"Other Adjustments", bankAlloc:true});
const emptyDb = () => ({users:baseUsers(),parties:[],bills:[],allocs:[],collections:[],advAdj:[],advSeq:0,audit:[],tally:defaultTally(),tombstones:[],expBatches:[],logs:[]});
const fromState = (j) => ({users:j.users||[],parties:j.parties||[],bills:j.bills||[],allocs:j.allocs||[],collections:j.collections||[],advAdj:j.advAdj||[],advSeq:j.advSeq||0,audit:j.audit||[],
  tally:{...defaultTally(),...(j.tally||{})},tombstones:j.tombstones||[],expBatches:j.expBatches||[],logs:j.logs||[]});

/* ================= server connection & saving ================= */
const API = { async req(method, url, body){
  const r = await fetch(url,{method,headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined,credentials:"same-origin"});
  let j=null; try{ j=await r.json(); }catch(e){}
  if(!r.ok){ const e=new Error((j&&j.error)||("Server error "+r.status)); e.status=r.status; throw e; } return j; } };
const SYNC_KEYS = ["users","parties","bills","allocs","collections","advAdj","audit","tombstones","expBatches","logs"];
function diffOps(a, b) {
  const ops = [];
  SYNC_KEYS.forEach(k=>{ if(a[k]===b[k]) return;
    const am = new Map(a[k].map(x=>[x.id,x])); const up = [];
    b[k].forEach(x=>{ const y=am.get(x.id); if(!y || (y!==x && JSON.stringify(y)!==JSON.stringify(x))) up.push(x); am.delete(x.id); });
    const del = [...am.keys()];
    if(up.length||del.length) ops.push({c:k,upsert:up,del}); });
  if(a.tally!==b.tally && JSON.stringify(a.tally)!==JSON.stringify(b.tally)) ops.push({tally:b.tally});
  return ops;
}

/* ================= calculations ================= */
function billCalc(db, b) {
  const al = db.allocs.filter(a => a.billId === b.id);
  const settled = al.filter(a=>a.status==="confirmed").reduce((s,a)=>s+a.amount,0);
  const prov = al.filter(a=>a.status==="provisional").reduce((s,a)=>s+a.amount,0);
  return {...b, settled, prov, pending: Math.round((b.amount-settled-prov)*100)/100, open: Math.round((b.amount-settled-prov)*100)/100, age: ageOf(b.date)};
}
const partyBills = (db, pid, onlyPending=true) =>
  db.bills.filter(b=>b.partyId===pid).map(b=>billCalc(db,b)).filter(b=>!onlyPending||b.pending>0.005).sort((a,b)=>a.date.localeCompare(b.date));
function advanceInfo(db, pid) {
  const cols = db.collections.filter(c=>c.partyId===pid&&c.status!=="rejected"&&c.advance>0);
  const used = {}; (db.advAdj||[]).filter(a=>a.partyId===pid).forEach(a=>a.advances.forEach(x=>{ used[x.advRef]=(used[x.advRef]||0)+x.amount; }));
  const rem = cols.map(c=>({c, advRef:c.advRef, remaining:Math.round((c.advance-(used[c.advRef]||0))*100)/100})).filter(r=>r.remaining>0.005);
  const parts = rem.filter(r=>r.c.status==="confirmed").sort((a,b)=>(a.c.postDate||a.c.date).localeCompare(b.c.postDate||b.c.date)||a.c.id-b.c.id);
  const sm = (l)=>Math.round(l.reduce((a,r)=>a+r.remaining,0)*100)/100;
  return {total:sm(rem), adjustable:sm(parts), parts};
}
function partySummary(db, p) {
  const bs = partyBills(db, p.id);
  return {...p, advance: advanceInfo(db,p.id).total, outstanding: bs.reduce((s,b)=>s+b.pending,0), prov: bs.reduce((s,b)=>s+b.prov,0), open: bs.length, oldest: bs[0]?.date};
}

/* ================= Tally MASTER (xlsx "List of Ledgers") ================= */
// "Lohardaga(1/6)" -> [0,5] ; "Ranchi(Dk)-1/4" -> [0,3] ; "Kujju(2&5)" -> [1,4] ; "(All)" / none -> []
function parseDays(name) {
  const s = name.replace(/\([A-Za-z\s.]*\)/g, "");
  const m = s.match(/(\d[\d\s\/&,\-]*)\)?\s*$/); if (!m) return [];
  return [...new Set((m[1].match(/\d+/g)||[]).map(Number).filter(n=>n>=1&&n<=7).map(n=>n-1))].sort();
}
function salesmanOf(name) {
  const k = name.trim().toLowerCase(); if (SALESMAN_ALIASES[k]) return SALESMAN_ALIASES[k];
  const m = name.match(/^(.+?)\s*\(\s*all\s*\)\s*$/i); return m ? m[1].trim() : null;
}
async function readMasterFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:"array"}); const ws = wb.Sheets[wb.SheetNames[0]];
  const ref = XLSX.utils.decode_range(ws["!ref"]); const vals = [];
  for (let r=0; r<=ref.e.r; r++) { const c = ws[XLSX.utils.encode_cell({r,c:0})]; vals.push(c && c.v!=null ? String(c.v).trim() : ""); }
  // Tally prints groups in bold – SheetJS community build ignores styles, so read bold flags straight from the xlsx.
  const zip = await JSZip.loadAsync(buf), P = (t)=>new DOMParser().parseFromString(t,"text/xml");
  const st = P(await zip.file("xl/styles.xml").async("string"));
  const fontBold = [...st.getElementsByTagName("fonts")[0].children].map(f=>{ const b=f.getElementsByTagName("b")[0]; return !!b && b.getAttribute("val")!=="0"; });
  const xfFont = [...st.getElementsByTagName("cellXfs")[0].children].map(x=>+(x.getAttribute("fontId")||0));
  const sheetFile = Object.keys(zip.files).filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  const sh = P(await zip.file(sheetFile).async("string")); const bold = [];
  [...sh.getElementsByTagName("c")].forEach(c=>{ const r=c.getAttribute("r")||""; if(/^A\d+$/.test(r)) bold[+r.slice(1)-1] = !!fontBold[xfFont[+(c.getAttribute("s")||0)]]; });
  return {vals, bold};
}
function buildMaster({vals, bold}) {
  const company = vals[0] || "";
  const start = vals.findIndex((v,i)=>bold[i] && v==="Sundry Debtors");
  if (start < 0) throw new Error("'Sundry Debtors' group not found. Please export 'List of Ledgers' from Tally.");
  const parties = [], salesmen = new Set(); let sm=null, group=null, gdays=[], parentDays=null, noBeats=false;
  for (let i=start+1; i<vals.length; i++) {
    const v = vals[i]; if (!v) continue;
    if (bold[i] && PRIMARY_GROUPS.has(v)) break;
    if (/^\d+ Group/.test(v)) break;
    if (bold[i]) {
      const s = salesmanOf(v);
      if (s) { sm = s; noBeats = !!SALESMAN_ALIASES[v.trim().toLowerCase()]; salesmen.add(s); group = v; gdays = []; parentDays = null; continue; }
      const own = parseDays(v), nextIsGroup = !!bold[i+1];
      if (nextIsGroup && own.length) parentDays = own;              // empty heading that carries days for the groups below it
      group = v; gdays = own.length ? own : (parentDays || []);
    } else parties.push({name:v, group, sm, days: noBeats ? [] : gdays});
  }
  const used = new Set(parties.map(p=>p.sm).filter(Boolean));
  return {company, parties, salesmen:[...salesmen].filter(x=>used.has(x))};
}
function applyMaster(db, m) {
  const loc = locFromCompany(m.company) || "Ranchi (HO)";
  const users = [...db.users], creds = [], smId = {};
  m.salesmen.forEach(n=>{
    const un = n.toLowerCase().replace(/\s+/g,"");
    let u = users.find(x=>x.username===un);
    if (!u) { u = {id:uid(),username:un,password:un+"123",name:n,role:"salesman",active:true,loc}; users.push(u); creds.push(`${un} / ${un}123`); }
    smId[n] = u.id; });
  const parties = [...db.parties]; let added=0, updated=0;
  m.parties.forEach(p=>{
    const f = {loc, group:p.group||"", salesmanId:p.sm?smId[p.sm]:null, days:p.days};
    const ex = parties.find(x=>x.name.toLowerCase()===p.name.toLowerCase());
    if (ex) { Object.assign(ex, f); updated++; } else { parties.push({id:uid(),name:p.name,phone:"",active:true,...f}); added++; } });
  return {users, parties, res:{added, updated, creds, loc, salesmen:m.salesmen, groups:new Set(m.parties.map(p=>p.group)).size}};
}

/* ================= Tally SALES BOOK (xml) ================= */
const unesc = (s) => s.replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n)).replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&").trim();
const tag = (s,t) => { const m = s.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? unesc(m[1]) : ""; };
async function readSalesXml(file) {
  const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf);
  const enc = (u8[0]===0xFF&&u8[1]===0xFE) ? "utf-16le" : (u8[0]===0xFE&&u8[1]===0xFF) ? "utf-16be" : "utf-8";
  const txt = new TextDecoder(enc).decode(buf);
  if (!txt.includes("<VOUCHER ")) throw new Error("No vouchers found. Export Day Book / Sales Register from Tally as XML.");
  const company = tag(txt, "SVCURRENTCOMPANY"); const out = {company, vouchers:[], cancelled:0, other:{}, noParty:0};
  txt.split("<VOUCHER ").slice(1).forEach(ch=>{
    ch = ch.split("</VOUCHER>")[0]; const head = ch.slice(0, ch.indexOf(">"));
    const type = (head.match(/VCHTYPE="([^"]*)"/)||[])[1] || "", action = (head.match(/ACTION="([^"]*)"/)||[])[1] || "";
    if (action==="Cancel" || tag(ch,"ISCANCELLED")==="Yes" || tag(ch,"ISOPTIONAL")==="Yes") { out.cancelled++; return; }
    if (type!=="Sales") { out.other[type] = (out.other[type]||0)+1; return; }
    const party = tag(ch,"PARTYLEDGERNAME"), no = tag(ch,"VOUCHERNUMBER"), d = tag(ch,"DATE");
    let amt = null;
    ch.split(/<(?:ALL)?LEDGERENTRIES\.LIST>/).slice(1).forEach(b=>{ if (amt===null && tag(b,"LEDGERNAME")===party) { const a=parseFloat(tag(b,"AMOUNT")); if(!isNaN(a)) amt=Math.abs(a); } });
    if (!party || !no || !/^\d{8}$/.test(d) || !amt) { out.noParty++; return; }
    out.vouchers.push({party, no, date:`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`, amount:Math.round(amt*100)/100});
  });
  return out;
}
function applySales(db, x) {
  const loc = locFromCompany(x.company) || "Ranchi (HO)"; const parties=[...db.parties], bills=[...db.bills];
  const res = {added:0, skipped:[], created:[], total:0, loc, cancelled:x.cancelled, other:x.other, bad:x.noParty};
  x.vouchers.forEach(v=>{
    let p = parties.find(q=>q.name.toLowerCase()===v.party.toLowerCase());
    if (!p) { p = {id:uid(),name:v.party,loc,group:"",salesmanId:null,days:[],phone:"",active:true}; parties.push(p); res.created.push(v.party); }
    if (bills.some(b=>b.partyId===p.id && b.no===v.no)) { res.skipped.push(v.no); return; }
    bills.push({id:uid(),partyId:p.id,no:v.no,date:v.date,due:addDays(v.date,30),amount:v.amount,source:"sales"}); res.added++; res.total += v.amount; });
  return {parties, bills, res};
}

/* ================= opening outstanding (Excel, optional) ================= */
const OPEN_COLS=["Party Name","Bill No","Bill Date","Pending Amount"];
function pDate(v){
  if(v===""||v==null) return null;
  if(v instanceof Date){ const d=new Date(v.getTime()+12*36e5); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`; }
  const s=String(v).trim(); let m;
  if((m=s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/))) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  if((m=s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  throw new Error(`bad date '${s}'`);
}
async function importOpening(db, file) {
  const wb = XLSX.read(await file.arrayBuffer(), {type:"array", cellDates:true});
  const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
  if(!json.length) throw new Error("The file is empty");
  const have = Object.keys(json[0]).map(h=>h.trim().toLowerCase());
  const miss = OPEN_COLS.find(c=>!have.includes(c.toLowerCase())); if(miss) throw new Error(`Column '${miss}' not found. Needed: ${OPEN_COLS.join(", ")}`);
  const parties=[...db.parties], bills=[...db.bills]; const res={added:0,skipped:[],errors:[],created:[]};
  json.forEach((raw,i)=>{ const r={}; Object.keys(raw).forEach(k=>r[k.trim().toLowerCase()]=raw[k]);
    try {
      const name=String(r["party name"]).trim(), no=String(r["bill no"]).trim(), amt=Number(String(r["pending amount"]).replace(/,/g,"")), dt=pDate(r["bill date"]);
      if(!name||!no||!(amt>0)||!dt) throw new Error("Party / Bill No / Date / Pending Amount missing");
      let p=parties.find(q=>q.name.toLowerCase()===name.toLowerCase());
      if(!p){ p={id:uid(),name,loc:"Ranchi (HO)",group:"",salesmanId:null,days:[],phone:"",active:true}; parties.push(p); res.created.push(name); }
      if(bills.some(b=>b.partyId===p.id&&b.no===no)){ res.skipped.push(no); return; }
      bills.push({id:uid(),partyId:p.id,no,date:dt,due:addDays(dt,30),amount:amt,source:"opening"}); res.added++;
    } catch(e){ res.errors.push(`Row ${i+2}: ${e.message}`); }});
  return {parties,bills,res};
}


/* ================= PDF helpers ================= */
const BROWSER_DL = { save: async ({filename, data}) => { const blob = (typeof Blob!=="undefined" && data instanceof Blob) ? data : new Blob([data]);
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 15000); } };
function useDl(){ return BROWSER_DL; }
async function savePdf(dl, filename, build, flash){
  try { if(!window.jspdf) throw new Error("PDF library did not load"); await dl.save({filename, data:build()}); }
  catch(e){ if(e && e.code==="declined") return; flash("err","Could not create PDF: "+(e.message||e.code||"error")); } }
const PdfBtn = ({dl, label, onClick, cls="sec sm", style}) => dl ? <button className={cls} style={style} onClick={onClick}>⬇ {label||"Download PDF"}</button> : null;
const safeName = (s) => String(s).replace(/[^A-Za-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,40);
function pdfHeader(doc, title, lines) {
  doc.setFontSize(16); doc.text(title, 14, 16); doc.setFontSize(10);
  lines.forEach((l,i)=>doc.text(l, 14, 24+i*6)); return 24+lines.length*6; }
function pdfPageNumbers(doc){ const n=doc.getNumberOfPages(); for(let i=1;i<=n;i++){ doc.setPage(i); doc.setFontSize(8); doc.text(`Page ${i} of ${n}`, doc.internal.pageSize.getWidth()-30, doc.internal.pageSize.getHeight()-8); } }
function ledgerRows(db, id) {
  const bs = db.bills.filter(b=>b.partyId===id); const e = [];
  bs.forEach(b=>e.push({date:b.date,k:b.id,kind:b.source==="opening"?"Opening Balance":b.source==="manual"?"Bill (added by admin)":"Sales Bill",ref:b.no,dr:b.amount,cr:0,t:"bill",eid:b.id}));
  db.allocs.filter(a=>a.status!=="rejected"&&a.kind!=="advadj"&&bs.some(b=>b.id===a.billId)).forEach(a=>{ const c=db.collections.find(x=>x.id===a.collectionId);
    e.push({date:a.date,k:a.id+1e9,kind:(ADJ[a.kind]||("Receipt"+(c?` (${modeLabel(c)})`:"")))+(a.status==="confirmed"?"":" (not yet posted)"),ref:bs.find(b=>b.id===a.billId).no,dr:0,cr:a.amount,t:c?"coll":"",eid:c?.id}); });
  db.collections.filter(c=>c.partyId===id&&c.status!=="rejected"&&c.advance>0).forEach(c=>e.push({date:c.postDate||c.date,k:c.id+2e9,kind:`Advance received (${modeLabel(c)})`+(c.status==="confirmed"?"":" (not yet posted)"),ref:c.advRef,dr:0,cr:c.advance,t:"coll",eid:c.id}));
  (db.advAdj||[]).filter(a=>a.partyId===id).forEach(a=>{
    e.push({date:a.date,k:a.id+3e9,kind:"Journal: advance adjusted (from advance)",ref:a.advances.map(x=>x.advRef).join(", "),dr:a.total,cr:0,t:"adj",eid:a.id});
    e.push({date:a.date,k:a.id+3e9+1,kind:"Journal: advance adjusted against bill",ref:a.bills.map(x=>x.no).join(", "),dr:0,cr:a.total,t:"adj",eid:a.id}); });
  e.sort((x,y)=>x.date.localeCompare(y.date)||x.k-y.k); let bal=0; e.forEach(r=>{bal+=r.dr-r.cr; r.bal=bal;});
  return {rows:e, bal};
}
function makeLedgerPdf(db, p) {
  const { jsPDF } = window.jspdf; const doc = new jsPDF(); const {rows,bal} = ledgerRows(db,p.id);
  const sm = db.users.find(u=>u.id===p.salesmanId);
  const y = pdfHeader(doc, "Gurmeet Motors - Party Ledger", [`Party: ${p.name}`, `${p.loc||""}${p.group?" | "+p.group:""}${sm?" | Salesman: "+sm.name:""}`, `As on: ${dmy(iso(new Date()))}   (generated ${new Date().toLocaleString("en-IN")})`]);
  doc.autoTable({startY:y, head:[["Date","Particulars","Bill No","Debit","Credit","Balance"]],
    body: rows.map(r=>[dmy(r.date), r.kind, r.ref, r.dr?rsf(r.dr):"", r.cr?rsf(r.cr):"", rsf(r.bal)]),
    foot: [["","Closing balance","", "", "", rsf(Math.abs(bal))+(bal>0?" Dr":bal<0?" Cr":"")]],
    styles:{fontSize:8}, headStyles:{fillColor:[11,92,173]}, footStyles:{fillColor:[240,240,240],textColor:0},
    columnStyles:{3:{halign:"right"},4:{halign:"right"},5:{halign:"right"}}});
  pdfPageNumbers(doc); return doc.output("blob");
}
function makePendingPdf(db, parties, title, filterLines) {
  const { jsPDF } = window.jspdf; const doc = new jsPDF(); const body = []; let grand = 0, nb = 0;
  parties.forEach(p=>{ const bs = partyBills(db,p.id); if(!bs.length) return; const tot = bs.reduce((a,b)=>a+b.pending,0); grand += tot; nb += bs.length;
    body.push([{content:`${p.name}${p.group?"   ["+p.group+"]":""}`, colSpan:5, styles:{fontStyle:"bold", fillColor:[235,243,251]}}]);
    bs.forEach(b=>body.push([b.no, dmy(b.date), String(b.age), rsf(b.amount), rsf(b.pending)]));
    body.push([{content:"Party total", colSpan:4, styles:{fontStyle:"bold", halign:"right"}}, {content:rsf(tot), styles:{fontStyle:"bold", halign:"right"}}]); });
  const y = pdfHeader(doc, title, [...filterLines, `${parties.length} part${parties.length===1?"y":"ies"} | ${nb} bill${nb===1?"":"s"} | Total pending: ${rsf(grand)}`, `Generated: ${new Date().toLocaleString("en-IN")}`]);
  doc.autoTable({startY:y, head:[["Bill No","Bill Date","Days","Bill Amount","Pending"]], body,
    foot:[[{content:"GRAND TOTAL", colSpan:4, styles:{halign:"right"}}, {content:rsf(grand), styles:{halign:"right"}}]],
    styles:{fontSize:8}, headStyles:{fillColor:[11,92,173]}, footStyles:{fillColor:[240,240,240],textColor:0},
    columnStyles:{2:{halign:"right"},3:{halign:"right"},4:{halign:"right"}}});
  pdfPageNumbers(doc); return doc.output("blob");
}

/* ================= small UI parts ================= */
const Top = ({title, back, user, logout, onPw}) => (
  <div className="top">{back && <div className="back" onClick={back}>‹</div>}<h1>{title}</h1>
    {user && <><span onClick={onPw}>{user.name.split(" ")[0]}</span><span onClick={logout}>Logout</span></>}</div>);
const Flash = ({f}) => f ? <div className={"flash "+f.t}>{f.m}</div> : null;
const ageCls = (a)=> a>60?"bad":a>30?"warn":"ok";
const DayChips = ({days, onChange}) => <div className="dchips">{DAYS.map((d,i)=>
  <a key={i} className={days.includes(i)?"on":""} onClick={()=>onChange(days.includes(i)?days.filter(x=>x!==i):[...days,i].sort())}>{d.slice(0,3)}</a>)}</div>;

/* ================= salesman screens ================= */
const hasBeats = (db, me) => db.parties.some(p=>p.active&&p.salesmanId===me.id&&p.days.length);
const effDay = (db, me, day) => day!==null ? day : (hasBeats(db,me) ? todayDay() : -1);   // -1 = "All"

const MODES = {cash:"Cash", cheque:"Cheque", online:"Bank / UPI"};
const ADJ = {return:"Goods Return", discount:"Discount", other:"Other Adjustment"};
const isAdj = (c) => !!c.kind && c.kind!=="receipt";
const modeLabel = (c) => isAdj(c) ? ADJ[c.kind] : MODES[c.mode];
const postingDate = (c) => c.enteredOn || c.date;      // date the entry was made in the system (cannot be edited)
const sumAmt = (l) => Math.round(l.reduce((a,c)=>a+c.amount,0)*100)/100;
function breakdownTxt(l, fmt) {
  const r = l.filter(c=>!isAdj(c)), a = l.filter(isAdj);
  return Object.entries(MODES).map(([k,v])=>`${v}: ${fmt(sumAmt(r.filter(c=>c.mode===k)))}`).join("  ·  ")
    + (a.length ? "  |  " + Object.entries(ADJ).filter(([k])=>a.some(c=>c.kind===k)).map(([k,v])=>`${v}: ${fmt(sumAmt(a.filter(c=>c.kind===k)))}`).join("  ·  ") : ""); }
function PartyCard({r, go, showDays}) {
  return <div className="card tap" onClick={()=>go({page:"party",id:r.id})}>
    <div className="row"><div className="name">{r.name}</div><div className={"amt "+(r.outstanding>0?"red":"")}>{money(r.outstanding)}</div></div>
    <div className="sub">{r.group?`${r.group} · `:""}{r.open} open bill{r.open===1?"":"s"}{r.oldest?` · oldest ${dmy(r.oldest)}`:""}{showDays?` · ${daysTxt(r.days)}`:""}</div>
    {r.advance>0 && <div className="green sub">Advance on account: {money(r.advance)}</div>}</div>;
}
function SMHome({db, me, go, day, setDay}) {
  const [q,setQ]=useState(""); const [showZero,setSZ]=useState(false);
  const mine = db.parties.filter(p=>p.active&&p.salesmanId===me.id).map(p=>partySummary(db,p));
  const s = q.trim().toLowerCase(); let rows, zero=[];
  if (s) rows = mine.filter(r=>r.name.toLowerCase().includes(s)).sort((a,b)=>a.name.localeCompare(b.name));
  else { const base = day>=0 ? mine.filter(r=>r.days.includes(day)) : mine;
    rows = base.filter(r=>r.outstanding>0.005); zero = base.filter(r=>r.outstanding<=0.005);
    if (day<0) rows.sort((a,b)=>b.outstanding-a.outstanding); }
  const total = rows.reduce((a,r)=>a+r.outstanding,0);
  const todayColl = db.collections.filter(c=>c.salesmanId===me.id&&!isAdj(c)&&c.status!=="rejected"&&postingDate(c)===iso(new Date())).reduce((a,c)=>a+c.amount,0);
  return <>
    <button className="block" style={{fontSize:20,padding:16}} onClick={()=>go({page:"pick"})}>＋ Collect Payment</button>
    <div style={{height:8}}/>
    <div className="row" style={{gap:8}}><button className="sec" style={{flex:1}} onClick={()=>go({page:"mycoll"})}>My Collections{todayColl>0?` · ${money(todayColl)}`:""}</button>
      <button className="sec" style={{flex:1}} onClick={()=>go({page:"pbreport",day:day})}>Pending Bills Report</button></div>
    <div style={{height:8}}/><button className="sec block" onClick={()=>go({page:"pick",adj:true})}>↩ Goods Return / Discount</button>
    <input placeholder="🔍 Search any party…" value={q} onChange={e=>setQ(e.target.value)} style={{margin:"12px 0"}}/>
    {!s && <div className="tabs"><a className={day<0?"on":""} onClick={()=>setDay(-1)}>All</a>
      {DAYS.map((d,i)=><a key={i} className={i===day?"on":""} onClick={()=>setDay(i)}>{d.slice(0,3)}</a>)}</div>}
    <div className="card row"><div><div className="sub">{s?"Search results (all parties)":day<0?"Pending with all my parties":`To collect on ${DAYS[day]}`}</div><div className="big">{money(total)}</div></div><div className="sub">{rows.length} parties</div></div>
    {rows.map(r=><PartyCard key={r.id} r={r} go={go} showDays={day<0||!!s}/>)}
    {!rows.length && <div className="card empty">{s?"No party found.":day<0?"No pending balances.":`No pending balances for ${DAYS[day]}.`}</div>}
    {zero.length>0 && <><button className="sec block" style={{marginBottom:12}} onClick={()=>setSZ(!showZero)}>{showZero?"Hide":"Show"} {zero.length} part{zero.length===1?"y":"ies"} with zero balance</button>
      {showZero && zero.map(r=><PartyCard key={r.id} r={r} go={go} showDays={day<0}/>)}</>}
  </>;
}
function PendingReport({db, me, flash, day0}) {
  const dl = useDl(); const isSM = me.role==="salesman";
  const [day,setDay]=useState(day0===undefined?"all":day0); const [smf,setSmf]=useState(""); const [loc,setLoc]=useState("");
  const parties = db.parties.filter(p=>p.active&&(isSM?p.salesmanId===me.id:(!smf||p.salesmanId===+smf))&&(!loc||p.loc===loc)&&(day==="all"||p.days.includes(day)))
    .map(p=>partySummary(db,p)).filter(r=>r.outstanding>0.005).sort((a,b)=>a.name.localeCompare(b.name));
  const bills = parties.flatMap(p=>partyBills(db,p.id)); const total = bills.reduce((a,b)=>a+b.pending,0);
  const bucket = (lo,hi)=>bills.filter(b=>b.age>=lo&&b.age<=hi).reduce((a,b)=>a+b.pending,0);
  const lines = [`Salesman: ${isSM?me.name:(smf?db.users.find(u=>u.id===+smf)?.name:"All")}`, `Location: ${loc||"All"}   |   Day: ${day==="all"?"All days":DAYS[day]}`];
  return <>
    <div className="card"><h3 style={{marginTop:0}}>Pending Bills Report</h3>
      {!isSM && <div className="row" style={{gap:8}}><div style={{flex:1}}><label style={{marginTop:0}}>Salesman</label><select value={smf} onChange={e=>setSmf(e.target.value)}><option value="">All</option>{db.users.filter(u=>u.role==="salesman").map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <div style={{flex:1}}><label style={{marginTop:0}}>Location</label><select value={loc} onChange={e=>setLoc(e.target.value)}><option value="">All</option>{LOCS.map(l=><option key={l}>{l}</option>)}</select></div></div>}
      <label>Visit day</label><div className="tabs" style={{marginBottom:0}}><a className={day==="all"?"on":""} onClick={()=>setDay("all")}>All days</a>{DAYS.map((d,i)=><a key={i} className={day===i?"on":""} onClick={()=>setDay(i)}>{d.slice(0,3)}</a>)}</div></div>
    <div className="card"><div className="sub">Total pending</div><div className="big red">{money(total)}</div>
      <div className="sub">{parties.length} parties · {bills.length} bills</div>
      <div className="sub" style={{marginTop:6}}>0-30 days: {money(bucket(0,30))} · 31-60: {money(bucket(31,60))} · 61+: {money(bucket(61,99999))}</div>
      {parties.length>0 && <PdfBtn dl={dl} label="Download / Print PDF" cls="" style={{marginTop:10}} onClick={()=>savePdf(dl,`PendingBills_${day==="all"?"All":DAYS[day]}_${iso(new Date())}.pdf`,()=>makePendingPdf(db,parties,"Gurmeet Motors - Pending Bills Report",lines),flash)}/>}
      {parties.length>0 && !dl && <div className="sub" style={{marginTop:8}}>PDF download works in the published page.</div>}</div>
    <div className="card scroll"><table><thead><tr><th>Party</th><th className="n">Bills</th><th className="n">Pending</th></tr></thead><tbody>
      {parties.slice(0,150).map(r=><tr key={r.id}><td>{r.name}<div className="sub">{r.group}</div></td><td className="n">{r.open}</td><td className="n">{money(r.outstanding)}</td></tr>)}
      {!parties.length && <tr><td colSpan="3" className="empty">No pending bills for this selection.</td></tr>}</tbody></table>
      {parties.length>150 && <div className="sub" style={{padding:8}}>Showing first 150 – the PDF has all {parties.length}.</div>}</div>
  </>;
}
/* ================= accounts: confirm collections ================= */
function confirmEntries(db, me, items) {      // items: [{id, postDate, bankDate}]
  const m = Object.fromEntries(items.map(i=>[i.id,i])); const now = new Date().toISOString();
  return {...db,
    collections: db.collections.map(c=>m[c.id]?{...c,status:"confirmed",confirmedBy:me.id,confirmedAt:now,postDate:m[c.id].postDate,bankDate:m[c.id].bankDate||""}:c),
    allocs: db.allocs.map(a=>m[a.collectionId]&&a.status==="provisional"?{...a,status:"confirmed",date:m[a.collectionId].postDate}:a)};
}
function rejectEntry(db, me, id, reason) {
  return {...db, collections: db.collections.map(c=>c.id===id?{...c,status:"rejected",reason,rejectedBy:me.id,rejectedAt:new Date().toISOString()}:c),
    allocs: db.allocs.map(a=>a.collectionId===id&&a.status!=="rejected"?{...a,status:"rejected"}:a)};
}
function ConfirmCollections({db, setDb, me, flash}) {
  const t = iso(new Date());
  const [tab,setTab]=useState("pending"); const [smf,setSmf]=useState(""); const [off,setOff]=useState({}); const [onlyFlag,setOnlyFlag]=useState(false);
  const [dates,setDates]=useState({}); const [rej,setRej]=useState(null); const [reason,setReason]=useState("");
  const [from,setFrom]=useState(t), [to,setTo]=useState(t); const dl2 = useDl();
  const pname=(id)=>db.parties.find(p=>p.id===id)?.name||"", sname=(id)=>db.users.find(u=>u.id===id)?.name||"";
  const byTab = (st)=>db.collections.filter(c=>c.status===st&&(!smf||c.salesmanId===+smf));
  const flaggedN = db.collections.filter(c=>c.status==="provisional"&&c.dateChanged).length;
  const dflag = (c) => (c.dateChanged || c.adminEdited) ? <div style={{marginTop:4}}>
    {c.dateChanged && <><span className="pill bad">📅 Receipt date differs</span> <span className="sub">receipt dated {dmy(c.date)}, entered {dmy(c.enteredOn)} </span></>}
    {c.adminEdited && <span className="pill"> ✎ Edited by admin</span>}</div> : null;
  const dline = (c) => `Posting date ${dmy(postingDate(c))}${c.date!==postingDate(c)?` · Receipt date ${dmy(c.date)}`:""}`;
  const pend = byTab("provisional").filter(c=>!onlyFlag||c.dateChanged).sort((a,b)=>postingDate(a).localeCompare(postingDate(b))||a.id-b.id);
  const sum = (l)=>l.reduce((a,c)=>a+c.amount,0);
  const adjL = pend.filter(isAdj); const cash = pend.filter(c=>c.mode==="cash"), online = pend.filter(c=>c.mode==="online"), chq = pend.filter(c=>c.mode==="cheque");
  const groups = {}; cash.forEach(c=>{ const k=c.salesmanId+"|"+postingDate(c); (groups[k]=groups[k]||[]).push(c); });
  const doConfirm = (items)=>{ if(!items.length) return flash("err","Nothing selected"); setDb(confirmEntries(db,me,items)); flash("ok",`${items.length} collection(s) confirmed and posted to ledgers`); };
  const doReject = ()=>{ if(!reason.trim()) return flash("err","Please write a reason for rejecting"); const c0=db.collections.find(x=>x.id===rej); if(c0.advance>0 && (db.advAdj||[]).some(a=>a.advances.some(x=>x.advRef===c0.advRef))) return flash("err","The advance from this entry is already adjusted against a bill. Reverse that first."); setDb(rejectEntry(db,me,rej,reason.trim())); setRej(null); setReason(""); flash("ok","Entry rejected / reversed – the amount is added back to the party's balance"); };
  const rejBox = (id) => rej===id ? <div style={{marginTop:8}}><input placeholder="Reason (e.g. cheque bounced, cash not received)" value={reason} onChange={e=>setReason(e.target.value)}/>
    <div className="row" style={{marginTop:6}}><button className="sm danger" onClick={doReject}>Reject entry</button><a onClick={()=>{setRej(null);setReason("");}}>Cancel</a></div></div> : null;
  const rejBtn = (c,label="Reject") => <button className="sm sec" style={{color:"var(--bad)",borderColor:"var(--bad)"}} onClick={()=>{setRej(c.id);setReason("");}}>{label}</button>;
  const sel = (dl)=>dl.filter(c=>!off[c.id]);
  const sms = db.users.filter(u=>u.role==="salesman");
  const done = db.collections.filter(c=>c.status==="confirmed"&&(!smf||c.salesmanId===+smf)&&postingDate(c)>=from&&postingDate(c)<=to).sort((a,b)=>(b.postDate||b.date).localeCompare(a.postDate||a.date)||b.id-a.id);
  const rejected = byTab("rejected").sort((a,b)=>b.id-a.id);
  const advRows = db.parties.filter(p=>p.active).map(p=>({p, info:advanceInfo(db,p.id), bills:partyBills(db,p.id)})).filter(r=>r.info.total>0.005&&(!smf||r.p.salesmanId===+smf));
  const planOf = (r)=>{ let cap = Math.min(r.info.adjustable, r.bills.reduce((a,b)=>a+b.pending,0)); cap=Math.round(cap*100)/100; const bl=[], ad=[]; let c1=cap, c2=cap;
    r.bills.forEach(b=>{ if(c1>0.005){ const x=Math.round(Math.min(c1,b.pending)*100)/100; bl.push({billId:b.id,no:b.no,amount:x}); c1=Math.round((c1-x)*100)/100; } });
    r.info.parts.forEach(pt=>{ if(c2>0.005){ const x=Math.round(Math.min(c2,pt.remaining)*100)/100; ad.push({advRef:pt.advRef,amount:x}); c2=Math.round((c2-x)*100)/100; } });
    return {total:cap, bills:bl, advances:ad}; };
  const advReady = advRows.filter(r=>planOf(r).total>0.005);
  const postAdv = (r)=>{ const pl=planOf(r); const date=dates["adv"+r.p.id]||t; const aid=uid();
    setDb({...db, advAdj:[...db.advAdj,{id:aid,partyId:r.p.id,date,postedOn:t,total:pl.total,bills:pl.bills,advances:pl.advances,by:me.id,at:new Date().toISOString()}],
      allocs:[...db.allocs,...pl.bills.map(b=>({id:uid(),billId:b.billId,amount:b.amount,kind:"advadj",status:"confirmed",collectionId:null,advAdjId:aid,date}))]});
    flash("ok",`Advance of ${money(pl.total)} adjusted against ${pl.bills.length} bill(s) – journal entry ready for Tally`); };
  const pickRange=(k)=>{ if(k==="today"){setFrom(t);setTo(t);} else if(k==="week"){setFrom(addDays(t,-6));setTo(t);} else {const d=new Date(); setFrom(iso(new Date(d.getFullYear(),d.getMonth(),1))); setTo(t);} };
  return <>
    <div className="row" style={{gap:8,marginBottom:10}}>
      <div className="tabs" style={{margin:0,flex:1}}>{[["pending",`To confirm (${db.collections.filter(c=>c.status==="provisional").length})`],["adv",`Advances${advReady.length?` (${advReady.length})`:""}`],["done","Confirmed"],["rejected","Rejected"]].map(([k,v])=><a key={k} className={tab===k?"on":""} onClick={()=>setTab(k)}>{v}</a>)}</div>
      <select value={smf} onChange={e=>setSmf(e.target.value)} style={{maxWidth:170}}><option value="">All salesmen</option>{sms.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></div>

    {tab==="pending" && <>
      <div className="grid" style={{marginBottom:12}}>
        <div className="card" style={{margin:0}}><div className="sub">Cash to confirm</div><div className="amt">{money(sum(cash))}</div><div className="sub">{cash.length} entries</div></div>
        <div className="card" style={{margin:0}}><div className="sub">Bank / UPI to confirm</div><div className="amt">{money(sum(online))}</div><div className="sub">{online.length} entries</div></div>
        <div className="card" style={{margin:0}}><div className="sub">Cheques in hand</div><div className="amt">{money(sum(chq))}</div><div className="sub">{chq.length} cheques</div></div>
        <div className="card" style={{margin:0}}><div className="sub">Returns / discounts</div><div className="amt">{money(sum(adjL))}</div><div className="sub">{adjL.length} journal entries</div></div></div>
      {dl2 && pend.length>0 && <div style={{marginBottom:10}}><button className="sec sm" onClick={async()=>{ try{ await dl2.save({filename:`Pending_Approvals_${iso(new Date())}.xlsx`,data:makeReportXlsx(buildReport(db,"approvals",{from:"",to:"",sm:smf,loc:""}))}); }catch(e){ if(!(e&&e.code==="declined")) flash("err","Could not create Excel"); } }}>⬇ Pending approval list (Excel)</button></div>}
      {flaggedN>0 && <div className="flash err row"><span>📅 {flaggedN} entr{flaggedN===1?"y has":"ies have"} a changed date – please check.</span>
        <label style={{margin:0,color:"inherit",display:"flex",gap:6,alignItems:"center"}}><input type="checkbox" style={{width:20,height:20}} checked={onlyFlag} onChange={e=>setOnlyFlag(e.target.checked)}/>Only these</label></div>}
      {!pend.length && <div className="card empty">{onlyFlag?"No date-changed entries.":"Everything is confirmed. 🎉"}</div>}

      {Object.keys(groups).length>0 && <h3 style={{margin:"8px 4px"}}>Cash received by salesmen</h3>}
      {Object.entries(groups).map(([k,l])=>{ const chosen=sel(l); return <div key={k} className="card">
        <div className="row"><div><div className="name">{sname(l[0].salesmanId)}</div><div className="sub">Entered on {dmy(postingDate(l[0]))} · {l.length} entries</div></div><div className="amt">{money(sum(l))}</div></div>
        {l.map(c=><div key={c.id} style={{padding:"8px 0",borderTop:"1px solid var(--line)"}}>
          <div className="row"><label style={{margin:0,display:"flex",gap:10,alignItems:"center",color:"var(--ink)",fontSize:16,flex:1}}>
            <input type="checkbox" style={{width:22,height:22}} checked={!off[c.id]} onChange={e=>setOff({...off,[c.id]:!e.target.checked})}/>{pname(c.partyId)}{c.advance>0?<span className="pill ok" style={{marginLeft:6}}>+ advance {money(c.advance)}</span>:null}</label>
            <b>{money(c.amount)}</b>{rejBtn(c,"Reject")}</div>
          {dflag(c)}{rejBox(c.id)}</div>)}
        <button className="block" style={{marginTop:8}} onClick={()=>doConfirm(chosen.map(c=>({id:c.id,postDate:c.date})))}>✔ Confirm cash received ({chosen.length} · {money(sum(chosen))})</button></div>; })}

      {online.length>0 && <h3 style={{margin:"14px 4px 8px"}}>Bank / UPI receipts</h3>}
      {online.map(c=><div key={c.id} className="card">
        <div className="row"><div><div className="name">{pname(c.partyId)}</div><div className="sub">{sname(c.salesmanId)} · {dline(c)} {c.ref?` · Ref ${c.ref}`:" · no UTR given"}{c.bank?` · ${c.bank}`:""}</div></div><div className="amt">{money(c.amount)}</div></div>
        {c.advance>0 && <div className="green sub">Includes advance {money(c.advance)} ({c.advRef})</div>}{dflag(c)}
        <label>Credited in bank on (bank / credit date)</label><input type="date" value={dates[c.id]||c.date} onChange={e=>setDates({...dates,[c.id]:e.target.value})}/>
        <div className="row" style={{marginTop:8}}><button className="sm" onClick={()=>doConfirm([{id:c.id,postDate:dates[c.id]||c.date,bankDate:dates[c.id]||c.date}])}>✔ Confirm receipt</button>{rejBtn(c,"Reject")}</div>{rejBox(c.id)}</div>)}

      {chq.length>0 && <h3 style={{margin:"14px 4px 8px"}}>Cheques</h3>}
      {chq.map(c=><div key={c.id} className="card">
        <div className="row"><div><div className="name">{pname(c.partyId)}</div><div className="sub">{sname(c.salesmanId)} · {dline(c)}</div></div><div className="amt">{money(c.amount)}</div></div>
        {c.advance>0 && <div className="green sub">Includes advance {money(c.advance)} ({c.advRef})</div>}{dflag(c)}
        <div style={{marginTop:6}}>Cheque <b>{c.chequeNo}</b> dated <b>{dmy(c.chequeDate)}</b>{c.bank?` · ${c.bank}`:""} {c.chequeDate>t && <span className="pill warn">Post-dated</span>}</div>
        <label>Received in bank on (date of deposit / credit)</label><input type="date" value={dates[c.id]||t} onChange={e=>setDates({...dates,[c.id]:e.target.value})}/>
        <div className="row" style={{marginTop:8}}><button className="sm" onClick={()=>doConfirm([{id:c.id,postDate:dates[c.id]||t,bankDate:dates[c.id]||t}])}>✔ Accept – received in bank</button>{rejBtn(c,"Bounced / Reject")}</div>{rejBox(c.id)}</div>)}

      {adjL.length>0 && <h3 style={{margin:"14px 4px 8px"}}>Goods return / discount / other (journal entries)</h3>}
      {adjL.map(c=><div key={c.id} className="card">
        <div className="row"><div><div className="name">{pname(c.partyId)}</div><div className="sub">{sname(c.salesmanId)} · {dline(c)}</div></div><div className="amt amber">{money(c.amount)}</div></div>
        <div style={{marginTop:6}}><span className="pill warn">{ADJ[c.kind]}</span>{c.ref?` · Ref ${c.ref}`:""}</div>
        {c.note && <div className="sub">Reason: {c.note}</div>}{dflag(c)}
        {db.allocs.filter(a=>a.collectionId===c.id).map(a=><div key={a.id} className="sub">• {db.bills.find(b=>b.id===a.billId)?.no} — {money(a.amount)}</div>)}
        <label>Journal date</label><input type="date" value={dates[c.id]||c.date} onChange={e=>setDates({...dates,[c.id]:e.target.value})}/>
        <div className="row" style={{marginTop:8}}><button className="sm" onClick={()=>doConfirm([{id:c.id,postDate:dates[c.id]||c.date}])}>✔ Confirm &amp; post journal</button>{rejBtn(c,"Reject")}</div>{rejBox(c.id)}</div>)}
    </>}

    {tab==="adv" && <>
      <p className="sub">Excess receipts are kept as advance. When a new bill exists, post a journal entry: debit the party against the advance, credit the same party against the bill. Only <b>confirmed</b> advances can be adjusted.</p>
      {!advRows.length && <div className="card empty">No advances on hand.</div>}
      {advRows.map(r=>{ const pl=planOf(r); const openT=r.bills.reduce((a,b)=>a+b.pending,0); return <div key={r.p.id} className="card">
        <div className="row"><div><div className="name">{r.p.name}</div><div className="sub">{sname(r.p.salesmanId)||"No salesman"}</div></div><div style={{textAlign:"right"}}><div className="sub">Advance</div><div className="amt green">{money(r.info.total)}</div></div></div>
        <div className="sub">Confirmed &amp; adjustable: {money(r.info.adjustable)} · Pending bills: {money(openT)}</div>
        {pl.total>0.005 ? <>
          <div style={{margin:"8px 0",fontSize:15}}><b>Journal entry to post ({money(pl.total)}):</b>
            {pl.advances.map((x,i)=><div key={i} className="row"><span>Dr {r.p.name.slice(0,22)} – against advance <b>{x.advRef}</b></span><span>{money(x.amount)}</span></div>)}
            {pl.bills.map((x,i)=><div key={i} className="row"><span>Cr {r.p.name.slice(0,22)} – against bill <b>{x.no}</b></span><span>{money(x.amount)}</span></div>)}</div>
          <label>Journal date</label><input type="date" value={dates["adv"+r.p.id]||t} onChange={e=>setDates({...dates,["adv"+r.p.id]:e.target.value})}/>
          <button className="sm" style={{marginTop:8}} onClick={()=>postAdv(r)}>✔ Post advance adjustment</button></>
        : <div className="amber sub" style={{marginTop:6}}>{r.info.adjustable<0.005?"Advance receipt not yet confirmed – confirm it first.":"No pending bill yet – will be adjusted when a new bill arrives."}</div>}</div>; })}
      {db.advAdj.length>0 && <><h3 style={{margin:"14px 4px 8px"}}>Adjustments done</h3><div className="card scroll"><table><thead><tr><th>Date</th><th>Party</th><th>Advance ref → Bills</th><th className="n">Amount</th></tr></thead><tbody>
        {[...db.advAdj].reverse().slice(0,30).map(a=><tr key={a.id}><td>{dmy(a.date)}</td><td>{pname(a.partyId)}</td><td className="sub">{a.advances.map(x=>x.advRef).join(", ")} → {a.bills.map(x=>x.no).join(", ")}</td><td className="n">{money(a.total)}</td></tr>)}</tbody></table></div></>}
    </>}

    {tab==="done" && <>
      <div className="tabs">{[["today","Today"],["week","Last 7 days"],["month","This month"]].map(([k,v])=><a key={k} onClick={()=>pickRange(k)}>{v}</a>)}</div>
      <div className="card row" style={{alignItems:"flex-end"}}><div style={{flex:1}}><label style={{marginTop:0}}>From</label><input type="date" value={from} onChange={e=>e.target.value&&setFrom(e.target.value)}/></div>
        <div style={{flex:1}}><label style={{marginTop:0}}>To</label><input type="date" value={to} onChange={e=>e.target.value&&setTo(e.target.value)}/></div></div>
      <div className="card"><div className="sub">Receipts confirmed · posting date {dmy(from)}{to!==from?` to ${dmy(to)}`:""}</div><div className="big green">{money(sumAmt(done.filter(c=>!isAdj(c))))}</div>
        <div className="sub">{done.length} entries · {breakdownTxt(done,money)}</div></div>
      <div className="card scroll"><table><thead><tr><th>Posting date</th><th>Party / Salesman</th><th>Mode</th><th className="n">Amount</th><th></th></tr></thead><tbody>
        {done.map(c=><tr key={c.id}><td>{dmy(postingDate(c))}<div className="sub">ledger date {dmy(c.postDate||c.date)}</div>{c.dateChanged?<div><span className="pill bad">📅 receipt date differs</span></div>:null}</td><td>{pname(c.partyId)}{c.advance>0?<span className="pill ok" style={{marginLeft:6}}>+ advance {money(c.advance)}</span>:null}<div className="sub">{sname(c.salesmanId)} · confirmed by {sname(c.confirmedBy)||"—"}</div></td>
          <td>{modeLabel(c)}{c.chequeNo?<div className="sub">Chq {c.chequeNo} ({dmy(c.chequeDate)})</div>:null}{c.ref?<div className="sub">{c.ref}</div>:null}</td><td className="n">{isAdj(c)?"− ":""}{money(c.amount)}</td>
          <td style={{minWidth:90}}>{me.role==="admin" && (rej===c.id ? rejBox(c.id) : rejBtn(c,"Reverse"))}</td></tr>)}
        {!done.length && <tr><td colSpan="5" className="empty">Nothing confirmed in this period.</td></tr>}</tbody></table></div></>}

    {tab==="rejected" && (rejected.length ? rejected.map(c=><div key={c.id} className="card"><div className="row"><div className="name">{pname(c.partyId)}</div><div className="amt red">{money(c.amount)}</div></div>
      <div className="sub">{sname(c.salesmanId)} · {modeLabel(c)} · {dline(c)}</div><div className="red sub">Reason: {c.reason}</div></div>) : <div className="card empty">No rejected entries.</div>)}
  </>;
}

function CollectPick({db, me, go, adj}) {
  const [q,setQ]=useState(""); const s=q.trim().toLowerCase();
  const mine = db.parties.filter(p=>p.active&&p.salesmanId===me.id).map(p=>partySummary(db,p));
  const rows = (s ? mine.filter(r=>r.name.toLowerCase().includes(s)) : mine.filter(r=>r.outstanding>0.005))
    .sort((a,b)=>(b.days.includes(todayDay())-a.days.includes(todayDay()))||a.name.localeCompare(b.name));
  return <>
    <input autoFocus placeholder="🔍 Type party name…" value={q} onChange={e=>setQ(e.target.value)} style={{marginBottom:12}}/>
    <p className="sub">{s?"All matching parties":"Parties with balance – today's beat first"}</p>
    {rows.map(r=><div key={r.id} className="card tap" onClick={()=>go({page:"collect",id:r.id,adj})}>
      <div className="row"><div className="name">{r.name}</div><div className={"amt "+(r.outstanding>0?"red":"")}>{money(r.outstanding)}</div></div>
      <div className="sub">{r.group||""}{r.days.includes(todayDay())?" · Today's beat":""}</div></div>)}
    {!rows.length && <div className="card empty">No party found.</div>}
  </>;
}
function CollectForm({db, id, onSave, adj}) {
  const p = db.parties.find(x=>x.id===id); const today = iso(new Date());
  const bills = partyBills(db,id).filter(b=>b.open>0.005);
  const totalOpen = Math.round(bills.reduce((a,b)=>a+b.open,0)*100)/100;
  const [amount,setAmount]=useState(""); const [mode,setMode]=useState("cash"); const [manual,setManual]=useState(false); const [man,setMan]=useState({});
  const [chq,setChq]=useState({no:"",date:today,bank:""}); const [ref,setRef]=useState(""); const [bank,setBank]=useState(""); const [note,setNote]=useState("");
  const [err,setErr]=useState(""); const [review,setReview]=useState(false); const [kind,setKind]=useState("return"); const [slip,setSlip]=useState("");
  const [cdate,setCdate]=useState(today);
  const amt = Math.round((Number(amount)||0)*100)/100;
  let left = amt; const auto = {}; bills.forEach(b=>{ const a=Math.round(Math.min(left,b.open)*100)/100; auto[b.id]=a; left=Math.round((left-a)*100)/100; });
  const alloc = manual ? Object.fromEntries(bills.map(b=>[b.id,Number(man[b.id])||0])) : auto;
  const allocSum = Math.round(Object.values(alloc).reduce((a,v)=>a+v,0)*100)/100;
  const advance = adj ? 0 : Math.max(0, Math.round((amt-allocSum)*100)/100);
  const dateChanged = cdate !== today;
  const check = () => {
    if (!(amt>0)) return adj?"Enter the amount":"Enter the amount received";
    if (!cdate || cdate>today) return "Date cannot be in the future";
    if (adj && amt > totalOpen+0.005) return `Amount is more than the pending ${money(totalOpen)}`;
    if (manual && bills.some(b=>alloc[b.id]>b.open+0.005)) return "A bill amount is more than its pending";
    if (manual && allocSum > amt+0.005) return "Bill-wise amounts add up to more than the amount received";
    if (adj && kind==="other" && !note.trim()) return "Please write what this adjustment is for";
    if (!adj && mode==="cheque" && (!chq.no.trim() || !chq.date)) return "Enter cheque number and cheque date";
    return ""; };
  const next = () => { const e = check(); setErr(e); if(!e) setReview(true); };
  const detail = adj ? (slip?`Ref ${slip}`:"") : mode==="cheque" ? `Cheque ${chq.no}${chq.bank?` · ${chq.bank}`:""} · dated ${dmy(chq.date)}` : mode==="online" ? `${ref?"Ref "+ref:""}${bank?(ref?" · ":"")+bank:""}` : "";
  const lines = bills.filter(b=>alloc[b.id]>0);
  if (review) return <>
    <div className="card"><div className="sub">Please check before saving</div><div className="name">{p.name}</div>
      <div className={"big "+(adj?"amber":"green")}>{money(amt)}</div><div>{adj?ADJ[kind]:MODES[mode]}{detail?` · ${detail}`:""}</div>
      <div className="sub">Receipt date: {dmy(cdate)} · Posting date: {dmy(today)}</div>
      {dateChanged && <div className="amber">📅 Date changed from today – accounts will see this flagged.</div>}
      {note && <div className="sub">Note: {note}</div>}</div>
    <div className="card"><div className="sub" style={{marginBottom:6}}>Against bills</div>
      {lines.map(b=><div key={b.id} className="row"><span>{b.no} <span className="sub">({dmy(b.date)})</span></span><b>{money(alloc[b.id])}</b></div>)}
      {!lines.length && <div className="sub">No pending bill</div>}
      {advance>0 && <div className="row" style={{marginTop:6}}><span className="amber">Advance (excess) – to be adjusted against future bills</span><b className="amber">{money(advance)}</b></div>}</div>
    <p className="sub">Your balance reduces as soon as you save.{adj?" Accounts will post it as a journal entry.":""} Once saved, a change needs admin approval. The accounts department later confirms the entry for posting to the ledger.</p>
    <button className="block" onClick={()=>onSave({partyId:id,mode:adj?"adjust":mode,kind:adj?kind:"receipt",amount:amt,advance,date:cdate,dateChanged,chequeNo:!adj&&mode==="cheque"?chq.no.trim():"",chequeDate:!adj&&mode==="cheque"?chq.date:"",bank:adj?"":mode==="cheque"?chq.bank:bank,ref:adj?slip.trim():mode==="online"?ref.trim():"",note},lines.map(b=>({billId:b.id,amount:alloc[b.id]})))}>✔ Confirm &amp; Save</button>
    <div style={{height:8}}/><button className="sec block" onClick={()=>setReview(false)}>‹ Change</button>
  </>;
  return <>
    <div className="card row"><div><div className="sub">Total pending</div><div className="amt red">{money(totalOpen)}</div>{advanceInfo(db,id).total>0 && <div className="sub green">Advance already with us: {money(advanceInfo(db,id).total)}</div>}</div>
      {totalOpen>0 && <button className="sec sm" onClick={()=>setAmount(String(totalOpen))}>Full amount</button>}</div>
    {adj && !bills.length ? <div className="card empty">Nothing pending – there is no bill to reduce.</div> : <>
    <div className="card"><label style={{marginTop:0}}>{adj?"Amount to reduce (₹)":"Amount received (₹)"}</label>
      <input type="number" inputMode="decimal" style={{fontSize:28,fontWeight:700}} value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0"/>
      {advance>0 && <div className="flash" style={{background:"#fff3e0",color:"var(--warn)",margin:"8px 0 0"}}>{money(advance)} is more than the bills selected – it will be kept as <b>ADVANCE</b> for this party.</div>}
      <label>Receipt date {adj?"(date of return / discount)":"(date money was received)"}</label><input type="date" value={cdate} max={today} onChange={e=>e.target.value&&setCdate(e.target.value)}/>
      <div className="sub" style={{marginTop:4}}>Posting date: <b>{dmy(today)}</b> (today – fixed, cannot be changed)</div>
      {dateChanged && <div className="amber sub">📅 Receipt date is not today – accounts will see this entry flagged for checking.</div>}
      {adj ? <><label>Type of adjustment</label>
        <div className="row" style={{gap:6}}>{Object.entries(ADJ).map(([k,v])=><button key={k} className={kind===k?"":"sec"} style={{flex:1,padding:"12px 4px",fontSize:15}} onClick={()=>setKind(k)}>{v}</button>)}</div>
        <label>{kind==="return"?"Return slip / credit note no. (optional)":"Reference (optional)"}</label><input value={slip} onChange={e=>setSlip(e.target.value)}/></> : <>
      <label>Received as</label>
      <div className="row" style={{gap:6}}>{Object.entries(MODES).map(([k,v])=><button key={k} className={mode===k?"":"sec"} style={{flex:1,padding:"12px 4px"}} onClick={()=>setMode(k)}>{v}</button>)}</div>
      {mode==="cheque" && <><label>Cheque number</label><input inputMode="numeric" value={chq.no} onChange={e=>setChq({...chq,no:e.target.value})}/>
        <label>Cheque date (post-dated? enter the date on cheque)</label><input type="date" value={chq.date} onChange={e=>setChq({...chq,date:e.target.value})}/>
        <label>Bank (optional)</label><input value={chq.bank} onChange={e=>setChq({...chq,bank:e.target.value})}/></>}
      {mode==="online" && <><label>UTR / Reference number (optional)</label><input value={ref} onChange={e=>setRef(e.target.value)}/>
        <label>Bank (optional)</label><input value={bank} onChange={e=>setBank(e.target.value)}/></>}
      </>}
      <label>{adj&&kind==="other"?"What is this for? (required)":adj?"Reason (optional)":"Note (optional)"}</label><input value={note} onChange={e=>setNote(e.target.value)}/></div>
    {bills.length>0 && <div className="card"><div className="row"><b>{adj?"Reduce which bills?":"Against which bills?"}</b><a onClick={()=>{ setManual(!manual); setMan(manual?{}:{...auto}); }}>{manual?"Auto (oldest first)":"Choose bills myself"}</a></div>
      {bills.map(b=><div key={b.id} className="row" style={{padding:"8px 0",borderBottom:"1px solid var(--line)"}}>
        <div><div>{b.no}</div><div className="sub">{dmy(b.date)} · pending {money(b.open)}</div></div>
        {manual ? <input type="number" inputMode="decimal" style={{width:120}} value={man[b.id]??""} onChange={e=>setMan({...man,[b.id]:e.target.value})}/> : <b className={auto[b.id]>0?"green":"sub"}>{auto[b.id]>0?money(auto[b.id]):"—"}</b>}</div>)}</div>}
    {!bills.length && !adj && <div className="card sub">No pending bill – the full amount will be kept as advance.</div>}
    {err && <div className="flash err">{err}</div>}
    <button className="block" style={{fontSize:19,padding:15}} onClick={next}>Review &amp; Save ›</button></>}
  </>;
}
function CollectDone({db, cid, go, home}) {
  const c = db.collections.find(x=>x.id===cid), p = db.parties.find(x=>x.id===c.partyId);
  return <>
    <div className="card" style={{textAlign:"center"}}><div style={{fontSize:46}}>✅</div><div className="name">{isAdj(c)?ADJ[c.kind]+" saved":"Collection saved"}</div>
      <div className={"big "+(isAdj(c)?"amber":"green")}>{money(c.amount)}</div><div>{p.name}</div><div className="sub">{modeLabel(c)} · Receipt date {dmy(c.date)}</div><div className="sub">Posting date {dmy(postingDate(c))}</div>
      {c.advance>0 && <p className="amber">{money(c.advance)} kept as advance ({c.advRef}) – it will be adjusted against the party's next bills.</p>}
      {c.dateChanged && <p className="amber sub">📅 Receipt date is not today – flagged for accounts.</p>}
      <p className="green">Balance updated. Accounts will confirm &amp; post it{isAdj(c)?" as a journal entry":" to the ledger"}.</p></div>
    <button className="block" onClick={()=>go({page:"pick",adj:isAdj(c)})}>{isAdj(c)?"＋ Another return / discount":"＋ Collect from another party"}</button><div style={{height:8}}/>
    <button className="sec block" onClick={home}>Back to home</button>
  </>;
}
const rsf = (v) => "Rs. " + Number(v||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
function makeCollectionPdf(me, list, from, to, partyName) {
  const { jsPDF } = window.jspdf; const doc = new jsPDF();
  doc.setFontSize(16); doc.text("Gurmeet Motors - Collection Report", 14, 16);
  doc.setFontSize(10); doc.text(`Salesman: ${me.name}`, 14, 24);
  doc.text(`Period: ${dmy(from)}${to!==from?" to "+dmy(to):""}`, 14, 30);
  doc.text(`Generated: ${new Date().toLocaleString("en-IN")}`, 14, 36);
  const total = sumAmt(list.filter(c=>!isAdj(c)));
  const rc = list.filter(c=>!isAdj(c)), ad = list.filter(isAdj);
  doc.autoTable({startY:42, head:[["Type","Entries","Amount"]],
    body:[...Object.entries(MODES).map(([k,v])=>{ const l=rc.filter(c=>c.mode===k); return [v, l.length, rsf(sumAmt(l))]; }), ["Total collected", rc.length, rsf(sumAmt(rc))],
      ...Object.entries(ADJ).filter(([k])=>ad.some(c=>c.kind===k)).map(([k,v])=>{ const l=ad.filter(c=>c.kind===k); return [v+" (adjustment)", l.length, rsf(sumAmt(l))]; })],
    styles:{fontSize:9}, headStyles:{fillColor:[11,92,173]}, columnStyles:{1:{halign:"right"},2:{halign:"right"}},
    didParseCell:(d)=>{ if(d.row.index===3 && d.section==="body") d.cell.styles.fontStyle="bold"; }});
  doc.autoTable({startY:doc.lastAutoTable.finalY+8, head:[["Posting date","Receipt date","Party","Mode","Details","Status","Amount"]],
    body:list.map(c=>[dmy(postingDate(c)), dmy(c.date), partyName(c.partyId), modeLabel(c), c.chequeNo?`Chq ${c.chequeNo} (${dmy(c.chequeDate)})`:(c.ref||""), c.status==="confirmed"?"Posted":"Not yet posted", rsf(c.amount)]),
    foot:[["","","","","","Total collected",rsf(total)]], styles:{fontSize:8}, headStyles:{fillColor:[11,92,173]}, footStyles:{fillColor:[240,240,240],textColor:0},
    columnStyles:{6:{halign:"right"}}});
  return doc.output("blob");
}
function MyCollections({db, me, go, flash}) {
  const t = iso(new Date());
  const [from,setFrom]=useState(t), [to,setTo]=useState(t), [preset,setPreset]=useState("today");
  const dl = useDl();
  const pick = (k) => { setPreset(k); const d=new Date();
    if(k==="today"){ setFrom(t); setTo(t); }
    else if(k==="yest"){ const y=addDays(t,-1); setFrom(y); setTo(y); }
    else if(k==="week"){ setFrom(addDays(t,-6)); setTo(t); }
    else if(k==="month"){ setFrom(iso(new Date(d.getFullYear(),d.getMonth(),1))); setTo(t); } };
  const all = db.collections.filter(c=>c.salesmanId===me.id);
  const list = all.filter(c=>postingDate(c)>=from&&postingDate(c)<=to).sort((a,b)=>postingDate(b).localeCompare(postingDate(a))||b.id-a.id);
  const valid = list.filter(c=>c.status!=="rejected");
  const total = sumAmt(valid.filter(c=>!isAdj(c))), adjTotal = sumAmt(valid.filter(isAdj));
  const pname = (id)=>db.parties.find(p=>p.id===id)?.name||"";
  const days = [...new Set(list.map(postingDate))];
  const pdf = async () => {
    try {
      if(!window.jspdf) throw new Error("PDF library did not load");
      await dl.save({filename:`Collections_${me.username}_${from}${to!==from?"_to_"+to:""}.pdf`, data:makeCollectionPdf(me,valid,from,to,pname)});
    } catch(e){ if(e && e.code==="declined") return; flash("err","Could not create PDF: "+(e.message||e.code||"error")); } };
  return <>
    <div className="tabs">{[["today","Today"],["yest","Yesterday"],["week","Last 7 days"],["month","This month"],["custom","Choose dates"]].map(([k,v])=>
      <a key={k} className={preset===k?"on":""} onClick={()=>k==="custom"?setPreset("custom"):pick(k)}>{v}</a>)}</div>
    {preset==="custom" && <div className="card row" style={{alignItems:"flex-end"}}>
      <div style={{flex:1}}><label style={{marginTop:0}}>From</label><input type="date" value={from} max={to} onChange={e=>e.target.value&&setFrom(e.target.value)}/></div>
      <div style={{flex:1}}><label style={{marginTop:0}}>To</label><input type="date" value={to} min={from} onChange={e=>e.target.value&&setTo(e.target.value)}/></div></div>}
    <div className="card"><div className="sub">Cash / cheque / bank collected · posting date {dmy(from)}{to!==from?` to ${dmy(to)}`:""}</div><div className="big green">{money(total)}</div>
      <div className="sub">{valid.filter(c=>!isAdj(c)).length} receipt(s) · {breakdownTxt(valid,money)}</div>
      {dl && list.length>0 && <button className="sec sm" style={{marginTop:10}} onClick={pdf}>⬇ Download PDF</button>}
      {!dl && list.length>0 && <div className="sub" style={{marginTop:8}}>PDF download works in the published page.</div>}</div>
    {days.map(d=><div key={d}>
      <div className="row sub" style={{margin:"10px 4px 6px"}}><b>{dmy(d)}{d===t?" (Today)":""}</b><b>{money(sumAmt(valid.filter(c=>postingDate(c)===d&&!isAdj(c))))}{valid.some(c=>postingDate(c)===d&&isAdj(c))?` + adj ${money(sumAmt(valid.filter(c=>postingDate(c)===d&&isAdj(c))))}`:""}</b></div>
      {list.filter(c=>postingDate(c)===d).map(c=><div key={c.id} className="card tap" onClick={()=>go({page:"ledger",id:c.partyId})}>
        <div className="row"><div className="name">{pname(c.partyId)}</div><div className={"amt "+(isAdj(c)?"amber":"green")}>{isAdj(c)?"− ":""}{money(c.amount)}</div></div>
        <div className="row sub"><span>{modeLabel(c)}{c.chequeNo?` · chq ${c.chequeNo} (${dmy(c.chequeDate)})`:""}{c.ref?` · ${c.ref}`:""}{isAdj(c)&&c.note?` · ${c.note}`:""}{c.advance>0?` · advance ${money(c.advance)}`:""}{c.dateChanged?` · 📅 receipt dated ${dmy(c.date)}`:""}</span>
          <span className={"pill "+(c.status==="confirmed"?"ok":c.status==="rejected"?"bad":"warn")}>{c.status==="confirmed"?"Posted":c.status==="rejected"?"Rejected":"Not yet posted"}</span></div>
        {c.status==="rejected" && <div className="red sub">Rejected by accounts: {c.reason||"no reason given"} – amount added back to balance</div>}
        {c.adminEdited && <div style={{marginTop:4}}><span className="pill">✎ Corrected by admin</span></div>}
        <div className="sub" style={{marginTop:4}}>Tap to open ledger ›</div></div>)}</div>)}
    {!list.length && <div className="card empty">No collections in this period.</div>}
  </>;
}
function PartyView({db, id, go, canCollect, flash}) {
  const dl = useDl();
  const p = db.parties.find(x=>x.id===id); const sm = db.users.find(u=>u.id===p.salesmanId);
  const bills = partyBills(db,id); const total = bills.reduce((s,b)=>s+b.pending,0), prov = bills.reduce((s,b)=>s+b.prov,0); const adv = advanceInfo(db,id).total;
  return <>
    <div className="card"><div className="sub">Total outstanding</div><div className={"big "+(total>0?"red":"")}>{money(total)}</div>
      {adv>0 && <div className="green" style={{marginTop:4}}>Advance on account: <b>{money(adv)}</b> – will be adjusted against new bills</div>}
      <div className="sub" style={{marginTop:6}}>{p.loc}{p.group?` · ${p.group}`:""}{sm?` · ${sm.name}`:""} · {daysTxt(p.days)}{p.phone?` · ${p.phone}`:""}</div></div>
    {canCollect && <button className="block" style={{fontSize:20,padding:16,marginBottom:8}} onClick={()=>go({page:"collect",id})}>＋ Collect Payment</button>}
    {canCollect && <button className="sec block" style={{marginBottom:8}} onClick={()=>go({page:"collect",id,adj:true})}>↩ Goods Return / Discount</button>}
    <h3 style={{margin:"16px 4px 8px"}}>Pending bills</h3>
    {bills.map(b=><div key={b.id} className="card tap" onClick={()=>go({page:"bill",id:b.id})}>
      <div className="row"><div className="name">{b.no}</div><div className="amt">{money(b.pending)}</div></div>
      <div className="row sub"><span>{dmy(b.date)}{b.pending!==b.amount?` · bill ${money(b.amount)}`:""}</span><span className={"pill "+ageCls(b.age)}>{b.age} days</span></div>
      </div>)}
    {!bills.length && <div className="card empty">No pending bills. All clear 👍</div>}
    <button className="sec block" onClick={()=>go({page:"ledger",id})}>View Ledger</button>
    {bills.length>0 && dl && <><div style={{height:8}}/><button className="sec block" onClick={()=>savePdf(dl,`PendingBills_${safeName(p.name)}.pdf`,()=>makePendingPdf(db,[p],"Gurmeet Motors - Pending Bills",[`Party: ${p.name}`]),flash)}>⬇ Pending bills PDF</button></>}
  </>;
}
function BillView({db, id}) {
  const b = billCalc(db, db.bills.find(b=>b.id===id)), p = db.parties.find(x=>x.id===b.partyId);
  const rec = db.allocs.filter(a=>a.billId===id&&a.status!=="rejected").map(a=>({...a,c:db.collections.find(c=>c.id===a.collectionId)}))
    .sort((x,y)=>x.date.localeCompare(y.date)||x.id-y.id);
  const got = rec.reduce((t,r)=>t+r.amount,0);
  return <>
    <div className="card"><div className="name">{p.name}</div>
      <div className="sub">{b.source==="opening"?"Opening balance":"Sales bill"} · Bill date {dmy(b.date)}{b.due?` · Due ${dmy(b.due)}`:""} · {b.age} days old</div>
      <div className="row" style={{marginTop:10}}><div><div className="sub">Bill amount</div><div className="amt">{money(b.amount)}</div></div>
        <div style={{textAlign:"center"}}><div className="sub">Received / adjusted</div><div className="amt green">{money(got)}</div></div>
        <div style={{textAlign:"right"}}><div className="sub">Pending</div><div className="amt red">{money(b.pending)}</div></div></div></div>
    <h3 style={{margin:"16px 4px 8px"}}>Receipts &amp; adjustments against this bill</h3>
    <div className="card scroll">{rec.length ? <table><thead><tr><th>Date</th><th>Mode</th><th className="n">Amount</th></tr></thead><tbody>
      {rec.map(r=><tr key={r.id}><td>{dmy(r.date)}</td>
        <td>{r.kind==="advadj"?"Advance adjusted (journal)":r.c?modeLabel(r.c):"Receipt"}{r.c?.chequeNo?<div className="sub">Chq {r.c.chequeNo} · {dmy(r.c.chequeDate)}</div>:null}{r.c?.ref?<div className="sub">{r.c.ref}</div>:null}
          <div className="sub">{r.status==="confirmed"?"Posted":"Not yet posted"}</div></td>
        <td className="n">{money(r.amount)}</td></tr>)}
      <tr><td colSpan="2"><b>Total received</b></td><td className="n"><b>{money(got)}</b></td></tr></tbody></table>
      : <div className="empty">No receipts yet against this bill.</div>}</div>
  </>;
}
function Ledger({db, id, flash, me, setDb}) {
  const p = db.parties.find(x=>x.id===id); const {rows:e, bal} = ledgerRows(db,id); const dl = useDl();
  const isAdmin = me?.role==="admin"; const [ed,setEd]=useState(null);
  const close=()=>setEd(null);
  const ctx = {db,me,setDb,flash,onDone:close};
  const panel = !ed ? null : ed.t==="bill" ? <BillEditor key={"b"+ed.id} {...ctx} partyId={id} bill={ed.id==="new"?null:db.bills.find(b=>b.id===ed.id)}/>
    : ed.t==="coll" ? <CollEditor key={"c"+ed.id} {...ctx} c={db.collections.find(c=>c.id===ed.id)}/>
    : <AdvAdjEditor key={"a"+ed.id} {...ctx} a={db.advAdj.find(x=>x.id===ed.id)}/>;
  const hist = (db.audit||[]).filter(x=>x.partyId===id).reverse();
  return <>
    <div className="card"><div className="name">{p.name}</div><div className="sub">Closing balance</div><div className={"big "+(bal>0?"red":"")}>{money(Math.abs(bal))} {bal>0?"Dr":bal<0?"Cr":""}</div>
      <div className="row" style={{justifyContent:"flex-start",gap:8,marginTop:10,flexWrap:"wrap"}}>
        <PdfBtn dl={dl} label="Print / Download Ledger PDF" onClick={()=>savePdf(dl,`Ledger_${safeName(p.name)}.pdf`,()=>makeLedgerPdf(db,p),flash)}/>
        {isAdmin && <button className="sm" onClick={()=>setEd({t:"bill",id:"new"})}>＋ Add bill</button>}</div>
      {isAdmin && <div className="sub" style={{marginTop:6}}>Admin: tap ✎ on any line to correct the bill or the receipt.</div>}</div>
    {panel}
    <div className="card scroll"><table><thead><tr><th>Date</th><th>Particulars</th><th className="n">Debit</th><th className="n">Credit</th><th className="n">Balance</th>{isAdmin && <th></th>}</tr></thead><tbody>
      {e.map((r,i)=><tr key={i}><td>{dmy(r.date)}</td><td>{r.kind}<div className="sub">{r.ref}</div></td><td className="n">{r.dr?money(r.dr):""}</td><td className="n">{r.cr?money(r.cr):""}</td><td className="n">{money(r.bal)}</td>
        {isAdmin && <td>{r.t && r.eid ? <a style={{fontSize:20}} onClick={()=>setEd({t:r.t,id:r.eid})}>✎</a> : null}</td>}</tr>)}
      {!e.length && <tr><td colSpan={isAdmin?6:5} className="empty">No entries yet.</td></tr>}</tbody></table></div>
    <p className="sub">Receipts marked "not yet posted" are collected by the salesman and awaiting accounts confirmation.</p>
    {isAdmin && hist.length>0 && <div className="card"><b>Changes made to this ledger</b>{hist.slice(0,15).map(h=><div key={h.id} className="sub" style={{marginTop:6}}>{new Date(h.at).toLocaleString("en-IN")} · {h.entity} {h.ref}: {h.changes.map(c=>`${c.field}${c.from?" "+c.from:""}${c.to?" → "+c.to:""}`).join("; ")}</div>)}</div>}
  </>;
}

/* ================= admin: edit anything from the ledger ================= */
const addAudit = (db, me, e) => ({...db, audit:[...(db.audit||[]), {id:uid(), at:new Date().toISOString(), by:me.id, ...e}]});
const diffOf = (o, n, fields) => fields.filter(([k])=>String(o[k]??"")!==String(n[k]??"")).map(([k,label,fmt])=>({field:label, from:(fmt||String)(o[k]??""), to:(fmt||String)(n[k]??"")}));
const mMoney = (v)=>v===""?"":money(v), mDate = (v)=>v?dmy(v):"";

function BillEditor({db, me, setDb, partyId, bill, onDone, flash}) {
  const allocated = bill ? Math.round(db.allocs.filter(a=>a.billId===bill.id&&a.status!=="rejected").reduce((t,a)=>t+a.amount,0)*100)/100 : 0;
  const [f,setF]=useState({no:bill?.no||"", date:bill?.date||iso(new Date()), due:bill?.due||"", amount:bill?String(bill.amount):""}); const [del,setDel]=useState(false);
  const set=(k,v)=>setF({...f,[k]:v});
  const save=()=>{
    const no=f.no.trim(), amt=Math.round((Number(f.amount)||0)*100)/100;
    if(!no) return flash("err","Bill number is required"); if(!f.date) return flash("err","Bill date is required"); if(!(amt>0)) return flash("err","Enter the bill amount");
    if(db.bills.some(b=>b.partyId===partyId&&b.no===no&&b.id!==bill?.id)) return flash("err","This party already has a bill with that number");
    if(amt<allocated-0.005) return flash("err",`Receipts / adjustments of ${money(allocated)} are already applied to this bill – amount cannot be lower than that`);
    const nb={...(bill||{id:uid(),partyId,source:"manual",imported_at:null}), no, date:f.date, due:f.due||addDays(f.date,30), amount:amt};
    if(bill){ const ch=diffOf(bill,nb,[["no","Bill number"],["date","Bill date",mDate],["due","Due date",mDate],["amount","Bill amount",mMoney]]); if(!ch.length) return onDone();
      setDb(addAudit({...db,bills:db.bills.map(b=>b.id===bill.id?nb:b)},me,{entity:"Bill",ref:no,partyId,changes:ch})); }
    else setDb(addAudit({...db,bills:[...db.bills,nb]},me,{entity:"Bill",ref:no,partyId,changes:[{field:"Bill added",from:"",to:`${no} · ${dmy(f.date)} · ${money(amt)}`}]}));
    flash("ok","Bill saved"); onDone(); };
  const remove=()=>{ if(allocated>0.005) return flash("err","Receipts are applied to this bill – reverse them first"); if(!del){ setDel(true); flash("err","Tap 'Delete bill' once more to confirm"); return; }
    setDb(addAudit({...db,bills:db.bills.filter(b=>b.id!==bill.id)},me,{entity:"Bill",ref:bill.no,partyId,changes:[{field:"Bill deleted",from:`${bill.no} · ${money(bill.amount)}`,to:""}]})); flash("ok","Bill deleted"); onDone(); };
  return <div className="card" style={{border:"2px solid var(--brand)"}}><b>{bill?"✎ Edit bill":"＋ Add bill"}</b>
    <label>Bill number</label><input value={f.no} onChange={e=>set("no",e.target.value)}/>
    <div className="row" style={{gap:8}}><div style={{flex:1}}><label>Bill date</label><input type="date" value={f.date} onChange={e=>set("date",e.target.value)}/></div>
      <div style={{flex:1}}><label>Due date</label><input type="date" value={f.due} onChange={e=>set("due",e.target.value)}/></div></div>
    <label>Bill amount (₹)</label><input type="number" inputMode="decimal" value={f.amount} onChange={e=>set("amount",e.target.value)}/>
    {bill && <div className="sub" style={{marginTop:6}}>Already applied against this bill: {money(allocated)}</div>}
    <div className="row" style={{marginTop:12,justifyContent:"flex-start",gap:10}}><button className="sm" onClick={save}>Save</button><button className="sm sec" onClick={onDone}>Cancel</button>
      {bill && <button className="sm sec" style={{color:"var(--bad)",borderColor:"var(--bad)",marginLeft:"auto"}} onClick={remove}>Delete bill</button>}</div></div>;
}

function CollEditor({db, me, setDb, c, onDone, flash}) {
  const adj = isAdj(c); const own = (bid)=>db.allocs.filter(a=>a.collectionId===c.id&&a.billId===bid&&a.status!=="rejected").reduce((t,a)=>t+a.amount,0);
  const bills = partyBills(db,c.partyId,false).map(b=>({...b, own:own(b.id), open:Math.round((b.open+own(b.id))*100)/100})).filter(b=>b.open>0.005||b.own>0);
  const [f,setF]=useState({amount:String(c.amount), date:c.date, mode:adj?"cash":c.mode, kind:adj?c.kind:"return", ref:c.ref||"", chqNo:c.chequeNo||"", chqDate:c.chequeDate||"", bank:c.bank||"", note:c.note||"", postDate:c.postDate||c.date});
  const [man,setMan]=useState(Object.fromEntries(bills.map(b=>[b.id,b.own?String(b.own):""]))); const [rj,setRj]=useState(false); const [reason,setReason]=useState("");
  const set=(k,v)=>setF({...f,[k]:v});
  const amt=Math.round((Number(f.amount)||0)*100)/100, allocSum=Math.round(bills.reduce((t,b)=>t+(Number(man[b.id])||0),0)*100)/100;
  const advance = adj?0:Math.max(0,Math.round((amt-allocSum)*100)/100);
  const usedAdv = c.advRef ? (db.advAdj||[]).reduce((t,a)=>t+a.advances.filter(x=>x.advRef===c.advRef).reduce((u,x)=>u+x.amount,0),0) : 0;
  const confirmed = c.status==="confirmed";
  const save=()=>{
    if(!(amt>0)) return flash("err","Enter the amount"); if(!f.date) return flash("err","Enter the date");
    if(bills.some(b=>(Number(man[b.id])||0)>b.open+0.005)) return flash("err","A bill-wise amount is more than that bill's pending");
    if(allocSum>amt+0.005) return flash("err","Bill-wise amounts add up to more than the amount");
    if(adj && Math.abs(allocSum-amt)>0.005) return flash("err","For returns / discounts the full amount must be applied to bills");
    if(advance<usedAdv-0.005) return flash("err",`${money(usedAdv)} of this entry's advance is already adjusted against bills – reverse that adjustment first`);
    if(!adj && f.mode==="cheque" && !f.chqNo.trim()) return flash("err","Enter the cheque number");
    const mode=adj?"adjust":f.mode, kind=adj?f.kind:"receipt"; let seq=db.advSeq||0, advRef=c.advRef||"";
    if(advance>0 && !advRef){ seq++; advRef="ADV-"+String(seq).padStart(4,"0"); } if(!(advance>0) && usedAdv<0.005) advRef="";
    const pd = confirmed ? f.postDate : c.postDate;
    const nc={...c, amount:amt, advance, advRef, date:f.date, dateChanged:f.date!==c.enteredOn, mode, kind, ref:f.ref.trim(), chequeNo:!adj&&mode==="cheque"?f.chqNo.trim():"", chequeDate:!adj&&mode==="cheque"?f.chqDate:"", bank:f.bank.trim(), note:f.note.trim(), postDate:pd, bankDate:confirmed&&(mode==="cheque"||mode==="online")?pd:c.bankDate, adminEdited:true};
    const lines=bills.filter(b=>(Number(man[b.id])||0)>0).map(b=>({billId:b.id,amount:Math.round(Number(man[b.id])*100)/100}));
    const txt=(ls)=>ls.map(l=>`${db.bills.find(b=>b.id===l.billId)?.no}: ${money(l.amount)}`).join(", ")||"—";
    const oldLines=db.allocs.filter(a=>a.collectionId===c.id&&a.status!=="rejected").map(a=>({billId:a.billId,amount:a.amount}));
    const ch=[...diffOf(c,nc,[["amount","Amount",mMoney],["date","Receipt date",mDate],["mode","Mode",(v)=>MODES[v]||ADJ[kind]||v],["kind","Type",(v)=>ADJ[v]||"Receipt"],["ref","UTR / Ref"],["chequeNo","Cheque no."],["chequeDate","Cheque date",mDate],["bank","Bank"],["note","Note"],["postDate","Bank / credit date",mDate],["advance","Advance",mMoney]]),
      ...(txt(oldLines)!==txt(lines)?[{field:"Bill-wise split",from:txt(oldLines),to:txt(lines)}]:[])];
    if(!ch.length) return onDone();
    const st=confirmed?"confirmed":"provisional", ad=confirmed?pd:f.date;
    let nd={...db, advSeq:seq, collections:db.collections.map(x=>x.id===c.id?nc:x),
      allocs:[...db.allocs.filter(a=>!(a.collectionId===c.id&&a.status!=="rejected")), ...lines.map(l=>({id:uid(),billId:l.billId,amount:l.amount,kind,status:st,collectionId:c.id,date:ad}))]};
    setDb(addAudit(nd,me,{entity:adj?ADJ[c.kind]:"Receipt",ref:c.advRef||modeLabel(c),partyId:c.partyId,changes:ch,status:c.status})); flash("ok","Entry updated"); onDone(); };
  const reverse=()=>{ if(!reason.trim()) return flash("err","Write the reason for reversing");
    if(usedAdv>0.005) return flash("err","The advance from this entry is already adjusted against a bill. Reverse that first.");
    setDb(addAudit(rejectEntry(db,me,c.id,reason.trim()),me,{entity:adj?ADJ[c.kind]:"Receipt",ref:modeLabel(c),partyId:c.partyId,changes:[{field:"Entry reversed",from:`${money(c.amount)} on ${dmy(c.date)}`,to:reason.trim()}]})); flash("ok","Entry reversed"); onDone(); };
  return <div className="card" style={{border:"2px solid var(--brand)"}}>
    <b>✎ Edit {adj?ADJ[c.kind]:"receipt"}</b> <span className={"pill "+(confirmed?"ok":"warn")}>{confirmed?"Posted":"Not yet posted"}</span>
    <div className="sub">Entered by {db.users.find(u=>u.id===c.salesmanId)?.name} · {c.advRef||""}</div>
    <div className="sub">Posting date (fixed): <b>{dmy(postingDate(c))}</b></div>
    <div className="row" style={{gap:8}}><div style={{flex:1}}><label>Amount (₹)</label><input type="number" inputMode="decimal" value={f.amount} onChange={e=>set("amount",e.target.value)}/></div>
      <div style={{flex:1}}><label>Receipt date</label><input type="date" value={f.date} onChange={e=>set("date",e.target.value)}/></div></div>
    {adj ? <><label>Type</label><select value={f.kind} onChange={e=>set("kind",e.target.value)}>{Object.entries(ADJ).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></>
      : <><label>Mode of receipt</label><select value={f.mode} onChange={e=>set("mode",e.target.value)}>{Object.entries(MODES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></>}
    {!adj && f.mode==="cheque" && <div className="row" style={{gap:8}}><div style={{flex:1}}><label>Cheque no.</label><input value={f.chqNo} onChange={e=>set("chqNo",e.target.value)}/></div><div style={{flex:1}}><label>Cheque date</label><input type="date" value={f.chqDate} onChange={e=>set("chqDate",e.target.value)}/></div></div>}
    <label>{adj?"Reference / return slip":"UTR / Reference no."}</label><input value={f.ref} onChange={e=>set("ref",e.target.value)}/>
    <label>Bank</label><input value={f.bank} onChange={e=>set("bank",e.target.value)}/>
    {confirmed && <><label>Bank / credit date (ledger date)</label><input type="date" value={f.postDate} onChange={e=>set("postDate",e.target.value)}/></>}
    <label>Note</label><input value={f.note} onChange={e=>set("note",e.target.value)}/>
    <label>Applied against bills</label>
    {bills.map(b=><div key={b.id} className="row" style={{padding:"6px 0",borderBottom:"1px solid var(--line)"}}><div><div>{b.no}</div><div className="sub">{dmy(b.date)} · can take up to {money(b.open)}</div></div>
      <input type="number" inputMode="decimal" style={{width:120}} value={man[b.id]} onChange={e=>setMan({...man,[b.id]:e.target.value})}/></div>)}
    {!adj && advance>0 && <div className="amber sub" style={{marginTop:6}}>{money(advance)} will be kept as advance</div>}
    <div className="row" style={{marginTop:12,justifyContent:"flex-start",gap:10}}><button className="sm" onClick={save}>Save changes</button><button className="sm sec" onClick={onDone}>Cancel</button>
      <button className="sm sec" style={{color:"var(--bad)",borderColor:"var(--bad)",marginLeft:"auto"}} onClick={()=>setRj(!rj)}>Reverse entry</button></div>
    {rj && <div style={{marginTop:8}}><input placeholder="Reason for reversing" value={reason} onChange={e=>setReason(e.target.value)}/><button className="sm danger" style={{marginTop:6}} onClick={reverse}>Confirm reverse</button></div>}
  </div>;
}
function AdvAdjEditor({db, me, setDb, a, onDone, flash}) {
  const [ok,setOk]=useState(false);
  const undo=()=>{ if(!ok){ setOk(true); flash("err","Tap 'Reverse adjustment' once more to confirm"); return; }
    setDb(addAudit({...db, tombstones:a.exp?[...db.tombstones,{id:a.id,type:"a",date:a.date,ref:"GMCM-J-"+String(a.id).slice(-8)}]:db.tombstones, advAdj:db.advAdj.filter(x=>x.id!==a.id), allocs:db.allocs.filter(x=>x.advAdjId!==a.id)},me,{entity:"Advance adjustment",ref:a.advances.map(x=>x.advRef).join(", "),partyId:a.partyId,changes:[{field:"Adjustment reversed",from:`${money(a.total)} against ${a.bills.map(b=>b.no).join(", ")}`,to:""}]})); flash("ok","Adjustment reversed – the advance is available again"); onDone(); };
  return <div className="card" style={{border:"2px solid var(--brand)"}}><b>Journal: advance adjustment</b>
    <div className="sub">{dmy(a.date)} · {money(a.total)} · {a.advances.map(x=>x.advRef).join(", ")} → {a.bills.map(b=>b.no).join(", ")}</div>
    <div className="row" style={{marginTop:10,justifyContent:"flex-start",gap:10}}><button className="sm sec" style={{color:"var(--bad)",borderColor:"var(--bad)"}} onClick={undo}>Reverse adjustment</button><button className="sm sec" onClick={onDone}>Close</button></div></div>;
}
function AuditLog({db}) {
  const name=(id)=>db.users.find(u=>u.id===id)?.name||"", pn=(id)=>db.parties.find(p=>p.id===id)?.name||"";
  const rows=[...(db.audit||[])].reverse().slice(0,300);
  return <div className="card scroll"><h3 style={{marginTop:0}}>Change history</h3><table><thead><tr><th>When / who</th><th>What</th><th>Changes</th></tr></thead><tbody>
    {rows.map(r=><tr key={r.id}><td>{new Date(r.at).toLocaleString("en-IN")}<div className="sub">{name(r.by)}</div></td><td>{r.entity} <b>{r.ref}</b><div className="sub">{pn(r.partyId)}</div></td>
      <td>{r.changes.map((c,i)=><div key={i} className="sub"><b>{c.field}:</b> {c.from?<s>{c.from}</s>:null}{c.from&&c.to?" → ":""}{c.to}</div>)}</td></tr>)}
    {!rows.length && <tr><td colSpan="3" className="empty">No changes made yet.</td></tr>}</tbody></table></div>;
}

/* ================= Tally XML export ================= */
const xe = (v)=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const tdate = (d)=>String(d).replace(/-/g,"");
const tamt = (v)=>(Math.round(v*100)/100).toFixed(2);
const guidOf = (k,id)=>"6d636d00-0000-4000-8000-"+k.charCodeAt(0).toString(16).padStart(2,"0")+Number(id).toString(16).padStart(10,"0").slice(-10);
const refOf = (k,id)=>"GMCM-"+k+"-"+String(id).slice(-8);
const leXml = (name,pos,amt,inner="",party=false)=>`<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xe(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${pos?"Yes":"No"}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>${party?"Yes":"No"}</ISPARTYLEDGER><AMOUNT>${tamt(amt)}</AMOUNT>${inner}</ALLLEDGERENTRIES.LIST>`;
const baXml = (name,type,amt)=>`<BILLALLOCATIONS.LIST><NAME>${xe(name)}</NAME><BILLTYPE>${type}</BILLTYPE><AMOUNT>${tamt(amt)}</AMOUNT></BILLALLOCATIONS.LIST>`;
const vchXml = (o)=>`<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${o.guid}" VCHTYPE="${o.type}" ACTION="${o.action}" OBJVIEW="Accounting Voucher View"><DATE>${tdate(o.date)}</DATE><GUID>${o.guid}</GUID><VOUCHERTYPENAME>${o.type}</VOUCHERTYPENAME><REFERENCE>${xe(o.ref)}</REFERENCE>`
  + (o.action==="Delete" ? "" : `<NARRATION>${xe(o.narr)}</NARRATION><PARTYLEDGERNAME>${xe(o.party)}</PARTYLEDGERNAME><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><EFFECTIVEDATE>${tdate(o.date)}</EFFECTIVEDATE>${o.entries}`) + `</VOUCHER></TALLYMESSAGE>`;
const collSig = (db,c)=>JSON.stringify([c.partyId,c.amount,c.advance||0,c.advRef||"",c.date,c.postDate||"",c.mode,c.kind||"",c.ref||"",c.chequeNo||"",c.chequeDate||"",c.bank||"",c.note||"",
  db.allocs.filter(a=>a.collectionId===c.id&&a.status==="confirmed").map(a=>[a.billId,a.amount]).sort()]);
function collVoucher(db, c, action) {
  const T=db.tally, party=db.parties.find(p=>p.id===c.partyId)?.name||"", sm=db.users.find(u=>u.id===c.salesmanId)?.name||"";
  const date=c.postDate||c.date, guid=guidOf("c",c.id), adj=isAdj(c), type=adj?"Journal":"Receipt", ref=refOf(adj?"J":"R",c.id);
  if (action==="Delete") return {guid,type,action,date,ref,party,amount:c.amount,xml:vchXml({guid,type,action,date,ref})};
  const als=db.allocs.filter(a=>a.collectionId===c.id&&a.status==="confirmed");
  const bills=als.map(a=>baXml(db.bills.find(b=>b.id===a.billId)?.no||"",   "Agst Ref", a.amount));
  const det=[c.chequeNo?`Cheque ${c.chequeNo} dt ${dmy(c.chequeDate)}`:"", c.ref?`Ref ${c.ref}`:"", c.bank||"", c.note||""].filter(Boolean).join(" | ");
  const narr=`${adj?ADJ[c.kind]:MODES[c.mode]} entered by ${sm} on ${dmy(postingDate(c))}${c.date!==postingDate(c)?" (receipt dated "+dmy(c.date)+")":""}${det?" | "+det:""}${c.advance>0?" | Advance "+c.advRef:""}`;
  let entries, drName;
  if (adj) {
    drName = c.kind==="return"?T.salesReturn:c.kind==="discount"?T.discount:T.other;
    entries = leXml(drName,true,-c.amount) + leXml(party,false,c.amount,bills.join(""),true);
  } else {
    drName = c.mode==="cash"?T.cash:c.mode==="cheque"?T.cheque:T.bank;
    const adv = c.advance>0 ? baXml(c.advRef,"Advance",c.advance) : "";
    let inner="";
    if (T.bankAlloc && c.mode==="cheque") inner=`<BANKALLOCATIONS.LIST><DATE>${tdate(date)}</DATE><INSTRUMENTDATE>${tdate(c.chequeDate||date)}</INSTRUMENTDATE><INSTRUMENTNUMBER>${xe(c.chequeNo)}</INSTRUMENTNUMBER><TRANSACTIONTYPE>Cheque/DD</TRANSACTIONTYPE><AMOUNT>${tamt(-c.amount)}</AMOUNT></BANKALLOCATIONS.LIST>`;
    else if (T.bankAlloc && c.mode==="online" && c.ref) inner=`<BANKALLOCATIONS.LIST><DATE>${tdate(date)}</DATE><TRANSACTIONTYPE>Others</TRANSACTIONTYPE><UNIQUEREFERENCENUMBER>${xe(c.ref)}</UNIQUEREFERENCENUMBER><AMOUNT>${tamt(-c.amount)}</AMOUNT></BANKALLOCATIONS.LIST>`;
    entries = leXml(party,false,c.amount,bills.join("")+adv,true) + leXml(drName,true,-c.amount,inner);
  }
  return {guid,type,action,date,ref,party,amount:c.amount,dr:drName,cr:party,xml:vchXml({guid,type,action,date,ref,narr,party,entries})};
}
function advVoucher(db, a, action) {
  const party=db.parties.find(p=>p.id===a.partyId)?.name||"", guid=guidOf("a",a.id), ref=refOf("J",a.id);
  if (action==="Delete") return {guid,type:"Journal",action,date:a.date,ref,party,amount:a.total,xml:vchXml({guid,type:"Journal",action,date:a.date,ref})};
  const dr=a.advances.map(x=>baXml(x.advRef,"Agst Ref",-x.amount)).join(""), cr=a.bills.map(x=>baXml(x.no,"Agst Ref",x.amount)).join("");
  const entries=leXml(party,true,-a.total,dr,true)+leXml(party,false,a.total,cr,true);
  return {guid,type:"Journal",action,date:a.date,ref,party,amount:a.total,dr:party+" (advance "+a.advances.map(x=>x.advRef).join(",")+")",cr:party+" (bill "+a.bills.map(x=>x.no).join(",")+")",
    xml:vchXml({guid,type:"Journal",action,date:a.date,ref,narr:`Advance ${a.advances.map(x=>x.advRef).join(", ")} adjusted against bill ${a.bills.map(x=>x.no).join(", ")}`,party,entries})};
}
function tallyPlan(db, from, to, again, againAction) {
  const out=[]; const ok=(d)=>(!from||d>=from)&&(!to||d<=to);
  if (again) {   // re-export everything confirmed in the posting-date range, whether exported before or not
    db.collections.forEach(c=>{ if(c.status==="confirmed" && ok(postingDate(c))) out.push({k:"c",id:c.id,posted:postingDate(c),v:collVoucher(db,c,c.exp?againAction:"Create"),label:c.exp?"Re-export":"New"}); });
    db.advAdj.forEach(a=>{ if(ok(a.postedOn||a.date)) out.push({k:"a",id:a.id,posted:a.postedOn||a.date,v:advVoucher(db,a,a.exp?againAction:"Create"),label:a.exp?"Re-export":"New"}); });
    return out.sort((x,y)=>x.v.date.localeCompare(y.v.date)||x.id-y.id);
  }
  db.collections.forEach(c=>{
    if (c.status==="confirmed") { if(!c.exp) { if(ok(postingDate(c))) out.push({k:"c",id:c.id,posted:postingDate(c),v:collVoucher(db,c,"Create"),label:"New"}); } else if(c.exp.sig!==collSig(db,c)) out.push({k:"c",id:c.id,posted:postingDate(c),v:collVoucher(db,c,"Alter"),label:"Changed"}); }
    else if (c.status==="rejected" && c.exp && !c.exp.deleted) out.push({k:"c",id:c.id,posted:postingDate(c),v:collVoucher(db,c,"Delete"),label:"Reversed"}); });
  db.advAdj.forEach(a=>{ if(!a.exp && ok(a.postedOn||a.date)) out.push({k:"a",id:a.id,posted:a.postedOn||a.date,v:advVoucher(db,a,"Create"),label:"New"}); });
  db.tombstones.forEach(t=>out.push({k:"t",id:t.id,posted:t.date,v:advVoucher(db,{id:t.id,partyId:0,date:t.date,total:0,advances:[],bills:[]},"Delete"),label:"Reversed"}));
  return out.sort((x,y)=>x.v.date.localeCompare(y.v.date)||x.id-y.id);
}
function tallyXml(db, plan) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xe(db.tally.company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>\n`
    + plan.map(p=>p.v.xml).join("\n") + `\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
function TallyExport({db, setDb, me, flash}) {
  const dl = useDl(); const isAdmin = me.role==="admin"; const T = db.tally;
  const [pfrom,setPfrom]=useState(""), [pto,setPto]=useState(""); const [busy,setBusy]=useState(false); const [showXml,setShowXml]=useState(false); const [msg,setMsg]=useState(null); const [zip,setZip]=useState(null); const [again,setAgain]=useState(false); const [againAct,setAgainAct]=useState("Create");
  const plan = tallyPlan(db, pfrom, pto, again, againAct); const xml = tallyXml(db, plan);
  useEffect(()=>{ let on=true; setZip(null); if(!plan.length||typeof JSZip==="undefined") return; const z=new JSZip(); z.file("GMCM_Tally_Vouchers.xml",xml); z.generateAsync({type:"blob"}).then(b=>{ if(on) setZip(b); }).catch(()=>{}); return ()=>{ on=false; }; },[xml]);
  const cnt = (f)=>plan.filter(f).length, sumP = (f)=>sumAmt(plan.filter(f).map(p=>({amount:p.v.amount})));
  const setT = (k,v)=>setDb({...db,tally:{...T,[k]:v}});
  const manualBill = db.allocs.some(a=>a.status==="confirmed"&&db.bills.find(b=>b.id===a.billId)?.source==="manual");
  const mark = (fileName) => {
    const at=new Date().toISOString(), cs=new Set(plan.filter(p=>p.k==="c"&&p.v.action!=="Delete").map(p=>p.id)), cd=new Set(plan.filter(p=>p.k==="c"&&p.v.action==="Delete").map(p=>p.id)), as=new Set(plan.filter(p=>p.k==="a").map(p=>p.id));
    setDb({...db,
      collections:db.collections.map(c=>cs.has(c.id)?{...c,exp:{sig:collSig(db,c),at}}:cd.has(c.id)?{...c,exp:{...c.exp,deleted:true}}:c),
      advAdj:db.advAdj.map(a=>as.has(a.id)?{...a,exp:{at}}:a), tombstones:again?db.tombstones:[],
      expBatches:[...db.expBatches,{id:uid(),at,by:me.id,file:fileName+(again?` (re-export ${pfrom?dmy(pfrom):"start"} to ${pto?dmy(pto):"end"})`:""),vouchers:plan.length,receipts:cnt(p=>p.v.type==="Receipt"&&p.v.action!=="Delete"),journals:cnt(p=>p.v.type==="Journal"&&p.v.action!=="Delete"),changed:cnt(p=>p.label==="Changed"),reversed:cnt(p=>p.label==="Reversed")}]}); };
  const stamp = ()=>new Date().toISOString().slice(0,16).replace(/[-:T]/g,"").replace(/^(\d{8})/,"$1_");
  const go = async (how) => {
    if(!plan.length) return; if(!T.company) { setMsg({t:"err",m:"Enter the Tally company name in the settings box above first."}); return; } setBusy(true); setMsg(null);
    try {
      const base=`GMCM_Tally_Vouchers_${stamp()}`;
      if(how==="copy"){ await navigator.clipboard.writeText(xml); mark(base+" (copied)"); setMsg({t:"ok",m:"XML copied – paste it into a text file and save it as .xml"}); }
      else if(how==="zip"){ if(!zip) { setMsg({t:"err",m:"The ZIP is still being prepared – try again in a moment, or use the .txt button."}); setBusy(false); return; } await dl.save({filename:base+".zip",data:zip}); mark(base+".zip"); setMsg({t:"ok",m:"Saved. Unzip it to get the .xml file for Tally."}); }
      else { await dl.save({filename:base+".xml",data:new Blob([xml],{type:"application/xml"})}); mark(base+".xml"); setMsg({t:"ok",m:"Saved. Import this .xml file in Tally."}); }
    } catch(e){ if(e&&e.code==="declined") setMsg({t:"err",m:"Download cancelled – nothing was marked as exported."}); else setMsg({t:"err",m:"Could not export ("+(e&&(e.code||e.message)||"error")+"). Try the .txt or Copy XML button."}); }
    setBusy(false); };
  const name=(id)=>db.users.find(u=>u.id===id)?.name||"";
  const fld=(k,label)=><div style={{flex:"1 1 200px"}}><label>{label}</label><input value={T[k]} disabled={!isAdmin} onChange={e=>setT(k,e.target.value)}/></div>;
  return <>
    <details className="card"><summary>Tally ledger names &amp; company {isAdmin?"":"(view only)"}</summary>
      <div className="row" style={{flexWrap:"wrap",gap:10,alignItems:"flex-start"}}>{fld("company","Tally company name (exact)")}{fld("cash","Cash receipts → ledger")}{fld("bank","Bank / UPI receipts → ledger")}{fld("cheque","Cheques → ledger")}{fld("salesReturn","Goods return → debit ledger")}{fld("discount","Discount → debit ledger")}{fld("other","Other adjustment → debit ledger")}</div>
      <label style={{display:"flex",gap:8,alignItems:"center",color:"var(--ink)"}}><input type="checkbox" style={{width:20,height:20}} disabled={!isAdmin} checked={T.bankAlloc} onChange={e=>setT("bankAlloc",e.target.checked)}/>Include cheque no./date and UTR as bank details in the voucher</label></details>
    <div className="grid" style={{marginBottom:12}}>
      <div className="card" style={{margin:0}}><div className="sub">Receipt vouchers</div><div className="amt">{cnt(p=>p.v.type==="Receipt"&&p.v.action!=="Delete")}</div><div className="sub">{money(sumP(p=>p.v.type==="Receipt"&&p.v.action!=="Delete"))}</div></div>
      <div className="card" style={{margin:0}}><div className="sub">Journal vouchers</div><div className="amt">{cnt(p=>p.v.type==="Journal"&&p.v.action!=="Delete")}</div><div className="sub">returns / discounts / advance adjustments</div></div>
      <div className="card" style={{margin:0}}><div className="sub">Changed after earlier export</div><div className="amt amber">{cnt(p=>p.label==="Changed")}</div><div className="sub">exported again as Alter</div></div>
      <div className="card" style={{margin:0}}><div className="sub">Reversed after export</div><div className="amt red">{cnt(p=>p.label==="Reversed")}</div><div className="sub">exported as Delete</div></div></div>
    {manualBill && <div className="flash err">Some receipts are against bills added manually by admin – those bills must exist in Tally too, or the import will fail for them.</div>}
    <div className="card"><div className="row" style={{flexWrap:"wrap",gap:10}}>
      <div><label style={{marginTop:0}}>Posting date from</label><input type="date" value={pfrom} onChange={e=>setPfrom(e.target.value)}/></div>
      <div><label style={{marginTop:0}}>Posting date to</label><input type="date" value={pto} onChange={e=>setPto(e.target.value)}/></div>
      <div className="row" style={{gap:8,flexWrap:"wrap"}}>{dl && <button disabled={busy||!plan.length} onClick={()=>go("zip")}>⬇ Download ZIP (contains .xml)</button>}
        {dl && <button className="sec" disabled={busy||!plan.length} onClick={()=>go("txt")}>⬇ XML file (for Tally)</button>}
        <button className="sec" disabled={busy||!plan.length} onClick={()=>go("copy")}>Copy XML</button></div></div>
      <div className="row sub" style={{justifyContent:"flex-start",gap:10,marginTop:6}}><a onClick={()=>{const d=iso(new Date());setPfrom(d);setPto(d);}}>Today only</a><a onClick={()=>{setPfrom("");setPto("");}}>Clear dates</a></div>
      <div style={{marginTop:10,padding:10,background:again?"#fff3e0":"#fafbfc",borderRadius:10}}>
        <label style={{display:"flex",gap:8,alignItems:"center",color:"var(--ink)",fontSize:16,margin:0}}><input type="checkbox" style={{width:20,height:20}} checked={again} onChange={e=>setAgain(e.target.checked)}/><b>Export again for these dates</b> – include entries already exported before</label>
        {again && <><div className="sub" style={{margin:"6px 0"}}>Picks every confirmed entry whose posting date is within the dates above{!pfrom&&!pto?" (no dates set – this means everything)":""}.</div>
          <label style={{display:"flex",gap:8,alignItems:"center",color:"var(--ink)",fontSize:15,margin:"4px 0"}}><input type="radio" style={{width:18,height:18}} checked={againAct==="Create"} onChange={()=>setAgainAct("Create")}/>Send as <b>Create</b> – use if those vouchers are not in Tally (new company / data restored). Importing over vouchers already in Tally may duplicate them.</label>
          <label style={{display:"flex",gap:8,alignItems:"center",color:"var(--ink)",fontSize:15,margin:"4px 0"}}><input type="radio" style={{width:18,height:18}} checked={againAct==="Alter"} onChange={()=>setAgainAct("Alter")}/>Send as <b>Alter</b> – use to refresh vouchers already imported (no duplicates).</label>
          <div className="sub">Entries never exported before are always sent as Create. Reversed entries are left out.</div></>}</div>
      {msg && <div className={"flash "+msg.t} style={{marginTop:10,marginBottom:0}}>{msg.m}</div>}
     
      {!plan.length && <div className="sub" style={{marginTop:8}}>Nothing to export. Only entries confirmed by accounts are exported, and each is exported once (tick “Export again for these dates” to repeat an earlier export). Entries are picked by their <b>posting date</b> (the day they were entered), so back-dated receipts are never missed.</div>}
      {plan.length>0 && <div className="sub" style={{marginTop:8}}>Marks these {plan.length} voucher(s) as exported only after the file is saved. Import in Tally: Gateway → Import → Vouchers.</div>}</div>
    {plan.length>0 && <div className="card scroll"><table><thead><tr><th>Posting date</th><th>Voucher date</th><th>Type</th><th>Party</th><th>Debit / Credit</th><th className="n">Amount</th></tr></thead><tbody>
      {plan.slice(0,200).map((p,i)=><tr key={i}><td>{dmy(p.posted)}</td><td>{dmy(p.v.date)}</td><td>{p.v.type} <span className={"pill "+(p.label==="New"?"ok":p.label==="Changed"||p.label==="Re-export"?"warn":"bad")}>{p.label}</span></td><td>{p.v.party}</td>
        <td className="sub">{p.v.dr?<>Dr {p.v.dr}<br/>Cr {p.v.cr}</>:"—"}</td><td className="n">{money(p.v.amount)}</td></tr>)}</tbody></table>
      {plan.length>200 && <div className="sub" style={{padding:8}}>Showing first 200 of {plan.length}.</div>}
      <div style={{padding:8}}><a onClick={()=>setShowXml(!showXml)}>{showXml?"Hide":"Preview"} XML</a>{showXml && <pre style={{whiteSpace:"pre-wrap",wordBreak:"break-all",fontSize:12,maxHeight:300,overflow:"auto",background:"#fafbfc",padding:8}}>{xml.slice(0,6000)}{xml.length>6000?"\n…":""}</pre>}</div></div>}
    <div className="card scroll"><h3 style={{marginTop:0}}>Export history</h3><table><thead><tr><th>When</th><th>File</th><th className="n">Vouchers</th><th className="n">Receipts</th><th className="n">Journals</th><th>By</th></tr></thead><tbody>
      {[...db.expBatches].reverse().map(b=><tr key={b.id}><td>{new Date(b.at).toLocaleString("en-IN")}</td><td className="sub">{b.file}</td><td className="n">{b.vouchers}</td><td className="n">{b.receipts}</td><td className="n">{b.journals}</td><td>{name(b.by)}</td></tr>)}
      {!db.expBatches.length && <tr><td colSpan="6" className="sub">No export yet.</td></tr>}</tbody></table></div>
  </>;
}

/* ================= management reports (screen + Excel + PDF) ================= */
const C = {                                   // column helpers: t = m money | d date | n number | (text)
  txt:(h,k,w)=>({h,k,w}), m:(h,k)=>({h,k,t:"m"}), d:(h,k)=>({h,k,t:"d"}), n:(h,k)=>({h,k,t:"n"}) };
const cellTxt = (c,v) => c.t==="m" ? money(v) : c.t==="d" ? dmy(v) : c.t==="n" ? String(v??"") : (v??"");
const pdfTxt = (c,v) => c.t==="m" ? rsf(v) : c.t==="d" ? dmy(v) : c.t==="n" ? String(v??"") : String(v??"");
function aggColl(list) {
  const r = list.filter(c=>!isAdj(c)&&c.status!=="rejected"), a = list.filter(c=>isAdj(c)&&c.status!=="rejected"), by = (l,k,v)=>sumAmt(l.filter(c=>c[k]===v));
  return {entries:r.length, cash:by(r,"mode","cash"), cheque:by(r,"mode","cheque"), online:by(r,"mode","online"), total:sumAmt(r),
    ret:by(a,"kind","return"), disc:by(a,"kind","discount"), other:by(a,"kind","other"), adv:Math.round(r.reduce((t,c)=>t+(c.advance||0),0)*100)/100,
    confirmed:sumAmt(r.filter(c=>c.status==="confirmed")), awaiting:sumAmt(r.filter(c=>c.status==="provisional"))}; }
function buildReport(db, kind, f) {
  const today = iso(new Date()); const uname=(id)=>db.users.find(u=>u.id===id)?.name||"", party=(id)=>db.parties.find(p=>p.id===id);
  const inR = (c)=>(!f.from||postingDate(c)>=f.from)&&(!f.to||postingDate(c)<=f.to);
  const okC = (c)=>inR(c)&&(!f.sm||c.salesmanId===+f.sm)&&(!f.loc||party(c.partyId)?.loc===f.loc);
  const okP = (p)=>p.active&&(!f.sm||p.salesmanId===+f.sm)&&(!f.loc||p.loc===f.loc);
  const per = `${f.from?dmy(f.from):"start"}${f.to&&f.to!==f.from?" to "+dmy(f.to):""}`;
  const sub = [`Salesman: ${f.sm?uname(+f.sm):"All"}   |   Location: ${f.loc||"All"}`];
  const status = (c)=>c.status==="confirmed"?"Posted":c.status==="rejected"?"Rejected":"Awaiting accounts";
  const detail = (c)=>[c.chequeNo?`Chq ${c.chequeNo} (${dmy(c.chequeDate)})`:"",c.ref?`Ref ${c.ref}`:"",c.bank||""].filter(Boolean).join(" · ");
  const sumCols = [C.n("Entries","entries"),C.m("Cash","cash"),C.m("Cheque","cheque"),C.m("Bank / UPI","online"),C.m("Total collected","total"),C.m("Goods return","ret"),C.m("Discount","disc"),C.m("Other adj.","other"),C.m("of which Advance","adv"),C.m("Posted","confirmed"),C.m("Awaiting accounts","awaiting")];
  const tot = (rows)=>{ const o={}; sumCols.forEach(c=>{ o[c.k]=Math.round(rows.reduce((t,r)=>t+r[c.k],0)*100)/100; }); return o; };
  if (kind==="summary") {
    const list = db.collections.filter(okC);
    const bySm = [...new Set(list.map(c=>c.salesmanId))].map(id=>({name:uname(id),...aggColl(list.filter(c=>c.salesmanId===id))})).sort((a,b)=>a.name.localeCompare(b.name));
    const byLoc = [...new Set(list.map(c=>party(c.partyId)?.loc||"—"))].map(l=>({name:l,...aggColl(list.filter(c=>(party(c.partyId)?.loc||"—")===l))}));
    const byDay = [...new Set(list.map(postingDate))].sort().map(d=>({name:d,...aggColl(list.filter(c=>postingDate(c)===d))}));
    return {title:"Collection Summary", file:"Collection_Summary", subtitle:[`Posting date: ${per}`,...sub], tables:[
      {name:"Salesman-wise",cols:[C.txt("Salesman","name"),...sumCols],rows:bySm,foot:{name:"Total",...tot(bySm)}},
      {name:"Location-wise",cols:[C.txt("Location","name"),...sumCols],rows:byLoc,foot:{name:"Total",...tot(byLoc)}},
      {name:"Day-wise (posting date)",cols:[C.d("Posting date","name"),...sumCols],rows:byDay,foot:{name:"Total",...tot(byDay)}}]};
  }
  if (kind==="register") {
    const list = db.collections.filter(okC).sort((a,b)=>postingDate(a).localeCompare(postingDate(b))||a.id-b.id);
    const rows = list.map(c=>({pd:postingDate(c),rd:c.date,sm:uname(c.salesmanId),party:party(c.partyId)?.name||"",loc:party(c.partyId)?.loc||"",type:modeLabel(c),det:detail(c),amt:c.amount,adv:c.advance||0,st:status(c),ld:c.status==="confirmed"?(c.postDate||c.date):"",by:c.confirmedBy?uname(c.confirmedBy):"",note:[c.note,c.dateChanged?"Receipt date differs":"",c.adminEdited?"Edited by admin":"",c.status==="rejected"?"Rejected: "+(c.reason||""):""].filter(Boolean).join(" | ")}));
    const live = rows.filter(r=>r.st!=="Rejected"), rcp = list.filter(c=>c.status!=="rejected"&&!isAdj(c));
    return {title:"Collection Register", file:"Collection_Register", subtitle:[`Posting date: ${per}`,...sub], tables:[{cols:[C.d("Posting date","pd"),C.d("Receipt date","rd"),C.txt("Salesman","sm"),C.txt("Party","party"),C.txt("Location","loc"),C.txt("Type / Mode","type"),C.txt("Cheque / UTR / Bank","det"),C.m("Amount","amt"),C.m("Advance","adv"),C.txt("Status","st"),C.d("Ledger / bank date","ld"),C.txt("Confirmed by","by"),C.txt("Remarks","note")],
      rows,foot:{party:"Total receipts (excl. adjustments & rejected)",amt:sumAmt(rcp),adv:Math.round(rcp.reduce((t,c)=>t+(c.advance||0),0)*100)/100}}]};
  }
  if (kind==="cheques") {
    const list = db.collections.filter(c=>c.mode==="cheque"&&!isAdj(c)&&okC(c)&&(!f.cst||(f.cst==="hand"?c.status==="provisional":f.cst==="bank"?c.status==="confirmed":c.status==="rejected"))).sort((a,b)=>(a.chequeDate||"").localeCompare(b.chequeDate||""));
    const days=(c)=>c.status==="provisional"?Math.round((new Date(c.chequeDate+"T12:00:00")-new Date(today+"T12:00:00"))/864e5):"";
    const rows = list.map(c=>({cd:c.chequeDate,no:c.chequeNo,party:party(c.partyId)?.name||"",sm:uname(c.salesmanId),bank:c.bank||"",amt:c.amount,pd:postingDate(c),st:c.status==="provisional"?"In hand (not yet in bank)":c.status==="confirmed"?"Received in bank":"Returned / rejected",bd:c.status==="confirmed"?(c.postDate||c.date):"",dd:days(c),flag:c.status==="provisional"?(days(c)>0?"Post-dated":days(c)<0?"Cheque date passed – deposit":"Due today"):""}));
    return {title:"Cheque Register", file:"Cheque_Register", subtitle:[`Posting date: ${per}`,...sub,`Status: ${f.cst==="hand"?"In hand":f.cst==="bank"?"Received in bank":f.cst==="rej"?"Returned":"All"}`], tables:[{cols:[C.d("Cheque date","cd"),C.txt("Cheque no.","no"),C.txt("Party","party"),C.txt("Salesman","sm"),C.txt("Bank","bank"),C.m("Amount","amt"),C.d("Posting date","pd"),C.txt("Status","st"),C.d("Received in bank","bd"),C.n("Days to cheque date","dd"),C.txt("Note","flag")],
      rows,foot:{party:"Total (excl. returned)",amt:sumAmt(list.filter(c=>c.status!=="rejected"))}}]};
  }
  if (kind==="approvals") {
    const list = db.collections.filter(c=>c.status==="provisional"&&okC(c)).sort((a,b)=>postingDate(a).localeCompare(postingDate(b))||a.id-b.id);
    const rows = list.map(c=>({pd:postingDate(c),rd:c.date,sm:uname(c.salesmanId),party:party(c.partyId)?.name||"",type:modeLabel(c),det:detail(c),amt:c.amount,adv:c.advance||0,wait:Math.round((new Date(today+"T12:00:00")-new Date(postingDate(c)+"T12:00:00"))/864e5),flag:[c.dateChanged?"Receipt date differs":"",c.adminEdited?"Edited by admin":""].filter(Boolean).join(" | ")}));
    const byMode = ["cash","online","cheque"].map(m=>({name:MODES[m],n:list.filter(c=>!isAdj(c)&&c.mode===m).length,amt:sumAmt(list.filter(c=>!isAdj(c)&&c.mode===m))})).concat(Object.entries(ADJ).map(([k,v])=>({name:v+" (journal)",n:list.filter(c=>c.kind===k).length,amt:sumAmt(list.filter(c=>c.kind===k))})));
    const adv = db.parties.filter(okP).map(p=>({p,i:advanceInfo(db,p.id),b:partyBills(db,p.id)})).filter(r=>r.i.total>0.005).map(r=>({party:r.p.name,sm:uname(r.p.salesmanId),adv:r.i.total,conf:r.i.adjustable,pend:sumAmt(r.b.map(x=>({amount:x.pending}))) ,st:r.i.adjustable<0.005?"Advance not yet confirmed":sumAmt(r.b.map(x=>({amount:x.pending})))<0.005?"Waiting for new bill":"Ready to adjust"}));
    return {title:"Pending Approval Report (awaiting accounts confirmation)", file:"Pending_Approvals", subtitle:[`As on ${dmy(today)}   |   Posting date: ${per||"all"}`,...sub], tables:[
      {name:"Summary by type",cols:[C.txt("Type","name"),C.n("Entries","n"),C.m("Amount","amt")],rows:byMode,foot:{name:"Total",n:byMode.reduce((t,r)=>t+r.n,0),amt:sumAmt(byMode.map(r=>({amount:r.amt})))}},
      {name:"Entries awaiting confirmation",cols:[C.d("Posting date","pd"),C.d("Receipt date","rd"),C.txt("Salesman","sm"),C.txt("Party","party"),C.txt("Type / Mode","type"),C.txt("Cheque / UTR / Bank","det"),C.m("Amount","amt"),C.m("Advance","adv"),C.n("Days waiting","wait"),C.txt("Flags","flag")],rows,foot:{party:"Total",amt:sumAmt(list)}},
      {name:"Advances awaiting adjustment",cols:[C.txt("Party","party"),C.txt("Salesman","sm"),C.m("Advance held","adv"),C.m("Confirmed (adjustable)","conf"),C.m("Pending bills","pend"),C.txt("Status","st")],rows:adv,foot:{party:"Total",adv:sumAmt(adv.map(r=>({amount:r.adv})))}}]};
  }
  if (kind==="ageing") {
    const bk=(b)=>b.age<=30?"b1":b.age<=60?"b2":b.age<=90?"b3":"b4";
    const rows = db.parties.filter(okP).map(p=>{ const bs=partyBills(db,p.id); const o={party:p.name,sm:uname(p.salesmanId),loc:p.loc||"",grp:p.group||"",b1:0,b2:0,b3:0,b4:0,total:0}; bs.forEach(b=>{o[bk(b)]+=b.pending;o.total+=b.pending;}); Object.keys(o).forEach(k=>{ if(typeof o[k]==="number") o[k]=Math.round(o[k]*100)/100; }); return o; }).filter(r=>r.total>0.005).sort((a,b)=>b.total-a.total);
    const cols=[C.m("0-30 days","b1"),C.m("31-60 days","b2"),C.m("61-90 days","b3"),C.m("Over 90 days","b4"),C.m("Total","total")];
    const t=(rs)=>{ const o={}; ["b1","b2","b3","b4","total"].forEach(k=>o[k]=Math.round(rs.reduce((a,r)=>a+r[k],0)*100)/100); return o; };
    const bySm=[...new Set(rows.map(r=>r.sm))].sort().map(n=>({name:n||"—",...t(rows.filter(r=>r.sm===n))}));
    return {title:"Ageing Analysis (age from bill date)", file:"Ageing", subtitle:[`As on ${dmy(today)}`,...sub], tables:[
      {name:"Salesman-wise",cols:[C.txt("Salesman","name"),...cols],rows:bySm,foot:{name:"Total",...t(rows)}},
      {name:"Party-wise",cols:[C.txt("Party","party"),C.txt("Salesman","sm"),C.txt("Location","loc"),C.txt("Route group","grp"),...cols],rows,foot:{party:"Total",...t(rows)}}]};
  }
  if (kind==="outstanding") {
    const key = f.grp==="loc"?(p)=>p.loc||"—":f.grp==="route"?(p)=>p.group||"—":(p)=>uname(p.salesmanId)||"Unassigned";
    const ps = db.parties.filter(okP).map(p=>({p,bs:partyBills(db,p.id),adv:advanceInfo(db,p.id).total}));
    const rows=[...new Set(ps.map(x=>key(x.p)))].sort().map(n=>{ const g=ps.filter(x=>key(x.p)===n); const out=sumAmt(g.flatMap(x=>x.bs).map(b=>({amount:b.pending}))); const adv=sumAmt(g.map(x=>({amount:x.adv}))); return {name:n,parties:g.filter(x=>x.bs.length).length,bills:g.reduce((t,x)=>t+x.bs.length,0),out,adv,net:Math.round((out-adv)*100)/100}; });
    const ft={name:"Total",parties:rows.reduce((t,r)=>t+r.parties,0),bills:rows.reduce((t,r)=>t+r.bills,0),out:sumAmt(rows.map(r=>({amount:r.out}))),adv:sumAmt(rows.map(r=>({amount:r.adv}))),net:sumAmt(rows.map(r=>({amount:r.net})))};
    return {title:"Outstanding Summary", file:"Outstanding_Summary", subtitle:[`As on ${dmy(today)}`,`Grouped by ${f.grp==="loc"?"location":f.grp==="route"?"route group":"salesman"}`,...sub], tables:[{cols:[C.txt(f.grp==="loc"?"Location":f.grp==="route"?"Route group":"Salesman","name"),C.n("Parties with balance","parties"),C.n("Open bills","bills"),C.m("Outstanding","out"),C.m("Advance held","adv"),C.m("Net","net")],rows,foot:ft}]};
  }
  // bill-wise pending
  const rows=[]; db.parties.filter(p=>okP(p)&&(f.day==="all"||f.day===undefined||p.days.includes(f.day))).sort((a,b)=>a.name.localeCompare(b.name)).forEach(p=>partyBills(db,p.id).forEach(b=>rows.push({sm:uname(p.salesmanId),grp:p.group||"",party:p.name,no:b.no,bd:b.date,age:b.age,amt:b.amount,pend:b.pending})));
  return {title:"Pending Bills (bill-wise)", file:"Pending_Bills", subtitle:[`As on ${dmy(today)}   |   Visit day: ${f.day==="all"||f.day===undefined?"All":DAYS[f.day]}`,...sub], tables:[{cols:[C.txt("Salesman","sm"),C.txt("Route group","grp"),C.txt("Party","party"),C.txt("Bill no.","no"),C.d("Bill date","bd"),C.n("Days","age"),C.m("Bill amount","amt"),C.m("Pending","pend")],rows,foot:{party:"Total pending",pend:sumAmt(rows.map(r=>({amount:r.pend})))}}]};
}
function makeReportXlsx(rep) {
  const wb = XLSX.utils.book_new();
  rep.tables.forEach((t,i)=>{
    const head=[[rep.title],...rep.subtitle.map(x=>[x]),[]]; if(t.name) head.push([t.name]);
    const aoa=[...head, t.cols.map(c=>c.h), ...t.rows.map(r=>t.cols.map(c=>c.t==="d"?(r[c.k]?Math.round(Date.UTC(+r[c.k].slice(0,4),+r[c.k].slice(5,7)-1,+r[c.k].slice(8,10))/864e5)+25569:""):(c.t==="m"||c.t==="n")?(r[c.k]===""||r[c.k]==null?"":Number(r[c.k])):(r[c.k]??"")))];
    if(t.foot) aoa.push(t.cols.map(c=>t.foot[c.k]===undefined?"":(c.t==="m"||c.t==="n")?Number(t.foot[c.k]):t.foot[c.k]));
    const ws=XLSX.utils.aoa_to_sheet(aoa); const hr=head.length;
    ws["!cols"]=t.cols.map(c=>({wch:c.t==="m"?16:c.t==="d"?13:c.t==="n"?10:Math.min(40,Math.max(14,c.h.length+4,...t.rows.slice(0,60).map(r=>String(r[c.k]??"").length+2)))}));
    t.cols.forEach((c,ci)=>{ for(let r=hr+1;r<aoa.length;r++){ const ref=XLSX.utils.encode_cell({r,c:ci}); const cell=ws[ref]; if(!cell) continue; if(c.t==="m") cell.z="#,##0.00"; if(c.t==="d") cell.z="dd-mm-yyyy"; } });
    const nm=(t.name||rep.title).replace(/[\\\/\?\*\[\]:]/g,"").slice(0,28)||("Sheet"+(i+1));
    XLSX.utils.book_append_sheet(wb,ws,nm+(wb.SheetNames.includes(nm)?i:""));
  });
  return new Blob([XLSX.write(wb,{type:"array",bookType:"xlsx"})],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
function makeReportPdf(rep) {
  const { jsPDF } = window.jspdf; const wide = Math.max(...rep.tables.map(t=>t.cols.length))>7; const doc = new jsPDF({orientation:wide?"landscape":"portrait"});
  let y = pdfHeader(doc, "Gurmeet Motors - "+rep.title, [...rep.subtitle, `Generated: ${new Date().toLocaleString("en-IN")}`]);
  rep.tables.forEach(t=>{
    if(t.name){ doc.setFontSize(11); doc.text(t.name, 14, y+4); y+=2; }
    doc.autoTable({startY:y+4, head:[t.cols.map(c=>c.h)], body:t.rows.map(r=>t.cols.map(c=>pdfTxt(c,r[c.k]))),
      foot:t.foot?[t.cols.map(c=>t.foot[c.k]===undefined?"":pdfTxt(c,t.foot[c.k]))]:undefined,
      styles:{fontSize:wide?7:8}, headStyles:{fillColor:[11,92,173]}, footStyles:{fillColor:[240,240,240],textColor:0},
      columnStyles:Object.fromEntries(t.cols.map((c,i)=>[i,{halign:c.t==="m"||c.t==="n"?"right":"left"}]))});
    y = doc.lastAutoTable.finalY+8; });
  pdfPageNumbers(doc); return doc.output("blob");
}
function ReportsHub({db, me, flash}) {
  const dl = useDl(); const t0 = iso(new Date());
  const KINDS = [["summary","Collection Summary"],["register","Collection Register"],["approvals","Pending Approvals"],["cheques","Cheque Register"],["ageing","Ageing"],["outstanding","Outstanding Summary"],["bills","Pending Bills"]];
  const [kind,setKind]=useState("summary"); const [from,setFrom]=useState(t0), [to,setTo]=useState(t0), [preset,setPreset]=useState("today");
  const [sm,setSm]=useState(""), [loc,setLoc]=useState(""), [cst,setCst]=useState(""), [grp,setGrp]=useState("sm"), [day,setDay]=useState("all");
  const usesDates = ["summary","register","cheques","approvals"].includes(kind);
  const pick=(k)=>{ setPreset(k); const d=new Date(); if(k==="today"){setFrom(t0);setTo(t0);} else if(k==="yest"){const y=addDays(t0,-1);setFrom(y);setTo(y);} else if(k==="week"){setFrom(addDays(t0,-6));setTo(t0);} else if(k==="month"){setFrom(iso(new Date(d.getFullYear(),d.getMonth(),1)));setTo(t0);} else if(k==="all"){setFrom("");setTo("");} };
  const rep = buildReport(db, kind, {from:usesDates?from:"",to:usesDates?to:"",sm,loc,cst,grp,day});
  const rows = rep.tables.reduce((t,x)=>t+x.rows.length,0);
  const fname = `${rep.file}${usesDates&&from?"_"+from+(to!==from?"_to_"+to:""):"_"+t0}`;
  const xlsx = async()=>{ try{ await dl.save({filename:fname+".xlsx",data:makeReportXlsx(rep)}); }catch(e){ if(!(e&&e.code==="declined")) flash("err","Could not create Excel: "+(e.message||e.code||"error")); } };
  return <>
    <div className="tabs">{KINDS.map(([k,v])=><a key={k} className={kind===k?"on":""} onClick={()=>setKind(k)}>{v}</a>)}</div>
    <div className="card">
      {usesDates && <><div className="tabs" style={{marginBottom:4}}>{[["today","Today"],["yest","Yesterday"],["week","Last 7 days"],["month","This month"],["all","All dates"],["custom","Choose dates"]].map(([k,v])=><a key={k} className={preset===k?"on":""} onClick={()=>k==="custom"?setPreset("custom"):pick(k)}>{v}</a>)}</div>
        <div className="sub">By <b>posting date</b> (the day the entry was made){kind==="approvals"?"; all dates shows everything still waiting":""}</div>
        {preset==="custom" && <div className="row" style={{gap:8}}><div style={{flex:1}}><label>From</label><input type="date" value={from} max={to||undefined} onChange={e=>setFrom(e.target.value)}/></div><div style={{flex:1}}><label>To</label><input type="date" value={to} min={from||undefined} onChange={e=>setTo(e.target.value)}/></div></div>}</>}
      <div className="row" style={{gap:8,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 150px"}}><label>Salesman</label><select value={sm} onChange={e=>setSm(e.target.value)}><option value="">All</option>{db.users.filter(u=>u.role==="salesman").map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <div style={{flex:"1 1 150px"}}><label>Location</label><select value={loc} onChange={e=>setLoc(e.target.value)}><option value="">All</option>{LOCS.map(l=><option key={l}>{l}</option>)}</select></div>
        {kind==="cheques" && <div style={{flex:"1 1 150px"}}><label>Cheque status</label><select value={cst} onChange={e=>setCst(e.target.value)}><option value="">All</option><option value="hand">In hand (not in bank)</option><option value="bank">Received in bank</option><option value="rej">Returned</option></select></div>}
        {kind==="outstanding" && <div style={{flex:"1 1 150px"}}><label>Group by</label><select value={grp} onChange={e=>setGrp(e.target.value)}><option value="sm">Salesman</option><option value="loc">Location</option><option value="route">Route group</option></select></div>}
        {kind==="bills" && <div style={{flex:"1 1 150px"}}><label>Visit day</label><select value={day} onChange={e=>setDay(e.target.value==="all"?"all":+e.target.value)}><option value="all">All days</option>{DAYS.map((d,i)=><option key={i} value={i}>{d}</option>)}</select></div>}</div>
      <div className="row" style={{justifyContent:"flex-start",gap:8,marginTop:12,flexWrap:"wrap"}}>
        {dl && <button disabled={!rows} onClick={xlsx}>⬇ Excel</button>}
        <PdfBtn dl={dl} cls="sec" label="PDF" onClick={()=>rows&&savePdf(dl,fname+".pdf",()=>makeReportPdf(rep),flash)}/>
        {!dl && <span className="sub">Downloads work in the published page.</span>}</div></div>
    <div className="card"><div className="name">{rep.title}</div>{rep.subtitle.map((x,i)=><div key={i} className="sub">{x}</div>)}</div>
    {rep.tables.map((t,i)=><div key={i} className="card scroll">{t.name && <h3 style={{marginTop:0}}>{t.name}</h3>}
      <table><thead><tr>{t.cols.map(c=><th key={c.k} className={c.t==="m"||c.t==="n"?"n":""}>{c.h}</th>)}</tr></thead><tbody>
        {t.rows.slice(0,300).map((r,j)=><tr key={j}>{t.cols.map(c=><td key={c.k} className={c.t==="m"||c.t==="n"?"n":""}>{cellTxt(c,r[c.k])}</td>)}</tr>)}
        {!t.rows.length && <tr><td colSpan={t.cols.length} className="empty">Nothing to show for this selection.</td></tr>}
        {t.foot && t.rows.length>0 && <tr style={{fontWeight:700,background:"#fafbfc"}}>{t.cols.map(c=><td key={c.k} className={c.t==="m"||c.t==="n"?"n":""}>{t.foot[c.k]===undefined?"":cellTxt(c,t.foot[c.k])}</td>)}</tr>}</tbody></table>
      {t.rows.length>300 && <div className="sub" style={{padding:8}}>Showing first 300 of {t.rows.length} rows – the Excel / PDF has all of them.</div>}</div>)}
  </>;
}

/* ================= admin screens ================= */
function Dashboard({db, setTab}) {
  const sums = db.parties.filter(p=>p.active).map(p=>partySummary(db,p));
  const byLoc = LOCS.map(l=>({name:l, n:sums.filter(s=>s.loc===l).length, o:sums.filter(s=>s.loc===l).reduce((a,s)=>a+s.outstanding,0)}));
  const sms = db.users.filter(u=>u.role==="salesman"&&u.active).map(u=>({name:u.name, n:sums.filter(s=>s.salesmanId===u.id).length, o:sums.filter(s=>s.salesmanId===u.id).reduce((a,s)=>a+s.outstanding,0)}));
  const un = sums.filter(s=>s.salesmanId==null).length;
  return <>
    <div className="card row"><div><div className="sub">Total outstanding (all locations)</div><div className="big red">{money(sums.reduce((a,s)=>a+s.outstanding,0))}</div></div>
      <div className="sub" style={{textAlign:"right"}}>{db.bills.length} bills<br/>{sums.length} parties{sums.some(x=>x.advance>0)?<><br/><span className="green">Advances held {money(sums.reduce((a,x)=>a+x.advance,0))}</span></>:null}</div></div>
    {db.collections.some(c=>c.status==="provisional") && <div className="flash" style={{background:"#fff3e0",color:"var(--warn)"}}>{db.collections.filter(c=>c.status==="provisional").length} collection(s) worth {money(db.collections.filter(c=>c.status==="provisional").reduce((a,c)=>a+c.amount,0))} waiting for confirmation. <a onClick={()=>setTab("coll")}>Confirm now</a></div>}
    {un>0 && <div className="flash err">{un} part{un===1?"y":"ies"} not assigned to any salesman. <a onClick={()=>setTab("parties:unassigned")}>Fix now</a></div>}
    {!db.parties.length && <div className="flash err">No data yet. Go to <a onClick={()=>setTab("import")}>Import</a>: first the Master, then the Sales Book.</div>}
    <div className="grid">
      <div className="card scroll"><h3 style={{marginTop:0}}>Location-wise</h3><table><thead><tr><th>Location</th><th className="n">Parties</th><th className="n">Outstanding</th></tr></thead><tbody>
        {byLoc.map(r=><tr key={r.name}><td>{r.name}</td><td className="n">{r.n}</td><td className="n">{money(r.o)}</td></tr>)}</tbody></table></div>
      <div className="card scroll"><h3 style={{marginTop:0}}>Salesman-wise</h3><table><thead><tr><th>Salesman</th><th className="n">Parties</th><th className="n">Outstanding</th></tr></thead><tbody>
        {sms.map(r=><tr key={r.name}><td>{r.name}</td><td className="n">{r.n}</td><td className="n">{money(r.o)}</td></tr>)}
        {!sms.length && <tr><td colSpan="3" className="sub">No salesman created yet.</td></tr>}</tbody></table></div>
    </div>
    <p className="sub">More summary reports will be added here in the next steps.</p>
  </>;
}
function PartyForm({db, p, onSave}) {
  const [f,setF]=useState(p||{name:"",loc:"Ranchi (HO)",group:"",salesmanId:null,days:[],phone:""});
  const set=(k,v)=>setF({...f,[k]:v});
  return <div style={{minWidth:250}}>
    <label>Party name (same as Tally ledger name)</label><input value={f.name} onChange={e=>set("name",e.target.value)}/>
    <label>Location</label><select value={f.loc||""} onChange={e=>set("loc",e.target.value)}><option value="">—</option>{LOCS.map(l=><option key={l}>{l}</option>)}</select>
    <label>Salesman</label><select value={f.salesmanId??""} onChange={e=>set("salesmanId",e.target.value?+e.target.value:null)}><option value="">— Unassigned —</option>{db.users.filter(u=>u.role==="salesman"&&u.active).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select>
    <label>Visit days (none = no fixed day)</label><DayChips days={f.days||[]} onChange={d=>set("days",d)}/>
    <label>Phone</label><input value={f.phone||""} onChange={e=>set("phone",e.target.value)}/>
    <br/><button className="sm" onClick={()=>onSave(f)}>Save</button></div>;
}
function AdminParties({db, setDb, flt, setFlt, flash, go}) {
  const [q,setQ]=useState(""); const [edit,setEdit]=useState(null); const [lim,setLim]=useState(100);
  const all = db.parties.filter(p=>p.active&&p.name.toLowerCase().includes(q.toLowerCase())).map(p=>partySummary(db,p)).filter(s=>flt!=="unassigned"||s.salesmanId==null);
  const rows = all.slice(0,lim);
  const save=(f)=>{
    if(!f.name.trim()) return flash("err","Party name is required");
    if(db.parties.some(p=>p.id!==f.id&&p.name.toLowerCase()===f.name.trim().toLowerCase())) return flash("err","A party with this name already exists");
    const parties = f.id ? db.parties.map(p=>p.id===f.id?{...p,...f,name:f.name.trim()}:p) : [...db.parties,{...f,name:f.name.trim(),id:uid(),active:true}];
    setDb({...db,parties}); setEdit(null); flash("ok","Party saved"); };
  return <>
    <div className="row" style={{marginBottom:12}}>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search party…"/>
      <select value={flt} onChange={e=>setFlt(e.target.value)} style={{maxWidth:200}}><option value="">All</option><option value="unassigned">Unassigned only</option></select>
      <button onClick={()=>setEdit("new")}>+ Add</button></div>
    {edit==="new" && <div className="card"><PartyForm db={db} onSave={save}/></div>}
    <div className="card scroll"><table><thead><tr><th>Party</th><th>Route group</th><th>Salesman</th><th>Days</th><th className="n">Outstanding</th><th></th></tr></thead><tbody>
      {rows.map(r=><React.Fragment key={r.id}>
        <tr><td><a onClick={()=>go({page:"party",id:r.id})}>{r.name}</a></td><td>{r.group||"—"}</td><td>{db.users.find(u=>u.id===r.salesmanId)?.name||"—"}</td>
          <td>{r.days.length?r.days.map(d=>DAYS[d].slice(0,3)).join(", "):"—"}</td><td className="n">{money(r.outstanding)}</td>
          <td><a onClick={()=>setEdit(edit===r.id?null:r.id)}>{edit===r.id?"Close":"Edit"}</a></td></tr>
        {edit===r.id && <tr><td colSpan="6"><PartyForm db={db} p={db.parties.find(p=>p.id===r.id)} onSave={save}/></td></tr>}
      </React.Fragment>)}
      {!rows.length && <tr><td colSpan="6" className="empty">No parties.</td></tr>}</tbody></table>
      {all.length>lim && <div style={{textAlign:"center",padding:10}}><button className="sec sm" onClick={()=>setLim(lim+200)}>Show more ({all.length-lim} left)</button></div>}</div>
  </>;
}
function AdminRoutes({db, setDb, flash}) {
  const sms = db.users.filter(u=>u.role==="salesman"&&u.active);
  const groups = {}; db.parties.filter(p=>p.active).forEach(p=>{ const k=p.group||"(no group)"; (groups[k]=groups[k]||[]).push(p); });
  const list = Object.entries(groups).map(([g,ps])=>({g,ps,sm:ps[0].salesmanId,days:ps[0].days,mixed:ps.some(p=>p.salesmanId!==ps[0].salesmanId||!same(p.days,ps[0].days)),
    out:ps.reduce((s,p)=>s+partySummary(db,p).outstanding,0)})).sort((a,b)=>(db.users.find(u=>u.id===a.sm)?.name||"~").localeCompare(db.users.find(u=>u.id===b.sm)?.name||"~")||a.g.localeCompare(b.g));
  const upd=(g,patch)=>{ setDb({...db,parties:db.parties.map(p=>(p.group||"(no group)")===g?{...p,...patch}:p)}); };
  return <>
    <p className="sub">Each Tally group is one beat. Changing salesman or days here updates every party in that group.</p>
    <div className="card scroll"><table><thead><tr><th>Route group (Tally)</th><th className="n">Parties</th><th>Salesman</th><th>Visit days</th><th className="n">Outstanding</th></tr></thead><tbody>
      {list.map(r=><tr key={r.g}><td>{r.g}{r.mixed && <div className="sub amber">individual overrides inside</div>}</td><td className="n">{r.ps.length}</td>
        <td><select value={r.sm??""} onChange={e=>upd(r.g,{salesmanId:e.target.value?+e.target.value:null})}><option value="">— none —</option>{sms.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></td>
        <td><DayChips days={r.days} onChange={d=>upd(r.g,{days:d})}/></td><td className="n">{money(r.out)}</td></tr>)}
      {!list.length && <tr><td colSpan="5" className="empty">Import the Master first.</td></tr>}</tbody></table></div>
  </>;
}
function AdminUsers({db, setDb, flash}) {
  const [edit,setEdit]=useState(null); const [f,setF]=useState({});
  const open=(u)=>{ setEdit(u?u.id:"new"); setF(u?{id:u.id,username:u.username,name:u.name,role:u.role,loc:u.loc,active:u.active,password:""}:{username:"",name:"",role:"salesman",loc:"",password:"",active:true}); };
  const set=(k,v)=>setF({...f,[k]:v});
  const save=()=>{
    if(!f.name.trim()) return flash("err","Name is required");
    if(edit==="new"){
      const un=(f.username||"").trim().toLowerCase();
      if(!un) return flash("err","Username is required");
      if(db.users.some(u=>u.username===un)) return flash("err","This username already exists");
      if((f.password||"").length<6) return flash("err","Password must be at least 6 characters");
      setDb({...db,users:[...db.users,{id:uid(),username:un,password:f.password,name:f.name.trim(),role:f.role,loc:f.loc,active:true}]});
    } else {
      if(f.password && f.password.length<6) return flash("err","Password must be at least 6 characters");
      setDb({...db,users:db.users.map(u=>u.id===edit?{...u,name:f.name.trim(),role:f.role,loc:f.loc,active:f.active,...(f.password?{password:f.password}:{})}:u)});
    }
    setEdit(null); flash("ok","User saved"); };
  const form = <div style={{minWidth:250}}>
    {edit==="new" && <><label>Username (for login)</label><input value={f.username} onChange={e=>set("username",e.target.value)} autoCapitalize="none"/></>}
    <label>Full name</label><input value={f.name} onChange={e=>set("name",e.target.value)}/>
    <label>Role</label><select value={f.role} onChange={e=>set("role",e.target.value)}><option value="salesman">Salesman</option><option value="accounts">Accounts</option><option value="admin">Admin</option></select>
    <label>Home location</label><select value={f.loc||""} onChange={e=>set("loc",e.target.value)}><option value="">—</option>{LOCS.map(l=><option key={l}>{l}</option>)}</select>
    <label>{edit==="new"?"Password (min 6 characters)":"New password (leave blank to keep)"}</label><input value={f.password} onChange={e=>set("password",e.target.value)}/>
    {edit!=="new" && <label><input type="checkbox" style={{width:"auto"}} checked={!!f.active} onChange={e=>set("active",e.target.checked)}/> Active</label>}
    <br/><button className="sm" onClick={save}>Save</button></div>;
  return <>
    <div style={{marginBottom:12}}><button onClick={()=>open(null)}>+ Add user</button></div>
    {edit==="new" && <div className="card">{form}</div>}
    <div className="card scroll"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Parties</th><th>Status</th><th></th></tr></thead><tbody>
      {db.users.map(u=><React.Fragment key={u.id}>
        <tr><td>{u.username}</td><td>{u.name}</td><td style={{textTransform:"capitalize"}}>{u.role}</td><td>{u.role==="salesman"?db.parties.filter(p=>p.salesmanId===u.id).length:"—"}</td>
          <td><span className={"pill "+(u.active?"ok":"bad")}>{u.active?"Active":"Disabled"}</span></td>
          <td><a onClick={()=>edit===u.id?setEdit(null):open(u)}>{edit===u.id?"Close":"Edit"}</a></td></tr>
        {edit===u.id && <tr><td colSpan="6">{form}</td></tr>}
      </React.Fragment>)}</tbody></table></div>
  </>;
}

function AdminImport({db, setDb, me, setTab, flash}) {
  const [res,setRes]=useState(null); const [busy,setBusy]=useState("");
  const log = (kind,file,added,skipped,errors,dbx) => ({...dbx, logs:[{id:uid(),at:new Date().toLocaleString("en-IN"),kind,file:file.name,added,skipped,errors,who:me.name},...db.logs].slice(0,10)});
  const run = async (kind, file) => {
    if(!file) return; setBusy(kind); setRes(null);
    try {
      if (kind==="master") {
        const m = buildMaster(await readMasterFile(file)); const a = applyMaster(db, m);
        setDb(log("Master",file,a.res.added+a.res.updated,0,0,{...db,users:a.users,parties:a.parties})); setRes({kind,...a.res});
      } else if (kind==="sales") {
        const x = await readSalesXml(file); const a = applySales(db, x);
        setDb(log("Sales Book",file,a.res.added,a.res.skipped.length,a.res.bad,{...db,parties:a.parties,bills:a.bills,tally:{...db.tally,company:x.company||db.tally.company}})); setRes({kind,...a.res});
      } else {
        const a = await importOpening(db, file);
        setDb(log("Opening",file,a.res.added,a.res.skipped.length,a.res.errors.length,{...db,parties:a.parties,bills:a.bills})); setRes({kind,...a.res});
      }
    } catch(e){ setRes({fatal:e.message}); }
    setBusy(""); };
  const Box=({kind,title,sub,accept})=><div className="card"><h3 style={{marginTop:0}}>{title}</h3><p className="sub">{sub}</p>
    <input type="file" accept={accept} disabled={!!busy} onChange={e=>{run(kind,e.target.files[0]); e.target.value="";}}/>
    {busy===kind && <p className="amber">Reading file… please wait.</p>}</div>;
  return <>
    {res?.fatal && <div className="flash err">{res.fatal}</div>}
    {res?.kind==="master" && <div className="card"><h3 style={{marginTop:0}}>Master imported</h3>
      <p className="green"><b>{res.added}</b> parties added, <b>{res.updated}</b> updated · location <b>{res.loc}</b> · <b>{res.groups}</b> route groups</p>
      <p>Salesmen found: <b>{res.salesmen.join(", ")||"none"}</b></p>
      {res.creds.length>0 && <p className="amber">New logins created (username / password) — ask them to change it:<br/><b>{res.creds.join("   •   ")}</b></p>}
      <p><a onClick={()=>setTab("routes")}>Check beats &amp; visit days →</a></p></div>}
    {res?.kind==="sales" && <div className="card"><h3 style={{marginTop:0}}>Sales Book imported</h3>
      <p className="green"><b>{res.added}</b> bills added · total {money(res.total)} · location {res.loc}</p>
      {res.skipped.length>0 && <p className="sub"><b>{res.skipped.length}</b> already existed (skipped): {res.skipped.slice(0,8).join(", ")}{res.skipped.length>8?" …":""}</p>}
      {res.cancelled>0 && <p className="sub">{res.cancelled} cancelled voucher(s) ignored.</p>}
      {Object.keys(res.other).length>0 && <p className="amber">Not imported (not Sales): {Object.entries(res.other).map(([k,v])=>`${v} × ${k||"unknown"}`).join(", ")}</p>}
      {res.bad>0 && <p className="red">{res.bad} voucher(s) had no party/amount and were skipped.</p>}
      {res.created.length>0 && <p className="amber"><b>{res.created.length}</b> customer(s) were not in the Master and were created without a salesman — <a onClick={()=>setTab("parties:unassigned")}>assign them</a>:<br/><span className="sub">{res.created.join(", ")}</span></p>}</div>}
    {res?.kind==="open" && <div className="card"><h3 style={{marginTop:0}}>Opening outstanding imported</h3><p className="green"><b>{res.added}</b> bills added.</p>
      {res.skipped.length>0 && <p className="sub">{res.skipped.length} already existed.</p>}{res.created.length>0 && <p className="amber">{res.created.length} new part{res.created.length===1?"y":"ies"} created.</p>}
      {res.errors.length>0 && <ul className="red">{res.errors.slice(0,20).map((e,i)=><li key={i}>{e}</li>)}</ul>}</div>}
    <div className="grid">
      <Box kind="master" title="1. Master (customers &amp; beats)" accept=".xlsx" sub="Tally → List of Ledgers → Excel (.xlsx). Run this first. Re-importing refreshes group, salesman and days."/>
      <Box kind="sales" title="2. Sales Book (XML)" accept=".xml" sub="Tally → Sales Register / Day Book → Export XML. Takes Bill No, Date, Customer and Amount. Safe to re-import: existing bills are skipped."/>
      <Box kind="open" title="3. Opening outstanding (optional)" accept=".xlsx,.xls,.csv" sub={"Excel with columns: "+OPEN_COLS.join(", ")+". Only if you want older pending bills."}/>
    </div>
    <div className="card scroll"><h3 style={{marginTop:0}}>Recent imports</h3><table><thead><tr><th>When</th><th>Type</th><th>File</th><th className="n">Added</th><th className="n">Skipped</th><th className="n">Errors</th><th>By</th></tr></thead><tbody>
      {db.logs.map(l=><tr key={l.id}><td>{l.at}</td><td>{l.kind}</td><td>{l.file}</td><td className="n">{l.added}</td><td className="n">{l.skipped}</td><td className="n">{l.errors}</td><td>{l.who}</td></tr>)}
      {!db.logs.length && <tr><td colSpan="7" className="sub">Nothing imported yet.</td></tr>}</tbody></table></div>
  </>;
}
function Password({me, flash, back, refresh, forced}) {
  const [o,setO]=useState(""),[n,setN]=useState(""),[n2,setN2]=useState(""),[busy,setBusy]=useState(false);
  const save=async()=>{ if(n.length<6) return flash("err","New password must be at least 6 characters"); if(n!==n2) return flash("err","The two new passwords do not match");
    setBusy(true); try{ await API.req("POST","/api/password",{oldPassword:o,newPassword:n}); flash("ok","Password changed"); await refresh(); if(back) back(); }catch(e){ flash("err",e.message); } setBusy(false); };
  return <div className="card">{forced && <p className="amber">Please set your own password before you continue.</p>}
    <label>Current password</label><input type="password" value={o} onChange={e=>setO(e.target.value)}/>
    <label>New password (min 6 characters)</label><input type="password" value={n} onChange={e=>setN(e.target.value)}/>
    <label>New password again</label><input type="password" value={n2} onChange={e=>setN2(e.target.value)}/><br/><button className="block" disabled={busy} onClick={save}>Save</button></div>;
}

/* ================= app shell ================= */
function Login({onLogin}) {
  const [u,setU]=useState(""),[p,setP]=useState(""),[err,setErr]=useState(""),[busy,setBusy]=useState(false);
  const go=async()=>{ if(!u.trim()||!p) return setErr("Enter username and password"); setBusy(true); setErr("");
    try{ await API.req("POST","/api/login",{username:u.trim(),password:p}); await onLogin(); }catch(e){ setErr(e.message); setBusy(false); } };
  return <div className="login">
    <h1 style={{textAlign:"center",color:"var(--brand)",marginBottom:2}}>Gurmeet Motors</h1>
    <p className="sub" style={{textAlign:"center",marginTop:0}}>Collection Management</p>
    {err && <div className="flash err">{err}</div>}
    <div className="card"><label>Username</label><input value={u} onChange={e=>setU(e.target.value)} autoCapitalize="none" autoComplete="username" onKeyDown={e=>e.key==="Enter"&&go()}/>
      <label>Password</label><input type="password" value={p} onChange={e=>setP(e.target.value)} autoComplete="current-password" onKeyDown={e=>e.key==="Enter"&&go()}/><br/><button className="block" disabled={busy} onClick={go}>{busy?"Please wait…":"Login"}</button></div>
  </div>;
}

function Root() {
  const [st,setSt]=useState({s:"loading"});
  const boot=async()=>{ try{ const j=await API.req("GET","/api/state"); setSt({s:"ready",j}); }catch(e){ setSt(e.status===401?{s:"login"}:{s:"error",msg:e.message}); } };
  useEffect(()=>{ boot(); },[]);
  if(st.s==="loading") return <div className="login"><p className="sub" style={{textAlign:"center"}}>Loading…</p></div>;
  if(st.s==="error") return <div className="login"><div className="flash err">Cannot reach the server: {st.msg}</div><button className="block" onClick={()=>{setSt({s:"loading"});boot();}}>Try again</button></div>;
  if(st.s==="login") return <Login onLogin={boot}/>;
  return <App key={st.j.me.id} j={st.j} onLogout={()=>setSt({s:"login"})}/>;
}

function App({j, onLogout}) {
  const [db,setDbRaw]=useState(()=>fromState(j));
  const meId = j.me.id;
  const dbRef = React.useRef(db), q = React.useRef({ops:[],busy:false}), lastSrv = React.useRef(JSON.stringify(j));
  const [sync,setSync]=useState({n:0,err:""});
  const [stack,setStack]=useState([]);
  const [tab,setTab]=useState("dash");
  const [dayRaw,setDay]=useState(null);
  const [fl,setFl]=useState(null);
  const refresh=async(force)=>{ const Q=q.current; if(Q.busy||Q.ops.length) return; if(force) lastSrv.current="";
    try{ const sj=await API.req("GET","/api/state"); if(Q.busy||Q.ops.length) return; const str=JSON.stringify(sj);
      if(str!==lastSrv.current){ lastSrv.current=str; const nd=fromState(sj); dbRef.current=nd; setDbRaw(nd); } }catch(e){ if(e.status===401) onLogout(); } };
  const flush=async()=>{ const Q=q.current; if(Q.busy) return; Q.busy=true; let hadErr=false;
    while(Q.ops.length){ const batch=Q.ops; Q.ops=[]; setSync({n:batch.length,err:""});
      try{ const r=await API.req("POST","/api/sync",{ops:batch});
        if(r.patched&&r.patched.collections&&r.patched.collections.length){ const m=new Map(r.patched.collections.map(c=>[c.id,c])); const nd={...dbRef.current,collections:dbRef.current.collections.map(c=>m.get(c.id)||c)}; dbRef.current=nd; setDbRaw(nd); }
        if(r.errors&&r.errors.length){ hadErr=true; flash("err","Some changes were not accepted: "+r.errors.slice(0,2).join("; ")); }
      }catch(e){ if(e.status===401){ Q.busy=false; return onLogout(); }
        Q.ops=[...batch,...Q.ops]; setSync({n:Q.ops.length,err:"No connection – your entries are kept and will be saved automatically"}); Q.busy=false; setTimeout(flush,5000); return; } }
    Q.busy=false; setSync({n:0,err:""}); refresh(true); };
  const setDb=(d)=>{ const ops=diffOps(dbRef.current,d); dbRef.current=d; setDbRaw(d); if(ops.length){ q.current.ops.push(...ops); setSync(x=>({...x,n:x.n||1})); flush(); } };
  useEffect(()=>{ const t=setInterval(()=>refresh(),20000); const v=()=>{ if(!document.hidden) refresh(); };
    const bu=(e)=>{ if(q.current.ops.length||q.current.busy){ e.preventDefault(); e.returnValue=""; } };
    document.addEventListener("visibilitychange",v); window.addEventListener("beforeunload",bu);
    return ()=>{ clearInterval(t); document.removeEventListener("visibilitychange",v); window.removeEventListener("beforeunload",bu); }; },[]);
  const flash=(t,m)=>{ try{ window.scrollTo({top:0,behavior:"smooth"}); }catch(e){} setFl({t,m}); setTimeout(()=>setFl(null),3500); };
  const me = db.users.find(u=>u.id===meId) || j.me;
  const saveColl=(c,al)=>{ const cid=uid(); const today=iso(new Date()); const d=c.date||today; const n=(db.advSeq||0)+(c.advance>0?1:0);
    setDb({...db,advSeq:n,collections:[...db.collections,{...c,id:cid,salesmanId:me.id,date:d,enteredOn:today,dateChanged:d!==today,advRef:c.advance>0?"ADV-"+String(n).padStart(4,"0"):"",status:"provisional",at:new Date().toISOString()}],
      allocs:[...db.allocs,...al.map(a=>({id:uid(),billId:a.billId,amount:a.amount,kind:c.kind||"receipt",status:"provisional",collectionId:cid,date:d}))]});
    setStack([...stack.slice(0,-1),{page:"done",id:cid}]); };
  const logout=async()=>{ try{ await API.req("POST","/api/logout"); }catch(e){} setFl(null); onLogout(); };
  const twoTap=(key,msg,fn)=>{ if(window["__c"+key]){ window["__c"+key]=false; fn(); } else { window["__c"+key]=true; flash("err",msg); setTimeout(()=>window["__c"+key]=false,4000);} };
  if(me.mustChange) return <><Top title="Set your password" user={me} logout={logout}/><div className="wrap"><Flash f={fl}/><Password me={me} flash={flash} refresh={()=>refresh(true)} forced/></div></>;

  const go=(p)=>setStack([...stack,p]); const back=()=>setStack(stack.slice(0,-1));
  const pendingN = db.collections.filter(c=>c.status==="provisional").length;
  const cur = stack[stack.length-1]; const isSM = me.role==="salesman", isAdmin = me.role==="admin";
  let title, body;
  if(cur) {
    if(cur.page==="party") { title=db.parties.find(p=>p.id===cur.id).name; body=<PartyView db={db} id={cur.id} go={go} canCollect={isSM} flash={flash}/>; }
    else if(cur.page==="bill") { title=db.bills.find(b=>b.id===cur.id).no; body=<BillView db={db} id={cur.id}/>; }
    else if(cur.page==="ledger") { title="Ledger"; body=<Ledger db={db} id={cur.id} flash={flash} me={me} setDb={setDb}/>; }
    else if(cur.page==="pick") { title=cur.adj?"Return / Discount – choose party":"Collect Payment – choose party"; body=<CollectPick db={db} me={me} go={go} adj={cur.adj}/>; }
    else if(cur.page==="collect") { title=(cur.adj?"Return / Discount: ":"Collect: ")+db.parties.find(p=>p.id===cur.id).name; body=<CollectForm key={cur.id+(cur.adj?"a":"")} db={db} id={cur.id} onSave={saveColl} adj={cur.adj}/>; }
    else if(cur.page==="done") { title="Saved"; body=<CollectDone db={db} cid={cur.id} go={go} home={()=>setStack([])}/>; }
    else if(cur.page==="pbreport") { title="Pending Bills Report"; body=<PendingReport db={db} me={me} flash={flash} day0={cur.day>=0?cur.day:"all"}/>; }
    else if(cur.page==="mycoll") { title="My Collections"; body=<MyCollections db={db} me={me} go={go} flash={flash}/>; }
    else if(cur.page==="pw") { title="Change Password"; body=<Password me={me} flash={flash} back={back} refresh={()=>refresh(true)}/>; }
  } else if(isSM) { const day=effDay(db,me,dayRaw); title=day<0?"All my parties":DAYS[day]+(day===todayDay()?" (Today)":""); body=<SMHome db={db} me={me} go={go} day={day} setDay={setDay}/>; }
  else {
    const [t,f]=tab.split(":"); title="Management Console";
    body = <>
      <div className="nav">
        <a className={t==="dash"?"on":""} onClick={()=>setTab("dash")}>Dashboard</a>
        <a className={t==="coll"?"on":""} onClick={()=>setTab("coll")}>Confirm Collections{pendingN>0?` (${pendingN})`:""}</a>
        <a className={t==="reports"?"on":""} onClick={()=>setTab("reports")}>Reports</a>
        <a className={t==="tally"?"on":""} onClick={()=>setTab("tally")}>Tally Export</a>
        {isAdmin && <a className={t==="audit"?"on":""} onClick={()=>setTab("audit")}>Audit Log</a>}
        {isAdmin && <><a className={t==="parties"?"on":""} onClick={()=>setTab("parties")}>Parties</a>
        <a className={t==="routes"?"on":""} onClick={()=>setTab("routes")}>Beats</a>
        <a className={t==="import"?"on":""} onClick={()=>setTab("import")}>Import</a>
        <a className={t==="users"?"on":""} onClick={()=>setTab("users")}>Users</a></>}</div>
      {t==="dash" && <Dashboard db={db} setTab={setTab}/>}
      {t==="coll" && <ConfirmCollections db={db} setDb={setDb} me={me} flash={flash}/>}
      {isAdmin && t==="audit" && <AuditLog db={db}/>}
      {t==="tally" && <TallyExport db={db} setDb={setDb} me={me} flash={flash}/>}
      {t==="reports" && <ReportsHub db={db} me={me} flash={flash}/>}
      {isAdmin && t==="parties" && <AdminParties db={db} setDb={setDb} flt={f||""} setFlt={(v)=>setTab(v?"parties:"+v:"parties")} flash={flash} go={go}/>}
      {isAdmin && t==="routes" && <AdminRoutes db={db} setDb={setDb} flash={flash}/>}
      {isAdmin && t==="import" && <AdminImport db={db} setDb={setDb} me={me} setTab={setTab} flash={flash}/>}
      {isAdmin && t==="users" && <AdminUsers db={db} setDb={setDb} flash={flash}/>}

    </>;
  }
  return <>
    {(sync.n>0||sync.err) && <div className="demo">{sync.err||"Saving…"}</div>}
    <Top title={title} back={cur?(cur.page==="done"?()=>setStack([]):back):null} user={me} logout={logout} onPw={()=>go({page:"pw"})}/>
    <div className={"wrap "+(!isSM&&!cur?"wide":"")}><Flash f={fl}/>{body}</div>
  </>;
}
ReactDOM.createRoot(document.getElementById("root")).render(<Root/>);
