let map;
let geoLayer;
let farms = new Map(); // farmCode -> {name, features[]}
let prod2025 = {};
let farmLabelMarker = null;
let __occTab = "pendentes";
// =============================
// SUPABASE CONFIG
// =============================
const SUPABASE_URL = window.__SUPABASE_URL || "";
const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY || "";
const EMPRESA_ID = window.__EMPRESA_ID || "default";
const FOTOS_BUCKET = window.__FOTOS_BUCKET || "ocorrencias-fotos";

console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SUPABASE_KEY_PREFIX:", (SUPABASE_ANON_KEY || "").slice(0, 20));
console.log(
  "SUPABASE_KEY_IS_VALID:",
  (SUPABASE_ANON_KEY || "").startsWith("eyJ") ||
  (SUPABASE_ANON_KEY || "").startsWith("sb_publishable_")
);
let sb = null;

try {
  if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase) {
    window.__sb = window.__sb || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    sb = window.__sb;
  }
} catch (e) {
  console.error("Erro ao criar Supabase client:", e);
  sb = null;
}

function assertSb() {
  if (!sb) throw new Error("Supabase não configurado no front.");
}

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// =============================
// STATUS HELPERS (PADRÃO DB)
// =============================
const STATUS = {
  PENDENTE: "pendente",
  EM_ANDAMENTO: "em_andamento",
  FEITA: "feita",
  CANCELADA: "cancelada",
  OK: "ok",
};

function normStatus(s) {
  return String(s || "").trim().toLowerCase();
}

function statusLabel(s) {
  const x = normStatus(s);
  if (x === STATUS.PENDENTE) return "Pendente";
  if (x === STATUS.EM_ANDAMENTO) return "Em andamento";
  if (x === STATUS.FEITA) return "Feita";
  if (x === STATUS.CANCELADA) return "Cancelada";
  if (x === STATUS.OK) return "OK";
  return s || "—";
}

function statusBadge(status) {
  const s = normStatus(status);
  if (s === STATUS.PENDENTE) return `<span class="badge orange">Pendente</span>`;
  if (s === STATUS.EM_ANDAMENTO) return `<span class="badge gray">Em andamento</span>`;
  if (s === STATUS.FEITA) return `<span class="badge green">Feita</span>`;
  if (s === STATUS.CANCELADA) return `<span class="badge red">Cancelada</span>`;
  return `<span class="badge gray">${statusLabel(status)}</span>`;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

// =============================
// AUTH / PERFIL
// =============================
let __session = null;
let __user = null;
let __perfil = null; // {nome, role, empresa_id}
let __userNameById = {}; // created_by(user_id) -> nome

async function guardSession() {
  assertSb();

  // 1) sessão
  const { data } = await sb.auth.getSession();
  __session = data?.session || null;

  if (!__session) {
    window.location.href = "./login.html";
    throw new Error("Sem sessão.");
  }

  // 2) user
  const { data: u, error: userErr } = await sb.auth.getUser();
  if (userErr) throw userErr;

  __user = u?.user || null;
  if (!__user) {
    window.location.href = "./login.html";
    throw new Error("Sem usuário.");
  }

  // 3) perfil (usuarios.id = auth.user.id)
  const { data: perfil, error: perfilErr } = await sb
    .from("usuarios")
    .select("nome, role, empresa_id, id")
    .eq("id", __user.id)
    .maybeSingle();

  if (perfilErr) throw perfilErr;

  // 4) se não existir, cria
  let finalPerfil = perfil;
  if (!finalPerfil) {
    const payload = {
      id: __user.id,
      empresa_id: EMPRESA_ID,
      nome: __user.email || "Usuário",
      role: "user",
    };

    const { data: up, error: upErr } = await sb
      .from("usuarios")
      .upsert(payload, { onConflict: "id" })
      .select("nome, role, empresa_id")
      .single();

    if (upErr) throw upErr;
    finalPerfil = up;
  }

  __perfil = finalPerfil;

  if (__perfil?.empresa_id && __perfil.empresa_id !== EMPRESA_ID) {
    console.warn("EMPRESA_ID no front diferente do perfil. Usando perfil:", __perfil.empresa_id);
  }

  return { user: __user, perfil: __perfil };
}

function isMaster() {
  return (__perfil?.role || "user") === "master";
}

function getProfileLabel() {
  return isMaster() ? "master" : "user";
}

// =============================
// NOMES (created_by -> nome)
// =============================
async function loadUserNameMap(createdByIds) {
  assertSb();

  const ids = [...new Set((createdByIds || []).filter(Boolean))];
  if (!ids.length) return {};

  const empresa = __perfil?.empresa_id || EMPRESA_ID;

  const { data, error } = await sb
    .from("usuarios")
    .select("id, nome")
    .eq("empresa_id", empresa)
    .in("id", ids);

  if (error) throw error;

  const out = {};
  for (const r of (data || [])) {
    out[r.id] = r.nome || r.id;
  }
  return out;
}

// =============================
// STORAGE (FOTOS)
// =============================
function slugFileName(name) {
  return String(name || "foto")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function uploadPhotosToSupabase({ files, farmCode, talhao, occId }) {
  if (!sb) return { urls: [], errors: ["Supabase não configurado no front."] };

  const urls = [];
  const errors = [];

  for (const file of files) {
    try {
      const safeName = slugFileName(file.name);
      const path =
        `${(__perfil?.empresa_id || EMPRESA_ID)}/${farmCode || "sem_fazenda"}/` +
        `${talhao || "fazenda"}/${occId}/` +
        `${Date.now()}_${safeName}`;

      const { error: upErr } = await sb.storage.from(FOTOS_BUCKET).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || "image/jpeg",
      });

      if (upErr) {
        errors.push(upErr.message || String(upErr));
        continue;
      }

      const { data } = sb.storage.from(FOTOS_BUCKET).getPublicUrl(path);
      if (data?.publicUrl) urls.push(data.publicUrl);
      else errors.push("Não consegui gerar publicUrl da foto.");
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }

  return { urls, errors };
}

// =============================
// DB: OCORRÊNCIAS
// =============================
let OCC_CACHE_BY_FARM = new Map(); // farm_code -> ocorrencias[]
let FARM_STATUS = new Map(); // farm_code -> status calculado (pendente/em_andamento/ok)

function normalizeFarmCode(x) {
  if (x === null || x === undefined) return null;
  return String(x);
}

async function fetchOccByFarm(farmCode) {
  assertSb();
  farmCode = normalizeFarmCode(farmCode);
  const empresa = __perfil?.empresa_id || EMPRESA_ID;

  const { data, error } = await sb
    .from("ocorrencias")
    .select("id, empresa_id, farm_code, talhao, cultura, pragas, matos, observacao, status, photos, created_at, created_by, cancelada, cancelada_por, cancelada_em")
    .eq("empresa_id", empresa)
    .eq("farm_code", farmCode)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) throw error;

  const ids = (data || []).map(o => o.created_by).filter(Boolean);
  __userNameById = await loadUserNameMap(ids);

  OCC_CACHE_BY_FARM.set(farmCode, data || []);
  return data || [];
}

