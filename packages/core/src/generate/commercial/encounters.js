// encounters.js — the commercial claim shapes: who saw whom, where, in or out of network, and the lines billed. Each
// shape names the catalog services it uses (reference-data/commercial/service-catalog.json), so the catalog holds
// exactly what the shapes need. Options let a test or a scenario fix the network of each party, consent, prior
// authorization and the markup; everything else is drawn from the seed.
import { pickOne, intBetween } from '../rng.js';
import { providerName } from '../entities.js';
import { syntheticNpi, claimNumber } from '../identifiers.js';
import { SERVICES, preventiveFor } from './adjudicate.js';

const isoAdd = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const clinician = (rng, network, specialty, groupId = null) => ({ network, specialty, groupId, name: providerName(rng), npi: syntheticNpi(rng) });
const pickMember = (rng, hh, test, what) => { const pool = hh.members.filter(test); if (!pool.length) throw new Error(`household: no member for ${what}`); return pickOne(rng, pool); };
const adult = (m) => m.age >= 18;
// Who a shape is for, where not everyone: a scenario's patient must pass the test of each of its claims' shapes.
export const SHAPE_MEMBER = { 'preventive-adult': adult, 'preventive-child': (x) => x.age < 18, 'problem-visit-listed': (x) => x.age >= 18 && x.age <= 65,
  surgery: (x) => x.age >= 12, acupuncture: adult };
const wellVisit = (age) => ['wellchild-infant', 'wellchild-1-4', 'wellchild-5-11', 'wellteen-12-17', 'welladult-18-39', 'welladult-40-64']
  .find((id) => { const b = SERVICES[id].preventive[0]; return age >= b.ages[0] && age <= b.ages[1]; });

// Each shape: (rng, household, opts) -> { memberId, emergency, facility, providers, lines, consent, priorAuthObtained }
export const SHAPES = {
  'office-primary': (rng, hh, o) => {
    const m = o.member || pickOne(rng, hh.members);
    const lines = [{ service: 'office-primary', providerId: 'p1' }];
    if (o.labs ?? rng() < 0.4) lines.push({ service: 'blood-draw', providerId: 'p1' }, { service: 'metabolic-panel', providerId: 'p1' });
    return { memberId: m.id, providers: { p1: clinician(rng, o.network || 'in', 'family-medicine') }, lines };
  },
  // a group practice holding an in-network and an out-of-network clinician; the claim is with one of them
  'office-specialist': (rng, hh, o) => {
    const m = o.member || pickOne(rng, hh.members);
    const group = `G${intBetween(rng, 100, 999)}`;
    const both = { in: clinician(rng, 'in', 'cardiology', group), out: clinician(rng, 'out', 'cardiology', group) };
    const net = o.network || 'in';
    return { memberId: m.id, providers: { p1: both[net] }, group: { id: group, clinicians: [both.in, both.out] }, lines: [{ service: 'office-specialist', providerId: 'p1' }] };
  },
  'preventive-adult': (rng, hh, o) => {
    const m = o.member || pickMember(rng, hh, SHAPE_MEMBER['preventive-adult'], 'an adult preventive visit');
    const lines = [{ service: wellVisit(m.age), providerId: 'p1' }];
    for (const id of ['hepc-test', 'hiv-test', 'a1c-test', 'pap-test', 'chlamydia-test', 'depression-screen']) if (preventiveFor(SERVICES[id], m)) lines.push({ service: id, providerId: 'p1' });
    if (o.flu ?? rng() < 0.5) lines.push({ service: 'vaccine-admin-adult', providerId: 'p1' }, { service: 'flu-vaccine', providerId: 'p1' });
    return { memberId: m.id, providers: { p1: clinician(rng, o.network || 'in', 'family-medicine') }, lines };
  },
  'preventive-child': (rng, hh, o) => {
    const m = o.member || pickMember(rng, hh, SHAPE_MEMBER['preventive-child'], 'a child preventive visit');
    const lines = [{ service: wellVisit(m.age), providerId: 'p1' }];
    if (preventiveFor(SERVICES['depression-screen'], m)) lines.push({ service: 'depression-screen', providerId: 'p1' });
    if (m.age >= 1 && (o.flu ?? rng() < 0.5)) lines.push({ service: 'vaccine-admin-child', providerId: 'p1' }, { service: 'flu-vaccine', providerId: 'p1' });
    return { memberId: m.id, providers: { p1: clinician(rng, o.network || 'in', 'pediatrics') }, lines };
  },
  // a problem visit billed separately from a listed service: the visit is cost-shared, the listed service is not
  'problem-visit-listed': (rng, hh, o) => {
    const m = o.member || pickMember(rng, hh, SHAPE_MEMBER['problem-visit-listed'], 'problem visit + HIV screen');
    return { memberId: m.id, providers: { p1: clinician(rng, o.network || 'in', 'family-medicine') }, lines: [{ service: 'office-primary', providerId: 'p1' }, { service: 'hiv-test', providerId: 'p1' }] };
  },
  lab: (rng, hh, o) => {
    const m = o.member || pickOne(rng, hh.members);
    return { memberId: m.id, providers: { p1: clinician(rng, o.network || 'in', 'clinical-laboratory') },
      lines: ['blood-draw', 'metabolic-panel', 'blood-count'].map((service) => ({ service, providerId: 'p1' })) };
  },
  imaging: (rng, hh, o) => {
    const m = o.member || pickOne(rng, hh.members);
    return { memberId: m.id, facility: { network: o.facilityNetwork || 'in', type: o.facilityType || 'hospital-outpatient' }, providers: { p1: clinician(rng, o.network || 'in', 'radiology') },
      lines: [{ service: 'chest-xray-facility' }, { service: 'chest-xray-reading', providerId: 'p1' }] };
  },
  emergency: (rng, hh, o) => {
    const m = o.member || pickOne(rng, hh.members);
    const lines = [{ service: 'er-facility' }, { service: 'er-physician', providerId: 'p1' }];
    const providers = { p1: clinician(rng, o.network || 'in', 'emergency-medicine') };
    if (o.xray ?? rng() < 0.3) { providers.p2 = clinician(rng, o.radiologyNetwork || o.network || 'in', 'radiology'); lines.push({ service: 'chest-xray-reading', providerId: 'p2' }); }
    return { memberId: m.id, emergency: true, facility: { network: o.facilityNetwork || 'in', type: 'hospital-emergency-department' }, providers, lines };
  },
  // elective knee arthroscopy at an in-network hospital outpatient department; each clinician's network, consent and
  // the prior authorization can be fixed
  surgery: (rng, hh, o) => {
    const m = o.member || pickMember(rng, hh, SHAPE_MEMBER.surgery, 'knee surgery');
    const providers = {
      surgeon: clinician(rng, o.surgeonNetwork || 'in', 'orthopedic-surgery'),
      anesthesia: clinician(rng, o.anesthesiaNetwork || 'out', 'anesthesiology'),
      pathology: clinician(rng, o.pathologyNetwork || 'in', 'pathology'),
      radiology: clinician(rng, o.radiologyNetwork || 'in', 'radiology'),
    };
    return { memberId: m.id, facility: { network: o.facilityNetwork || 'in', type: o.facilityType || 'hospital-outpatient' }, providers,
      consent: o.consent || [], priorAuthObtained: o.priorAuthObtained ?? true,
      lines: [{ service: 'knee-surgery-facility' }, { service: 'knee-surgery-surgeon', providerId: 'surgeon' },
        { service: 'knee-anesthesia', providerId: 'anesthesia', minutes: o.minutes || 15 * intBetween(rng, 3, 8) },
        { service: 'tissue-exam', providerId: 'pathology' }, { service: 'knee-xray-reading', providerId: 'radiology' }] };
  },
  ambulance: (rng, hh, o) => {
    const m = o.member || pickOne(rng, hh.members);
    return { memberId: m.id, emergency: true, providers: { p1: clinician(rng, o.network || 'out', 'ambulance') },
      lines: [{ service: 'ambulance-transport', providerId: 'p1' }, { service: 'ambulance-mileage', providerId: 'p1', units: o.miles || intBetween(rng, 4, 30) }] };
  },
  // a visit to an urgent care center (place of service 20), billed by the center
  'urgent-care': (rng, hh, o) => {
    const m = o.member || pickOne(rng, hh.members);
    return { memberId: m.id, providers: { p1: clinician(rng, o.network || 'in', 'urgent-care') }, lines: [{ service: 'urgent-care-visit', providerId: 'p1' }] };
  },
  acupuncture: (rng, hh, o) => {
    const m = o.member || pickMember(rng, hh, SHAPE_MEMBER.acupuncture, 'acupuncture');
    return { memberId: m.id, providers: { p1: clinician(rng, o.network || 'in', 'acupuncture') }, lines: [{ service: 'acupuncture', providerId: 'p1' }] };
  },
};
export const SHAPE_NAMES = Object.keys(SHAPES);

