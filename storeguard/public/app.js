const $ = (sel) => document.querySelector(sel);
const fileInput = $('#file-input');
const dropZone = $('#drop-zone');
const dropTitle = $('#drop-title');
const dropSub = $('#drop-sub');
const storeSelect = $('#store-select');
const cameraInput = $('#camera-input');
const datetimeInput = $('#datetime-input');
const analyseBtn = $('#analyse-btn');
const statusEl = $('#analyse-status');
const listEl = $('#incident-list');
const detailEl = $('#detail');
const emptyState = $('#empty-state');

let selectedFile = null;
let incidents = [];
let activeId = null;

function setNowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  datetimeInput.value =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadStores() {
  const stores = await fetch('/api/stores').then((r) => r.json());
  storeSelect.innerHTML = stores.map((s) => `<option value="${s}">${s}</option>`).join('');
}

async function loadIncidents() {
  incidents = await fetch('/api/incidents').then((r) => r.json());
  renderList();
  renderStats();
  if (activeId && !incidents.find((i) => i.id === activeId)) {
    activeId = null;
    renderDetail();
  } else if (activeId) {
    renderDetail();
  }
}

function renderStats() {
  $('#stat-total').textContent = incidents.length;
  $('#stat-confirmed').textContent = incidents.filter((i) => i.reviewer_status === 'confirmed').length;
  $('#stat-suspicious').textContent = incidents.filter((i) => i.reviewer_status === 'suspicious').length;
  $('#stat-cleared').textContent = incidents.filter((i) => i.reviewer_status === 'false_alarm').length;
}

function severityClass(s) {
  return ['high', 'medium', 'low', 'none'].includes(s) ? s : 'none';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}

function renderList() {
  if (!incidents.length) {
    listEl.innerHTML = '<li class="muted" style="cursor:default;background:transparent;border:0">No incidents yet.</li>';
    return;
  }
  listEl.innerHTML = incidents
    .map((i) => `
      <li data-id="${i.id}" class="${i.id === activeId ? 'active' : ''}">
        <div class="incident-row">
          <span class="incident-store">${i.store}</span>
          <span class="badge ${severityClass(i.severity)}">${i.severity || 'none'}</span>
        </div>
        <div class="incident-meta">
          <span>${i.camera || '—'} · ${fmtTime(i.created_at)}</span>
          <span class="badge status-${i.reviewer_status}">${i.reviewer_status.replace('_', ' ')}</span>
        </div>
      </li>
    `).join('');
  listEl.querySelectorAll('li[data-id]').forEach((li) => {
    li.addEventListener('click', () => {
      activeId = Number(li.dataset.id);
      renderList();
      renderDetail();
    });
  });
}

function renderDetail() {
  const inc = incidents.find((i) => i.id === activeId);
  if (!inc) {
    detailEl.innerHTML = '<div class="empty"><p>Select or upload an incident to review.</p></div>';
    return;
  }
  const isVideo = inc.media_type && inc.media_type.startsWith('video/');
  const media = inc.media_url
    ? isVideo
      ? `<video src="${inc.media_url}" controls></video>`
      : `<img src="${inc.media_url}" alt="incident" />`
    : '';

  detailEl.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>${inc.store}</h2>
        <div class="sub">${inc.camera || 'Unknown camera'} · captured ${inc.captured_at || '—'} · saved ${fmtTime(inc.created_at)}</div>
      </div>
      <button class="ghost danger" id="delete-btn">Delete</button>
    </div>

    <div class="media-wrap">${media}</div>

    <div class="metrics">
      <div class="metric"><div class="label">Flagged</div><div class="value">${inc.flagged ? 'Yes' : 'No'}</div></div>
      <div class="metric"><div class="label">Severity</div><div class="value"><span class="badge ${severityClass(inc.severity)}">${inc.severity || 'none'}</span></div></div>
      <div class="metric"><div class="label">Confidence</div><div class="value">${inc.confidence}%</div></div>
    </div>

    <div class="section">
      <h4>Summary</h4>
      <p>${inc.summary || '—'}</p>
    </div>

    <div class="section">
      <h4>Scene description</h4>
      <p>${inc.scene_description || '—'}</p>
    </div>

    <div class="section">
      <h4>Specific flags</h4>
      ${inc.flags && inc.flags.length
        ? `<ul class="flags-list">${inc.flags.map((f) => `<li>${f}</li>`).join('')}</ul>`
        : '<p class="muted">None reported.</p>'}
    </div>

    <div class="section">
      <h4>Recommendation</h4>
      <p>${inc.recommendation || '—'}</p>
    </div>

    <div class="section">
      <h4>Reviewer action</h4>
      <div class="actions">
        <button class="ghost confirm ${inc.reviewer_status === 'confirmed' ? 'active' : ''}" data-status="confirmed">Confirm Theft</button>
        <button class="ghost susp ${inc.reviewer_status === 'suspicious' ? 'active' : ''}" data-status="suspicious">Suspicious</button>
        <button class="ghost false ${inc.reviewer_status === 'false_alarm' ? 'active' : ''}" data-status="false_alarm">False Alarm</button>
      </div>
      <div class="note-row">
        <textarea id="note-input" placeholder="Reviewer note (optional)">${inc.reviewer_note || ''}</textarea>
        <button class="ghost" id="save-note">Save note</button>
      </div>
    </div>
  `;

  detailEl.querySelectorAll('.actions button').forEach((btn) => {
    btn.addEventListener('click', () => updateStatus(inc.id, btn.dataset.status));
  });
  $('#save-note').addEventListener('click', () => updateNote(inc.id, $('#note-input').value));
  $('#delete-btn').addEventListener('click', () => deleteIncident(inc.id));
}

async function updateStatus(id, status) {
  await fetch(`/api/incidents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer_status: status }),
  });
  await loadIncidents();
}

async function updateNote(id, note) {
  await fetch(`/api/incidents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer_note: note }),
  });
  setStatus('Note saved.', 'ok');
}

async function deleteIncident(id) {
  if (!confirm('Delete this incident?')) return;
  await fetch(`/api/incidents/${id}`, { method: 'DELETE' });
  if (activeId === id) activeId = null;
  await loadIncidents();
}

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + kind;
}

function setFile(file) {
  selectedFile = file;
  if (file) {
    dropTitle.textContent = file.name;
    dropSub.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ${file.type || 'unknown'}`;
  } else {
    dropTitle.textContent = 'Drop screenshot or clip';
    dropSub.textContent = 'image or video — from Hik-Connect';
  }
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => setFile(e.target.files[0] || null));

['dragenter', 'dragover'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) setFile(f);
});

analyseBtn.addEventListener('click', async () => {
  if (!selectedFile) return setStatus('Pick a file first.', 'error');
  const fd = new FormData();
  fd.append('file', selectedFile);
  fd.append('store', storeSelect.value);
  fd.append('camera', cameraInput.value);
  fd.append('datetime', datetimeInput.value);
  analyseBtn.disabled = true;
  setStatus('Sending to Claude…');
  try {
    const res = await fetch('/api/analyse', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    setStatus('Analysis complete.', 'ok');
    setFile(null);
    fileInput.value = '';
    activeId = data.id;
    await loadIncidents();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    analyseBtn.disabled = false;
  }
});

setNowLocal();
loadStores();
loadIncidents();
setInterval(loadIncidents, 30000);
