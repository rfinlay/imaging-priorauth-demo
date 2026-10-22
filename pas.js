// Da Vinci PAS client. Talks to the public HL7 Da Vinci Prior Authorization
// reference implementation (https://prior-auth.davinci.hl7.org/fhir), which is a
// LIVE sandbox: it validates the Bundle, stores it, and returns a real ClaimResponse
// with a preAuthRef (the sandbox's prior-auth number). Its rules engine has no CQL
// rule for imaging CPT codes, so every imaging request comes back "queued / Pending".
// The final approve/deny for the demo is therefore produced by a clearly labeled
// SIMULATED payer adjudicator (see app.js). If the sandbox is unreachable, the whole
// submission falls back to the simulated payer and the UI says so.

export const PAS_BASE = 'https://prior-auth.davinci.hl7.org/fhir';
const FHIR_HEADERS = { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' };
const BASE_URL = 'http://example.com/fhir'; // fullUrl prefix the sandbox resolves references against
const TIMEOUT_MS = 20000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function entry(resource) {
  return { fullUrl: `${BASE_URL}/${resource.resourceType}/${resource.id}`, resource };
}

/** Build a PAS request Bundle for one imaging order. All data is synthetic. */
export function buildPasBundle(c, rule, today) {
  const ids = {
    claim: `claim-${c.id}`, patient: `pat-${c.patient.mrn}`, practitioner: `pra-${c.ordering.npi}`,
    org: 'org-demo-imaging', payer: `org-${rule.payerId}`, coverage: `cov-${c.patient.memberId}`,
    sr: `sr-${c.id}`, qr: `qr-${c.id}`,
  };
  const conditions = c.icd10.map((d, i) => ({
    resourceType: 'Condition', id: `cond-${c.id}-${i + 1}`,
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
    code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: d.code, display: d.text }], text: d.text },
    subject: { reference: `Patient/${ids.patient}` },
  }));

  const claim = {
    resourceType: 'Claim', id: ids.claim,
    meta: { profile: ['http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim'] },
    identifier: [{ system: 'http://example.com/imaging-center/PATIENT_EVENT_TRACE_NUMBER', value: c.id }],
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional', display: 'Professional' }] },
    use: 'preauthorization',
    patient: { reference: `Patient/${ids.patient}` },
    created: today,
    insurer: { reference: `Organization/${ids.payer}` },
    provider: { reference: `Organization/${ids.org}` },
    priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: c.urgency === 'expedited' ? 'stat' : 'normal' }] },
    referral: { reference: `ServiceRequest/${ids.sr}` },
    supportingInfo: [{
      sequence: 1,
      category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claiminformationcategory', code: 'info', display: 'Information' }] },
      valueReference: { reference: `QuestionnaireResponse/${ids.qr}` },
    }],
    diagnosis: conditions.map((cond, i) => ({ sequence: i + 1, diagnosisReference: { reference: `Condition/${cond.id}` } })),
    insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${ids.coverage}` } }],
    item: [{
      sequence: 1,
      category: { coding: [{ system: 'https://x12.org/codes/service-type-codes', code: '4', display: 'Diagnostic X-Ray' }] },
      productOrService: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: c.cpt, display: c.cptText }] },
      servicedDate: today,
      diagnosisSequence: conditions.map((_, i) => i + 1),
    }],
  };

  const serviceRequest = {
    resourceType: 'ServiceRequest', id: ids.sr, status: 'active', intent: 'order',
    priority: c.urgency === 'expedited' ? 'urgent' : 'routine',
    code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: c.cpt, display: c.cptText }] },
    subject: { reference: `Patient/${ids.patient}` },
    requester: { reference: `Practitioner/${ids.practitioner}` },
    reasonReference: conditions.map((cond) => ({ reference: `Condition/${cond.id}` })),
    note: [{ text: c.referral }],
  };

  // DTR-style documentation: the clinical notes answered as a questionnaire.
  const qr = {
    resourceType: 'QuestionnaireResponse', id: ids.qr, status: 'completed',
    questionnaire: 'http://example.com/Questionnaire/imaging-medical-necessity',
    subject: { reference: `Patient/${ids.patient}` }, authored: `${today}T09:00:00Z`,
    author: { reference: `Practitioner/${ids.practitioner}` },
    item: c.notes.map((n, i) => ({ linkId: `note-${i + 1}`, text: 'Clinical documentation', answer: [{ valueString: n }] })),
  };

  const patient = {
    resourceType: 'Patient', id: ids.patient,
    identifier: [{ system: 'http://example.com/imaging-center/mrn', value: c.patient.mrn }, { system: `http://example.com/${rule.payerId}/member`, value: c.patient.memberId }],
    name: [{ family: c.patient.name.split(' ').slice(-1)[0], given: c.patient.name.split(' ').slice(0, -1) }],
    gender: c.patient.sex === 'F' ? 'female' : 'male', birthDate: c.patient.dob,
    address: [{ state: 'TX' }],
  };
  const practitioner = {
    resourceType: 'Practitioner', id: ids.practitioner,
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: c.ordering.npi }],
    name: [{ text: c.ordering.name }],
  };
  const org = { resourceType: 'Organization', id: ids.org, name: 'Demo Imaging Center (synthetic)', address: [{ city: 'El Paso', state: 'TX' }] };
  const payer = { resourceType: 'Organization', id: ids.payer, name: `${rule.payer} (synthetic)` };
  const coverage = {
    resourceType: 'Coverage', id: ids.coverage, status: 'active', subscriberId: c.patient.memberId,
    beneficiary: { reference: `Patient/${ids.patient}` }, payor: [{ reference: `Organization/${ids.payer}` }],
    class: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'plan' }] }, value: rule.plan }],
  };

  return {
    resourceType: 'Bundle',
    meta: { profile: ['http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-request-bundle'] },
    type: 'collection', timestamp: new Date().toISOString(),
    entry: [claim, serviceRequest, qr, patient, practitioner, ...conditions, org, payer, coverage].map(entry),
  };
}

