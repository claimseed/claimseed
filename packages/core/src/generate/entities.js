// entities.js — synthetic beneficiary, providers, places.
import { FIRST_NAMES, LAST_NAMES, STREET_NAMES, PLACES, PROVIDER_FIRST, PROVIDER_LAST, SPECIALTIES, FACILITY_PARTS } from './lexicon.js';
import { pickOne, intBetween } from './rng.js';
import { syntheticNpi, syntheticMbi, phone555, memberId } from './identifiers.js';

export function makePlace(rng) { return pickOne(rng, PLACES); }

export function makeBeneficiary(rng, place, { referenceSurname = false } = {}) {
  const first = pickOne(rng, FIRST_NAMES);
  const mi = String.fromCharCode(65 + intBetween(rng, 0, 25));
  const last = referenceSurname ? 'Specimen' : pickOne(rng, LAST_NAMES.filter((n) => n !== 'Specimen'));
  const street = `${intBetween(rng, 100, 9899)} ${pickOne(rng, STREET_NAMES)}`;
  const apt = rng() < 0.3 ? ` Apt ${intBetween(rng, 101, 420)}` : '';
  return {
    firstName: first, middleInitial: mi, lastName: last,
    name: `${first} ${mi}. ${last}`,
    nameUpper: `${first.toUpperCase()} ${mi} ${last.toUpperCase()}`,
    addressLines: [`${first.toUpperCase()} ${mi} ${last.toUpperCase()}`, `${street}${apt}`, `${place.city.toUpperCase()}, ${place.state} ${place.zip}`],
    mbi: syntheticMbi(rng),
    memberId: memberId(rng),
    phone: phone555(rng, place.areaCode),
    place,
  };
}

// Individual providers carry the sentinel middle name "Specimen" (as beneficiaries carry the surname), so a generated
// first+last combination can never be mistaken for, or collide with, a real practitioner in the NPPES registry.
export function providerName(rng) { return `${pickOne(rng, PROVIDER_FIRST)} Specimen ${pickOne(rng, PROVIDER_LAST)}, MD`; }
export function makeProvider(rng, place, specialtyCode) {
  const spec = SPECIALTIES.find((s) => s.code === specialtyCode) || pickOne(rng, SPECIALTIES);
  const facility = ['LAB', 'RAD', 'PT'].includes(spec.code) || rng() < 0.35;
  let name;
  if (facility) {
    const kind = spec.code === 'LAB' ? 'Diagnostic Laboratory' : spec.code === 'RAD' ? 'Imaging Center' : spec.code === 'PT' ? 'Physical Therapy Center' : pickOne(rng, ['Medical Center', 'Community Hospital', 'Regional Medical Group', 'Family Clinic', 'Specialty Associates']);
    name = `${pickOne(rng, FACILITY_PARTS.prefix)} ${kind}`; // e.g. "Specimen Community Hospital"
  } else {
    name = providerName(rng);
  }
  return {
    name, nameUpper: name.toUpperCase(), specialty: spec.name, specialtyCode: spec.code, facility,
    npi: syntheticNpi(rng),
    phone: phone555(rng, place.areaCode),
    addressLines: [`${intBetween(rng, 100, 9899)} ${pickOne(rng, STREET_NAMES)}`, `${place.city}, ${place.state} ${place.zip}`],
    participating: true,
  };
}
