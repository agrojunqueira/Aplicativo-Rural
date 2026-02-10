
let map;
let geoLayer;
let farms = new Map(); // farmCode -> {name, features[]}
let prod2025 = {};
let farmLabelMarker = null;

// ---- Ocorrências (armazenamento local) ----
const LS_KEY = "aplicativo_rural_ocorrencias_v1";

function loadOcc(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}
function saveOcc(arr){
  localStorage.setItem(LS_KEY, JSON.stringify(arr));
}
function uid(){
  return "O" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function parseFarmName(inf){
  // Example: "23110-FLOR DA MATA-01"
  if(!inf) return {farmCode:"", farmName:"", talhao:""};
  const parts = inf.split("-");
  if(parts.length < 3){
    return {farmCode: parts[0] || "", farmName: (parts[1]||"").trim(), talhao: (parts[2]||"").trim()};
  }
  const farmCode = parts[0].trim();
  const talhao = parts[parts.length-1].trim();
  const farmName = parts.slice(1, parts.length-1).join("-").trim();
  return {farmCode, farmName, talhao};
}

function chaveFromProps(props){
  const farm = (props.PROPRIEAD ?? "").toString().trim();
  const tal = (props.TALHAO ?? "").toString().trim();
  if(!farm || !tal) return "";
  return `${farm}_${parseInt(tal,10)}`;
}

function formatNum(x, dec=1){
  if(x===null || x===undefined || Number.isNaN(x)) return "—";
  return Number(x).toLocaleString("pt-BR",{minimumFractionDigits:dec, maximumFractionDigits:dec});
}

function statusBadge(status){
  const s = (status||"").toLowerCase();
  if(s === "pendente") return `<span class="badge orange">Pendente</span>`;
  if(s === "em andamento") return `<span class="badge gray">Em andamento</span>`;
  if(s === "feito") return `<span class="badge green">Feito</span>`;
  return `<span class="badge gray">${status||"—"}</span>`;
}

function computeStatusForTalhao(farmCode, talhao){
  const occ = loadOcc().filter(o => o.scope==="talhao" && o.farmCode===farmCode && o.talhao===talhao);
  if(occ.some(o=>o.status==="Pendente")) return "Pendente";
  if(occ.some(o=>o.status==="Em andamento")) return "Em andamento";
  return "OK";
}

function computeStatusForFarm(farmCode){
  const all = loadOcc().filter(o => (o.scope==="fazenda" && o.farmCode===farmCode) || (o.scope==="talhao" && o.farmCode===farmCode));
  if(all.some(o=>o.status==="Pendente")) return "Pendente";
  if(all.some(o=>o.status==="Em andamento")) return "Em andamento";
  return "OK";
}

// ---- Modal ----
function openModal({title, sub, bodyHtml, onSave}){
  const bd = document.getElementById("modalBackdrop");
  document.getElementById("modalTitle").textContent = title || "Modal";
  document.getElementById("modalSub").textContent = sub || "";
  const body = document.getElementById("modalBody");
  body.innerHTML = bodyHtml || "";
  bd.style.display = "flex";

  const cancel = document.getElementById("modalCancel");
  const save = document.getElementById("modalSave");

  function close(){
    bd.style.display = "none";
    cancel.onclick = null;
    save.onclick = null;
  }
  cancel.onclick = close;
  bd.onclick = (e)=>{ if(e.target === bd) close(); };


  // if no onSave provided, use Save as "Fechar" and hide Cancel
  if(!onSave){
    save.textContent = "Fechar";
    cancel.style.display = "none";
    save.onclick = ()=> close();
    return;
  }else{
    cancel.style.display = "block";
    save.textContent = "Salvar";
  }

  save.onclick = async ()=>{
    const ok = await onSave?.(close);
    if(ok) close();
  };
}

function getProfile(){
  return document.getElementById("profileSelect")?.value || "user";
}
function getMode(){
  return document.getElementById("modeSelect")?.value || "talhao";
}

function renderTalhaoCard(feature){
  const props = feature.properties || {};
  const layerId = (props.LAYER ?? "").toString();
  const inf = (props["INF."] ?? props.INF ?? "").toString();
  const {farmCode, farmName, talhao} = parseFarmName(inf);
  const chave = chaveFromProps(props);
  const prod = prod2025[chave] || {};

  // area (ha)
  let areaHa = null;
  try{ areaHa = turf.area(feature)/10000.0; }catch(e){}

  const status = computeStatusForTalhao(farmCode, talhao);

  const card = document.getElementById("infoCard");
  card.innerHTML = `
    <div class="topline">
      <span class="pill"><b>COD</b> ${layerId || "—"}</span>
      <span class="pill"><b>Fazenda</b> ${farmCode || "—"} — ${farmName || "—"}</span>
      <span class="pill"><b>Talhão</b> ${talhao || props.TALHAO || "—"}</span>
      <span class="pill"><b>Status</b> ${status}</span>
    </div>

    <div class="grid">
      <div>
        <div class="k">Área (ha)</div>
        <div class="v">${formatNum(areaHa,2)}</div>
      </div>
      <div>
        <div class="k">Cultura / Safra</div>
        <div class="v">Cana / 2025</div>
      </div>
      <div>
        <div class="k">TCH 2025</div>
        <div class="v">${formatNum(prod.tch,1)}</div>
      </div>
      <div>
        <div class="k">ATR 2025</div>
        <div class="v">${formatNum(prod.atr,1)}</div>
      </div>
    </div>

    <div class="occ">
      <div class="row">
        <button id="btnNewOcc">+ Criar Ocorrência (Talhão)</button>
        <button class="secondary" id="btnRefreshOcc">Atualizar</button>
      </div>
      <div class="small" style="margin-top:8px;">Pragas e matos podem ser vazios. “Feito” só no perfil Master.</div>
      <div id="occList"></div>
    </div>
  `;

  document.getElementById("btnNewOcc").onclick = ()=> openOccForm({scope:"talhao", farmCode, farmName, talhao});
  document.getElementById("btnRefreshOcc").onclick = ()=> renderOccList({scope:"talhao", farmCode, talhao});
  renderOccList({scope:"talhao", farmCode, talhao});
}

function renderFarmCard(farmCode){
  const farm = farms.get(farmCode);
  if(!farm) return;
  const status = computeStatusForFarm(farmCode);

  // area total and prod média ponderada
  let totalHa = 0;
  let sumTch=0, sumAtr=0, sumW=0;
  farm.features.forEach(f=>{
    let ha=0;
    try{ ha = turf.area(f)/10000.0; }catch(e){}
    totalHa += ha;
    const key = chaveFromProps(f.properties||{});
    const p = prod2025[key];
    if(p && (p.tch!=null || p.atr!=null)){
      sumW += ha;
      if(p.tch!=null) sumTch += ha * p.tch;
      if(p.atr!=null) sumAtr += ha * p.atr;
    }
  });
  const tchMed = sumW ? (sumTch/sumW) : null;
  const atrMed = sumW ? (sumAtr/sumW) : null;

  const card = document.getElementById("infoCard");
  card.innerHTML = `
    <div class="topline">
      <span class="pill"><b>Fazenda</b> ${farmCode} — ${farm.name}</span>
      <span class="pill"><b>Status</b> ${status}</span>
      <span class="pill"><b>Talhões</b> ${farm.features.length}</span>
    </div>
    <div class="grid">
      <div>
        <div class="k">Área total (ha)</div>
        <div class="v">${formatNum(totalHa,2)}</div>
      </div>
      <div>
        <div class="k">Cultura / Safra</div>
        <div class="v">Cana / 2025</div>
      </div>
      <div>
        <div class="k">TCH médio 2025</div>
        <div class="v">${formatNum(tchMed,1)}</div>
      </div>
      <div>
        <div class="k">ATR médio 2025</div>
        <div class="v">${formatNum(atrMed,1)}</div>
      </div>
    </div>

    <div class="occ">
      <div class="row">
        <button id="btnNewOccFarm">+ Criar Ocorrência (Fazenda)</button>
        <button class="secondary" id="btnPendReport">Pendências</button>
        <button class="secondary" id="btnRefreshOccFarm">Atualizar</button>
      </div>
      <div class="small" style="margin-top:8px;">Ocorrência na fazenda pode ser geral ou aplicada a talhões. “Feito” só no perfil Master.</div>
      <div id="occList"></div>
    </div>
  `;
  document.getElementById("btnNewOccFarm").onclick = ()=> openOccForm({scope:"fazenda", farmCode, farmName:farm.name, talhao:null});
  document.getElementById("btnRefreshOccFarm").onclick = ()=> renderOccList({scope:"fazenda", farmCode, talhao:null});
  renderOccList({scope:"fazenda", farmCode, talhao:null});
}

function renderOccList({scope, farmCode, talhao}){
  const all = loadOcc();
  let list = [];
  if(scope==="talhao"){
    list = all.filter(o=>o.scope==="talhao" && o.farmCode===farmCode && o.talhao===talhao);
  }else{
    list = all.filter(o=> (o.scope==="fazenda" && o.farmCode===farmCode) || (o.scope==="talhao" && o.farmCode===farmCode));
  }
  list.sort((a,b)=> (b.createdAt||0) - (a.createdAt||0));
  const wrap = document.getElementById("occList");
  if(!wrap) return;
  if(list.length===0){
    wrap.innerHTML = `<div class="muted" style="margin-top:10px;">Nenhuma ocorrência registrada ainda.</div>`;
    return;
  }
  wrap.innerHTML = list.map(o=>{
    const where = o.scope==="talhao" ? `Talhão ${o.talhao}` : "Fazenda";
    const pr = (o.pragas||[]).map(x=>`<span class="tag">${x}</span>`).join("");
    const mt = (o.matos||[]).map(x=>`<span class="tag">${x}</span>`).join("");
    const fotos = (o.photos||[]).length ? `<div class="thumbs">` + (o.photos||[]).slice(0,3).map((p,idx)=>`<img class="thumb" src="${p}" title="Abrir" onclick="window.__openPhotoViewer(\'${o.id}\', ${idx})" />`).join("") + ((o.photos||[]).length>3?`<div class="thumb-more" onclick="window.__openPhotoViewer(\'${o.id}\', 0)">+${(o.photos||[]).length-3}</div>`:"") + `</div>` : "";
    const dt = new Date(o.date||o.createdAt||Date.now());
    const dtStr = dt.toLocaleDateString("pt-BR");
    const canClose = getProfile()==="master";
    const action = `
      <div class="row" style="margin-top:8px;">
        <select data-id="${o.id}" class="statusSel">
          <option ${o.status==="Pendente"?"selected":""}>Pendente</option>
          <option ${o.status==="Em andamento"?"selected":""}>Em andamento</option>
          <option ${o.status==="Feito"?"selected":""}>Feito</option>
        </select>
        <button class="secondary" data-id="${o.id}" class="btnEdit">Editar</button>
      </div>
    `;
    return `
      <div class="occ-item">
        <div class="occ-head">
          <div><b>${o.cultura || "—"}</b> • ${where} • <span class="small">${dtStr}</span></div>
          ${statusBadge(o.status)}
        </div>
        <div class="small" style="margin-top:6px;"><b>Obs:</b> ${escapeHtml(o.observacao||"—")}</div>
        ${o.pragas?.length ? `<div class="small" style="margin-top:6px;"><b>Pragas:</b> ${pr}</div>` : ``}
        ${o.matos?.length ? `<div class="small" style="margin-top:6px;"><b>Matos:</b> ${mt}</div>` : ``}
        ${fotos}
        <div class="row" style="margin-top:8px;">
          <select data-id="${o.id}" class="statusSel" style="flex:1;">
            <option value="Pendente" ${o.status==="Pendente"?"selected":""}>Pendente</option>
            <option value="Em andamento" ${o.status==="Em andamento"?"selected":""}>Em andamento</option>
            <option value="Feito" ${o.status==="Feito"?"selected":""}>Feito</option>
          </select>
          <button class="secondary" data-id="${o.id}" onclick="window.__editOcc('${o.id}')">Editar</button>
        </div>
      </div>
    `;
  }).join("");

  // hook status change
  wrap.querySelectorAll(".statusSel").forEach(sel=>{
    sel.onchange = ()=>{
      const id = sel.getAttribute("data-id");
      const next = sel.value;
      if(next==="Feito" && getProfile()!=="master"){
        alert("Só Master pode finalizar como FEITO.");
        sel.value = "Em andamento";
        return;
      }
      if(next==="Feito"){
        openModal({
          title:"Finalizar ocorrência",
          sub:"Para marcar como FEITO, descreva o que foi feito (obrigatório).",
          bodyHtml:`<label>O que foi feito *</label><textarea id="doneText" placeholder="Ex: Aplicado X, dose Y, data..."></textarea>`,
          onSave: ()=>{
            const txt = document.getElementById("doneText").value.trim();
            if(!txt){ alert("Campo obrigatório: o que foi feito."); return false; }
            const arr = loadOcc();
            const idx = arr.findIndex(o=>o.id===id);
            if(idx>=0){
              arr[idx].status = "Feito";
              arr[idx].doneText = txt;
              arr[idx].doneAt = Date.now();
              saveOcc(arr);
            }
            // re-render current card
            refreshCurrentCard();
            return true;
          }
        });
        // revert select until modal saves
        sel.value = "Em andamento";
        return;
      }
      const arr = loadOcc();
      const idx = arr.findIndex(o=>o.id===id);
      if(idx>=0){
        arr[idx].status = next;
        saveOcc(arr);
      }
      refreshCurrentCard();
    };
  });
}

function escapeHtml(s){
  return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// expose edit

// open photo viewer (lightbox) for an occurrence
window.__openPhotoViewer = (occId, startIdx=0)=>{
  const occ = loadOcc().find(o=>o.id===occId);
  if(!occ || !occ.photos || !occ.photos.length) return;
  let i = Math.max(0, Math.min(startIdx, occ.photos.length-1));
  const render = ()=>{
    const img = occ.photos[i];
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="small">Foto ${i+1} de ${occ.photos.length}</div>
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
      sub: `${occ.farmCode} — ${occ.farmName}` + (occ.scope==="talhao" ? ` • Talhão ${occ.talhao}` : ""),
      bodyHtml,
      onSave: null
    });
    // hook nav
    setTimeout(()=>{
      const prev=document.getElementById("pvPrev");
      const next=document.getElementById("pvNext");
      if(prev) prev.onclick=()=>{ i = (i-1+occ.photos.length)%occ.photos.length; render(); };
      if(next) next.onclick=()=>{ i = (i+1)%occ.photos.length; render(); };
    },0);
  };
  render();
};
// relatório de pendências por fazenda (não-feitos)
window.__openPendReport = (farmCode)=>{
  const farm = farms.get(farmCode);
  if(!farm) return;
  const all = loadOcc().filter(o=> (o.scope==="fazenda" && o.farmCode===farmCode) || (o.scope==="talhao" && o.farmCode===farmCode));
  const pend = all.filter(o=>o.status!=="Feito");
  // group by talhao (null => fazenda)
  const groups = new Map();
  for(const o of pend){
    const key = o.scope==="talhao" ? `Talhão ${o.talhao}` : "Fazenda (geral)";
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const rows = [...groups.entries()].map(([k,arr])=>{
    arr.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    const items = arr.slice(0,8).map(o=>{
      const dt = new Date(o.date||o.createdAt||Date.now()).toLocaleDateString("pt-BR");
      return `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:8px;margin-top:6px;">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;">
          <div><b>${escapeHtml(o.cultura||"—")}</b> • <span class="small">${dt}</span></div>
          ${statusBadge(o.status)}
        </div>
        <div class="small" style="margin-top:6px;"><b>Obs:</b> ${escapeHtml(o.observacao||"—")}</div>
      </div>`;
    }).join("");
    return `<div style="margin-top:12px;">
      <div style="font-weight:700;">${escapeHtml(k)} <span class="small">(${arr.length})</span></div>
      ${items}
    </div>`;
  }).join("");

  const body = `
    <div>
      <div class="small">Pendências = ocorrências em <b>Pendente</b> ou <b>Em andamento</b>.</div>
      <div style="margin-top:10px;">
        <div class="row">
          <div style="border:1px solid #e5e7eb;border-radius:12px;padding:10px;">
            <div class="small">Total pendências</div>
            <div style="font-size:22px;font-weight:800;">${pend.length}</div>
          </div>
          <div style="border:1px solid #e5e7eb;border-radius:12px;padding:10px;">
            <div class="small">Talhões com pendência</div>
            <div style="font-size:22px;font-weight:800;">${[...groups.keys()].filter(x=>x.startsWith("Talhão")).length}</div>
          </div>
        </div>
        ${rows || '<div class="muted" style="margin-top:10px;">Nenhuma pendência 🎉</div>'}
      </div>
    </div>`;
  openModal({title:"Relatório de pendências", sub:`Fazenda ${farmCode} — ${farm.name}`, bodyHtml: body, onSave: null});
};

window.__editOcc = (id)=>{
  const occ = loadOcc().find(o=>o.id===id);
  if(!occ) return;
  openOccForm({scope: occ.scope, farmCode: occ.farmCode, farmName: occ.farmName, talhao: occ.talhao, existing: occ});
};

function openOccForm({scope, farmCode, farmName, talhao, existing}){
  const isEdit = !!existing;
  const title = isEdit ? "Editar ocorrência" : "Nova ocorrência";
  const sub = scope==="talhao" ? `Fazenda ${farmCode} — ${farmName} • Talhão ${talhao}` : `Fazenda ${farmCode} — ${farmName}`;
  const culturaVal = existing?.cultura || "Cana";
  const pragasVal = (existing?.pragas||[]).join(", ");
  const matosVal = (existing?.matos||[]).join(", ");
  const obsVal = existing?.observacao || "";
  const dateVal = existing?.date ? new Date(existing.date).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
  const statusVal = existing?.status || "Pendente";

  const scopeExtra = scope==="fazenda" ? `
    <label>Aplicar a</label>
    <select id="farmApply">
      <option value="geral" ${existing?.farmApply==="geral"?"selected":""}>Geral da fazenda (sem talhão)</option>
      <option value="todos" ${existing?.farmApply==="todos"?"selected":""}>Todos os talhões da fazenda</option>
      <option value="selecionar" ${existing?.farmApply==="selecionar"?"selected":""}>Talhões selecionados (digitar)</option>
    </select>
    <div id="farmApplyTalhoesWrap" style="display:none;">
      <label>Talhões (separar por vírgula)</label>
      <input id="farmApplyTalhoes" placeholder="Ex: 2406, 2407, 2410" value="${escapeHtml((existing?.farmApplyTalhoes||[]).join(", "))}"/>
    </div>
  ` : "";

  openModal({
    title,
    sub,
    bodyHtml: `
      <label>Cultura</label>
      <input id="cultura" value="${escapeHtml(culturaVal)}" placeholder="Ex: Cana, Soja..."/>

      <label>Pragas (separar por vírgula)</label>
      <input id="pragas" value="${escapeHtml(pragasVal)}" placeholder="Ex: mosca-branca, cigarrinha"/>

      <label>Matos (separar por vírgula)</label>
      <input id="matos" value="${escapeHtml(matosVal)}" placeholder="Ex: buva, capim-colchão"/>

      <label>Observação *</label>
      <textarea id="obs" placeholder="Descreva o que viu no campo...">${escapeHtml(obsVal)}</textarea>

      <label>Data</label>
      <input id="date" type="date" value="${dateVal}"/>

      <label>Status</label>
      <select id="status">
        <option value="Pendente" ${statusVal==="Pendente"?"selected":""}>Pendente</option>
        <option value="Em andamento" ${statusVal==="Em andamento"?"selected":""}>Em andamento</option>
        <option value="Feito" ${statusVal==="Feito"?"selected":""}>Feito</option>
      </select>

      <label>Fotos (opcional)</label>
      <input id="photos" type="file" multiple accept="image/*"/>

      ${scopeExtra}
      <div class="small" style="margin-top:8px;">Dica: fotos muito grandes podem não caber no armazenamento local. Use poucas ou imagens leves.</div>
    `,
    onSave: async ()=>{
      const cultura = document.getElementById("cultura").value.trim();
      const pragas = document.getElementById("pragas").value.split(",").map(s=>s.trim()).filter(Boolean);
      const matos = document.getElementById("matos").value.split(",").map(s=>s.trim()).filter(Boolean);
      const obs = document.getElementById("obs").value.trim();
      const date = document.getElementById("date").value;
      let status = document.getElementById("status").value;
      if(status==="Feito" && getProfile()!=="master"){
        alert("Só Master pode finalizar como FEITO.");
        status = "Pendente";
      }
      if(!obs){
        alert("Observação é obrigatória.");
        return false;
      }

      // fotos -> data URLs (limit)
      const files = [...(document.getElementById("photos").files||[])].slice(0,6);
      const photos = [];
      for(const f of files){
        const dataUrl = await fileToDataURL(f);
        // basic cap: skip if too big
        if(dataUrl.length > 650000){ // ~650KB
          continue;
        }
        photos.push(dataUrl);
      }

      const arr = loadOcc();
      const record = {
        id: existing?.id || uid(),
        scope,
        farmCode,
        farmName,
        talhao: scope==="talhao" ? talhao : null,
        cultura,
        pragas,
        matos,
        observacao: obs,
        date: date ? Date.parse(date) : Date.now(),
        status: status,
        photos: existing?.photos?.length ? existing.photos.concat(photos) : photos,
        createdAt: existing?.createdAt || Date.now(),
      };

      if(scope==="fazenda"){
        const apply = document.getElementById("farmApply").value;
        record.farmApply = apply;
        if(apply==="selecionar"){
          const t = document.getElementById("farmApplyTalhoes").value.split(",").map(s=>s.trim()).filter(Boolean);
          record.farmApplyTalhoes = t;
        }else{
          record.farmApplyTalhoes = [];
        }
      }

      if(isEdit){
        const idx = arr.findIndex(o=>o.id===existing.id);
        if(idx>=0) arr[idx]=record;
        else arr.push(record);
      }else{
        arr.push(record);
      }
      saveOcc(arr);

      if(record.status==="Feito"){
        // ask doneText
        openModal({
          title:"Finalizar ocorrência",
          sub:"Para marcar como FEITO, descreva o que foi feito (obrigatório).",
          bodyHtml:`<label>O que foi feito *</label><textarea id="doneText" placeholder="Ex: Aplicado X, dose Y, data..."></textarea>`,
          onSave: ()=>{
            const txt = document.getElementById("doneText").value.trim();
            if(!txt){ alert("Campo obrigatório: o que foi feito."); return false; }
            const arr2 = loadOcc();
            const idx2 = arr2.findIndex(o=>o.id===record.id);
            if(idx2>=0){
              arr2[idx2].doneText = txt;
              arr2[idx2].doneAt = Date.now();
              arr2[idx2].status = "Feito";
              saveOcc(arr2);
            }
            refreshCurrentCard();
            return true;
          }
        });
      }

      refreshCurrentCard();
      return true;
    }
  });

  // show/hide apply talhoes
  if(scope==="fazenda"){
    const applySel = document.getElementById("farmApply");
    const wrap = document.getElementById("farmApplyTalhoesWrap");
    const sync = ()=>{
      wrap.style.display = applySel.value==="selecionar" ? "block" : "none";
    };
    applySel.onchange = sync;
    sync();
  }
}

function fileToDataURL(file){
  return new Promise((resolve)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = ()=> resolve("");
    reader.readAsDataURL(file);
  });
}