/** Fetch the sandbox CapabilityStatement; resolves true if reachable. */
export async function sandboxOnline() {
  try {
    const r = await withTimeout(fetch(`${PAS_BASE}/metadata`, { headers: { Accept: 'application/fhir+json' } }), 8000);
    return r.ok;
  } catch { return false; }
}

/** POST Claim/$submit. Returns {ok, status, claimResponse, preAuthRef, raw} or {ok:false, error}. */
export async function submitPriorAuth(bundle) {
  try {
    const r = await withTimeout(fetch(`${PAS_BASE}/Claim/$submit`, { method: 'POST', headers: FHIR_HEADERS, body: JSON.stringify(bundle) }), TIMEOUT_MS);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!r.ok) {
      const diag = json?.issue?.map((i) => i.diagnostics).filter(Boolean).join('; ');
      return { ok: false, status: r.status, error: diag || `HTTP ${r.status}`, raw: text };
    }
    const cr = json?.entry?.map((e) => e.resource).find((x) => x?.resourceType === 'ClaimResponse') || (json?.resourceType === 'ClaimResponse' ? json : null);
    return { ok: true, status: r.status, claimResponse: cr, preAuthRef: cr?.preAuthRef, outcome: cr?.outcome, disposition: cr?.disposition, raw: json };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/** GET the stored ClaimResponse back from the sandbox by preAuthRef (proves it was persisted). */
export async function pollClaimResponse(preAuthRef, patientIdentifier) {
  const url = `${PAS_BASE}/ClaimResponse?identifier=${encodeURIComponent(preAuthRef)}&patient.identifier=${encodeURIComponent(patientIdentifier)}`;
  try {
    const r = await withTimeout(fetch(url, { headers: { Accept: 'application/fhir+json' } }), TIMEOUT_MS);
    if (!r.ok) return { ok: false, status: r.status };
    const json = await r.json();
    const cr = json?.entry?.map((e) => e.resource).find((x) => x?.resourceType === 'ClaimResponse' && x.preAuthRef === preAuthRef)
      || json?.entry?.map((e) => e.resource).find((x) => x?.resourceType === 'ClaimResponse');
    return { ok: true, status: r.status, claimResponse: cr, url };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, url };
  }
}
