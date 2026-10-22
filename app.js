import { CASES, PAYER_RULES, CPT, HISTORY } from './data.js';
import { buildPasBundle, submitPriorAuth, pollClaimResponse, sandboxOnline, PAS_BASE } from './pas.js';

// ---------- state ----------
const START = new Date(); START.setMinutes(0, 0, 0);
const state = {
  now: new Date(START),            // simulated clock
  sandbox: 'checking',             // checking | online | offline
  step: 1,
  selectedId: null,
  cases: CASES.map((c) => ({
    ...c, cptText: CPT[c.cpt], rule: PAYER_RULES.find((r) => r.payerId === c.payerId),
    stage: 'new',                  // new | checked | packet | submitting | pending | approved | denied | appeal-draft | appeal-pending | overturned | upheld | no-auth
    arrivedAt: new Date(START.getTime() - (CASES.indexOf(c) * 25 + 15) * 60000),
    log: [], submit: null, poll: null, appealText: '', appealSubmittedAt: null, decidedAt: null, appealDecidedAt: null,
  })),
};
const HOUR = 3600000;
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmtDT = (d) => d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDate = (d) => d.toISOString().slice(0, 10);
const hl7ts = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 12);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

const STEPS = [
  { n: 1, lbl: 'Order arrives', sub: 'HL7 order from the RIS' },
  { n: 2, lbl: 'Is prior auth required?', sub: 'Payer rules by CPT' },
  { n: 3, lbl: 'Assemble packet', sub: 'Referral + clinical notes' },
  { n: 4, lbl: 'Submit to payer', sub: 'FHIR prior-auth request' },
  { n: 5, lbl: 'Track the clock', sub: '7-day / 72-hour queue' },
  { n: 6, lbl: 'Appeal a denial', sub: 'Drafted for signature' },
  { n: 7, lbl: 'Monday report', sub: 'Owner view' },
];

function selected() { return state.cases.find((c) => c.id === state.selectedId) || null; }
function log(c, msg, kind = 'agent') { c.log.push({ t: new Date(state.now), msg, kind }); }
function hoursBetween(a, b) { return Math.max(0, (b - a) / HOUR); }
function deadline(c) { return c.urgency === 'expedited' ? c.rule.expeditedHours : c.rule.standardDays * 24; }

// ---------- simulated clock + simulated payer decisions ----------
function advance(hours) {
  state.now = new Date(state.now.getTime() + hours * HOUR);
  tick();
  render();
}
function tick() {
  for (const c of state.cases) {
    if (c.stage === 'pending' && c.submit && c.payerDecision) {
      const waitH = c.payerDecision.afterHours ?? c.payerDecision.afterDays * 24;
      if (hoursBetween(c.submit.at, state.now) >= waitH) {
        c.decidedAt = new Date(c.submit.at.getTime() + waitH * HOUR);
        c.stage = c.payerDecision.outcome;
        log(c, c.payerDecision.outcome === 'approved'
          ? `Payer decision received: APPROVED. Auth # ${c.payerDecision.authNumber}, valid ${c.payerDecision.validDays} days. Scheduling unblocked.`
          : `Payer decision received: DENIED (${c.payerDecision.reasonCode}). Appeal draft started automatically.`, 'sim');
        if (c.stage === 'denied') { c.appealText = draftAppeal(c); c.stage = 'appeal-draft'; }
      }
    }
    if (c.stage === 'appeal-pending' && c.appealDecision) {
      const waitH = c.appealDecision.afterDays * 24;
      if (hoursBetween(c.appealSubmittedAt, state.now) >= waitH) {
        c.appealDecidedAt = new Date(c.appealSubmittedAt.getTime() + waitH * HOUR);
        c.stage = c.appealDecision.outcome;
        log(c, c.appealDecision.outcome === 'overturned'
          ? `Appeal decision: denial OVERTURNED. Auth # ${c.appealDecision.authNumber}, valid ${c.appealDecision.validDays} days.`
          : 'Appeal decision: denial upheld. Routed to the ordering physician for peer-to-peer.', 'sim');
      }
    }
  }
}

