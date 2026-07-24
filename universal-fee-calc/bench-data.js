/* ============================================================
   SAVILLS SRM · BENCHMARKING · data layer
   Reads project records from the store and derives per-role
   rate facts consistent with the calculator:
     • quoted rate   — start-year rate, before client discount
     • effective rate— quoted × (1 − client discount)   ← what client paid
     • cost floor     — tier's Col E / Col G floor (constant)
     • below floor    — effective < floor (potentially unprofitable)
   Plus a realistic sample dataset so the dashboard has data to show.
   ============================================================ */
(function () {
  'use strict';
  const CATALOG = window.RATES_CATALOG;
  const STORE = window.UFC_Store;

  /* ---------- Rate math (mirrors app.js) ---------- */
  function tierOf(role) {
    const title = CATALOG.titles.find(t => t.id === role.titleId);
    if (!title) return { title: null, tier: null };
    const tier = title.tiers.find(x => x.id === role.tierId) || title.tiers.find(x => x.id === 'mid') || title.tiers[0];
    return { title, tier };
  }
  function roleBase(role, p) {
    if (role.rateSource === 'contracted') {
      const cr = parseFloat(role.contractedRate);
      return { base: isNaN(cr) ? 0 : cr, anchor: p.timeline.startYear };
    }
    const { tier } = tierOf(role);
    if (!tier || tier.isNoCharge) return { base: 0, anchor: p.assumptions.catalogBaseYear || CATALOG.baseYear };
    const adj = (p.assumptions.industryAdj || 0) / 100;
    return { base: tier.rate * (1 - adj), anchor: p.assumptions.catalogBaseYear || CATALOG.baseYear };
  }
  function rateAtYear(role, p, year) {
    const { base, anchor } = roleBase(role, p);
    if (!base) return 0;
    const esc = (p.assumptions.escalation || 0) / 100;
    if (p.assumptions.rateLock) return base * Math.pow(1 + esc, (p.timeline.startYear) - anchor);
    return base * Math.pow(1 + esc, year - anchor);
  }
  function roleFteMonths(role, p) {
    const months = STORE.computeMonthsByPhase(p);
    return (p.phases || []).reduce((s, ph) => s + (months[ph.id] || []).reduce((a, m) => {
      const mk = m.year + '-' + m.month;
      return a + ((role.fteMonthly && role.fteMonthly[mk] != null ? role.fteMonthly[mk] : (role.fte?.[ph.id] || 0)) / 100);
    }, 0), 0);
  }
  function roleFee(role, p) {
    const hrs = p.assumptions.hrsPerMo || 173.33;
    const months = STORE.computeMonthsByPhase(p);
    let fee = 0;
    (p.phases || []).forEach(ph => {
      (months[ph.id] || []).forEach(m => {
        const mk = m.year + '-' + m.month;
        const fte = (role.fteMonthly && role.fteMonthly[mk] != null ? role.fteMonthly[mk] : (role.fte?.[ph.id] || 0)) / 100;
        if (!fte) return;
        fee += fte * rateAtYear(role, p, m.year) * hrs;
      });
    });
    return fee;
  }

  /* ---------- Per-role facts across all projects ---------- */
  function roleFacts(projects) {
    const out = [];
    (projects || []).forEach(p => {
      const discPct = (p.assumptions?.discount || 0) / 100;
      const startYear = p.timeline?.startYear;
      const groupName = (gid) => (p.groups || []).find(g => g.id === gid)?.name || '';
      (p.roles || []).forEach(r => {
        const { title, tier } = tierOf(r);
        if (!title) return;
        const quoted = rateAtYear(r, p, startYear);
        if (!quoted) return;                       // no-charge / unpriced → skip from rate stats
        const effective = quoted * (1 - discPct);
        const floor = (tier && !tier.isNoCharge) ? (tier.costFloor || 0) : 0;
        out.push({
          projectId: p.id,
          projectName: p.project?.name || 'Untitled',
          client: p.project?.client || '',
          industry: p.project?.industry || '',
          projectType: p.project?.projectType || '',
          status: p.project?.status || '',
          startYear,
          titleId: title.id,
          titleName: title.name,
          tierId: tier?.id,
          tierLabel: tier?.label || '',
          projectRole: r.projectRole || '',
          team: groupName(r.groupId),
          resource: r.resource || '',
          rateSource: r.rateSource || 'grid',
          quoted,
          effective,
          floor,
          belowFloor: floor > 0 && effective < floor - 0.005,
          fteMonths: roleFteMonths(r, p),
          fee: roleFee(r, p),
        });
      });
    });
    return out;
  }

  /* ---------- Per-project rollup ---------- */
  function projectFacts(projects) {
    return (projects || []).map(p => {
      const fin = STORE.projectFinancials(p, (r) => {
        // base-year-equivalent rate so the store's escalation math reproduces ours
        const { base, anchor } = roleBase(r, p);
        const baseYear = p.assumptions.catalogBaseYear || CATALOG.baseYear;
        const esc = (p.assumptions.escalation || 0) / 100;
        return base * Math.pow(1 + esc, baseYear - anchor); // re-anchor to baseYear (cancels store's year-baseYear)
      });
      const months = STORE.enumerateMonths(p.timeline).length;
      const facts = roleFacts([p]);
      return {
        id: p.id,
        name: p.project?.name || 'Untitled',
        client: p.project?.client || '',
        industry: p.project?.industry || '',
        projectType: p.project?.projectType || '',
        status: p.project?.status || '',
        startYear: p.timeline?.startYear,
        durationMonths: months,
        gross: fin.gross,
        net: fin.net,
        discountPct: p.assumptions?.discount || 0,
        roleCount: (p.roles || []).length,
        belowFloorCount: facts.filter(f => f.belowFloor).length,
        isSample: p.source?.type === 'sample',
        roleFacts: facts,
      };
    });
  }

  /* ---------- Stats helpers ---------- */
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function quantile(arr, q) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const pos = (s.length - 1) * q;
    const base = Math.floor(pos), rest = pos - base;
    return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
  }

  /** Group role facts by staff title → summary stats. */
  function statsByTitle(facts) {
    const order = CATALOG.titles.map(t => t.id);
    const groups = {};
    facts.forEach(f => { (groups[f.titleId] = groups[f.titleId] || []).push(f); });
    return order.filter(id => groups[id]).map(id => {
      const g = groups[id];
      const q = g.map(x => x.quoted), e = g.map(x => x.effective);
      const title = CATALOG.titles.find(t => t.id === id);
      const floors = title.tiers.filter(t => !t.isNoCharge).map(t => t.costFloor);
      return {
        titleId: id,
        titleName: title.name,
        rack: title.rackRate,
        floorLow: Math.min(...floors),
        floorHigh: Math.max(...floors),
        n: g.length,
        quotedMin: Math.min(...q), quotedMed: median(q), quotedMax: Math.max(...q),
        effMin: Math.min(...e), effMed: median(e), effMax: Math.max(...e),
        belowFloor: g.filter(x => x.belowFloor).length,
        items: g,
      };
    });
  }

  /* ============================================================
     SAMPLE DATASET — realistic historicals across industries
     ============================================================ */
  function uid() { return 'r' + Math.random().toString(36).slice(2, 9); }
  function ph(name, length) { return { id: uid(), name, length }; }
  // role(titleId, tierId, projectRole, teamIdx, allocPct, contractedRate?)
  function mkProject(spec) {
    const groups = spec.teams.map(n => ({ id: uid(), name: n }));
    const phases = spec.phases.map(p => ph(p[0], p[1]));
    const roles = spec.roles.map(r => {
      const fte = {};
      phases.forEach(p => fte[p.id] = r.alloc);
      return {
        id: uid(),
        titleId: r.title, tierId: r.tier,
        resource: r.name || 'TBD',
        projectRole: r.role || '',
        rateSource: r.contracted != null ? 'contracted' : 'grid',
        contractedRate: r.contracted != null ? r.contracted : null,
        groupId: groups[r.team || 0].id,
        fte,
      };
    });
    const dur = phases.reduce((s, p) => s + p.length, 0);
    const endTotal = (spec.startMonth - 1) + dur - 1;
    return {
      id: 'sample_' + spec.key,
      project: { name: spec.name, client: spec.client, lead: spec.lead || '', industry: spec.industry,
        status: spec.status, proposalDate: spec.proposalDate || '', location: spec.location || '',
        clientContact: '', clientRelOwner: '' },
      timeline: { startMonth: spec.startMonth, startYear: spec.startYear,
        endMonth: (endTotal % 12) + 1, endYear: spec.startYear + Math.floor(endTotal / 12) },
      phases, groups, roles,
      assumptions: { hrsPerMo: 173.33, escalation: 3.0, industryAdj: 20,
        discount: spec.discount || 0, rateLock: !!spec.rateLock, catalogBaseYear: CATALOG.baseYear },
      source: { type: 'sample', name: 'seeded sample', ingestedAt: new Date().toISOString() },
      createdAt: new Date(spec.startYear, spec.startMonth - 1, 1).toISOString(),
    };
  }

  const SAMPLE_SPECS = [   /* SRM: no sample data */
  ];

  function ensureSamples() {
    const existing = STORE.listProjects();
    const hasSamples = existing.some(p => p.source?.type === 'sample');
    if (hasSamples) return 0;
    let n = 0;
    SAMPLE_SPECS.forEach(spec => { STORE.saveProject(mkProject(spec)); n++; });
    return n;
  }
  function removeSamples() {
    STORE.listProjects().filter(p => p.source?.type === 'sample').forEach(p => STORE.deleteProject(p.id));
  }

  window.BENCH = {
    roleFacts, projectFacts, statsByTitle, median, quantile,
    ensureSamples, removeSamples,
    rateAtYear, tierOf,
  };
})();