/**
 * Claims for a household in plan year `year`: one per entry of `shapes` (a name, or { shape, ...options }), in date
 * order. Each claim gets an id, dates (received after service; decidable when received, or later after a request for
 * information; decided some days after), and a markup (in network 1.4-2.2, out of network 1.8-3.0) unless fixed. `days`
 * bounds the day of the year (from 5 January) each service falls on.
 */
export function makeCommercialClaims(rng, household, { shapes, year = 2026, days: span = [0, 330] } = {}) {
  const start = `${year}-01-05`;
  const days = shapes.map(() => intBetween(rng, span[0], span[1])).sort((a, b) => a - b);
  return shapes.map((s, i) => {
    const spec = typeof s === 'string' ? { shape: s } : s;
    const fn = SHAPES[spec.shape]; if (!fn) throw new Error(`unknown claim shape ${spec.shape} (known: ${SHAPE_NAMES.join(', ')})`);
    const member = spec.memberId ? household.members.find((m) => m.id === spec.memberId) : undefined;
    if (member && SHAPE_MEMBER[spec.shape] && !SHAPE_MEMBER[spec.shape](member)) throw new Error(`encounters: member/shape mismatch (${spec.shape})`);
    const c = fn(rng, household, { ...spec, member });
    const service = isoAdd(start, days[i]);
    const received = isoAdd(service, intBetween(rng, 3, 20));
    const asked = spec.infoRequested ?? rng() < 0.15;
    const decidable = asked ? isoAdd(received, intBetween(rng, 10, 25)) : received;
    const anyOut = Object.values(c.providers || {}).some((p) => p.network === 'out') || c.facility?.network === 'out';
    // claim numbers in the plan style claimseed's other plan EOBs use (CS and ten digits)
    return { id: claimNumber(rng, 'ma'), shape: spec.shape, ...c, dateOfService: service,
      dates: { received, infoRequested: asked ? isoAdd(received, intBetween(rng, 2, 6)) : null, decidable },
      decisionDays: spec.decisionDays ?? intBetween(rng, 5, 25),
      markup: spec.markup ?? (anyOut ? 1.8 + rng() * 1.2 : 1.4 + rng() * 0.8) };
  });
}