// ---------- domain logic ----------
function authCheck(c) {
  const required = c.rule.requiresAuth.includes(c.cpt);
  return {
    required,
    reasons: [
      { ok: true, text: `Payer identified from the order: ${c.rule.payer} (${c.rule.plan}).` },
      { ok: true, text: `Procedure ${c.cpt}, ${c.cptText}.` },
      required
        ? { ok: false, text: `${c.rule.payer} lists CPT ${c.cpt} on its prior-authorization list. Authorization is required before scheduling.` }
        : { ok: true, text: `${c.rule.payer} does not require prior authorization for CPT ${c.cpt}. Order can be scheduled now.` },
      { ok: true, text: c.urgency === 'expedited' ? `Marked EXPEDITED by the ordering physician: ${c.rule.expeditedHours}-hour decision clock.` : `Routine priority: ${c.rule.standardDays}-day decision clock.` },
    ],
  };
}

function packetChecklist(c) {
  const items = [
    { k: 'Order', ok: true, text: `Signed order from ${c.ordering.name} (NPI ${c.ordering.npi})` },
    { k: 'Diagnosis', ok: true, text: c.icd10.map((d) => `${d.code} ${d.text}`).join('; ') },
    { k: 'Referral reason', ok: true, text: c.referral },
    { k: 'Clinical notes', ok: c.notes.length >= 2, text: `${c.notes.length} note(s) attached from the referring office` },
    { k: 'Conservative therapy', ok: c.notes.some((n) => /therapy|NSAID|conservative/i.test(n)), text: c.notes.some((n) => /therapy|NSAID|conservative/i.test(n)) ? 'Documented' : 'Not documented in the notes received. Flagged for the front desk to request from the referring office.' },
    { k: 'Red flags / risk factors', ok: c.notes.some((n) => /red flag|smok|new in onset|weakness|numbness|nodule/i.test(n)), text: c.notes.some((n) => /red flag|smok|new in onset|weakness|numbness|nodule/i.test(n)) ? 'Documented' : 'Not explicitly documented. Denial risk is higher; the agent will ask for clarification.' },
    { k: 'Member eligibility', ok: true, text: `Member ID ${c.patient.memberId} active with ${c.rule.payer} (eligibility check)` },
  ];
  return items;
}

function draftAppeal(c) {
  const d = c.payerDecision;
  const dx = c.icd10.map((x) => `${x.text} (${x.code})`).join(' and ');
  return `${c.rule.payer}
Appeals Department

Re: Expedited reconsideration of prior-authorization denial
Member: ${c.patient.name}   Member ID: ${c.patient.memberId}   DOB: ${c.patient.dob}
Service: CPT ${c.cpt}, ${c.cptText}
Denial reference: ${d.reasonCode}, dated ${fmtDate(c.decidedAt)}

To whom it may concern,

I am writing on behalf of my patient to request reconsideration of the denial of ${c.cptText}. The denial states: "${d.reason}"

Clinical rationale. The patient has ${dx}. ${c.referral}

Supporting documentation already in the record:
${c.notes.map((n) => `  • ${n}`).join('\n')}

Why the requested study is the appropriate exam. ${appealRationale(c)}

Under the plan's own medical-necessity criteria and the ACR Appropriateness Criteria for this presentation, the requested study is the indicated examination. A delay in diagnosis carries real risk for this patient. I respectfully request that the denial be overturned and the study authorized.

I am available for a peer-to-peer discussion at the plan's convenience.

Sincerely,


__________________________________
${c.ordering.name}   NPI ${c.ordering.npi}
${c.ordering.specialty}

[Drafted by the prior-authorization agent for physician review. Not valid until signed.]`;
}
function appealRationale(c) {
  if (c.cpt === '70553') return 'A new headache pattern in a patient over 50 is itself a red-flag feature under the ACR Appropriateness Criteria for headache ("new headache, age over 50"). MRI with and without contrast is rated "usually appropriate" for this indication; non-contrast CT head is the recommended alternative only when hemorrhage is suspected or MRI is contraindicated. Neither applies here.';
  if (c.cpt === '72148') return 'Lumbar radiculopathy with a focal motor deficit after six weeks of failed conservative therapy meets the ACR criteria for MRI lumbar spine without contrast ("usually appropriate").';
  return 'The requested examination is the study rated "usually appropriate" by the ACR Appropriateness Criteria for this clinical presentation.';
}

