// household.js — a fictional household on an employer plan: the subscriber and, under family coverage, a spouse and
// children, everyone under 65. Names come from the lexicon (the surname never "Specimen", which stays the Medicare
// reference patient's); member ids carry the SPEC sentinel and a two-digit suffix per person.
import { FIRST_NAMES, LAST_NAMES } from '../lexicon.js';
import { pickOne, intBetween } from '../rng.js';
import { memberId } from '../identifiers.js';
import { PLACES } from './adjudicate.js';

// The places the commercial notice mails to (reference-data/commercial/places.json)
export function commercialPlace(rng) {
  return pickOne(rng, PLACES.places);
}

// Places the plans may not use: a place whose county (countyFips) the stored CLAS list names, or in a state the list is
// not stored for (so a place in a new state cannot pass unchecked). Returns one message per problem.
export function clasProblems(places = PLACES.places, clas = PLACES.clas) {
  return places.flatMap((p) => {
    const listed = clas.listedFips?.[p.state];
    if (!Array.isArray(listed)) return [`${p.city}, ${p.state}: CLAS list not stored`];
    return listed.includes(p.countyFips) ? [`${p.city}, ${p.state}: county ${p.countyFips} CLAS-listed`] : [];
  });
}

function person(rng, { relation, age, sex, surname }) {
  const flags = {};
  if (age >= 18) flags.overweight = rng() < 0.45;
  if (sex === 'F' && age >= 15 && age <= 24) flags['sexually-active'] = rng() < 0.6;
  return { relation, age, sex, firstName: pickOne(rng, FIRST_NAMES), lastName: surname, flags };
}

/** makeHousehold(rng, { tier: 'self'|'family', children }) -> { tier, subscriberId, members: [{ id, relation, age, sex, ... }] } */
export function makeHousehold(rng, { tier, children } = {}) {
  if (!['self', 'family'].includes(tier)) throw new Error(`unknown coverage tier ${tier}`);
  const surname = pickOne(rng, LAST_NAMES.filter((n) => n !== 'Specimen'));
  const base = memberId(rng);
  const sexOf = () => (rng() < 0.5 ? 'F' : 'M');
  const members = [person(rng, { relation: 'subscriber', age: intBetween(rng, 24, 64), sex: sexOf(), surname })];
  if (tier === 'family') {
    members.push(person(rng, { relation: 'spouse', age: intBetween(rng, 24, 64), sex: sexOf(), surname }));
    const n = children ?? intBetween(rng, 1, 3);
    for (let i = 0; i < n; i++) members.push(person(rng, { relation: 'child', age: intBetween(rng, 0, 17), sex: sexOf(), surname }));
  }
  members.forEach((m, i) => { m.id = `${base}-${String(i + 1).padStart(2, '0')}`; });
  return { tier, subscriberId: members[0].id, members };
}