// ---- Rendering and map logic ----
let currentFarmCode = "";
let currentSelectedFeature = null;

function clearFarmLabel(){
  if(farmLabelMarker){
    farmLabelMarker.remove();
    farmLabelMarker = null;
  }
}

function setFarmLabel(farmCode, bounds){
  clearFarmLabel();
  const farm = farms.get(farmCode);
  if(!farm) return;
  const center = bounds.getCenter();
  const icon = L.divIcon({
    className: "",
    html: `<div style="background:rgba(17,24,39,.92);color:#fff;padding:6px 10px;border-radius:999px;font-size:12px;box-shadow:0 2px 10px rgba(0,0,0,.15);border:1px solid rgba(255,255,255,.25);">${farmCode} — ${farm.name}</div>`
  });
  farmLabelMarker = L.marker(center, {icon, interactive:false}).addTo(map);
}

function refreshCurrentCard(){
  const mode = getMode();
  if(mode==="talhao" && currentSelectedFeature){
    renderTalhaoCard(currentSelectedFeature);
  }else if(mode==="fazenda" && currentFarmCode){
    renderFarmCard(currentFarmCode);
  }
  // also update styles (status affects badges only for now)
}

async function init(){
  map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  map.setView([-20.3, -49.2], 10);

  prod2025 = await (await fetch('data/producao2025.json')).json();

  const kmlText = await (await fetch('data/geral.kml')).text();
  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
  const geojson = toGeoJSON.kml(dom);

  // organize by farm
  geojson.features.forEach(f=>{
    const props = f.properties || {};
    const inf = (props["INF."] ?? "").toString();
    const {farmCode, farmName} = parseFarmName(inf);
    if(!farms.has(farmCode)){
      farms.set(farmCode,{name:farmName || farmCode, features:[]});
    }
    farms.get(farmCode).features.push(f);
  });

  const select = document.getElementById("farmSelect");
  select.innerHTML = '<option value="">Selecione a fazenda…</option>';

  [...farms.entries()]
    .sort((a,b)=> (parseInt(a[0],10) || 0) - (parseInt(b[0],10) || 0))
    .forEach(([code,obj])=>{
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${code} — ${obj.name}`;
      select.appendChild(opt);
    });

  function drawFarm(code){
    clearFarmLabel();
    currentSelectedFeature = null;
    const card = document.getElementById("infoCard");
    if(geoLayer){ geoLayer.remove(); }
    if(!code || !farms.has(code)) {
      card.innerHTML = `<div class="muted">Selecione uma fazenda.</div>`;
      return;
    }
    currentFarmCode = code;
    const fc = {type:"FeatureCollection", features: farms.get(code).features};
    geoLayer = L.geoJSON(fc, {
      style: (feature)=>{
      const props = feature.properties || {};
      const inf = (props["INF."] ?? props.INF ?? "").toString();
      const {farmCode, talhao} = parseFarmName(inf);
      const st = computeStatusForTalhao(farmCode, talhao);
      let fillColor = "#60a5fa"; // default
      if(st==="Pendente") fillColor = "#f59e0b";
      else if(st==="Em andamento") fillColor = "#9ca3af";
      else if(st==="OK") fillColor = "#34d399";
      return {weight:1, fillOpacity:0.25, fillColor};
    },
      onEachFeature: (feature, layer)=>{
        layer.on('click', ()=>{
          const mode = getMode();
          if(mode==="fazenda"){
            // highlight all, zoom + farm card
            geoLayer.eachLayer(l=> l.setStyle({weight:1, fillOpacity:0.08}));
            layer.setStyle({weight:2, fillOpacity:0.22});
            const b = geoLayer.getBounds();
            map.fitBounds(b, {padding:[20,20]});
            setFarmLabel(code, b);
            renderFarmCard(code);
          }else{
            currentSelectedFeature = feature;
            renderTalhaoCard(feature);
            layer.setStyle({weight:3, fillOpacity:0.25});
            geoLayer.eachLayer(l=>{
              if(l !== layer) l.setStyle({weight:1, fillOpacity:0.15});
            });
          }
        });
      }
    }).addTo(map);

    const b = geoLayer.getBounds();
    map.fitBounds(b, {padding:[20,20]});
    // show farm card by default in farm mode, else instructions
    if(getMode()==="fazenda"){
      setFarmLabel(code, b);
      renderFarmCard(code);
    }else{
      card.innerHTML = `<div class="muted">Clique em um talhão no mapa para ver detalhes e criar ocorrências.</div>`;
    }
  }

  select.addEventListener('change', e=> drawFarm(e.target.value));
  document.getElementById("modeSelect").addEventListener('change', ()=>{
    // redraw current farm for correct default view
    drawFarm(select.value);
  });
  document.getElementById("profileSelect").addEventListener('change', ()=>{
    refreshCurrentCard();
  });

  const first = select.options[1]?.value;
  if(first){
    select.value = first;
    drawFarm(first);
  }
}

init().catch(err=>{
  console.error(err);
  const card = document.getElementById("infoCard");
  card.innerHTML = `<div class="muted">Erro ao carregar. Veja o console.</div>`;
});