function hl7Message(c) {
  const [last, ...rest] = c.patient.name.split(' ').reverse();
  const first = rest.reverse().join(' ');
  const [oLast, oFirst] = c.ordering.name.replace(/^Dr\. /, '').replace(/, MD$/, '').split(' ').reverse();
  const ts = hl7ts(c.arrivedAt);
  return [
    `MSH|^~\\&|RIS|DEMOIMG|PAAGENT|DEMOIMG|${ts}||ORM^O01^ORM_O01|${c.id}-MSG|P|2.5.1`,
    `PID|1||${c.patient.mrn}^^^DEMOIMG^MR||${last}^${first}||${c.patient.dob.replace(/-/g, '')}|${c.patient.sex}|||^^EL PASO^TX^79901`,
    `PV1|1|O|RAD^^^DEMOIMG||||${c.ordering.npi}^${oLast}^${oFirst}`,
    `IN1|1|${c.rule.payerId}^${c.rule.plan}|${c.rule.payerId}|${c.rule.payer}|||||||||||||||||||||||||||||||${c.patient.memberId}`,
    `ORC|NW|${c.id}^RIS||${c.id}-G^RIS|SC||^^^${ts}^^${c.urgency === 'expedited' ? 'S' : 'R'}|||||${c.ordering.npi}^${oLast}^${oFirst}`,
    `OBR|1|${c.id}^RIS||${c.cpt}^${c.cptText}^C4|${c.urgency === 'expedited' ? 'S' : 'R'}||${ts}||||||${c.referral.replace(/\|/g, '/')}|||${c.ordering.npi}^${oLast}^${oFirst}||||||||${c.cpt === '72148' || c.cpt === '70553' || c.cpt === '72141' || c.cpt === '70551' ? 'MR' : 'CT'}`,
    ...c.icd10.map((d, i) => `DG1|${i + 1}||${d.code}^${d.text}^I10|||A`),
    ...c.notes.map((n, i) => `NTE|${i + 1}|L|${n.replace(/\|/g, '/')}`),
  ].join('\n');
}

// ---------- actions ----------
async function doSubmit(c) {
  c.stage = 'submitting';
  log(c, 'Human approved the packet. Building the FHIR prior-authorization request (Da Vinci PAS Claim bundle).', 'human');
  render();
  const bundle = buildPasBundle(c, c.rule, fmtDate(state.now));
  let res = null;
  if (state.sandbox !== 'offline') {
    log(c, `Sending Claim/$submit to the HL7 Da Vinci payer sandbox (${PAS_BASE}).`);
    render();
    res = await submitPriorAuth(bundle);
  }
  const at = new Date(state.now);
  if (res?.ok) {
    c.submit = { mode: 'live', at, preAuthRef: res.preAuthRef, outcome: res.outcome, disposition: res.disposition, raw: res.raw, bundle };
    log(c, `Payer sandbox accepted the request (HTTP ${res.status}). Tracking number ${res.preAuthRef}. Payer status: ${res.disposition}.`);
    const p = await pollClaimResponse(res.preAuthRef, c.patient.mrn);
    c.poll = p;
    log(c, p.ok && p.claimResponse ? 'Read the stored ClaimResponse back from the payer sandbox. Submission confirmed.' : 'Could not read the ClaimResponse back yet; will retry on the next poll.');
  } else {
    if (res && !res.ok) log(c, `Payer sandbox rejected or was unreachable (${esc(res.error)}). Falling back to the simulated payer.`, 'sim');
    c.submit = { mode: 'simulated', at, preAuthRef: `SIM-${c.id}`, outcome: 'queued', disposition: 'Pending', raw: null, bundle };
    log(c, 'Simulated payer accepted the request. Status: Pending.', 'sim');
  }
  c.stage = 'pending';
  log(c, `Decision clock started: ${deadline(c)} hours (${c.urgency === 'expedited' ? 'expedited' : 'standard'}). The agent will poll and escalate at 75% of the window.`);
  state.step = 5;
  render();
}

function signAppeal(c) {
  c.appealText = $('#appeal-text')?.value || c.appealText;
  c.appealSubmittedAt = new Date(state.now);
  c.stage = 'appeal-pending';
  log(c, 'Physician signed the appeal. Submitted to the payer with the clinical rationale and ACR citation.', 'human');
  state.step = 5;
  render();
}

function runAllOthers() {
  // Convenience: process the remaining orders so the queue and report have more than one row.
  const pending = state.cases.filter((c) => c.stage === 'new');
  (async () => {
    for (const c of pending) {
      const chk = authCheck(c);
      log(c, `Order ${c.id} received from the RIS (HL7 ORM^O01).`);
      if (!chk.required) { c.stage = 'no-auth'; log(c, `No prior authorization required by ${c.rule.payer}. Released to scheduling.`); continue; }
      c.stage = 'packet';
      log(c, 'Prior authorization required. Packet assembled from referral and notes.');
      await doSubmit(c);
    }
    state.step = 5; render();
  })();
}

