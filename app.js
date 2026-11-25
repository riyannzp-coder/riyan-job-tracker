/* Riyan Job Search UI — renders the command center and the list, and talks to SheetStore (store.js).
   Data model, status logic, funnel/source calculations, CSV and backup formats are unchanged. */
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
  const WARN_DAYS = 8, STALE_DAYS = 15;     // days without update: 0–7 neutral, 8–14 follow up, 15+ stale
  // visual family of each status, so color is never the only signal (the pill always carries the label too)
  const TONE = { applied: 'early', contacted: 'early', screening: 'progress', test: 'progress', int_hr: 'interview', int_user: 'interview',
    final: 'interview', offer: 'offer', accepted: 'offer', rejected: 'rejected', ghosted: 'closed', withdrawn: 'closed' };

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // ---------- Util ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parse = (s) => { if (!s) return null; const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? null : d; };
  const diffDays = (s) => { const d = parse(s); return d ? Math.round((today - d) / 864e5) : null; };
  const fmtDate = (s) => { const d = parse(s); return d ? d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
  const fmtShort = (s) => { const d = parse(s); return d ? d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : '—'; };
  const pct = (a, b) => b ? Math.round((a / b) * 100) + '%' : '—';
  const reached = (a) => BY_ID[a.status]?.group === 'closed' ? (ORDER[a.lastStage] ?? 0) : (ORDER[a.status] ?? 0);
  const groupOf = (a) => BY_ID[a.status]?.group || 'active';
  const sinceUpdate = (a) => diffDays(a.updatedAt || a.appliedDate);
  const isOpen = (a) => groupOf(a) !== 'closed' && a.status !== 'accepted';
  const pill = (status) => `<span class="pill st-${TONE[status] || 'early'}">${esc(BY_ID[status]?.label || status || '—')}</span>`;
  const ageCls = (n) => n === null ? '' : n >= STALE_DAYS ? 'hot-age' : n >= WARN_DAYS ? 'warn-age' : '';
  const ageTxt = (n) => n === null ? '' : n === 0 ? 'diupdate hari ini' : `${n} hari sejak update`;
  const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800); }

  $('#todayLbl').textContent = today.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ---------- Penyimpanan: Google Sheets lewat store.js (cache di browser ini) ----------
  let apps = [];
  let loaded = false;
  let mode = 'local';
  let pending = 0;
  const SYNC_TXT = { sheets: 'Tersinkron', cache: 'Offline', local: 'Hanya di perangkat' };
  function setStatus(s, msg) {
    const el = $('#status');
    el.dataset.s = s === 'saved' && mode === 'local' ? 'local' : s;
    $('#status-t').textContent = msg || (s === 'saving' ? 'Menyimpan…' : s === 'error' ? 'Sinkron tertunda' : SYNC_TXT[mode]);
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
    if (failed) setStatus('error', `${SheetStore.pending()} menunggu sinkron`);
    else if (!pending) setStatus('saved');
    return true;
  }
  const putApp = (a) => write(() => SheetStore.set(a));
  const removeApp = (id) => write(() => SheetStore.remove(id));

  // status change from the table, the cards or the board: same rule as before for "Berhenti di tahap"
  function changeStatus(id, status) {
    const cur = apps.find((x) => x.id === id);
    if (!cur || cur.status === status || !BY_ID[status]) return;
    const a = { ...cur, status, updatedAt: iso(today) };
    const prev = cur.status;
    if (BY_ID[a.status].group === 'closed' && !a.lastStage) a.lastStage = BY_ID[prev].group === 'closed' ? 'applied' : (prev === 'offer' || prev === 'accepted' ? 'final' : prev);
    putApp(a).then((ok) => ok && toast(`${a.company}: status jadi ${BY_ID[a.status].label}`));
  }

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
    const acts = actionItems();
    renderHealth(acts); renderActions(acts); renderFunnel(); renderSources(); renderTrend(); renderPipeline(); renderList();
  }

  // ----- what needs attention: built only from nextStep/nextDate and the last update date -----
  function actionItems() {
    const items = [];
    apps.filter(isOpen).forEach((a) => {
      const nd = parse(a.nextDate);
      const since = sinceUpdate(a);
      if (nd) {
        const inDays = Math.round((nd - today) / 864e5);
        if (inDays < 0) return items.push({ a, g: 'overdue', key: inDays, urg: `Terlambat ${-inDays} hari`, what: a.nextStep || 'Langkah berikutnya', date: a.nextDate });
        if (inDays === 0) return items.push({ a, g: 'today', key: 0, urg: 'Hari ini', what: a.nextStep || 'Langkah berikutnya', date: a.nextDate });
        if (inDays <= 7) return items.push({ a, g: 'soon', key: inDays, urg: inDays === 1 ? 'Besok' : `${inDays} hari lagi`, what: a.nextStep || 'Langkah berikutnya', date: a.nextDate });
        return;                                       // scheduled further out: nothing to do yet
      }
      if (since === null || groupOf(a) !== 'active') return;
      if (since >= STALE_DAYS) items.push({ a, g: 'stale', key: -since, urg: `Tidak ada update ${since} hari`, what: isStart(a) ? 'Follow up, atau tandai "Tidak ada kabar"' : 'Tanyakan update proses', date: a.updatedAt || a.appliedDate });
      else if (since >= WARN_DAYS) items.push({ a, g: 'followup', key: -since, urg: `${since} hari sejak update`, what: isStart(a) ? 'Follow up ke recruiter' : 'Tanyakan update proses', date: a.updatedAt || a.appliedDate });
    });
    return items;
  }

  function renderHealth(acts) {
    const n = apps.length;
    const active = apps.filter((a) => groupOf(a) === 'active');
    const responded = apps.filter((a) => reached(a) >= 1);
    const interviewed = apps.filter((a) => reached(a) >= INTERVIEW_IDX);
    const offers = apps.filter((a) => reached(a) >= ORDER.offer);
    const last30 = apps.filter((a) => { const d = diffDays(a.appliedDate); return d !== null && d <= 30; }).length;
    const acc = apps.filter((a) => a.status === 'accepted').length;
    $('#h-total').textContent = n; $('#h-active').textContent = active.length; $('#h-resp').textContent = pct(responded.length, n);
    $('#k-total').textContent = n; $('#k-total-m').textContent = `${last30} dalam 30 hari`;
    $('#k-active').textContent = active.length; $('#k-active-m').textContent = `${active.filter(isStart).length} menunggu respon`;
    $('#k-resp').textContent = pct(responded.length, n);
    $('#k-int').textContent = interviewed.length; $('#k-int-m').textContent = `${pct(interviewed.length, n)} dari semua`;
    $('#k-offer').textContent = offers.length; $('#k-offer-m').textContent = acc ? `${acc} diterima` : `${pct(offers.length, interviewed.length)} dari interview`;

    // one interpretation, picked from what the data actually shows
    const urgent = acts.filter((x) => x.g === 'overdue' || x.g === 'today').length;
    const follow = acts.filter((x) => x.g === 'followup' || x.g === 'stale').length;
    const wk = weekCounts(2);
    let t;
    if (!loaded) t = 'Memuat data lamaran…';
    else if (!n) t = 'Belum ada lamaran tercatat. Mulai dengan menambah lamaran pertama.';
    else if (urgent) t = `${urgent} jadwal lewat atau jatuh hari ini. Itu prioritas Anda sekarang.`;
    else if (follow) t = `Pipeline berjalan, tapi ${follow} lamaran perlu follow up. Itu prioritas Anda sekarang.`;
    else if (!active.length && !offers.length) t = 'Tidak ada proses yang sedang berjalan. Saatnya menambah lamaran baru.';
    else if (wk[1] === 0 && wk[0] === 0) t = 'Belum ada lamaran baru dalam 2 minggu terakhir. Jaga ritme agar pipeline tetap terisi.';
    else t = `Pipeline aktif dan semua lamaran sudah terpantau. ${interviewed.length} sudah sampai interview.`;
    $('#takeaway').textContent = t;
  }

  const GROUPS = [
    ['overdue', 'Terlambat'], ['today', 'Hari ini'], ['soon', '7 hari ke depan'], ['followup', 'Follow up'], ['stale', 'Tanpa kabar 15+ hari'],
  ];
  let rescheduling = null;
  function renderActions(acts) {
    const badge = $('#actionsCount');
    badge.hidden = !acts.length;
    badge.textContent = `${acts.length} item`;
    badge.classList.toggle('hot', acts.some((x) => x.g === 'overdue' || x.g === 'stale'));
    if (!loaded) { $('#actions').innerHTML = '<p class="empty">Memuat…</p>'; return; }
    if (!acts.length) {
      $('#actions').innerHTML = `<div class="all-clear"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>${apps.length ? 'Tidak ada jadwal atau follow-up yang mendesak.' : 'Belum ada lamaran. Tambahkan lamaran pertama Anda.'}</div>`;
      return;
    }
    $('#actions').innerHTML = GROUPS.map(([g, title]) => {
      const list = acts.filter((x) => x.g === g).sort((x, y) => x.key - y.key);
      if (!list.length) return '';
      return `<div class="agroup" data-g="${g}"><h3>${title}<span class="n">${list.length}</span></h3><ul class="alist">${list.map((x) => {
        const scheduled = g === 'overdue' || g === 'today' || g === 'soon';
        const resch = rescheduling === x.a.id
          ? `<span class="resched"><label class="sr" for="rs-${esc(x.a.id)}">Tanggal baru</label><input type="date" id="rs-${esc(x.a.id)}" data-resched-date="${esc(x.a.id)}" value="${esc(x.a.nextDate || iso(today))}"><button type="button" class="btn sm primary" data-resched-save="${esc(x.a.id)}">Simpan</button></span>`
          : `<button type="button" class="btn sm" data-resched="${esc(x.a.id)}">Jadwal ulang</button>`;
        return `<li class="aitem" data-g="${g}">
          <span class="bar" aria-hidden="true"></span>
          <div class="body">
            <div class="t1"><b>${esc(x.a.company)}</b>${pill(x.a.status)}</div>
            <div class="t2">${esc(x.a.position)}</div>
            <div class="t3"><span class="urg">${esc(x.urg)}</span><span>${esc(x.what)}</span>${scheduled && x.date ? `<span class="age">${fmtShort(x.date)}</span>` : ''}</div>
          </div>
          <div class="acts">
            <button type="button" class="btn sm" data-edit="${esc(x.a.id)}">Buka</button>
            ${scheduled
              ? `<button type="button" class="btn sm" data-done="${esc(x.a.id)}">Tandai selesai</button>${resch}`
              : `<button type="button" class="btn sm" data-touched="${esc(x.a.id)}">Sudah follow up</button>${resch}`}
          </div>
        </li>`;
      }).join('')}</ul></div>`;
    }).join('');
  }

  function renderFunnel() {
    const n = apps.length;
    const counts = FUNNEL.map((s, i) => apps.filter((a) => reached(a) >= i).length);
    $('#funnel').innerHTML = FUNNEL.map((s, i) => {
      const c = counts[i];
      const conv = i === 0 ? 'dari total' : `${pct(c, counts[i - 1])}`;
      const cls = [i >= INTERVIEW_IDX ? 'int' : '', c === 0 ? 'zero' : ''].join(' ');
      return `<li class="frow ${cls}"><span class="lbl" title="${esc(s.label)}">${esc(s.label)}</span><div class="track" aria-hidden="true"><div class="fill" style="width:${n ? (c / n) * 100 : 0}%"></div></div><span class="num">${c}<small>${conv}</small></span></li>`;
    }).join('') + `<li class="funnel-note">Persentase = konversi dari tahap sebelumnya. Hijau = sudah sampai interview.</li>`;
  }

  function renderSources() {
    const stats = SOURCES.map((s) => {
      const r = apps.filter((a) => a.source === s);
      return { s, n: r.length, i: r.filter((a) => reached(a) >= INTERVIEW_IDX).length };
    }).filter((x) => x.n || x.s !== 'Lainnya');
    const max = Math.max(1, ...stats.map((x) => x.n));
    // flags only when there is enough data: at least 2 applications per compared source
    const enough = stats.filter((x) => x.n >= 2);
    const best = enough.filter((x) => x.i > 0).sort((a, b) => b.i / b.n - a.i / a.n || b.n - a.n)[0];
    const low = best && enough.filter((x) => x !== best && x.n >= 3 && x.i / x.n < best.i / best.n).sort((a, b) => a.i / a.n - b.i / b.n || b.n - a.n)[0];
    $('#srcFlags').innerHTML = best
      ? `<span class="flag best">Sumber terbaik <b>${esc(best.s)}</b> · ${pct(best.i, best.n)} sampai interview</span>${low ? `<span class="flag low">Konversi rendah <b>${esc(low.s)}</b> · ${pct(low.i, low.n)}</span>` : ''}`
      : `<span class="flag info">Data belum cukup untuk menyimpulkan sumber terbaik.</span>`;
    $('#sources').innerHTML = stats.map((x) => `
      <div class="src${best && x === best ? ' is-best' : ''}">
        <span class="name">${esc(x.s)}</span>
        <span class="rate">${x.n ? pct(x.i, x.n) : '—'}</span>
        <span class="meta"><span>${x.n} lamaran · ${x.i} interview</span><span class="meter" aria-hidden="true"><i class="m-int" style="width:${(x.i / max) * 100}%"></i><i class="m-all" style="width:${((x.n - x.i) / max) * 100}%"></i></span></span>
      </div>`).join('');
  }

  // applications per week (Monday start), counted by tanggal apply / dihubungi
  function weekStart(d) { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function weekCounts(weeks) {
    const start0 = weekStart(today);
    return Array.from({ length: weeks }, (_, k) => {
      const s = new Date(start0); s.setDate(s.getDate() - 7 * (weeks - 1 - k));
      const e = new Date(s); e.setDate(e.getDate() + 7);
      return apps.filter((a) => { const d = parse(a.appliedDate); return d && d >= s && d < e; }).length;
    });
  }
  function renderTrend() {
    const W = 8, counts = weekCounts(W);
    const start0 = weekStart(today);
    const labels = counts.map((_, k) => { const s = new Date(start0); s.setDate(s.getDate() - 7 * (W - 1 - k)); return s.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }); });
    const total = counts.reduce((x, y) => x + y, 0);
    const avg = total / W;
    const max = Math.max(1, ...counts, Math.ceil(avg));
    const w = 560, h = 190, padL = 8, padR = 8, padT = 22, padB = 30, bw = (w - padL - padR) / W;
    const y = (v) => padT + (h - padT - padB) * (1 - v / max);
    const bars = counts.map((c, k) => {
      const x = padL + k * bw + bw * 0.18, bwid = bw * 0.64, top = c ? y(c) : h - padB - 3;
      return `<rect class="bar-rect${k === W - 1 ? ' now' : ''}${c ? '' : ' zero'}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bwid.toFixed(1)}" height="${(h - padB - top).toFixed(1)}" rx="4"><title>${labels[k]}: ${c} lamaran</title></rect>
        <text class="val" x="${(x + bwid / 2).toFixed(1)}" y="${(top - 6).toFixed(1)}" text-anchor="middle">${c}</text>
        <text x="${(x + bwid / 2).toFixed(1)}" y="${h - 10}" text-anchor="middle">${k === W - 1 ? 'Minggu ini' : labels[k]}</text>`;
    }).join('');
    const ay = y(avg);
    $('#trend').innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Lamaran per minggu, 8 minggu terakhir: ${counts.join(', ')}">
      <line class="grid-line" x1="${padL}" x2="${w - padR}" y1="${h - padB}" y2="${h - padB}"/>
      ${bars}
      ${total ? `<line class="avg-line" x1="${padL}" x2="${w - padR}" y1="${ay.toFixed(1)}" y2="${ay.toFixed(1)}"/><text class="avg-lbl" x="${w - padR}" y="${(ay - 6).toFixed(1)}" text-anchor="end">rata-rata ${avg.toFixed(1)}/minggu</text>` : ''}
    </svg>`;
    const thisWeek = counts[W - 1];
    $('#trendNote').textContent = total
      ? `${total} lamaran dalam 8 minggu terakhir, rata-rata ${avg.toFixed(1)} per minggu. Minggu ini: ${thisWeek}.`
      : 'Belum ada lamaran dalam 8 minggu terakhir.';
  }

  function renderPipeline() {
    const rows = apps.filter(isOpen).sort((x, y) => reached(y) - reached(x) || (sinceUpdate(y) ?? 0) - (sinceUpdate(x) ?? 0));
    $('#pipeline').innerHTML = rows.length ? rows.map((a) => {
      const since = sinceUpdate(a);
      return `<li class="prow">
        <div class="who"><b>${esc(a.company)}</b><span>${esc(a.position)}</span></div>
        <div class="right">${pill(a.status)}<button type="button" class="btn sm ghost" data-edit="${esc(a.id)}" aria-label="Lihat ${esc(a.company)}">Lihat</button></div>
        <div class="next"><span>Apply ${fmtShort(a.appliedDate)}</span><span class="age ${ageCls(since)}">${ageTxt(since)}</span>${a.nextStep || a.nextDate ? `<span>Berikutnya: <b>${esc(a.nextStep || '—')}</b>${a.nextDate ? ` · ${fmtShort(a.nextDate)}` : ''}</span>` : ''}</div>
      </li>`;
    }).join('') : `<li class="empty">${loaded ? 'Tidak ada lamaran yang sedang berjalan.' : 'Memuat…'}</li>`;
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
    const val = (a) => k === 'status' ? (ALL.findIndex((s) => s.id === a.status)) : (String(a[k] || '').toLowerCase() || (k.endsWith('Date') ? (sort.dir > 0 ? '9999' : '0000') : ''));
    return rows.slice().sort((x, y) => { const a = val(x), b = val(y); return (a > b ? 1 : a < b ? -1 : 0) * sort.dir; });
  }

  const emptyMsg = () => !loaded ? 'Memuat…' : apps.length ? 'Tidak ada lamaran yang cocok dengan pencarian atau filter.' : 'Belum ada lamaran. Ketuk "Tambah lamaran" untuk mencatat yang pertama.';

  function renderList() {
    const rows = sortRows(filtered());
    $('#countNote').textContent = rows.length === apps.length ? `${apps.length} lamaran` : `${rows.length} dari ${apps.length} lamaran ditampilkan`;
    document.querySelectorAll('th button[data-sort]').forEach((b) => {
      const th = b.parentElement;
      if (b.dataset.sort === sort.key) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
      b.textContent = b.textContent.replace(/ [↑↓]$/, '') + (b.dataset.sort === sort.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : '');
    });

    const statusSel = (a) => `<select class="st-${TONE[a.status] || 'early'}" data-status="${esc(a.id)}" aria-label="Status ${esc(a.company)}">${stageOptions}</select>`;
    $('#tbody').innerHTML = rows.length ? rows.map((a) => {
      const since = sinceUpdate(a);
      const nd = parse(a.nextDate);
      const late = nd && nd < today && isOpen(a);
      const extra = [a.workType, a.location].filter(Boolean).join(' · ');
      return `<tr data-id="${esc(a.id)}">
        <td><div class="co">${esc(a.company)}</div><div class="pos">${esc(a.position)}</div>${extra ? `<div class="sub">${esc(extra)}</div>` : ''}</td>
        <td>${statusSel(a)}<div class="sub age ${isOpen(a) ? ageCls(since) : ''}">${groupOf(a) === 'closed' && a.lastStage ? `di tahap ${esc(BY_ID[a.lastStage]?.label || '')}` : ageTxt(since)}</div></td>
        <td><span class="chip">${esc(a.source || '—')}</span>${a.referrer ? `<div class="sub">via ${esc(a.referrer)}</div>` : ''}</td>
        <td>${fmtDate(a.appliedDate)}</td>
        <td>${a.nextStep ? esc(a.nextStep) : '<span class="sub">—</span>'}</td>
        <td>${a.nextDate ? `<span class="${late ? 'age hot-age' : ''}">${fmtDate(a.nextDate)}${late ? ' · lewat' : ''}</span>` : '<span class="sub">—</span>'}</td>
        <td class="rowact"><button type="button" class="btn sm ghost" data-edit="${esc(a.id)}">Detail</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="7" class="empty">${emptyMsg()}</td></tr>`;

    // phones: one card per application instead of the wide table
    $('#cardView').innerHTML = rows.length ? rows.map((a) => {
      const since = sinceUpdate(a);
      const next = a.nextStep || a.nextDate ? `<span class="acard-next">Berikutnya: ${esc(a.nextStep || '—')}${a.nextDate ? ` · ${fmtShort(a.nextDate)}` : ''}</span>` : '';
      return `<article class="acard">
        <button type="button" class="acard-main" data-edit="${esc(a.id)}">
          <span class="acard-top"><b>${esc(a.company)}</b><span class="age ${isOpen(a) ? ageCls(since) : ''}">${since !== null ? since + ' hr' : ''}</span></span>
          <span class="pos">${esc(a.position)}</span>
          <span class="acard-meta"><span class="chip">${esc(a.source || '—')}</span><span class="age">Apply ${fmtShort(a.appliedDate)}</span></span>
          ${next}
        </button>
        ${statusSel(a)}
      </article>`;
    }).join('') : `<p class="empty">${emptyMsg()}</p>`;
    rows.forEach((a) => document.querySelectorAll(`select[data-status="${CSS.escape(a.id)}"]`).forEach((s) => { s.value = a.status; }));

    const cols = [...STAGES.map((s) => ({ key: s.id, label: s.label, test: (a) => a.status === s.id })), { key: 'closed', label: 'Ditutup', test: (a) => groupOf(a) === 'closed' }];
    const dotColor = { early: 'var(--muted)', progress: 'var(--brand)', interview: 'var(--success)', offer: 'var(--success)', closed: 'var(--danger)' };
    $('#boardView').innerHTML = cols.map((c) => {
      const items = rows.filter(c.test);
      return `<div class="col" data-col="${c.key}"><div class="col-head"><span><i class="dotc" style="background:${dotColor[TONE[c.key] || 'closed']}"></i>${esc(c.label)}</span><span class="n">${items.length}</span></div>${items.map((a) => {
        const since = sinceUpdate(a);
        return `<button type="button" class="kcard" draggable="true" data-id="${esc(a.id)}" data-edit="${esc(a.id)}"><b>${esc(a.company)}</b><span class="pos">${esc(a.position)}</span>
          ${a.nextStep ? `<span class="knext">${esc(a.nextStep)}${a.nextDate ? ` · ${fmtShort(a.nextDate)}` : ''}</span>` : ''}
          <span class="row">${c.key === 'closed' ? pill(a.status) : `<span class="chip">${esc(a.source || '—')}</span>`}<span class="age ${isOpen(a) ? ageCls(since) : ''}">${since !== null ? since + ' hari' : ''}</span></span></button>`;
      }).join('')}</div>`;
    }).join('');
  }

  // ---------- Interaksi ----------
  ['#q', '#fStatus', '#fSource'].forEach((s) => $(s).addEventListener('input', renderList));
  document.querySelectorAll('th button[data-sort]').forEach((b) => b.addEventListener('click', () => {
    sort = sort.key === b.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: b.dataset.sort, dir: ['company', 'source', 'nextStep'].includes(b.dataset.sort) ? 1 : -1 };
    renderList();
  }));
  function setView(v) {
    view = v === 'board' ? 'board' : 'table';
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === view)));
    $('#tableView').hidden = view !== 'table';
    $('#boardView').hidden = view !== 'board';
  }
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    setView(b.dataset.view);
    try { localStorage.setItem(KEY + '.view', view); } catch (e) {}
  }));
  try { setView(localStorage.getItem(KEY + '.view')); } catch (e) {}

  document.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed && !dragJustEnded) return openForm(ed.dataset.edit);
    const done = e.target.closest('[data-done]');
    if (done) {
      const cur = apps.find((x) => x.id === done.dataset.done); if (!cur) return;
      putApp({ ...cur, nextStep: '', nextDate: '', updatedAt: iso(today) }).then(() => toast(`${cur.company}: "${cur.nextStep || 'langkah'}" ditandai selesai. Perbarui statusnya kalau ada perubahan.`));
      return;
    }
    const touched = e.target.closest('[data-touched]');
    if (touched) {
      const cur = apps.find((x) => x.id === touched.dataset.touched); if (!cur) return;
      putApp({ ...cur, updatedAt: iso(today) }).then(() => toast(`${cur.company}: follow up dicatat hari ini.`));
      return;
    }
    const rs = e.target.closest('[data-resched]');
    if (rs) { rescheduling = rs.dataset.resched; renderActions(actionItems()); const inp = document.querySelector(`[data-resched-date="${CSS.escape(rescheduling)}"]`); inp && inp.focus(); return; }
    const rss = e.target.closest('[data-resched-save]');
    if (rss) {
      const id = rss.dataset.reschedSave, cur = apps.find((x) => x.id === id);
      const val = document.querySelector(`[data-resched-date="${CSS.escape(id)}"]`)?.value;
      if (!cur || !val) return;
      rescheduling = null;
      putApp({ ...cur, nextDate: val, updatedAt: iso(today) }).then(() => toast(`${cur.company}: dijadwalkan ulang ke ${fmtDate(val)}.`));
    }
  });
  document.addEventListener('change', (e) => {
    const s = e.target.closest('select[data-status]');
    if (s) changeStatus(s.dataset.status, s.value);
  });

  // board: drag a card onto another column to change its status (desktop; on phones a tap opens the detail)
  let dragId = null, dragJustEnded = false;
  const board = $('#boardView');
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kcard'); if (!card) return;
    dragId = card.dataset.id; card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId);
  });
  board.addEventListener('dragend', (e) => {
    e.target.closest('.kcard')?.classList.remove('dragging');
    board.querySelectorAll('.drop-ok').forEach((c) => c.classList.remove('drop-ok'));
    dragId = null; dragJustEnded = true; setTimeout(() => (dragJustEnded = false), 50);
  });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.col'); if (!col || !dragId) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    board.querySelectorAll('.drop-ok').forEach((c) => c !== col && c.classList.remove('drop-ok'));
    col.classList.add('drop-ok');
  });
  board.addEventListener('dragleave', (e) => { const col = e.target.closest('.col'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop-ok'); });
  board.addEventListener('drop', (e) => {
    const col = e.target.closest('.col'); if (!col || !dragId) return;
    e.preventDefault();
    const id = dragId, key = col.dataset.col;
    const cur = apps.find((x) => x.id === id);
    if (!cur) return;
    if (key === 'closed') { if (groupOf(cur) !== 'closed') changeStatus(id, 'rejected'); }
    else changeStatus(id, key);
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

  // timeline: only events this application's fields actually record
  function timelineFor(a) {
    const ev = [];
    if (a.appliedDate) ev.push({ cls: 't-done', t: a.status === 'contacted' ? 'Dihubungi recruiter' : 'Melamar', s: `${fmtDate(a.appliedDate)}${a.source ? ' · ' + a.source : ''}` });
    const g = groupOf(a);
    if (g === 'closed') {
      if (a.lastStage && a.lastStage !== 'applied' && a.lastStage !== 'contacted') ev.push({ cls: 't-done', t: `Sampai ${BY_ID[a.lastStage]?.label || a.lastStage}`, s: '' });
      ev.push({ cls: 't-end', t: BY_ID[a.status].label, s: a.updatedAt ? fmtDate(a.updatedAt) : '' });
    } else if (!isStart(a)) {
      ev.push({ cls: g === 'win' ? 't-win' : 't-done', t: BY_ID[a.status].label, s: a.updatedAt ? `update ${fmtDate(a.updatedAt)}` : '' });
    }
    if (a.nextStep || a.nextDate) ev.push({ cls: 't-next', t: a.nextStep || 'Langkah berikutnya', s: a.nextDate ? fmtDate(a.nextDate) : '' });
    return ev;
  }

  function openForm(id) {
    editing = id ? apps.find((a) => a.id === id) : null;
    form.reset();
    const a = editing || { source: 'LinkedIn', status: 'applied', appliedDate: iso(today) };
    [...form.elements].forEach((el) => { if (el.name) el.value = a[el.name] ?? (el.name === 'lastStage' ? 'applied' : ''); });
    $('#dlgTitle').textContent = editing ? editing.company : 'Tambah lamaran';
    const tl = editing ? timelineFor(editing) : [];
    $('#timeline').hidden = !tl.length;
    $('#timeline').innerHTML = tl.map((x) => `<li class="${x.cls}"><b>${esc(x.t)}</b>${x.s ? `<span>${esc(x.s)}</span>` : ''}</li>`).join('');
    $('#moreFields').open = !!(editing && (editing.contact || editing.link || editing.notes));
    $('#delBtn').hidden = !editing; $('#delBtn').textContent = 'Hapus'; $('#delBtn').classList.remove('armed'); delArmed = false;
    $('#formErr').hidden = true;
    ['#f-company', '#f-position'].forEach((s) => $(s).removeAttribute('aria-invalid'));
    syncFormVis();
    dlg.showModal();
    if (!matchMedia('(pointer: coarse)').matches) $('#f-company').focus();   // no surprise keyboard on phones
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-add]')) openForm(null); });
  $('#cancelBtn').addEventListener('click', () => dlg.close());
  $('#dlgX').addEventListener('click', () => dlg.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    Object.keys(data).forEach((k) => (data[k] = String(data[k]).trim()));
    if (!data.company || !data.position) {
      $('#formErr').hidden = false;
      ['company', 'position'].forEach((k) => $('#f-' + k).setAttribute('aria-invalid', String(!data[k])));
      $(!data.company ? '#f-company' : '#f-position').focus();
      return;
    }
    if (data.source !== 'Referral') data.referrer = '';
    if (BY_ID[data.status].group !== 'closed') data.lastStage = '';
    data.updatedAt = iso(today);
    const rec = editing ? { ...editing, ...data } : { id: uid(), ...data };
    const wasEdit = !!editing;
    dlg.close();
    putApp(rec).then((ok) => ok && toast(wasEdit ? 'Perubahan disimpan' : 'Lamaran ditambahkan'));
  });
  $('#delBtn').addEventListener('click', () => {
    const b = $('#delBtn');
    if (!delArmed) { delArmed = true; b.textContent = 'Ketuk lagi untuk hapus'; b.classList.add('armed'); clearTimeout(delT); delT = setTimeout(() => { delArmed = false; b.textContent = 'Hapus'; b.classList.remove('armed'); }, 3000); return; }
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
    toast('CSV diunduh');
  });
  $('#exportJson').addEventListener('click', () => { download(`lamaran-kerja-backup-${iso(today)}.json`, JSON.stringify(apps, null, 2), 'application/json'); toast('Backup JSON diunduh'); });
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
        setStatus('saved');
        return toast(`${list.length} lamaran diimpor. Sheet berisi ${res.total ?? list.length} lamaran.`);
      }
      for (const a of list) await SheetStore.set(a);
      await reload();
      toast(`${list.length} lamaran diimpor`);
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
  document.querySelector('nav.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { showTab(b.dataset.tab); window.scrollTo({ top: 0 }); } });

  // ---------- Menu "Lainnya" ----------
  const more = $('#more');
  document.addEventListener('click', (e) => { if (e.target.closest('[data-more]')) more.showModal(); });
  $('#m-close').addEventListener('click', () => more.close());
  more.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) { if (e.target === more) more.close(); return; }
    more.close();
    if (b.dataset.act === 'connect') openConnect(); else $('#' + b.dataset.act).click();
  });
  // a tap on the dimmed backdrop closes any sheet
  [dlg].forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

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
    if (state === 'pending') setStatus('error', `${d.count} menunggu sinkron`);
  });

  showTab((location.hash || '').slice(1));
  render();

  (async function boot() {
    try { const r = await SheetStore.load(); mode = r.source; apps = await SheetStore.all(); }
    catch (e) { setStatus('error', 'Data belum bisa dimuat. Muat ulang halaman.'); }
    loaded = true;
    $('#local-warn').hidden = mode !== 'local';
    $('#offline-warn').hidden = mode !== 'cache';
    if ($('#status').dataset.s !== 'error') setStatus(SheetStore.pending() ? 'error' : 'saved', SheetStore.pending() ? `${SheetStore.pending()} menunggu sinkron` : undefined);
    render();
  })();
})();
