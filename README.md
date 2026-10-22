# Prior Authorization Agent — clickable demo

Live: **https://rfinlay.github.io/imaging-priorauth-demo/**

A working, clickable demo of an AI prior-authorization agent for an outpatient imaging
center. Built for a conversation with a radiologist owner, an administrator and an engineer.
Static site (vanilla HTML/CSS/JS, no build step), hosted on GitHub Pages.

**Demo with synthetic data.** Every patient, provider, payer, member ID, note and metric is
invented. There is no PHI anywhere in this repository or in anything it sends.

## What is real and what is simulated

| Piece | Status | Detail |
|---|---|---|
| Payer prior-auth submission | **REAL** | `POST Claim/$submit` to the public HL7 Da Vinci Prior Authorization reference implementation, `https://prior-auth.davinci.hl7.org/fhir`. It validates the FHIR bundle, persists it, and returns a real `ClaimResponse` with a `preAuthRef`. CORS allows calls from `rfinlay.github.io`, so the browser talks to it directly, no backend. |
| Reading the response back | **REAL** | `GET ClaimResponse?identifier={preAuthRef}&patient.identifier={mrn}` against the same sandbox; the UI links to it so a skeptic can open the stored record. |
| FHIR request format | **REAL** | Da Vinci PAS request bundle: Claim (use=preauthorization), ServiceRequest, QuestionnaireResponse (DTR-style documentation), Patient, Practitioner, Condition, Organization, Coverage. Built in `pas.js`. |
| Approve / deny decision | **SIMULATED** (labeled 🟠) | The sandbox's rules engine has CQL rules only for a few HCPCS codes (home oxygen, CPAP, etc.). Any imaging CPT comes back `outcome=queued, disposition=Pending` and stays there. The demo's final decisions, denial reason and appeal outcome come from a scripted "simulated payer" in `data.js`. |
| Incoming RIS order | **SIMULATED** | A synthetic HL7 v2.5.1 `ORM^O01` message is generated per order and displayed. No live RIS or Orthanc feed is wired in (see below). |
| 7-day / 72-hour clocks | **REAL logic, simulated time** | The queue computes CMS-0057-F windows (7 calendar days standard, 72 hours expedited) from the submission timestamp; a demo clock lets you advance time so a week fits in 3 minutes. |
| Appeal letter | **TEMPLATED** | Drafted from the denial reason, diagnosis, notes and an ACR Appropriateness Criteria rationale. Not an LLM call; in production this is an LLM draft that a physician edits and signs. |
| Monday report | **SYNTHETIC** | 90-day history is hard-coded in `data.js`; the session's live cases are added on top. |
| Sandbox fallback | automatic | If the sandbox is unreachable the banner turns orange and the submission goes to the simulated payer, labeled as such. |

Human sign-off ("Human approves") gates are shown at the two places a person must act:
approving the packet before submission, and signing the appeal.

## Sandbox research (2026-10-22, verified with real HTTP calls)

| Candidate | Result |
|---|---|
| HL7 Da Vinci PAS RI, `prior-auth.davinci.hl7.org/fhir` | **LIVE.** `/metadata` 200 (FHIR 4.0.1, `cors: true`). `Claim/$submit` with a valid PAS bundle → **HTTP 201** ClaimResponse `queued/Pending`. Open (no token needed for `$submit`). Imaging CPTs are not in its rules table so they pend. `/debug/ReleaseClaim` 500s. **Used.** |
| HL7 Da Vinci CRD RI, `crd.davinci.hl7.org` | Up (200), but `/cds-services` 404 at root; the CDS Hooks discovery sits under a different path and needs an EHR launch. Not used; CRD's job (is auth required?) is done by a local rule table in the demo. |
| HL7 Da Vinci DTR RI, `dtr.davinci.hl7.org` | Up (200), SMART-app flavored, needs an EHR launch context. Not used. |
| CMS Blue Button 2.0 sandbox | 200, but it is a beneficiary claims-history API (OAuth, synthetic Medicare data). No prior-auth operation. Not used. |
| CMS BCDA sandbox | 200, bulk claims export for ACOs. No prior auth. Not used. |
| Epic open FHIR sandbox | 200, R4 metadata (95 KB). Clinical data only; no PAS. Not used. |
| Logica sandbox (`api.logicahealth.org`) | DNS does not resolve. Dead. |
| UnitedHealthcare `developer.uhc.com` | DNS does not resolve. Humana developer portal is a static site requiring registration; no anonymous sandbox. Availity requires a signed developer agreement. Not used. |
| HAPI `hapi.fhir.org`, Firely `server.fire.ly` | Live generic R4 servers, no PAS operation. Could host test Patients but add nothing. Not used. |
| Orthanc demo, `orthanc.uclouvain.be/demo` | **LIVE** DICOM server (REST 200, studies listed), but sends no `Access-Control-Allow-Origin` header, so a browser-only app cannot read it. `demo.orthanc-server.com` has an expired TLS certificate. Kept out; the RIS feed is a synthetic HL7 ORM instead. |

## Run locally

```
python3 -m http.server 8080
# open http://localhost:8080
```

Any static server works; the page uses ES modules so it will not open from `file://`.

## Files

- `index.html`, `styles.css`: shell and styling, responsive down to phone width.
- `app.js`: state, simulated clock, the seven screens, event wiring.
- `pas.js`: FHIR bundle builder, `$submit`, `ClaimResponse` poll, sandbox health check.
- `data.js`: synthetic orders, payer rule table, simulated decisions, report history.

## License

MIT. Demo only; not medical software.