// ---------- render ----------
function render() {
  $('#clock-now').textContent = fmtDT(state.now);
  const pill = $('#sandbox-pill');
  pill.className = 'pill ' + ({ checking: 'pill-muted', online: 'pill-ok', offline: 'pill-warn' }[state.sandbox]);
  pill.textContent = { checking: 'Checking payer sandbox…', online: 'Payer sandbox: LIVE (HL7 Da Vinci PAS)', offline: 'Payer sandbox offline → simulated payer' }[state.sandbox];

  $('#steps').innerHTML = STEPS.map((s) => `
    <button class="step ${s.n === state.step ? 'active' : ''} ${s.n < state.step ? 'done' : ''}" data-step="${s.n}">
      <span class="num">${s.n}</span><span><span class="lbl">${s.lbl}</span><br><span class="sub">${s.sub}</span></span>
    </button>`).join('');

  const c = selected();
  const pane = $('#pane');
  switch (state.step) {
    case 1: pane.innerHTML = viewInbox(); break;
    case 2: pane.innerHTML = c ? viewCheck(c) : needOrder(); break;
    case 3: pane.innerHTML = c ? viewPacket(c) : needOrder(); break;
    case 4: pane.innerHTML = c ? viewSubmit(c) : needOrder(); break;
    case 5: pane.innerHTML = viewQueue(); break;
    case 6: pane.innerHTML = viewAppeal(); break;
    case 7: pane.innerHTML = viewReport(); break;
  }
}
const needOrder = () => `<div class="card"><h2>Pick an order first</h2><p class="lead">Go to step 1 and click an incoming order.</p><div class="actions"><button class="btn btn-primary" data-step="1">Go to the inbox</button></div></div>`;

function stagePill(c) {
  const map = {
    new: ['pill-muted', 'New'], checked: ['pill-info', 'Checked'], packet: ['pill-info', 'Packet ready'], submitting: ['pill-info', 'Submitting…'],
    pending: ['pill-warn', 'Awaiting payer'], approved: ['pill-ok', 'Approved'], denied: ['pill-bad', 'Denied'], 'appeal-draft': ['pill-human', 'Appeal needs signature'],
    'appeal-pending': ['pill-warn', 'Appeal pending'], overturned: ['pill-ok', 'Overturned → approved'], upheld: ['pill-bad', 'Upheld'], 'no-auth': ['pill-ok', 'No auth needed'],
  };
  const [cls, txt] = map[c.stage] || ['pill-muted', c.stage];
  return `<span class="pill ${cls}">${txt}</span>`;
}

function viewInbox() {
  return `<div class="card">
    <h2>Incoming orders from the RIS</h2>
    <p class="lead">Each row is an imaging order the radiology information system just sent as an HL7 message. Click one to follow the agent through it. The first two orders show the full story: one approval, one denial that gets appealed.</p>
    <div class="orders">${state.cases.map((c) => `
      <button class="order ${c.id === state.selectedId ? 'selected' : ''}" data-select="${c.id}">
        <span><span class="o-title">${esc(c.patient.name)} · ${esc(c.cptText)}</span><br>
        <span class="o-meta">${c.id} · ${esc(c.rule.payer)} · ordered by ${esc(c.ordering.name)} · arrived ${fmtDT(c.arrivedAt)}${c.urgency === 'expedited' ? ' · <strong>EXPEDITED</strong>' : ''}</span></span>
        <span>${stagePill(c)}</span>
      </button>`).join('')}</div>
    <div class="actions">
      <button class="btn" id="run-all" ${state.cases.some((c) => c.stage === 'new') ? '' : 'disabled'}>Let the agent process all remaining orders</button>
      <span class="small">Fills the queue and the Monday report in one click.</span>
    </div>
  </div>
  ${selected() ? `<div class="card">
    <h2>HL7 order message · ${selected().id}</h2>
    <p class="lead">This is what the RIS actually sends. The agent reads the patient, insurance (IN1), procedure (OBR) and diagnosis (DG1) segments. Synthetic message.</p>
    <div class="hl7">${hl7Message(selected()).split('\n').map((l) => `<span class="seg">${l.slice(0, 3)}</span>${esc(l.slice(3))}`).join('\n')}</div>
    <div class="actions"><button class="btn btn-primary" data-step="2">Next: does this need prior auth? →</button></div>
  </div>` : ''}`;
}

