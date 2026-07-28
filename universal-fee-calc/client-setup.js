/* ============================================================
   SAVILLS SRM · CLIENT SETUP
   ------------------------------------------------------------
   One-time (re-runnable) admin tool that seeds the Client -> Work
   Order hierarchy:
     1 · Client roster — parses the "Summary" revenue-forecast
         workbook (Customer / Jan..Dec / Total / PM columns) into
         Client records (name + PM, via the Revenue Leaders directory).
     2 · Work orders — parses the "by customer-project" workbook
         (Customer Name / Job Name / monthly $ / Total) into Work
         Order (project) records under their client, carrying the
         monthly $ as source.importedByMonth (same convention as
         Import Revenues). Rows are matched to a Client by name.
     3 · Lump-sum clients — clients with no numbered jobs (seen in
         source data as e.g. a flat monthly total, no job breakdown)
         are hand-entered here (a name + monthly total) rather than
         auto-parsed — there's no automated ingestion for that shape
         in this repo, so it's a small manual form instead of a
         one-time parser.
     4 · Reconcile pipeline — live (non-imported) projects that
         predate this restructure and carry only the legacy free-text
         project.client string get a fuzzy-matched clientId suggestion
         (reusing Staffing's token-match engine), accept/change/skip.
     5 · Merge clients — collapses two client records that turned out
         to be the same company (e.g. two spellings) into one.
   Idempotent: importing the same workbook twice does not duplicate
   clients (name match) or work orders (client + name match).
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => '$' + Math.round(n || 0).toLocaleString();
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ---------- 1 · Summary workbook (client roster + PM) ---------- */
  let SUMMARY = null;   // [{ name, total, pm, year }]

  function parseSummaryWorkbook(aoa) {
    let headerRow = -1;
    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r];
      if (row && String(row[0] || '').trim() === 'Customer') { headerRow = r; break; }
    }
    if (headerRow < 0) throw new Error('Could not find the "Customer … PM" header row.');
    const header = aoa[headerRow];
    const totalIdx = header.findIndex(h => String(h || '').trim() === 'Total');
    const pmIdx = header.findIndex(h => String(h || '').trim() === 'PM');
    const rows = [];
    for (let r = headerRow + 1; r < aoa.length; r++) {
      const row = aoa[r]; if (!row) continue;
      const name = String(row[0] || '').trim();
      if (!name) continue;
      if (/^totals?$/i.test(name) || /^speculative/i.test(name)) break;   // stop before the Totals / Speculative sections
      const total = totalIdx >= 0 ? (parseFloat(row[totalIdx]) || 0) : 0;
      const pm = pmIdx >= 0 ? String(row[pmIdx] || '').trim() : '';
      if (!total && !pm) continue;   // a stray blank row inside the table
      rows.push({ name, total, pm });
    }
    return rows;
  }

  /* ---------- 2 · "by customer-project" workbook (work orders) ---------- */
  let JOBS = null;   // [{ client, job, monthly:{ 'YYYY-M': $ }, total }]
  let JOBS_YEAR = null;

  function detectYear(aoa) {
    for (let r = 0; r < Math.min(aoa.length, 6); r++) {
      const row = aoa[r] || [];
      for (const v of row) { if (typeof v === 'number' && v >= 2020 && v <= 2100) return v; }
    }
    return new Date().getFullYear();
  }

  function parseJobsWorkbook(aoa) {
    const year = detectYear(aoa);
    let headerRow = -1;
    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r];
      if (row && /customer/i.test(String(row[0] || '')) && /job/i.test(String(row[1] || ''))) { headerRow = r; break; }
    }
    if (headerRow < 0) throw new Error('Could not find the "Customer Name / Job Name" header row.');
    const header = aoa[headerRow];
    const monthCols = [];
    for (let c = 2; c < header.length; c++) {
      const h = String(header[c] || '').trim().toLowerCase();
      const mi = MONTHS.indexOf(h.slice(0, 3));
      if (mi >= 0) monthCols.push({ idx: c, month: mi + 1 });
    }
    const totalIdx = header.findIndex(h => String(h || '').trim() === 'Total');
    const rows = [];
    for (let r = headerRow + 1; r < aoa.length; r++) {
      const row = aoa[r]; if (!row) continue;
      const client = String(row[0] || '').trim();
      const job = row[1] == null ? '' : String(row[1]).trim();
      if (!client || !job) continue;   // blank Job Name = the sheet's own per-customer subtotal row — skip
      const monthly = {};
      monthCols.forEach(mc => { const v = parseFloat(row[mc.idx]); if (v) monthly[year + '-' + mc.month] = v; });
      const total = totalIdx >= 0 ? (parseFloat(row[totalIdx]) || 0) : Object.values(monthly).reduce((a, b) => a + b, 0);
      if (!total) continue;
      rows.push({ client, job, monthly, total });
    }
    return { rows, year };
  }

  function readWorkbook(file) {
    return file.arrayBuffer().then(buf => {
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false });
      const name = wb.SheetNames.find(n => /summary|customer.*project|by customer/i.test(n)) || wb.SheetNames[0];
      return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    });
  }

  function wire() {
    $('#summary-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const msg = $('#summary-msg');
      try {
        const aoa = await readWorkbook(f);
        SUMMARY = parseSummaryWorkbook(aoa);
        msg.innerHTML = `<div class="msg ok">Parsed ${SUMMARY.length} clients.</div>`;
        renderSummaryPreview();
      } catch (err) { msg.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; SUMMARY = null; }
      updateSeedButton();
    });

    $('#jobs-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const msg = $('#jobs-msg');
      try {
        const aoa = await readWorkbook(f);
        const parsed = parseJobsWorkbook(aoa);
        JOBS = parsed.rows; JOBS_YEAR = parsed.year;
        const clients = new Set(JOBS.map(j => j.client)).size;
        msg.innerHTML = `<div class="msg ok">Parsed ${JOBS.length} work orders across ${clients} clients (year ${JOBS_YEAR}).</div>`;
        renderJobsPreview();
      } catch (err) { msg.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; JOBS = null; }
      updateSeedButton();
    });

    function updateSeedButton() {
      const btn = $('#seed-commit');
      btn.disabled = !(SUMMARY || JOBS);
    }

    function renderSummaryPreview() {
      $('#summary-preview-card').hidden = false;
      const rows = SUMMARY.slice(0, 300).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.pm)}</td><td class="num">${fmt(r.total)}</td></tr>`).join('');
      $('#summary-preview').innerHTML = `<thead><tr><th>Client</th><th>PM</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody>`;
    }
    function renderJobsPreview() {
      $('#jobs-preview-card').hidden = false;
      const rows = JOBS.slice(0, 300).map(r => `<tr><td>${esc(r.client)}</td><td>${esc(r.job)}</td><td class="num">${Object.keys(r.monthly).length}</td><td class="num">${fmt(r.total)}</td></tr>`).join('');
      $('#jobs-preview').innerHTML = `<thead><tr><th>Client</th><th>Job</th><th class="num">Months</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody>`
        + (JOBS.length > 300 ? `<tfoot><tr><td colspan="4" class="note">…and ${JOBS.length - 300} more</td></tr></tfoot>` : '');
    }

    /* ---- Commit: clients first, then work orders, then default WOs for
       any client that ends up with none. Idempotent — safe to re-run. ---- */
    $('#seed-commit').addEventListener('click', () => {
      const log = [];
      let clientsCreated = 0, clientsMatched = 0, wosCreated = 0, wosSkipped = 0, defaultsCreated = 0;

      const clientFor = (name, pm) => {
        const existing = STORE.resolveClient(name);
        if (existing) { clientsMatched++; return existing; }
        let pmId = '';
        if (pm) { const leader = STORE.resolveLeader(pm) || STORE.addLeader(pm); pmId = leader ? leader.id : ''; }
        clientsCreated++;
        return STORE.saveClient({ name, pmId, pm: pmId ? STORE.leaderById(pmId).displayName : '' });
      };

      (SUMMARY || []).forEach(r => clientFor(r.name, r.pm));
      (JOBS || []).forEach(r => clientFor(r.client, ''));

      (JOBS || []).forEach(r => {
        const client = STORE.resolveClient(r.client);
        if (!client) { wosSkipped++; return; }
        const already = STORE.listProjects().some(p => p.project && p.project.clientId === client.id && p.project.name === r.job);
        if (already) { wosSkipped++; return; }
        STORE.saveProject({
          project: { name: r.job, client: client.name, clientId: client.id, status: 'active', lead: client.pm || '', leadId: client.pmId || '' },
          timeline: {}, phases: [], groups: [], roles: [],
          assumptions: { hrsPerMo: 173.33, escalation: 0, industryAdj: 0, discount: 0, rateLock: false, billingMode: 'phase', catalogBaseYear: JOBS_YEAR || 2024, feeBasis: 'fixed', nteCeiling: 0, feeShare: { enabled: false, pct: 0 } },
          source: { type: 'import', importedAt: new Date().toISOString(), importedByMonth: r.monthly, importedTotal: r.total, reconciled: false },
        });
        wosCreated++;
      });

      // Every client must have >=1 Work Order (lump-sum clients from the
      // Summary sheet with no numbered jobs get the auto "General" WO,
      // seeded with their Summary total as a single-month placeholder).
      STORE.listClients().forEach(c => {
        const summaryRow = (SUMMARY || []).find(r => STORE.resolveClient(r.name) && STORE.resolveClient(r.name).id === c.id);
        const created = STORE.ensureDefaultWorkOrder(c.id);
        if (created && summaryRow && summaryRow.total) {
          created.source = { type: 'import', importedAt: new Date().toISOString(), importedByMonth: { [(JOBS_YEAR || new Date().getFullYear()) + '-1']: summaryRow.total }, importedTotal: summaryRow.total, reconciled: false };
          STORE.saveProject(created);
        }
        if (created) defaultsCreated++;
      });

      log.push(`${clientsCreated} client(s) created, ${clientsMatched} already existed.`);
      log.push(`${wosCreated} work order(s) created, ${wosSkipped} already existed / skipped.`);
      if (defaultsCreated) log.push(`${defaultsCreated} default "General" work order(s) created for lump-sum clients.`);
      $('#seed-msg').innerHTML = `<div class="msg ok">${log.map(esc).join('<br>')}</div>`;
      $('#seed-commit').disabled = true;
      renderReconcile(); renderMergePickers();
    });
  }

  /* ---------- 3 · Manual lump-sum client entry ---------- */
  function wireManualClient() {
    $('#manual-add').addEventListener('click', () => {
      const name = $('#manual-name').value.trim();
      const pm = $('#manual-pm').value.trim();
      const total = parseFloat($('#manual-total').value) || 0;
      const msg = $('#manual-msg');
      if (!name) { msg.innerHTML = '<div class="msg err">Client name required.</div>'; return; }
      const pmLeader = pm ? (STORE.resolveLeader(pm) || STORE.addLeader(pm)) : null;
      const client = STORE.addClient(name, pmLeader ? pmLeader.id : '');
      const created = STORE.ensureDefaultWorkOrder(client.id);
      if (created && total) {
        created.source = { type: 'import', importedAt: new Date().toISOString(), importedByMonth: { [new Date().getFullYear() + '-' + (new Date().getMonth() + 1)]: total }, importedTotal: total, reconciled: false };
        STORE.saveProject(created);
      }
      msg.innerHTML = `<div class="msg ok">${esc(name)} added${created ? ' with a General work order' : ' (already had one)'}.</div>`;
      $('#manual-name').value = ''; $('#manual-pm').value = ''; $('#manual-total').value = '';
      renderReconcile(); renderMergePickers();
    });
  }

  /* ---------- 4 · Reconcile legacy pipeline projects (fuzzy match) ---------- */
  function renderReconcile() {
    const card = $('#reconcile-card');
    const staff = window.UFC_Staff;
    const clients = STORE.listClients();
    const unmatched = STORE.listProjects().filter(p => !STORE.isChangeOrder(p) && p.project && !p.project.clientId && p.project.client);
    card.hidden = unmatched.length === 0;
    if (!unmatched.length) return;
    const rows = unmatched.map(p => {
      let best = null, bestScore = 0;
      if (staff && staff.tokenScore) {
        clients.forEach(c => { const s = staff.tokenScore(p.project.client, c.name); if (s > bestScore) { bestScore = s; best = c; } });
      }
      const opts = ['<option value="">— skip —</option>']
        .concat(clients.map(c => `<option value="${c.id}" ${best && best.id === c.id ? 'selected' : ''}>${esc(c.name)}${best && best.id === c.id ? ' (suggested · ' + Math.round(bestScore * 100) + '%)' : ''}</option>`))
        .concat([`<option value="__add">＋ Create client "${esc(p.project.client)}"</option>`])
        .join('');
      return `<tr data-pid="${p.id}"><td>${esc(p.project.name)}</td><td>${esc(p.project.client)}</td><td><select class="rc-sel">${opts}</select></td></tr>`;
    }).join('');
    card.querySelector('#reconcile-table').innerHTML = `<thead><tr><th>Project</th><th>Legacy client string</th><th>Assign to</th></tr></thead><tbody>${rows}</tbody>`;
  }
  function wireReconcile() {
    $('#reconcile-apply').addEventListener('click', () => {
      let n = 0;
      document.querySelectorAll('#reconcile-table tr[data-pid]').forEach(tr => {
        const pid = tr.dataset.pid;
        const sel = tr.querySelector('.rc-sel');
        const v = sel.value; if (!v) return;
        const p = STORE.getProject(pid); if (!p) return;
        let client = null;
        if (v === '__add') client = STORE.addClient(p.project.client);
        else client = STORE.clientById(v);
        if (!client) return;
        p.project.clientId = client.id;
        p.project.client = client.name;
        STORE.saveProject(p);
        n++;
      });
      $('#reconcile-msg').innerHTML = `<div class="msg ok">${n} project(s) reconciled.</div>`;
      renderReconcile();
    });
  }

  /* ---------- 5 · Merge clients ---------- */
  function renderMergePickers() {
    const clients = STORE.listClients();
    const opts = '<option value="">— select —</option>' + clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('#merge-loser').innerHTML = opts;
    $('#merge-winner').innerHTML = opts;
  }
  function wireMerge() {
    $('#merge-go').addEventListener('click', () => {
      const loser = $('#merge-loser').value, winner = $('#merge-winner').value;
      const msg = $('#merge-msg');
      if (!loser || !winner) { msg.innerHTML = '<div class="msg err">Pick both a client to merge from and to.</div>'; return; }
      const res = STORE.mergeClientInto(loser, winner);
      if (!res || res.error) { msg.innerHTML = `<div class="msg err">${esc((res && res.error) || 'Merge failed.')}</div>`; return; }
      msg.innerHTML = `<div class="msg ok">Merged — ${res.movedCount} work order(s) moved to ${esc(res.winner.name)}.</div>`;
      renderMergePickers(); renderReconcile();
    });
  }

  /* ADMIN-ONLY gate. */
  function init() {
    const me = STORE.getCurrentUser();
    if (!STORE.isAdmin(me)) {
      document.querySelector('.wrap').innerHTML =
        '<h1>Client Setup</h1><div class="card"><h2>Admin only</h2><p class="note">This tool is restricted to administrators. You’re signed in as <strong>' +
        esc(me.name || 'unknown') + '</strong>.</p></div>';
      return;
    }
    wire();
    wireManualClient();
    wireReconcile();
    wireMerge();
    renderReconcile();
    renderMergePickers();
  }
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(init); else window.addEventListener('load', init);
})();