async function fetchFarmStatuses() {
  assertSb();
  const empresa = __perfil?.empresa_id || EMPRESA_ID;

  const { data, error } = await sb
    .from("ocorrencias")
    .select("farm_code, status, cancelada")
    .eq("empresa_id", empresa)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) throw error;

  const mapLocal = new Map(); // farm -> {pend:boolean, and:boolean}
  for (const r of (data || [])) {
    const fc = normalizeFarmCode(r.farm_code);
    if (!fc) continue;
    if (r.cancelada) continue;

    if (!mapLocal.has(fc)) mapLocal.set(fc, { pend: false, and: false });
    const st = normStatus(r.status);

    if (st === STATUS.PENDENTE) mapLocal.get(fc).pend = true;
    if (st === STATUS.EM_ANDAMENTO) mapLocal.get(fc).and = true;
  }

  FARM_STATUS.clear();
  for (const [fc, flags] of mapLocal.entries()) {
    if (flags.pend) FARM_STATUS.set(fc, STATUS.PENDENTE);
    else if (flags.and) FARM_STATUS.set(fc, STATUS.EM_ANDAMENTO);
    else FARM_STATUS.set(fc, STATUS.OK);
  }
}

function computeStatusForFarmFromCache(farmCode) {
  farmCode = normalizeFarmCode(farmCode);
  const s = FARM_STATUS.get(farmCode);
  return s || STATUS.OK;
}

function computeStatusForTalhaoFromCache(farmCode, talhao) {
  farmCode = normalizeFarmCode(farmCode);
  talhao = talhao ? String(talhao) : null;
  const rows = OCC_CACHE_BY_FARM.get(farmCode) || [];
  const tal = rows.filter(o => !o.cancelada && String(o.talhao || "") === String(talhao || ""));

  if (tal.some(o => normStatus(o.status) === STATUS.PENDENTE)) return STATUS.PENDENTE;
  if (tal.some(o => normStatus(o.status) === STATUS.EM_ANDAMENTO)) return STATUS.EM_ANDAMENTO;
  return STATUS.OK;
}