function viewCheck(c) {
  const chk = authCheck(c);
  if (c.stage === 'new') { c.stage = chk.required ? 'checked' : 'no-auth'; log(c, `Order ${c.id} received from the RIS (HL7 ORM^O01).`); log(c, chk.required ? `Prior authorization REQUIRED by ${c.rule.payer} for CPT ${c.cpt}.` : `No prior authorization required by ${c.rule.payer} for CPT ${c.cpt}. Released to scheduling.`); }
  return `<div class="card">
    <h2>Is prior authorization required? ${chk.required ? '<span class="pill pill-bad">Yes</span>' : '<span class="pill pill-ok">No</span>'}</h2>
    <p class="lead">${esc(c.patient.name)} · ${esc(c.cptText)} (CPT ${c.cpt}) · ${esc(c.rule.payer)}</p>
    <ul class="checklist">${chk.reasons.map((r) => `<li><span class="tick ${r.ok ? 'ok' : 'warn'}">${r.ok ? '✓' : '!'}</span><span>${esc(r.text)}</span></li>`).join('')}</ul>
    <p class="note" style="margin-top:14px">How it decides: the agent keeps a rule table per payer and CPT, kept current from each payer's published prior-auth list. In production this is also checked live through the payer's Coverage Requirements Discovery (CRD) service.</p>
    <div class="actions">
      ${chk.required
        ? `<button class="btn btn-primary" data-step="3">Next: assemble the packet →</button>`
        : `<button class="btn btn-primary" data-step="5">Release to scheduling, view the queue →</button>`}
      <button class="btn" data-step="1">← Back to inbox</button>
    </div>
  </div>`;
}

function viewPacket(c) {
  const items = packetChecklist(c);
  if (c.stage === 'checked') { c.stage = 'packet'; log(c, 'Documentation packet assembled from the referral, clinical notes and eligibility check.'); }
  const canSubmit = ['packet'].includes(c.stage);
  return `<div class="card">
    <h2>Documentation packet</h2>
    <p class="lead">The agent gathers what the payer will ask for, before anyone picks up the phone. Anything missing is flagged for a person to chase.</p>
    <div class="grid2">
      <div><h3>Patient and order</h3><dl class="kv">
        <dt>Patient</dt><dd>${esc(c.patient.name)} · DOB ${c.patient.dob}</dd>
        <dt>Member ID</dt><dd>${c.patient.memberId}</dd>
        <dt>Payer</dt><dd>${esc(c.rule.payer)}</dd>
        <dt>Procedure</dt><dd>${c.cpt} · ${esc(c.cptText)}</dd>
        <dt>Priority</dt><dd>${c.urgency === 'expedited' ? 'Expedited (72 h)' : 'Standard (7 days)'}</dd>
        <dt>Ordering</dt><dd>${esc(c.ordering.name)}</dd></dl></div>
      <div><h3>Completeness check</h3><ul class="checklist">${items.map((i) => `<li><span class="tick ${i.ok ? 'ok' : 'warn'}">${i.ok ? '✓' : '!'}</span><span><strong>${i.k}.</strong> ${esc(i.text)}</span></li>`).join('')}</ul></div>
    </div>
    <h3>Referral reason</h3><p style="margin:0">${esc(c.referral)}</p>
    <h3>Clinical notes attached</h3><ul style="margin:0 0 0 18px">${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    <div class="human-gate"><span class="pill pill-human">Human approves</span><span class="why">The authorization coordinator reviews the packet before anything leaves the building. The agent never submits on its own.</span>
      ${canSubmit ? `<button class="btn btn-human" data-submit="${c.id}">Approve packet and submit</button>` : `<span class="small">Already submitted. ${stagePill(c)}</span>`}
    </div>
    <div class="actions"><button class="btn" data-step="2">← Back</button>${canSubmit ? '' : `<button class="btn btn-primary" data-step="4">View the submission →</button>`}</div>
  </div>`;
}

