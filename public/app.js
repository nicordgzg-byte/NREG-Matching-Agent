let currentTab = 'active';

async function request(path, options = {}) {
  const token = localStorage.getItem('nreg_panel_token');
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    const next = prompt('Token del panel:');
    if (next) { localStorage.setItem('nreg_panel_token', next); return request(path, options); }
  }
  return response.json();
}

function money(value) { return value == null ? '—' : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(value); }

function recordCard(record) {
  const title = `${record.record_type === 'OFFER' ? 'Oferta' : 'Demanda'} #${record.id}`;
  const details = [record.property_type, record.zones?.join(', '), record.price_min || record.price_max ? money(record.price_min || record.price_max) : null].filter(Boolean).join(' · ');
  const action = record.status === 'ACTIVE'
    ? `<button class="secondary" onclick="recordAction('${record.id}', 'close')">Cerrar</button>`
    : `<button class="secondary" onclick="recordAction('${record.id}', 'renew')">Renovar</button>`;
  return `<article class="record"><div><h3>${title} <span class="muted">${record.status}</span></h3><p>${details || 'Sin datos resumidos'}</p><p class="muted">${escapeHtml(record.original_message)}</p></div><div>${action}</div></article>`;
}

function matchCard(match) {
  return `<article class="record"><div><h3>Match #${match.id} · ${match.score}/100</h3><p>${escapeHtml(match.reasons.join(' · '))}</p><p class="muted">Oferta: ${escapeHtml(match.offer_message)}</p><p class="muted">Demanda: ${escapeHtml(match.demand_message)}</p></div><button class="secondary" onclick="reviewMatch('${match.id}')">Revisado</button></article>`;
}

function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

async function load() {
  const [active, offers, demands, matches, closed, expired] = await Promise.all([
    request('/api/records?status=ACTIVE'), request('/api/records?status=ACTIVE'), request('/api/records?status=ACTIVE'), request('/api/matches'), request('/api/records?status=CLOSED'), request('/api/records?status=EXPIRED')
  ]);
  const activeRecords = active || [];
  document.querySelector('#metrics').innerHTML = [
    ['Activos', activeRecords.length],
    ['Ofertas', activeRecords.filter((r) => r.record_type === 'OFFER').length],
    ['Demandas', activeRecords.filter((r) => r.record_type === 'DEMAND').length],
    ['Matches', (matches || []).length]
  ].map(([label, value]) => `<div class="card"><div class="muted">${label}</div><div class="metric">${value}</div></div>`).join('');

  const content = document.querySelector('#content');
  if (currentTab === 'matches') {
    content.innerHTML = `<div class="toolbar"><h2>Matches detectados</h2><button class="secondary" onclick="load()">Actualizar</button></div><div class="list">${matches.length ? matches.map(matchCard).join('') : '<div class="empty">Todavía no hay matches.</div>'}</div>`;
  } else {
    const records = currentTab === 'active' ? activeRecords : [...(closed || []), ...(expired || [])];
    content.innerHTML = `<div class="toolbar"><h2>${currentTab === 'active' ? 'Registros activos' : 'Registros cerrados o vencidos'}</h2><button class="secondary" onclick="load()">Actualizar</button></div><div class="list">${records.length ? records.map(recordCard).join('') : '<div class="empty">No hay registros.</div>'}</div>`;
  }
}

async function recordAction(id, action) { await request(`/api/records/${id}/${action}`, { method: 'POST' }); await load(); }
async function reviewMatch(id) { await request(`/api/matches/${id}/review`, { method: 'POST' }); await load(); }

document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
  currentTab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('secondary', item !== button));
  load();
}));

load();