async function insertOccSupabaseFull(record) {
  assertSb();
  const empresa = __perfil?.empresa_id || EMPRESA_ID;

  const { data: u } = await sb.auth.getUser();
  const userId = u?.user?.id || __user?.id;

  // garante perfil do usuário
  const displayName = (__perfil?.nome || __user?.email || "Usuário");

  const { error: upUserErr } = await sb
    .from("usuarios")
    .upsert(
      [{
        empresa_id: (__perfil?.empresa_id || EMPRESA_ID),
        id: userId,
        nome: displayName,
        role: (__perfil?.role || "user")
      }],
      { onConflict: "id" }
    );

  if (upUserErr) throw upUserErr;

  const payload = {
    id: record.id,
    empresa_id: empresa,
    farm_code: normalizeFarmCode(record.farmCode),
    talhao: record.talhao ? String(record.talhao) : null,
    cultura: record.cultura || null,
    pragas: record.pragas || [],
    matos: record.matos || [],
    observacao: record.observacao || null,
    status: normStatus(record.status || STATUS.PENDENTE),
    photos: record.photos || [],
    cancelada: false,
    created_by: userId,
  };

  const { data, error } = await sb
    .from("ocorrencias")
    .insert([payload])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateOccStatus({ id, status }) {
  assertSb();
  const st = normStatus(status);

  const { data, error } = await sb
    .from("ocorrencias")
    .update({ status: st })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function cancelOcc({ id }) {
  if (!isMaster()) {
    alert("Só Master pode cancelar ocorrência.");
    return;
  }
  assertSb();
  if (!confirm("Tem certeza que deseja CANCELAR esta ocorrência?")) return;
const { data, error } = await sb
  .from("ocorrencias")
  .update({ 
  status: STATUS.CANCELADA,
  canceled_at: new Date().toISOString()
})
  .eq("id", id)
  .select()
  .single();

 if (error) throw error;

location.reload(); // recarrega pra refletir o status
return data;
}

// =============================
// UTIL / UI
// =============================
function parseFarmName(inf) {
  if (!inf) return { farmCode: "", farmName: "", talhao: "" };
  const parts = String(inf).split("-").map(p => p.trim()).filter(Boolean);

  if (parts.length === 1) return { farmCode: parts[0] || "", farmName: "", talhao: "" };
  if (parts.length === 2) return { farmCode: parts[0] || "", farmName: parts[1] || "", talhao: "" };

  const farmCode = parts[0] || "";
  const talhao = parts[parts.length - 1] || "";
  const farmName = parts.slice(1, parts.length - 1).join("-").trim();
  return { farmCode, farmName, talhao };
}

function chaveFromProps(props) {
  const farm = (props.PROPRIEAD ?? "").toString().trim();
  const tal = (props.TALHAO ?? "").toString().trim();
  if (!farm || !tal) return "";
  return `${farm}_${parseInt(tal, 10)}`;
}

function formatNum(x, dec = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return Number(x).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// ---- Modal ----
function openModal({ title, sub, bodyHtml, onSave }) {
  const bd = document.getElementById("modalBackdrop");
  document.getElementById("modalTitle").textContent = title || "Modal";
  document.getElementById("modalSub").textContent = sub || "";
  const body = document.getElementById("modalBody");
  body.innerHTML = bodyHtml || "";
  bd.style.display = "flex";

  const cancel = document.getElementById("modalCancel");
  const save = document.getElementById("modalSave");

  function close() {
    bd.style.display = "none";
    cancel.onclick = null;
    save.onclick = null;
  }
  cancel.onclick = close;
  bd.onclick = (e) => { if (e.target === bd) close(); };

  if (!onSave) {
    save.textContent = "Fechar";
    cancel.style.display = "none";
    save.onclick = () => close();
    return;
  } else {
    cancel.style.display = "block";
    save.textContent = "Salvar";
  }

  save.onclick = async () => {
    const ok = await onSave?.(close);
    if (ok) close();
  };
}

function getMode() {
  return document.getElementById("modeSelect")?.value || "talhao";
}

// =============================
// UI: Ocorrências
// =============================
let currentFarmCode = "";
let currentSelectedFeature = null;

function clearFarmLabel() {
  if (farmLabelMarker) {
    farmLabelMarker.remove();
    farmLabelMarker = null;
  }
}

function setFarmLabel(farmCode, bounds) {
  clearFarmLabel();
  const farm = farms.get(farmCode);
  if (!farm) return;
  const center = bounds.getCenter();
  const icon = L.divIcon({
    className: "",
    html: `<div style="background:rgba(17,24,39,.92);color:#fff;padding:6px 10px;border-radius:999px;font-size:12px;box-shadow:0 2px 10px rgba(0,0,0,.15);border:1px solid rgba(255,255,255,.25);">${farmCode} — ${farm.name}</div>`
  });
  farmLabelMarker = L.marker(center, { icon, interactive: false }).addTo(map);
}

async function refreshCurrentCard() {
  const mode = getMode();
  if (mode === "talhao" && currentSelectedFeature) {
    await renderTalhaoCard(currentSelectedFeature);
  } else if (mode === "fazenda" && currentFarmCode) {
    await renderFarmCard(currentFarmCode);
  }
}

async function renderTalhaoCard(feature) {
  const props = feature.properties || {};
  const layerId = (props.LAYER ?? "").toString();
  const inf = (props["INF."] ?? props.INF ?? "").toString();
  const { farmCode, farmName, talhao } = parseFarmName(inf);

  await fetchOccByFarm(farmCode);

  const chave = chaveFromProps(props);
  const prod = prod2025[chave] || {};
  let areaHa = null;
  try { areaHa = turf.area(feature) / 10000.0; } catch (e) {}

  const status = computeStatusForTalhaoFromCache(farmCode, talhao);

  const card = document.getElementById("infoCard");
  card.innerHTML = `
    <div class="topline">
      <span class="pill"><b>COD</b> ${layerId || "—"}</span>
      <span class="pill"><b>Fazenda</b> ${farmCode || "—"} — ${farmName || "—"}</span>
      <span class="pill"><b>Talhão</b> ${talhao || props.TALHAO || "—"}</span>
      <span class="pill"><b>Status</b> ${statusLabel(status)}</span>
      <span class="pill"><b>Perfil</b> ${getProfileLabel()}</span>
      <a class="pill" href="./dashboard.html">📊 Dashboard</a>
    </div>
<div class="tabs" style="display:flex; gap:8px; margin:10px 0;">
<button id="tabPendentes" class="tab ${__occTab === 'pendentes' ? 'active' : ''}" onclick="window.__setOccTab('pendentes')">Pendentes</button>
 <button id="tabCanceladas" class="tab ${__occTab === 'canceladas' ? 'active' : ''}" onclick="window.__setOccTab('canceladas')">Canceladas</button>
</div>
    <div class="grid">
      <div><div class="k">Área (ha)</div><div class="v">${formatNum(areaHa, 2)}</div></div>
      <div><div class="k">Cultura / Safra</div><div class="v">Cana / 2025</div></div>
      <div><div class="k">TCH 2025</div><div class="v">${formatNum(prod.tch, 1)}</div></div>
      <div><div class="k">ATR 2025</div><div class="v">${formatNum(prod.atr, 1)}</div></div>
    </div>

    <div class="occ">
      <div class="row">
        <button id="btnNewOcc">+ Criar Ocorrência (Talhão)</button>
        <button class="secondary" id="btnRefreshOcc">Atualizar</button>
        <button class="secondary" id="btnLogout">Sair</button>
      </div>
      <div class="small" style="margin-top:8px;">“Feita” e “Cancelar” só Master.</div>
      <div id="occList"></div>
    </div>
  `;

  document.getElementById("btnNewOcc").onclick = () => openOccForm({ farmCode, farmName, talhao });
  document.getElementById("btnRefreshOcc").onclick = async () => {
    await fetchOccByFarm(farmCode);
    await renderOccList({ farmCode, talhao });
  };
  document.getElementById("btnLogout").onclick = async () => {
    await sb.auth.signOut();
    window.location.href = "./login.html";
  };

  await renderOccList({ farmCode, talhao });
}

async function renderFarmCard(farmCode) {
  const farm = farms.get(farmCode);
  if (!farm) return;

  await fetchOccByFarm(farmCode);

  const status = computeStatusForFarmFromCache(farmCode);

  let totalHa = 0;
  let sumTch = 0, sumAtr = 0, sumW = 0;
  farm.features.forEach(f => {
    let ha = 0;
    try { ha = turf.area(f) / 10000.0; } catch (e) {}
    totalHa += ha;
    const key = chaveFromProps(f.properties || {});
    const p = prod2025[key];
    if (p && (p.tch != null || p.atr != null)) {
      sumW += ha;
      if (p.tch != null) sumTch += ha * p.tch;
      if (p.atr != null) sumAtr += ha * p.atr;
    }
  });
  const tchMed = sumW ? (sumTch / sumW) : null;
  const atrMed = sumW ? (sumAtr / sumW) : null;

  const card = document.getElementById("infoCard");
  card.innerHTML = `
    <div class="topline">
      <span class="pill"><b>Fazenda</b> ${farmCode} — ${farm.name}</span>
      <span class="pill"><b>Status</b> ${statusLabel(status)}</span>
      <span class="pill"><b>Talhões</b> ${farm.features.length}</span>
      <span class="pill"><b>Perfil</b> ${getProfileLabel()}</span>
      <a class="pill" href="./dashboard.html">📊 Dashboard</a>
    </div>

    <div class="grid">
      <div><div class="k">Área total (ha)</div><div class="v">${formatNum(totalHa, 2)}</div></div>
      <div><div class="k">Cultura / Safra</div><div class="v">Cana / 2025</div></div>
      <div><div class="k">TCH médio 2025</div><div class="v">${formatNum(tchMed, 1)}</div></div>
      <div><div class="k">ATR médio 2025</div><div class="v">${formatNum(atrMed, 1)}</div></div>
    </div>

    <div class="occ">
      <div class="row">
        <button id="btnNewOccFarm">+ Criar Ocorrência (Fazenda)</button>
        <button class="secondary" id="btnRefreshOccFarm">Atualizar</button>
        <button class="secondary" id="btnLogout">Sair</button>
      </div>
      <div class="small" style="margin-top:8px;">“Feita” e “Cancelar” só Master.</div>
      <div id="occList"></div>
    </div>
  `;

  document.getElementById("btnNewOccFarm").onclick = () => openOccForm({ farmCode, farmName: farm.name, talhao: null });
  document.getElementById("btnRefreshOccFarm").onclick = async () => {
    await fetchOccByFarm(farmCode);
    await renderOccList({ farmCode, talhao: null });
  };
  document.getElementById("btnLogout").onclick = async () => {
    await sb.auth.signOut();
    window.location.href = "./login.html";
  };

  await renderOccList({ farmCode, talhao: null });
}

async function renderOccList({ farmCode, talhao }) {
  farmCode = normalizeFarmCode(farmCode);
  const rows = OCC_CACHE_BY_FARM.get(farmCode) || [];

let list =
  __occTab === "canceladas"
    ? rows.filter(o => normStatus(o.status) === STATUS.CANCELADA)
    : rows.filter(o => normStatus(o.status) !== STATUS.CANCELADA);
  if (talhao !== null && talhao !== undefined) {
    list = list.filter(o => String(o.talhao || "") === String(talhao || ""));
  }

  list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const wrap = document.getElementById("occList");
  if (!wrap) return;

  if (!list.length) {
    wrap.innerHTML = `<div class="muted" style="margin-top:10px;">Nenhuma ocorrência registrada ainda.</div>`;
    return;
  }

  wrap.innerHTML = list.map(o => {
    const where = o.talhao ? `Talhão ${escapeHtml(o.talhao)}` : "Fazenda";
    const pr = (o.pragas || []).map(x => `<span class="tag">${escapeHtml(x)}</span>`).join("");
    const mt = (o.matos || []).map(x => `<span class="tag">${escapeHtml(x)}</span>`).join("");

    const fotos = (o.photos || []).length
      ? `<div class="thumbs">` +
        (o.photos || []).slice(0, 3).map((p, idx) =>
          `<img class="thumb" src="${p}" title="Abrir" onclick="window.__openPhotoViewer('${o.id}', ${idx})" />`
        ).join("") +
        ((o.photos || []).length > 3 ? `<div class="thumb-more" onclick="window.__openPhotoViewer('${o.id}', 0)">+${(o.photos || []).length - 3}</div>` : "") +
        `</div>`
      : "";

    const dtStr = new Date(o.created_at).toLocaleString("pt-BR");
    const cancelBtn = isMaster() ? `<button class="secondary" onclick="window.__cancelOcc('${o.id}')">Cancelar</button>` : ``;

    const st = normStatus(o.status);

    return `
      <div class="occ-item">
        <div class="occ-head">
          <div><b>${escapeHtml(o.cultura || "—")}</b> • ${where} • <span class="small">${dtStr}</span></div>
          ${statusBadge(st)}
        </div>

        <div class="small" style="margin-top:6px;"><b>Obs:</b> ${escapeHtml(o.observacao || "—")}</div>
        <div class="small" style="margin-top:6px; opacity:.8;"><b>Criado por:</b> ${__userNameById?.[o.created_by] || (o.created_by ? o.created_by.slice(0, 8) : "—")}</div>
        ${o.pragas?.length ? `<div class="small" style="margin-top:6px;"><b>Pragas:</b> ${pr}</div>` : ``}
        ${o.matos?.length ? `<div class="small" style="margin-top:6px;"><b>Matos:</b> ${mt}</div>` : ``}
        ${fotos}

        <div class="row" style="margin-top:8px;">
          <select data-id="${o.id}" class="statusSel" style="flex:1;">
            <option value="${STATUS.PENDENTE}" ${st === STATUS.PENDENTE ? "selected" : ""}>Pendente</option>
            <option value="${STATUS.EM_ANDAMENTO}" ${st === STATUS.EM_ANDAMENTO ? "selected" : ""}>Em andamento</option>
            <option value="${STATUS.FEITA}" ${st === STATUS.FEITA ? "selected" : ""}>Feita</option>
          </select>
          ${cancelBtn}
        </div>
      </div>
    `;
  }).join("");

  wrap.querySelectorAll(".statusSel").forEach(sel => {
    sel.onchange = async () => {
      const id = sel.getAttribute("data-id");
      const next = normStatus(sel.value);

      if (next === STATUS.FEITA && !isMaster()) {
        alert("Só Master pode finalizar como FEITA.");
        sel.value = STATUS.EM_ANDAMENTO;
        return;
      }

      try {
        await updateOccStatus({ id, status: next });
        await fetchOccByFarm(farmCode);
        await fetchFarmStatuses();
        await refreshCurrentCard();
        repaintMapColors();
      } catch (e) {
        alert("Erro ao atualizar status: " + (e?.message || e));
        console.error(e);
      }
    };
  });
}

window.__openPhotoViewer = (occId, startIdx = 0) => {
  const all = [];
  for (const arr of OCC_CACHE_BY_FARM.values()) all.push(...arr);
  const occ = all.find(o => o.id === occId);
  if (!occ || !occ.photos || !occ.photos.length) return;

  let i = Math.max(0, Math.min(startIdx, occ.photos.length - 1));
  const render = () => {
    const img = occ.photos[i];
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="small">Foto ${i + 1} de ${occ.photos.length}</div>
        <div style="display:flex;justify-content:center;">
          <img src="${img}" style="max-width:100%;max-height:70vh;border-radius:12px;border:1px solid #e5e7eb;" />
        </div>
        <div class="row">
          <button class="secondary" id="pvPrev">⬅️ Anterior</button>
          <button class="secondary" id="pvNext">Próxima ➡️</button>
        </div>
      </div>`;
    openModal({
      title: "Fotos da ocorrência",
      sub: `Fazenda ${escapeHtml(occ.farm_code || "—")}` + (occ.talhao ? ` • Talhão ${escapeHtml(occ.talhao)}` : ""),
      bodyHtml,
      onSave: null
    });
    setTimeout(() => {
      const prev = document.getElementById("pvPrev");
      const next = document.getElementById("pvNext");
      if (prev) prev.onclick = () => { i = (i - 1 + occ.photos.length) % occ.photos.length; render(); };
      if (next) next.onclick = () => { i = (i + 1) % occ.photos.length; render(); };
    }, 0);
  };
  render();
};

window.__cancelOcc = async (id) => {
  if (!confirm("Cancelar essa ocorrência? (fica no histórico como cancelada)")) return;
  try {
    const farmCode = currentFarmCode;
    await cancelOcc({ id });
    await fetchOccByFarm(farmCode);
    await fetchFarmStatuses();
    await refreshCurrentCard();
    repaintMapColors();
  } catch (e) {
    alert("Erro ao cancelar: " + (e?.message || e));
    console.error(e);
  }
};
window.__setOccTab = async (tab) => {
  __occTab = tab;

  const b1 = document.getElementById("tabPendentes");
  const b2 = document.getElementById("tabCanceladas");

  if (b1 && b2) {
    b1.classList.toggle("active", tab === "pendentes");
    b2.classList.toggle("active", tab === "canceladas");
  }

  try {
    const farmCode = currentFarmCode;
    await fetchOccByFarm(farmCode);
    await renderOccList({ farmCode, talhao: null });
  } catch (e) {
    console.error(e);
  }
};
// =============================
// FORM: CRIAR OCORRÊNCIA
// =============================
function openOccForm({ farmCode, farmName, talhao }) {
  const title = "Nova ocorrência";
  const sub = talhao
    ? `Fazenda ${farmCode} — ${farmName} • Talhão ${talhao}`
    : `Fazenda ${farmCode} — ${farmName}`;

  openModal({
    title,
    sub,
    bodyHtml: `
      <label>Cultura</label>
      <input id="cultura" value="Cana" placeholder="Ex: Cana, Soja..."/>

      <label>Pragas (separar por vírgula)</label>
      <input id="pragas" placeholder="Ex: mosca-branca, cigarrinha"/>

      <label>Matos (separar por vírgula)</label>
      <input id="matos" placeholder="Ex: buva, capim-colchão"/>

      <label>Observação *</label>
      <textarea id="obs" placeholder="Descreva o que viu no campo..."></textarea>

      <label>Status</label>
      <select id="status">
        <option value="${STATUS.PENDENTE}" selected>Pendente</option>
        <option value="${STATUS.EM_ANDAMENTO}">Em andamento</option>
        <option value="${STATUS.FEITA}">Feita</option>
      </select>

      <label>Fotos (opcional)</label>
      <input id="photos" type="file" multiple accept="image/*"/>

      <div class="small" style="margin-top:8px;">Dica: fotos grandes demoram. Suba poucas.</div>
    `,
    onSave: async () => {
      try {
        const cultura = document.getElementById("cultura").value.trim();
        const pragas = document.getElementById("pragas").value.split(",").map(s => s.trim()).filter(Boolean);
        const matos = document.getElementById("matos").value.split(",").map(s => s.trim()).filter(Boolean);
        const obs = document.getElementById("obs").value.trim();
        let status = normStatus(document.getElementById("status").value);

        if (!obs) {
          alert("Observação é obrigatória.");
          return false;
        }

        if (status === STATUS.FEITA && !isMaster()) {
          alert("Só Master pode finalizar como FEITA.");
          status = STATUS.EM_ANDAMENTO;
        }

        const occId = uid();
        const files = [...(document.getElementById("photos").files || [])].slice(0, 6);

        let photos = [];
        if (files.length) {
          const { urls, errors } = await uploadPhotosToSupabase({ files, farmCode, talhao, occId });
          photos = urls;
          if (errors.length) {
            console.warn("Erros no upload:", errors);
            alert("Algumas fotos podem não ter subido. Veja o console (F12).");
          }
        }

        const record = {
          id: occId,
          farmCode,
          talhao: talhao ? String(talhao) : null,
          cultura,
          pragas,
          matos,
          observacao: obs,
          status,
          photos
        };

        await insertOccSupabaseFull(record);

        await fetchOccByFarm(farmCode);
        await fetchFarmStatuses();
        await refreshCurrentCard();
        repaintMapColors();

        return true;
      } catch (e) {
        alert("Erro ao salvar: " + (e?.message || e));
        console.error(e);
        return false;
      }
    }
  });
}

// =============================
// MAP / INIT
// =============================
function repaintMapColors() {
  if (!geoLayer) return;
  geoLayer.eachLayer(layer => {
    const feature = layer.feature;
    const props = feature?.properties || {};
    const inf = (props["INF."] ?? props.INF ?? "").toString();
    const { farmCode, talhao } = parseFarmName(inf);

    const mode = getMode();
    if (mode === "fazenda") {
      const st = computeStatusForFarmFromCache(farmCode);
      let fillColor = "#34d399";
      if (st === STATUS.PENDENTE) fillColor = "#f59e0b";
      else if (st === STATUS.EM_ANDAMENTO) fillColor = "#9ca3af";
      layer.setStyle({ weight: 1, fillOpacity: 0.20, fillColor });
    } else {
      const st = computeStatusForTalhaoFromCache(farmCode, talhao);
      let fillColor = "#34d399";
      if (st === STATUS.PENDENTE) fillColor = "#f59e0b";
      else if (st === STATUS.EM_ANDAMENTO) fillColor = "#9ca3af";
      layer.setStyle({ weight: 1, fillOpacity: 0.25, fillColor });
    }
  });
}

async function init() {
  await guardSession();
  await fetchFarmStatuses();

  map = L.map('map');
  window.__leafletMap = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  map.setView([-20.3, -49.2], 10);

  prod2025 = await (await fetch('./data/producao2025.json')).json();
  const kmlText = await (await fetch('./data/geral.kml')).text();
  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
  const geojson = toGeoJSON.kml(dom);

  geojson.features.forEach(f => {
    const props = f.properties || {};
    const inf = (props["INF."] ?? props.INF ?? "").toString();
    const { farmCode, farmName } = parseFarmName(inf);
    if (!farms.has(farmCode)) {
      farms.set(farmCode, { name: farmName || farmCode, features: [] });
    }
    farms.get(farmCode).features.push(f);
  });

  const select = document.getElementById("farmSelect");
  select.innerHTML = '<option value="">Selecione a fazenda…</option>';

  [...farms.entries()]
    .sort((a, b) => (parseInt(a[0], 10) || 0) - (parseInt(b[0], 10) || 0))
    .forEach(([code, obj]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${code} — ${obj.name}`;
      select.appendChild(opt);
    });

  function drawAllFarms() {
    clearFarmLabel();
    currentSelectedFeature = null;
    currentFarmCode = "";

    if (geoLayer) { geoLayer.remove(); }

    const fc = { type: "FeatureCollection", features: geojson.features };

    geoLayer = L.geoJSON(fc, {
      style: (feature) => {
        const props = feature.properties || {};
        const inf = (props["INF."] ?? props.INF ?? "").toString();
        const { farmCode, talhao } = parseFarmName(inf);

        const mode = getMode();
        let st = STATUS.OK;
        if (mode === "fazenda") st = computeStatusForFarmFromCache(farmCode);
        else st = computeStatusForTalhaoFromCache(farmCode, talhao);

        let fillColor = "#34d399";
        if (st === STATUS.PENDENTE) fillColor = "#f59e0b";
        else if (st === STATUS.EM_ANDAMENTO) fillColor = "#9ca3af";
        return { weight: 1, fillOpacity: 0.20, fillColor };
      },
      onEachFeature: (feature, layer) => {
        layer.on('click', async () => {
          const props = feature.properties || {};
          const inf = (props["INF."] ?? props.INF ?? "").toString();
          const { farmCode } = parseFarmName(inf);

          const mode = getMode();

          if (mode === "fazenda") {
            currentFarmCode = farmCode;
            await renderFarmCard(farmCode);
          } else {
            currentFarmCode = farmCode;
            currentSelectedFeature = feature;
            await renderTalhaoCard(feature);
          }
        });
      }
    }).addTo(map);

    const b = geoLayer.getBounds();
    map.fitBounds(b, { padding: [20, 20] });

    const card = document.getElementById("infoCard");
    card.innerHTML = `<div class="muted">Mapa geral carregado. Clique em um talhão para ver e criar ocorrências.</div>`;

    setTimeout(() => map.invalidateSize(), 250);
  }

  function drawFarm(code) {
    clearFarmLabel();
    currentSelectedFeature = null;

    const card = document.getElementById("infoCard");
    if (geoLayer) { geoLayer.remove(); }

    if (!code || !farms.has(code)) {
      drawAllFarms();
      return;
    }

    currentFarmCode = code;

    const fc = { type: "FeatureCollection", features: farms.get(code).features };

    geoLayer = L.geoJSON(fc, {
      style: (feature) => {
        const props = feature.properties || {};
        const inf = (props["INF."] ?? props.INF ?? "").toString();
        const { farmCode, talhao } = parseFarmName(inf);

        const st = computeStatusForTalhaoFromCache(farmCode, talhao);

        let fillColor = "#34d399";
        if (st === STATUS.PENDENTE) fillColor = "#f59e0b";
        else if (st === STATUS.EM_ANDAMENTO) fillColor = "#9ca3af";

        return { weight: 1, fillOpacity: 0.25, fillColor };
      },
      onEachFeature: (feature, layer) => {
        layer.on('click', async () => {
          const mode = getMode();

          if (mode === "fazenda") {
            const b = geoLayer.getBounds();
            map.fitBounds(b, { padding: [20, 20] });
            setFarmLabel(code, b);
            await renderFarmCard(code);
          } else {
            currentSelectedFeature = feature;
            await renderTalhaoCard(feature);

            layer.setStyle({ weight: 3, fillOpacity: 0.25 });
            geoLayer.eachLayer(l => {
              if (l !== layer) l.setStyle({ weight: 1, fillOpacity: 0.15 });
            });
          }
        });
      }
    }).addTo(map);

    const b = geoLayer.getBounds();
    map.fitBounds(b, { padding: [20, 20] });

    if (getMode() === "fazenda") {
      setFarmLabel(code, b);
      renderFarmCard(code);
    } else {
      card.innerHTML = `<div class="muted">Clique em um talhão no mapa para ver detalhes e criar ocorrências.</div>`;
    }

    setTimeout(() => map.invalidateSize(), 250);
  }

  select.addEventListener('change', e => drawFarm(e.target.value));
  document.getElementById("modeSelect").addEventListener('change', () => {
    repaintMapColors();
    drawFarm(select.value);
  });

  // FAB
  const fab = document.getElementById("fabAdd");
  if (fab) {
    fab.addEventListener("click", () => {
      const farmCode = currentFarmCode || document.getElementById("farmSelect")?.value;
      if (!farmCode) {
        alert("Selecione uma fazenda primeiro.");
        return;
      }

      const mode = getMode();

      if (mode === "talhao") {
        if (!currentSelectedFeature) {
          alert("No modo Talhão, clique em um talhão no mapa antes de criar ocorrência.");
          return;
        }
        const props = currentSelectedFeature.properties || {};
        const inf = (props["INF."] ?? props.INF ?? "").toString();
        const parsed = parseFarmName(inf);
        openOccForm({ farmCode: parsed.farmCode, farmName: parsed.farmName, talhao: parsed.talhao });
        return;
      }

      const farm = farms.get(farmCode);
      const farmName = farm?.name || "";
      openOccForm({ farmCode, farmName, talhao: null });
    });
  }

  drawAllFarms();
}

init().catch(err => {
  console.error(err);
  const card = document.getElementById("infoCard");
  if (card) card.innerHTML = `<div class="muted">Erro ao carregar. Veja o console.</div>`;
});