function viewSubmit(c) {
  if (!c.submit && c.stage !== 'submitting') return `<div class="card"><h2>Not submitted yet</h2><p class="lead">Approve the packet in step 3 first.</p><div class="actions"><button class="btn btn-primary" data-step="3">Go to the packet</button></div></div>`;
  const s = c.submit;
  return `<div class="card">
    <h2>Submission to the payer ${s ? (s.mode === 'live' ? '<span class="pill pill-ok">Real FHIR call</span>' : '<span class="pill pill-warn">Simulated payer</span>') : '<span class="spinner"></span>'}</h2>
    <p class="lead">The packet is converted to the national standard for electronic prior authorization (HL7 FHIR, Da Vinci PAS, the format CMS requires payers to support by 2027) and sent to the payer.</p>
    <h3>Agent log</h3>
    <ul class="log">${c.log.map((l) => `<li><span>${l.kind === 'human' ? '🟣' : l.kind === 'sim' ? '🟠' : '🟢'}</span><span>${l.msg}<br><span class="t">${fmtDT(l.t)}</span></span></li>`).join('')}</ul>
    ${s ? `<h3>Payer response</h3><dl class="kv">
      <dt>Payer tracking #</dt><dd>${esc(s.preAuthRef)}</dd>
      <dt>Status</dt><dd>${esc(s.disposition)} (${esc(s.outcome)})</dd>
      <dt>Endpoint</dt><dd>${s.mode === 'live' ? `<a href="${PAS_BASE}/metadata" target="_blank" rel="noopener">${PAS_BASE}</a>` : 'Simulated payer (sandbox unavailable)'}</dd>
      ${c.poll?.url ? `<dt>Read back</dt><dd><a href="${esc(c.poll.url)}" target="_blank" rel="noopener">Open the stored response on the payer sandbox</a></dd>` : ''}</dl>
    <p class="note sim" style="margin-top:12px">What is real here: the request bundle below was really sent to the HL7 Da Vinci prior-authorization sandbox and really stored there under that tracking number. What is simulated: the sandbox has no medical-necessity rules for imaging, so it leaves every imaging request "Pending". The approve/deny you will see on the queue comes from a simulated payer and is labeled 🟠.</p>
    <details><summary>Show the FHIR request we sent (${(JSON.stringify(s.bundle).length / 1024).toFixed(1)} KB)</summary><div class="json">${esc(JSON.stringify(s.bundle, null, 2))}</div></details>
    ${s.raw ? `<details><summary>Show the payer's FHIR ClaimResponse</summary><div class="json">${esc(JSON.stringify(s.raw, null, 2))}</div></details>` : ''}` : ''}
    <div class="actions"><button class="btn btn-primary" data-step="5">Next: track the clock →</button></div>
  </div>`;
}

function viewQueue() {
  const rows = state.cases.filter((c) => c.stage !== 'new');
  const alerts = rows.filter((c) => c.stage === 'pending' && hoursBetween(c.submit.at, state.now) / deadline(c) >= 0.75);
  return `<div class="card">
    <h2>Authorization queue</h2>
    <p class="lead">Every open request against its regulatory clock: 7 calendar days for standard, 72 hours for expedited (the CMS-0057-F rule payers must meet from 2026). Use the demo clock at the top to move time forward. Decisions marked 🟠 are simulated.</p>
    ${alerts.length ? `<p class="note sim">⚠ ${alerts.length} request(s) past 75% of the clock. The agent has escalated to the payer and alerted the coordinator.</p>` : ''}
    ${rows.length ? `<table class="q"><thead><tr><th>Patient / study</th><th>Payer</th><th>Submitted</th><th>Clock</th><th>Status</th></tr></thead><tbody>
      ${rows.map((c) => {
        const live = c.stage === 'pending' || c.stage === 'appeal-pending';
        const start = c.stage === 'appeal-pending' ? c.appealSubmittedAt : c.submit?.at;
        const total = c.stage === 'appeal-pending' ? 30 * 24 : deadline(c);
        const used = start ? hoursBetween(start, state.now) : 0;
        const ratio = Math.min(1, used / total);
        const cls = ratio >= 1 ? 'bad' : ratio >= 0.75 ? 'warn' : '';
        const left = Math.max(0, total - used);
        const clock = live ? `<div class="meter ${cls}"><span style="width:${Math.round(ratio * 100)}%"></span></div><span class="small">${left >= 48 ? `${Math.floor(left / 24)} days` : `${Math.round(left)} h`} left of ${total >= 72 && total % 24 === 0 ? `${total / 24} days` : `${total} h`}</span>`
          : c.decidedAt ? `<span class="small">Decided in ${hoursBetween(c.submit.at, c.decidedAt) >= 48 ? `${Math.round(hoursBetween(c.submit.at, c.decidedAt) / 24)} days` : `${Math.round(hoursBetween(c.submit.at, c.decidedAt))} h`}</span>` : '<span class="small">—</span>';
        return `<tr class="clickable" data-open="${c.id}"><td><strong>${esc(c.patient.name)}</strong><br><span class="small">${esc(c.cptText)}${c.urgency === 'expedited' ? ' · EXPEDITED' : ''}</span></td>
          <td>${esc(c.rule.payer)}<br><span class="small">${c.submit ? (c.submit.mode === 'live' ? 'via FHIR sandbox' : 'simulated payer') : ''}</span></td>
          <td class="small">${c.submit ? fmtDT(c.submit.at) : '—'}</td><td>${clock}</td>
          <td>${stagePill(c)}${c.stage === 'appeal-draft' ? `<br><button class="btn btn-sm btn-human" data-appeal="${c.id}" style="margin-top:6px">Review appeal</button>` : ''}${c.stage === 'approved' || c.stage === 'overturned' ? `<br><span class="small">Auth # ${c.stage === 'approved' ? c.payerDecision.authNumber : c.appealDecision.authNumber}</span>` : ''}</td></tr>`;
      }).join('')}</tbody></table>` : '<p>No requests yet. Pick an order in step 1.</p>'}
    <div class="actions">
      <button class="btn" data-advance="24">Advance the clock 1 day</button>
      <button class="btn" data-advance="72">Advance 3 days</button>
      ${state.cases.some((c) => c.stage === 'new') ? '<button class="btn" id="run-all">Process the remaining orders</button>' : ''}
      <button class="btn btn-primary" data-step="7">Owner's Monday report →</button>
    </div>
  </div>
  ${selected() && selected().log.length ? `<div class="card"><h2>Agent log · ${esc(selected().patient.name)}</h2>
    <ul class="log">${selected().log.map((l) => `<li><span>${l.kind === 'human' ? '🟣' : l.kind === 'sim' ? '🟠' : '🟢'}</span><span>${l.msg}<br><span class="t">${fmtDT(l.t)}</span></span></li>`).join('')}</ul>
    <p class="small" style="margin-top:10px">🟢 agent · 🟣 human decision · 🟠 simulated payer</p></div>` : ''}`;
}

