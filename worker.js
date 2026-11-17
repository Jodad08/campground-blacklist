// Cloudflare Worker: campground booking blacklist checker.
//
// Routes:
//   GET  /            -> UI (load blacklist, live search, bulk bookings check)
//   POST /check       -> JSON in/out. Accepts EITHER a bulk `bookingsCsv`
//                        (string) OR a single `booking` object (search).
//   PUT  /blacklist   -> (optional) store a blacklist CSV in Workers KV so
//                        clients only send bookings. Requires ADMIN_TOKEN.
//
// KV is optional. If a /check request omits `blacklistCsv`, the Worker falls
// back to the CSV stored in KV under the key "current".

import { runCheck, checkRecords } from "./matching.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (request.method === "POST" && url.pathname === "/check") {
      return handleCheck(request, env);
    }
    if (request.method === "PUT" && url.pathname === "/blacklist") {
      return handleStoreBlacklist(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function handleCheck(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON body." }, 400);
  }

  // Accept EITHER a bulk bookings CSV or a single typed-in person (search).
  const hasCsv = typeof body.bookingsCsv === "string" && body.bookingsCsv.length;
  const hasOne = body.booking && typeof body.booking === "object";
  if (!hasCsv && !hasOne) {
    return json({ error: "Provide bookingsCsv or a booking object." }, 400);
  }

  // blacklist: from request, or fall back to KV.
  let blacklistCsv = body.blacklistCsv;
  if (!blacklistCsv) {
    if (env.BLACKLIST) blacklistCsv = await env.BLACKLIST.get("current");
    if (!blacklistCsv) {
      return json({ error: "No blacklist provided and none stored in KV." }, 400);
    }
  }

  const threshold = clamp(Number(body.threshold ?? 0.85), 0.7, 1.0);
  const fuzzy = body.fuzzy !== false;
  const minFields = body.minFields === 2 ? 2 : 1;

  try {
    const out = hasCsv
      ? runCheck(body.bookingsCsv, blacklistCsv, { threshold, fuzzy, minFields })
      : checkRecords([body.booking], blacklistCsv, { threshold, fuzzy, minFields });
    return json(out);
  } catch (e) {
    return json({ error: "Could not process CSVs: " + e.message }, 400);
  }
}

async function handleStoreBlacklist(request, env) {
  if (!env.BLACKLIST) {
    return json({ error: "No KV namespace bound (BLACKLIST)." }, 501);
  }
  // Fail closed: without ADMIN_TOKEN set, nobody can overwrite the stored blacklist.
  if (!env.ADMIN_TOKEN) {
    return json({ error: "Uploads disabled: set the ADMIN_TOKEN secret first." }, 503);
  }
  const auth = request.headers.get("authorization") || "";
  if (!(await tokenMatches(auth, `Bearer ${env.ADMIN_TOKEN}`))) {
    return json({ error: "Unauthorized." }, 401);
  }
  const csv = await request.text();
  if (!csv.trim()) return json({ error: "Empty body." }, 400);
  await env.BLACKLIST.put("current", csv);
  return json({ ok: true, stored: csv.length });
}

// Constant-time comparison: hash both sides so lengths match, then compare every byte.
async function tokenMatches(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}
function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return 0.85;
  return Math.max(lo, Math.min(hi, n));
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Campground Blacklist Checker</title>
<style>
  :root { --bg:#0f1720; --card:#182430; --line:#26333f; --fg:#e8eef4;
          --muted:#93a4b3; --accent:#3fa66a; --danger:#e0574b; --warn:#e0b04b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:940px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:16px; margin:0 0 12px; }
  .step { color:var(--accent); font-weight:700; margin-right:6px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line);
          border-radius:12px; padding:20px 22px; margin-bottom:20px; }
  .card.disabled { opacity:.55; }
  label { display:block; font-weight:600; margin:14px 0 6px; }
  input[type=file], input[type=text] { width:100%; padding:10px; background:#0f1a24;
          border:1px solid var(--line); border-radius:8px; color:var(--fg); }
  input[type=file] { border-style:dashed; }
  .row { display:flex; gap:18px; flex-wrap:wrap; align-items:flex-start; }
  .row > div { flex:1; min-width:180px; }
  input[type=range] { width:100%; }
  .val { color:var(--accent); font-weight:700; }
  button { margin-top:16px; background:var(--accent); color:#04120a; border:0;
           padding:11px 20px; font-size:15px; font-weight:700; border-radius:8px;
           cursor:pointer; }
  button.sec { background:transparent; color:var(--accent);
               border:1px solid var(--accent); }
  button:disabled { opacity:.4; cursor:default; }
  .pill { display:inline-block; padding:2px 9px; border-radius:20px;
          font-size:12px; font-weight:700; }
  .pill.exact { background:#3a1f1c; color:var(--danger); }
  .pill.fuzzy { background:#3a331c; color:var(--warn); }
  table { width:100%; border-collapse:collapse; margin-top:14px; font-size:14px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line);
          vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .summary { font-size:16px; margin:0 0 8px; }
  .ok { color:var(--accent); } .bad { color:var(--danger); }
  .banner { border-radius:8px; padding:14px 16px; font-weight:700; font-size:16px; }
  .banner.bad { background:#3a1f1c; border:1px solid var(--danger); color:#ffd7d2; }
  .banner.ok { background:#16301f; border:1px solid var(--accent); color:#c9f2d8; }
  .dl { display:inline-block; margin:6px 0 4px; color:var(--accent); font-weight:700;
        text-decoration:none; border:1px solid var(--accent); padding:8px 16px;
        border-radius:8px; }
  .muted { color:var(--muted); font-size:13px; font-weight:400; }
  a.tmpl { color:var(--accent); }
  .err { background:#3a1f1c; border:1px solid var(--danger); color:#ffd7d2;
         padding:10px 12px; border-radius:8px; margin-top:10px; }
  code { background:#0f1a24; padding:1px 6px; border-radius:4px; }
</style></head>
<body><div class="wrap">
  <h1>Campground Blacklist Checker</h1>
  <p class="sub">Load your list of banned guests, then check one person on the
     spot or a whole bookings CSV. Matches on email, name, or phone, with typo
     tolerance. Runs free at the edge on Cloudflare Workers.</p>

  <!-- STEP 1: blacklist -->
  <div class="card" id="blCard">
    <h2><span class="step">1</span>Load your blacklist</h2>
    <input type="file" id="blFile" accept=".csv">
    <div id="blStatus" class="muted" style="margin-top:10px;">No blacklist loaded yet.</div>
    <div class="muted" style="margin-top:8px;">
      Need the format? <a class="tmpl" id="dlBlTmpl" href="#">Download blacklist template</a>
    </div>
  </div>

  <!-- shared settings -->
  <div class="card">
    <h2>Match settings</h2>
    <div class="row">
      <div>
        <label>Typo tolerance <span class="val" id="tval">85%</span> similarity</label>
        <input type="range" id="threshold" min="70" max="100" step="1" value="85">
        <div class="muted">Higher = stricter. 100% = exact matches only.</div>
      </div>
      <div>
        <label>Options</label>
        <label class="muted"><input type="checkbox" id="fuzzy" checked>
          Fuzzy match name &amp; email (phone always exact)</label>
        <label class="muted" style="margin-top:8px;">
          <input type="checkbox" id="double">
          Require <strong>2+ fields</strong> to match (fewer false positives)</label>
      </div>
    </div>
  </div>

  <!-- STEP 2a: live search -->
  <div class="card disabled" id="searchCard">
    <h2><span class="step">2</span>Search one person</h2>
    <div class="row">
      <div><label>Name</label><input type="text" id="sName" placeholder="Jane Doe"></div>
      <div><label>Email</label><input type="text" id="sEmail" placeholder="jane@example.com"></div>
      <div><label>Phone</label><input type="text" id="sPhone" placeholder="555-123-4567"></div>
    </div>
    <button id="searchBtn" disabled>Check this person</button>
    <div id="searchOut"></div>
  </div>

  <!-- STEP 2b: bulk -->
  <div class="card disabled" id="bulkCard">
    <h2><span class="step">2</span>Check a bookings CSV</h2>
    <input type="file" id="bkFile" accept=".csv">
    <div class="muted" style="margin-top:8px;">
      <a class="tmpl" id="dlBkTmpl" href="#">Download bookings template</a>
    </div>
    <button id="bulkBtn" disabled>Check bookings</button>
    <div id="bulkOut"></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let blacklistCsv = null;

$("threshold").oninput = (e) => $("tval").textContent = e.target.value + "%";

function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
function opts(){return {threshold:Number($("threshold").value)/100, fuzzy:$("fuzzy").checked, minFields:$("double").checked?2:1};}
function readFile(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsText(f);});}

// ---- templates ----
const BL_TMPL="name,email,phone\\nJohn Smith,john.smith@example.com,555-123-4567\\nJane Doe,,555-987-6543\\nRepeat Offender,repeat@example.com,\\n";
const BK_TMPL="Full Name,Email,Phone\\nAlice Green,alice@example.com,555-000-1111\\nBob Jones,bob@example.com,555-222-3333\\n";
function dl(name,text){const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(text);a.download=name;a.click();}
$("dlBlTmpl").onclick=(e)=>{e.preventDefault();dl("blacklist-template.csv",BL_TMPL);};
$("dlBkTmpl").onclick=(e)=>{e.preventDefault();dl("bookings-template.csv",BK_TMPL);};

// ---- step 1: load blacklist ----
$("blFile").onchange = async () => {
  const f=$("blFile").files[0]; if(!f) return;
  blacklistCsv = await readFile(f);
  const rows = blacklistCsv.split(/\\r?\\n/).filter(l=>l.trim()).length - 1;
  $("blStatus").innerHTML = '<span class="ok">Loaded '+Math.max(rows,0)+' banned entr'+(rows===1?'y':'ies')+'.</span> Held in this browser only.';
  for(const c of ["searchCard","bulkCard"]) $(c).classList.remove("disabled");
  $("searchBtn").disabled=false; $("bulkBtn").disabled=false;
};

async function postCheck(payload){
  payload.blacklistCsv = blacklistCsv || undefined;
  Object.assign(payload, opts());
  const r=await fetch("/check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  return r.json();
}

// ---- step 2a: search one person ----
$("searchBtn").onclick = async () => {
  $("searchOut").innerHTML="";
  const booking={name:$("sName").value.trim(), email:$("sEmail").value.trim(), phone:$("sPhone").value.trim()};
  if(!booking.name && !booking.email && !booking.phone){ $("searchOut").innerHTML='<div class="err">Enter at least one of name, email, or phone.</div>'; return; }
  try{
    const d=await postCheck({booking});
    if(d.error){ $("searchOut").innerHTML='<div class="err">'+esc(d.error)+'</div>'; return; }
    const res=d.results[0];
    if(res.banned){
      const why=res.reasons.map(m=>'<span class="pill '+m.matchType+'">'+m.matchType+'</span> '+esc(m.field)+(m.matchType==="fuzzy"?' ('+Math.round(m.similarity*100)+'%)':'')+' &rarr; '+esc(m.bannedValue)).join('<br>');
      $("searchOut").innerHTML='<div class="banner bad" style="margin-top:14px;">&#9888; BANNED</div><div class="muted" style="margin-top:10px;">'+why+'</div>';
    } else {
      $("searchOut").innerHTML='<div class="banner ok" style="margin-top:14px;">&#10003; Not on the blacklist</div>'+(d.minFields===2?'<div class="muted" style="margin-top:6px;">(2+ field mode)</div>':'');
    }
  }catch(e){ $("searchOut").innerHTML='<div class="err">'+esc(e.message)+'</div>'; }
};

// ---- step 2b: bulk ----
function toCsv(flagged){
  if(!flagged.length) return "";
  const cols=Object.keys(flagged[0].row).concat(["matched_on"]);
  const q=v=>/[",\\n]/.test(v)?'"'+String(v).replace(/"/g,'""')+'"':v;
  const lines=[cols.join(",")];
  for(const r of flagged){
    const on=r.reasons.map(m=>m.field+":"+m.matchType+(m.matchType==="fuzzy"?"("+m.similarity+")":"")).join("; ");
    lines.push(cols.map(c=>q(c==="matched_on"?on:(r.row[c]??""))).join(","));
  }
  return lines.join("\\n");
}
$("bulkBtn").onclick = async () => {
  $("bulkOut").innerHTML="";
  const f=$("bkFile").files[0];
  if(!f){ $("bulkOut").innerHTML='<div class="err">Choose a bookings CSV.</div>'; return; }
  try{
    const bookingsCsv=await readFile(f);
    const d=await postCheck({bookingsCsv});
    if(d.error){ $("bulkOut").innerHTML='<div class="err">'+esc(d.error)+'</div>'; return; }
    if(!d.flagged.length){ $("bulkOut").innerHTML='<p class="summary ok" style="margin-top:14px;">No matches. All '+d.total+' booking(s) are clear.</p>'; return; }
    let rows="";
    for(const r of d.flagged){
      const booking=Object.entries(r.row).map(([k,v])=>'<div><span class="muted">'+esc(k)+':</span> '+esc(v)+'</div>').join("");
      const matched=r.reasons.map(m=>'<div><span class="pill '+m.matchType+'">'+m.matchType+'</span> '+esc(m.field)+(m.matchType==="fuzzy"?' <span class="muted">('+Math.round(m.similarity*100)+'%)</span>':'')+'</div>').join("");
      const banned=r.reasons.map(m=>'<div class="muted">'+esc(m.bannedValue)+'</div>').join("");
      rows+='<tr><td>'+booking+'</td><td>'+matched+'</td><td>'+banned+'</td></tr>';
    }
    const uri="data:text/csv;charset=utf-8,"+encodeURIComponent(toCsv(d.flagged));
    const mode=d.minFields===2?' <span class="muted">(2+ field mode)</span>':'';
    $("bulkOut").innerHTML='<p class="summary bad" style="margin-top:14px;"><strong>'+d.flagged.length+'</strong> of '+d.total+' booking(s) matched a banned guest'+mode+'.</p>'+
      '<a class="dl" href="'+uri+'" download="flagged.csv">Download flagged.csv</a>'+
      '<table><thead><tr><th>Booking</th><th>Matched on</th><th>Banned entry</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){ $("bulkOut").innerHTML='<div class="err">'+esc(e.message)+'</div>'; }
};
</script>
</body></html>`;
