// Synthetic demo data. Every patient, provider, payer ID and note below is invented.
// Nothing here is real PHI.

export const PAYER_RULES = [
  // Which payers require prior auth for which CPT codes (synthetic rule table that
  // stands in for a payer's published PA list / a CRD "coverage requirements" lookup).
  { payer: 'Rio Grande Health Plan', plan: 'Commercial PPO', payerId: 'RGHP-TX',
    requiresAuth: ['70553', '72148', '72141', '71260', '74177', '70450'], expeditedHours: 72, standardDays: 7 },
  { payer: 'Sun City Medicare Advantage', plan: 'Medicare Advantage HMO', payerId: 'SCMA-TX',
    requiresAuth: ['70553', '72148', '72141', '74177', '70551'], expeditedHours: 72, standardDays: 7 },
  { payer: 'Medicare Part B (traditional)', plan: 'Fee-for-service', payerId: 'CMS-FFS',
    requiresAuth: [], expeditedHours: 72, standardDays: 7 },
];

export const CPT = {
  '72148': 'MRI lumbar spine without contrast',
  '70553': 'MRI brain with and without contrast',
  '71260': 'CT chest with contrast',
  '74177': 'CT abdomen and pelvis with contrast',
  '70450': 'CT head without contrast',
  '72141': 'MRI cervical spine without contrast',
  '70551': 'MRI brain without contrast',
};

// Each case is one order arriving from the RIS as an HL7 v2 ORM^O01 message.
// `payerDecision` is what the SIMULATED payer adjudicator returns when the real
// sandbox leaves the request pended (the Da Vinci sandbox pends all imaging CPTs).
export const CASES = [
  {
    id: 'ORD-10421',
    patient: { name: 'Maria Delgado', mrn: 'MRN-000731', dob: '1972-04-11', sex: 'F', memberId: 'RG77410233' },
    payerId: 'RGHP-TX',
    cpt: '72148',
    icd10: [{ code: 'M54.16', text: 'Radiculopathy, lumbar region' }, { code: 'M51.36', text: 'Other intervertebral disc degeneration, lumbar region' }],
    ordering: { name: 'Dr. Ana Rivas, MD', npi: '1999990011', specialty: 'Family Medicine' },
    urgency: 'routine',
    referral: 'Low back pain radiating to left leg for 8 weeks. Positive straight-leg raise on the left. Please evaluate for disc herniation with nerve root compression.',
    notes: [
      'Conservative therapy: 6 weeks physical therapy (completed 09-28), NSAIDs x 8 weeks. No improvement.',
      'Neuro exam: left L5 dermatome numbness, 4/5 dorsiflexion weakness.',
      'No red flags: no fever, no weight loss, no bowel/bladder symptoms.',
    ],
    payerDecision: { outcome: 'approved', afterDays: 2, authNumber: 'RG-2026-884120', validDays: 60 },
  },
  {
    id: 'ORD-10422',
    patient: { name: 'Robert Chen', mrn: 'MRN-000912', dob: '1958-09-02', sex: 'M', memberId: 'SC55012899' },
    payerId: 'SCMA-TX',
    cpt: '70553',
    icd10: [{ code: 'R51.9', text: 'Headache, unspecified' }],
    ordering: { name: 'Dr. Luis Ortega, MD', npi: '1999990022', specialty: 'Internal Medicine' },
    urgency: 'routine',
    referral: 'New daily headaches x 3 weeks in a 68-year-old. Rule out intracranial lesion.',
    notes: [
      'Headache new in onset after age 50. Worse in the morning.',
      'Neuro exam documented as normal.',
      'No prior head imaging on file.',
    ],
    // The simulated payer denies for "insufficient documentation of red-flag features",
    // which gives the agent a chance to draft an appeal citing ACR Appropriateness Criteria.
    payerDecision: {
      outcome: 'denied', afterDays: 4,
      reason: 'Documentation does not establish a red-flag feature that meets the plan\'s medical necessity criteria for MRI brain with and without contrast. Consider CT head without contrast.',
      reasonCode: 'MN-204',
    },
    appealDecision: { outcome: 'overturned', afterDays: 3, authNumber: 'SC-2026-310077', validDays: 45 },
  },
  {
    id: 'ORD-10423',
    patient: { name: 'Eleanor Whitfield', mrn: 'MRN-001044', dob: '1949-12-20', sex: 'F', memberId: '1EG4TE5MK72' },
    payerId: 'CMS-FFS',
    cpt: '74177',
    icd10: [{ code: 'R10.9', text: 'Unspecified abdominal pain' }],
    ordering: { name: 'Dr. Priya Nair, MD', npi: '1999990033', specialty: 'Gastroenterology' },
    urgency: 'routine',
    referral: 'Persistent right lower quadrant pain, 10 days. Evaluate for appendiceal or colonic pathology.',
    notes: ['CBC: WBC 11.8. CRP mildly elevated.'],
    payerDecision: null, // traditional Medicare: no prior auth required
  },
  {
    id: 'ORD-10424',
    patient: { name: 'Jamal Okafor', mrn: 'MRN-001102', dob: '1985-06-30', sex: 'M', memberId: 'RG77419902' },
    payerId: 'RGHP-TX',
    cpt: '71260',
    icd10: [{ code: 'R91.1', text: 'Solitary pulmonary nodule' }],
    ordering: { name: 'Dr. Ana Rivas, MD', npi: '1999990011', specialty: 'Family Medicine' },
    urgency: 'expedited',
    referral: 'Incidental 9 mm right upper lobe nodule on chest X-ray. Expedited: patient is a current smoker and leaves the country in 5 days.',
    notes: ['Chest X-ray 10-20: 9 mm RUL nodule, new compared to 2024.', '30 pack-year smoking history.'],
    payerDecision: { outcome: 'approved', afterHours: 30, authNumber: 'RG-2026-884133', validDays: 30 },
  },
];

// Synthetic 90-day history that feeds the owner's Monday report.
export const HISTORY = {
  periodLabel: 'Last 90 days (synthetic)',
  authsRequired: 412,
  authsSubmitted: 412,
  approvedFirstPass: 351,
  denied: 61,
  appealed: 44,
  overturned: 29,
  avgTurnaroundHoursStandard: 41,
  avgTurnaroundHoursExpedited: 19,
  breachedStandard: 3,
  breachedExpedited: 1,
  staffMinutesSavedPerAuth: 23,
  weeklyTurnaround: [52, 49, 46, 44, 43, 41, 40, 41, 39, 38, 41, 40, 39],
};