function viewAppeal() {
  const c = state.cases.find((x) => x.id === state.selectedId && ['appeal-draft', 'appeal-pending', 'overturned', 'upheld'].includes(x.stage))
    || state.cases.find((x) => x.stage === 'appeal-draft') || state.cases.find((x) => ['appeal-pending', 'overturned', 'upheld'].includes(x.stage));
  if (!c) return `<div class="card"><h2>No denials to appeal</h2><p class="lead">Submit ${esc(state.cases[1].patient.name)}'s MRI brain (order ${state.cases[1].id}) and advance the clock about 4 days. That request is denied by the simulated payer and lands here.</p><div class="actions"><button class="btn btn-primary" data-step="1">Go to the inbox</button><button class="btn" data-step="5">Go to the queue</button></div></div>`;
  const editable = c.stage === 'appeal-draft';
  return `<div class="card">
    <h2>Appeal drafted for signature ${stagePill(c)}</h2>
    <p class="lead">${esc(c.patient.name)} · ${esc(c.cptText)} · denied by ${esc(c.rule.payer)} on ${fmtDT(c.decidedAt)} <span class="pill pill-warn">simulated decision</span></p>
    <h3>Denial reason</h3><p style="margin:0">${esc(c.payerDecision.reason)} <span class="small">(${c.payerDecision.reasonCode})</span></p>
    <h3>Draft appeal letter</h3>
    ${editable ? `<textarea class="letter" id="appeal-text">${esc(c.appealText)}</textarea>` : `<div class="letter">${esc(c.appealText)}</div>`}
    <div class="human-gate"><span class="pill pill-human">Human approves</span><span class="why">The ordering physician reads, edits and signs. The agent drafts and files; a licensed clinician owns the clinical argument.</span>
      ${editable ? `<button class="btn btn-human" data-sign="${c.id}">Sign as ${esc(c.ordering.name)} and submit</button>` : `<span class="small">Signed ${c.appealSubmittedAt ? fmtDT(c.appealSubmittedAt) : ''}</span>`}
    </div>
    <div class="actions"><button class="btn" data-step="5">← Back to the queue</button><button class="btn btn-primary" data-step="7">Monday report →</button></div>
  </div>`;
}

