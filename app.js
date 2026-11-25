/* Job Search Tracker UI — renders the tabs and form, and talks to SheetStore (store.js). */
(() => {
  const KEY = 'jt-ui';                      // per-device UI preferences (table/board view)

  // Tahap proses, berurutan. group: active = masih berjalan, win = offering/diterima, closed = selesai tanpa hasil
  // Tahap awal ada dua pilihan: Applied (Anda melamar) atau Contacted (dihubungi recruiter/HR lebih dulu)
  const STAGES = [
    { id: 'applied',   label: 'Applied',          group: 'active' },
    { id: 'contacted', label: 'Contacted',        group: 'active' },
    { id: 'screening', label: 'Screening CV',     group: 'active' },
    { id: 'test',      label: 'Tes / assessment', group: 'active' },
    { id: 'int_hr',    label: 'Interview HR',     group: 'active' },
    { id: 'int_user',  label: 'Interview user',   group: 'active' },
    { id: 'final',     label: 'Final interview',  group: 'active' },
    { id: 'offer',     label: 'Offering',         group: 'win' },
    { id: 'accepted',  label: 'Diterima',         group: 'win' },
  ];
  const CLOSED = [
    { id: 'rejected',  label: 'Ditolak',          group: 'closed' },
    { id: 'ghosted',   label: 'Tidak ada kabar',  group: 'closed' },
    { id: 'withdrawn', label: 'Memutuskan untuk tidak lanjut', group: 'closed' },
  ];
  const ALL = [...STAGES, ...CLOSED];
  const BY_ID = Object.fromEntries(ALL.map((s) => [s.id, s]));
  // Funnel: Applied dan Contacted digabung jadi satu tahap awal
  const FUNNEL = STAGES.filter((s) => s.id !== 'contacted').map((s) => s.id === 'applied' ? { ...s, label: 'Applied / contacted' } : s);
  const ORDER = Object.fromEntries(FUNNEL.map((s, i) => [s.id, i]));
  ORDER.contacted = 0;
  const isStart = (a) => a.status === 'applied' || a.status === 'contacted';
  const INTERVIEW_IDX = ORDER.int_hr;
  const SOURCES = ['LinkedIn', 'Referral', 'Website perusahaan', 'Job portal', 'Lainnya'];
  const STALE_DAYS = 14;

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // ---------- Penyimpanan: Google Sheets lewat store.js (cache di browser ini) ----------
  let apps = [];
  let loaded = false;
  let mode = 'local';
  let pending = 0;
  function setStatus(s, msg) {
    const el = $('#status'); el.dataset.s = s;
    $('#status-t').textContent = msg || (s === 'saving' ? 'Menyimpan…' : s === 'error' ? 'Gagal menyimpan' : mode === 'local' ? 'Tersimpan di perangkat' : 'Tersimpan');
  }
  async function reload() { apps = await SheetStore.all(); render(); }
  // Penulisan yang sedang berjalan dihitung di `pending`; status kembali "Tersinkron" setelah semuanya selesai
  async function write(fn) {
    pending++; setStatus('saving');
    let failed = false;
    const job = fn().catch(() => { failed = true; });
    await reload();                                   // the cache already holds the change
    await job;
    pending--;
    if (failed) setStatus('error', `${SheetStore.pending()} belum terkirim`);
    else if (!pending) setStatus('saved', mode === 'local' ? null : 'Tersinkron');
    return true;
  }
  const putApp = (a) => write(() => SheetStore.set(a));
  const removeApp = (id) => write(() => SheetStore.remove(id));

  // ---------- Util ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parse = (s) => { if (!s) return null; const d = new Date(s + 'T00:00:00'); return isNaN(d) ? null : d; };
  const diffDays = (s) => { const d = parse(s); return d ? Math.round((today - d) / 864e5) : null; };
  const fmtDate = (s) => { const d = parse(s); return d ? d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
  const pct = (a, b) => b ? Math.round((a / b) * 100) + '%' : '—';
  const reached = (a) => BY_ID[a.status]?.group === 'closed' ? (ORDER[a.lastStage] ?? 0) : (ORDER[a.status] ?? 0);
  const groupOf = (a) => BY_ID[a.status]?.group || 'active';
  const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }

  $('#todayLbl').textContent = today.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ---------- Isi pilihan ----------
  const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
  const stageOptions = `<optgroup label="Proses">${STAGES.map((s) => opt(s.id, s.label)).join('')}</optgroup><optgroup label="Ditutup">${CLOSED.map((s) => opt(s.id, s.label)).join('')}</optgroup>`;
  $('#f-status').innerHTML = stageOptions;
  $('#f-lastStage').innerHTML = STAGES.slice(0, 7).map((s) => opt(s.id, s.label)).join('');
  $('#f-source').innerHTML = SOURCES.map((s) => opt(s, s)).join('');
  $('#fStatus').innerHTML = opt('', 'Semua status') + opt('@active', 'Masih berjalan') + opt('@win', 'Offering / diterima') + opt('@closed', 'Ditutup') + stageOptions;
  $('#fSource').innerHTML = opt('', 'Semua sumber') + SOURCES.map((s) => opt(s, s)).join('');

  // ---------- Render ----------
  let view = 'table';
  let sort = { key: 'appliedDate', dir: -1 };

  function render() {
    renderKpis(); renderTodo(); renderFunnel(); renderSources(); renderList();
  }

  function renderKpis() {
    const n = apps.length;
    const active = apps.filter((a) => groupOf(a) === 'active');
    const responded = apps.filter((a) => reached(a) >= 1);
    const interviewed = apps.filter((a) => reached(a) >= INTERVIEW_IDX);
    const offers = apps.filter((a) => reached(a) >= ORDER.offer);
    const last30 = apps.filter((a) => { const d = diffDays(a.appliedDate); return d !== null && d <= 30; }).length;
    $('#k-total').textContent = n;
    $('#k-total-m').textContent = `${last30} dalam 30 hari terakhir`;
    $('#k-active').textContent = active.length;
    const waiting = active.filter(isStart).length;
    $('#k-active-m').textContent = `${waiting} masih menunggu respon`;
    $('#k-resp').textContent = pct(responded.length, n);
    $('#k-int').textContent = interviewed.length;
    $('#k-int-m').textContent = `${pct(interviewed.length, n)} dari semua lamaran`;
    $('#k-offer').textContent = offers.length;
    const acc = apps.filter((a) => a.status === 'accepted').length;
    $('#k-offer-m').textContent = acc ? `${acc} diterima` : `${pct(offers.length, interviewed.length)} dari yang interview`;

    // Kalimat ringkasan
    let t;
    if (!loaded) t = 'Memuat data lamaran…';
    else if (!n) t = 'Belum ada lamaran. Klik "Tambah lamaran" untuk mulai mencatat.';
    else {
      const bestSrc = SOURCES.map((s) => { const r = apps.filter((a) => a.source === s); return { s, n: r.length, i: r.filter((a) => reached(a) >= INTERVIEW_IDX).length }; })
        .filter((x) => x.n >= 2).sort((a, b) => b.i / b.n - a.i / a.n)[0];
      t = `${active.length} dari ${n} lamaran masih berjalan, ${interviewed.length} sudah sampai interview.`;
      if (bestSrc && bestSrc.i) t += ` ${bestSrc.s} paling efektif: ${pct(bestSrc.i, bestSrc.n)} lamarannya lanjut ke interview.`;
    }
    $('#takeaway').textContent = t;
  }

  function renderTodo() {
    const items = [];
    apps.forEach((a) => {
      if (groupOf(a) === 'closed' || a.status === 'accepted') return;
      const nd = parse(a.nextDate);
      if (nd) {
        const inDays = Math.round((nd - today) / 864e5);
        if (inDays >= -3 && inDays <= 7) {
          const lbl = inDays < 0 ? `${-inDays} hari lewat` : inDays === 0 ? 'Hari ini' : inDays === 1 ? 'Besok' : `${inDays} hari lagi`;
          items.push({ a, sortKey: inDays, cls: inDays < 0 ? 'late' : 'soon', when: lbl, what: a.nextStep || BY_ID[a.status].label });
          return;
        }
      }
      const since = diffDays(a.updatedAt || a.appliedDate);
      if (groupOf(a) === 'active' && since !== null && since > STALE_DAYS && !nd) {
        items.push({ a, sortKey: 100 - since, cls: 'late', when: `${since} hari tanpa update`, what: isStart(a) ? 'Follow up ke recruiter atau tandai "Tidak ada kabar"' : 'Tanyakan update proses' });
      }
    });
    items.sort((x, y) => x.sortKey - y.sortKey);
    $('#todo').innerHTML = items.length
      ? items.map((x) => `<li data-id="${esc(x.a.id)}" tabindex="0"><span class="when ${x.cls}">${esc(x.when)}</span><span class="what"><b>${esc(x.a.company)} · ${esc(x.a.position)}</b><span>${esc(x.what)}</span></span><span class="pill g-${groupOf(x.a)}">${esc(BY_ID[x.a.status].label)}</span></li>`).join('')
      : '<li class="empty" style="background:none;cursor:default">Tidak ada jadwal atau follow-up yang mendesak.</li>';
  }

  function renderFunnel() {
    const n = apps.length;
    const counts = FUNNEL.map((s, i) => apps.filter((a) => reached(a) >= i).length);
    $('#funnel').innerHTML = FUNNEL.map((s, i) => {
      const c = counts[i];
      const conv = i === 0 ? '' : `<small>${pct(c, counts[i - 1])}</small>`;
      return `<div class="frow ${s.group === 'win' ? 'win' : ''}"><span class="lbl" title="${esc(s.label)}">${esc(s.label)}</span><div class="track"><div class="fill" style="width:${n ? (c / n) * 100 : 0}%"></div></div><span class="num">${c}${conv}</span></div>`;
    }).join('') + `<p class="note">Persentase kecil = konversi dari tahap sebelumnya.</p>`;
  }

  function renderSources() {
    const max = Math.max(1, ...SOURCES.map((s) => apps.filter((a) => a.source === s).length));
    $('#sources').innerHTML = SOURCES.map((s) => {
      const r = apps.filter((a) => a.source === s);
      if (!r.length && s === 'Lainnya') return '';
      const g = { active: 0, win: 0, closed: 0 };
      r.forEach((a) => g[groupOf(a)]++);
      const iv = r.filter((a) => reached(a) >= INTERVIEW_IDX).length;
      const w = (k) => (g[k] / max) * 100;
      return `<div class="src"><div class="src-top"><b>${esc(s)}</b><span>${r.length} lamaran · ${iv} interview (${pct(iv, r.length)})</span></div>
        <div class="stack" role="img" aria-label="${esc(s)}: ${g.active} berjalan, ${g.win} offering, ${g.closed} ditutup">
          <i class="seg-active" style="width:${w('active')}%"></i><i class="seg-win" style="width:${w('win')}%"></i><i class="seg-closed" style="width:${w('closed')}%"></i>
        </div></div>`;
    }).join('');
  }

  function filtered() {
    const q = $('#q').value.trim().toLowerCase();
    const fs = $('#fStatus').value, fsrc = $('#fSource').value;
    return apps.filter((a) => {
      if (fsrc && a.source !== fsrc) return false;
      if (fs) { if (fs.startsWith('@')) { if (groupOf(a) !== fs.slice(1)) return false; } else if (a.status !== fs) return false; }
      if (q) { const hay = [a.company, a.position, a.notes, a.referrer, a.location, a.nextStep, a.contact].join(' ').toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
  }

  function sortRows(rows) {
    const k = sort.key;
    const val = (a) => k === 'status' ? (ALL.findIndex((s) => s.id === a.status)) : (a[k] || (k.endsWith('Date') ? (sort.dir > 0 ? '9999' : '0000') : ''));
    return rows.slice().sort((x, y) => { const a = val(x), b = val(y); return (a > b ? 1 : a < b ? -1 : 0) * sort.dir; });
  }

  function renderList() {
    const rows = sortRows(filtered());
    $('#countNote').textContent = rows.length === apps.length ? `${apps.length} lamaran` : `${rows.length} dari ${apps.length} lamaran ditampilkan`;
    document.querySelectorAll('th button[data-sort]').forEach((b) => {
      const th = b.parentElement;
      if (b.dataset.sort === sort.key) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
      b.textContent = b.textContent.replace(/ [↑↓]$/, '') + (b.dataset.sort === sort.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : '');
    });

    $('#tbody').innerHTML = rows.length ? rows.map((a) => {
      const d = diffDays(a.appliedDate);
      const g = groupOf(a);
      const statusSel = `<select class="g-${g}" data-status="${esc(a.id)}" aria-label="Status ${esc(a.company)}">${stageOptions}</select>`;
      const link = a.link ? ` · <a href="${esc(a.link)}" target="_blank" rel="noopener">lowongan</a>` : '';
      const extra = [a.workType, a.location].filter(Boolean).join(' · ');
      return `<tr data-id="${esc(a.id)}">
        <td><div class="co">${esc(a.company)}</div><div class="pos">${esc(a.position)}</div>${extra || link ? `<div class="days">${esc(extra)}${link}</div>` : ''}</td>
        <td><span class="chip">${esc(a.source || '—')}</span>${a.referrer ? `<div class="days">via ${esc(a.referrer)}</div>` : ''}</td>
        <td>${fmtDate(a.appliedDate)}${d !== null ? `<div class="days">${d} hari lalu</div>` : ''}</td>
        <td>${statusSel}${g === 'closed' && a.lastStage ? `<div class="days">di tahap ${esc(BY_ID[a.lastStage]?.label || '')}</div>` : ''}</td>
        <td>${a.nextStep ? esc(a.nextStep) : '<span class="days">—</span>'}${a.nextDate ? `<div class="days">${fmtDate(a.nextDate)}</div>` : ''}</td>
        <td style="max-width:260px">${a.notes ? esc(a.notes) : '<span class="days">—</span>'}</td>
        <td class="rowact"><button type="button" class="ghost" data-edit="${esc(a.id)}">Edit</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="7" class="empty">${!loaded ? 'Memuat…' : apps.length ? 'Tidak ada lamaran yang cocok dengan filter.' : 'Belum ada lamaran. Klik "+ Tambah lamaran" di atas untuk mencatat yang pertama.'}</td></tr>`;
    rows.forEach((a) => { const s = document.querySelector(`select[data-status="${CSS.escape(a.id)}"]`); if (s) s.value = a.status; });

    const cols = [...STAGES.map((s) => ({ key: s.id, label: s.label, test: (a) => a.status === s.id })), { key: 'closed', label: 'Ditutup', test: (a) => groupOf(a) === 'closed' }];
    $('#boardView').innerHTML = cols.map((c) => {
      const items = rows.filter(c.test);
      return `<div class="col"><div class="col-head">${esc(c.label)}<span>${items.length}</span></div>${items.map((a) => `
        <button type="button" class="kcard" data-edit="${esc(a.id)}"><b>${esc(a.company)}</b><span class="pos">${esc(a.position)}</span>
        <span class="row"><span class="chip">${esc(a.source || '—')}</span><span>${c.key === 'closed' ? esc(BY_ID[a.status].label) : (diffDays(a.appliedDate) ?? '–') + ' hari'}</span></span></button>`).join('')}</div>`;
    }).join('');
  }

  // ---------- Interaksi ----------
  ['#q', '#fStatus', '#fSource'].forEach((s) => $(s).addEventListener('input', renderList));
  document.querySelectorAll('th button[data-sort]').forEach((b) => b.addEventListener('click', () => {
    sort = sort.key === b.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: b.dataset.sort, dir: b.dataset.sort === 'company' || b.dataset.sort === 'source' ? 1 : -1 };
    renderList();
  }));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#tableView').hidden = view !== 'table';
    $('#boardView').hidden = view !== 'board';
    try { localStorage.setItem(KEY + '.view', view); } catch (e) {}
  }));
  try { const v = localStorage.getItem(KEY + '.view'); if (v === 'board') document.querySelector('[data-view="board"]').click(); } catch (e) {}

  document.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return openForm(ed.dataset.edit);
    const li = e.target.closest('#todo li[data-id]');
    if (li) openForm(li.dataset.id);
  });
  $('#todo').addEventListener('keydown', (e) => { const li = e.target.closest('li[data-id]'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openForm(li.dataset.id); } });
  $('#tbody').addEventListener('change', (e) => {
    const s = e.target.closest('select[data-status]');
    if (!s) return;
    const cur = apps.find((x) => x.id === s.dataset.status);
    if (!cur) return;
    const a = { ...cur, status: s.value, updatedAt: iso(today) };
    const prev = cur.status;
    if (BY_ID[a.status].group === 'closed' && !a.lastStage) a.lastStage = BY_ID[prev].group === 'closed' ? 'applied' : (prev === 'offer' || prev === 'accepted' ? 'final' : prev);
    putApp(a).then((ok) => ok && toast(`${a.company}: status jadi ${BY_ID[a.status].label}`));
  });

  // ---------- Form ----------
  const dlg = $('#dlg'), form = $('#form');
  let editing = null, delArmed = false, delT;
  const syncFormVis = () => {
    $('#refWrap').hidden = $('#f-source').value !== 'Referral';
    $('#lastStageWrap').hidden = BY_ID[$('#f-status').value].group !== 'closed';
  };
  $('#f-source').addEventListener('change', syncFormVis);
  $('#f-status').addEventListener('change', syncFormVis);

  function openForm(id) {
    editing = id ? apps.find((a) => a.id === id) : null;
    form.reset();
    const a = editing || { source: 'LinkedIn', status: 'applied', appliedDate: iso(today) };
    [...form.elements].forEach((el) => { if (el.name) el.value = a[el.name] ?? (el.name === 'lastStage' ? 'applied' : ''); });
    $('#dlgTitle').textContent = editing ? 'Edit lamaran' : 'Tambah lamaran';
    $('#delBtn').hidden = !editing; $('#delBtn').textContent = 'Hapus lamaran'; delArmed = false;
    $('#formErr').hidden = true;
    syncFormVis();
    dlg.showModal();
    $('#f-company').focus();
  }
  $('#addBtn').addEventListener('click', () => openForm(null));
  $('#cancelBtn').addEventListener('click', () => dlg.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    Object.keys(data).forEach((k) => (data[k] = data[k].trim()));
    if (!data.company || !data.position) { $('#formErr').hidden = false; return; }
    if (data.source !== 'Referral') data.referrer = '';
    if (BY_ID[data.status].group !== 'closed') data.lastStage = '';
    data.updatedAt = iso(today);
    const rec = editing ? { ...editing, ...data } : { id: uid(), ...data };
    const wasEdit = !!editing;
    dlg.close();
    putApp(rec).then((ok) => ok && toast(wasEdit ? 'Perubahan disimpan' : 'Lamaran ditambahkan'));
  });
  $('#delBtn').addEventListener('click', () => {
    if (!delArmed) { delArmed = true; $('#delBtn').textContent = 'Klik lagi untuk menghapus'; clearTimeout(delT); delT = setTimeout(() => { delArmed = false; $('#delBtn').textContent = 'Hapus lamaran'; }, 3000); return; }
    const id = editing.id;
    dlg.close();
    removeApp(id).then((ok) => ok && toast('Lamaran dihapus'));
  });

  // ---------- Ekspor / impor ----------
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const COLS = ['company', 'position', 'source', 'referrer', 'appliedDate', 'status', 'lastStage', 'nextStep', 'nextDate', 'workType', 'location', 'salary', 'contact', 'link', 'notes', 'updatedAt'];
  $('#exportCsv').addEventListener('click', () => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [COLS.join(','), ...apps.map((a) => COLS.map((c) => q(c === 'status' || c === 'lastStage' ? (BY_ID[a[c]]?.label || '') : a[c])).join(','))];
    download(`lamaran-kerja-${iso(today)}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
  });
  $('#exportJson').addEventListener('click', () => download(`lamaran-kerja-backup-${iso(today)}.json`, JSON.stringify(apps, null, 2), 'application/json'));
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      e.target.value = '';
      let data;
      try {
        data = JSON.parse(r.result);
        if (!Array.isArray(data) || !data.every((a) => a && a.company && a.status && BY_ID[a.status])) throw new Error();
      } catch (err) { return toast('File tidak bisa dibaca. Pilih file hasil "Backup JSON".'); }
      const list = data.map((a) => ({ ...a, id: /^[A-Za-z0-9_-]{1,60}$/.test(a.id || '') ? a.id : uid() }));
      if (SheetStore.configured()) {
        setStatus('saving', 'Mengimpor…');
        const res = await SheetStore.importApps(list, (n, all) => setStatus('saving', `Mengimpor ${n}/${all}…`));
        await reload();
        if (res.failed.length) { setStatus('error', 'Sebagian belum masuk'); return toast(`Belum masuk: ${res.failed.flatMap((f) => f.ids).join(', ')}. Impor lagi untuk mencoba sisanya.`); }
        setStatus('saved', 'Tersinkron');
        return toast(`${list.length} lamaran diimpor. Sheet berisi ${res.total ?? list.length} lamaran.`);
      }
      for (const a of list) await SheetStore.set(a);
      await reload();
      const n = list.length;
      toast(`${n} lamaran diimpor`);
    };
    r.readAsText(f);
  });

  // ---------- Tab ----------
  const TABS = ['ringkasan', 'lamaran'];
  function showTab(tab) {
    if (!TABS.includes(tab)) tab = 'ringkasan';
    document.querySelectorAll('nav.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
    try { history.replaceState(null, '', '#' + tab); } catch (e) {}
  }
  document.querySelector('nav.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });

  // ---------- Sambungan ke Google Sheets ----------
  const cdlg = $('#connect');
  function openConnect() {
    const c = SheetStore.config() || {};
    $('#c-url').value = c.url || ''; $('#c-key').value = c.key || '';
    $('#c-msg').textContent = SheetStore.configured() ? 'Tersambung. Ubah hanya kalau URL atau kunci berganti.' : '';
    $('#c-disconnect').hidden = !SheetStore.configured();
    cdlg.showModal();
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-connect]')) openConnect(); });
  $('#c-close').addEventListener('click', () => cdlg.close());
  $('#c-save').addEventListener('click', async () => {
    const msg = $('#c-msg'); msg.textContent = 'Mengetes sambungan…';
    try { const r = await SheetStore.connect($('#c-url').value, $('#c-key').value); msg.textContent = `Tersambung ke "${r.sheet}". Memuat ulang…`; setTimeout(() => location.reload(), 600); }
    catch (err) { msg.textContent = err.message === 'unauthorized' ? 'Kunci API salah. Salin lagi dari log Apps Script.' : 'Tidak bisa menghubungi Apps Script. Cek URL /exec dan akses "Anyone".'; }
  });
  $('#c-disconnect').addEventListener('click', () => { SheetStore.disconnect(); location.reload(); });
  SheetStore.on((state, d) => {
    if (state === 'synced') setStatus('saved', 'Tersinkron');
    if (state === 'pending') setStatus('error', `${d.count} belum terkirim`);
  });

  showTab((location.hash || '').slice(1));
  render();

  (async function boot() {
    try { const r = await SheetStore.load(); mode = r.source; apps = await SheetStore.all(); }
    catch (e) { setStatus('error', 'Data belum bisa dimuat. Muat ulang halaman.'); }
    loaded = true;
    $('#local-warn').hidden = mode !== 'local';
    $('#offline-warn').hidden = mode !== 'cache';
    if ($('#status').dataset.s !== 'error') setStatus('saved', mode === 'sheets' ? 'Tersinkron' : mode === 'cache' ? 'Offline' : 'Hanya di perangkat');
    render();
  })();
})();