function viewReport() {
  const h = HISTORY;
  const live = state.cases.filter((c) => c.submit);
  const liveDenied = live.filter((c) => ['denied', 'appeal-draft', 'appeal-pending', 'overturned', 'upheld'].includes(c.stage)).length;
  const liveApproved = live.filter((c) => c.stage === 'approved').length;
  const liveOverturned = live.filter((c) => c.stage === 'overturned').length;
  const liveAppealed = live.filter((c) => ['appeal-pending', 'overturned', 'upheld'].includes(c.stage)).length;
  const submitted = h.authsSubmitted + live.length;
  const denied = h.denied + liveDenied;
  const appealed = h.appealed + liveAppealed;
  const overturned = h.overturned + liveOverturned;
  const max = Math.max(...h.weeklyTurnaround);
  return `<div class="card">
    <h2>Monday report · prior authorization</h2>
    <p class="lead">${h.periodLabel}, plus whatever you did in this demo session. This is the one tile the owner reads over coffee; the detail is a click away.</p>
    <div class="tiles">
      <div class="tile"><div class="l">Average turnaround</div><div class="v">${h.avgTurnaroundHoursStandard} h</div><div class="d">standard · ${h.avgTurnaroundHoursExpedited} h expedited · limit 168 h / 72 h</div></div>
      <div class="tile"><div class="l">Denial rate</div><div class="v">${pct(denied, submitted)}%</div><div class="d">${denied} of ${submitted} requests</div></div>
      <div class="tile"><div class="l">Appeal rate</div><div class="v">${pct(appealed, denied)}%</div><div class="d">${appealed} of ${denied} denials appealed</div></div>
      <div class="tile"><div class="l">Overturn rate</div><div class="v">${pct(overturned, appealed)}%</div><div class="d">${overturned} of ${appealed} appeals won</div></div>
    </div>
    <div class="grid2" style="margin-top:16px">
      <div class="tile"><div class="l">Turnaround trend, hours per week (lower is better)</div>
        <div class="spark">${h.weeklyTurnaround.map((v) => `<span style="height:${Math.round((v / max) * 100)}%" title="${v} h"></span>`).join('')}</div>
        <div class="small">${h.weeklyTurnaround[0]} h → ${h.weeklyTurnaround.at(-1)} h over 13 weeks</div></div>
      <div class="tile"><div class="l">Clock breaches by payer</div>
        <div class="d">Standard 7-day: <strong>${h.breachedStandard}</strong> · Expedited 72-hour: <strong>${h.breachedExpedited}</strong></div>
        <div class="d">Each breach was escalated the same day with the payer's own tracking number.</div>
        <div class="l" style="margin-top:12px">Staff time</div>
        <div class="d">About <strong>${h.staffMinutesSavedPerAuth} minutes</strong> of phone and portal work per authorization moved from people to the agent. ${Math.round(submitted * h.staffMinutesSavedPerAuth / 60)} hours this period.</div></div>
    </div>
    <p class="note" style="margin-top:14px">First-pass approvals: ${pct(h.approvedFirstPass + liveApproved, submitted)}%. Every number on this page is synthetic for the demo. In production they come from the agent's own records, and the owner can ask the agent follow-up questions in plain English ("which payer denies us the most?").</p>
    <div class="actions"><button class="btn" data-step="5">← Queue</button><button class="btn" data-step="1">Start over with another order</button></div>
  </div>`;
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-step],[data-select],[data-submit],[data-sign],[data-advance],[data-open],[data-appeal],#run-all');
  if (!t) return;
  if (t.dataset.step) { state.step = Number(t.dataset.step); render(); }
  else if (t.dataset.select) { state.selectedId = t.dataset.select; render(); }
  else if (t.dataset.submit) { const c = state.cases.find((x) => x.id === t.dataset.submit); if (c && c.stage === 'packet') { state.step = 4; doSubmit(c); } }
  else if (t.dataset.sign) { const c = state.cases.find((x) => x.id === t.dataset.sign); if (c && c.stage === 'appeal-draft') signAppeal(c); }
  else if (t.dataset.advance) { advance(Number(t.dataset.advance)); }
  else if (t.dataset.open) { state.selectedId = t.dataset.open; render(); }
  else if (t.dataset.appeal) { state.selectedId = t.dataset.appeal; state.step = 6; render(); }
  else if (t.id === 'run-all') { runAllOthers(); }
  if (window.innerWidth < 860 && (t.dataset.step || t.dataset.appeal)) window.scrollTo({ top: 0, behavior: 'smooth' });
});

render();
sandboxOnline().then((ok) => { state.sandbox = ok ? 'online' : 'offline'; render(); });
