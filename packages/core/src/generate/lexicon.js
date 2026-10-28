// lexicon.js — curated word lists for synthetic identities. Every list is original to
// claimseed and deliberately generic. Street names are fictional; cities, states and
// ZIP prefixes are real so addresses *format* correctly. Nothing here is drawn from any
// document; see docs/synthetic-data-policy.md.

export const FIRST_NAMES = [
  'Harriet', 'Wendell', 'Dolores', 'Raymond', 'Bernice', 'Clarence', 'Marguerite', 'Lionel',
  'Opal', 'Norman', 'Rosalind', 'Vernon', 'Thelma', 'Alvin', 'Lorraine', 'Chester', 'Geraldine',
  'Herbert', 'Maxine', 'Leroy', 'Ernestine', 'Delbert', 'Wilma', 'Horace', 'Beatrice', 'Rudolph',
  'Estelle', 'Winston', 'Mildred', 'Everett', 'Carmela', 'Sidney', 'Joyce', 'Ignatius', 'Pearl',
  'Thaddeus', 'Yolanda', 'Marvin', 'Ruthanne', 'Cornelius',
];
// Surnames: common English, Spanish, Italian, Polish, Korean, Vietnamese, Nigerian and Indian-origin
// forms chosen for plausibility, not taken from any record. "Specimen" is reserved for the
// reference patient so a reviewer can spot a specimen at a glance.
export const LAST_NAMES = [
  'Specimen', 'Abernathy', 'Castellano', 'Dunmore', 'Ferraro', 'Galloway', 'Hollister', 'Iwamoto',
  'Jurkowski', 'Kaminski', 'Larkspur', 'Maldonado', 'Nakashima', 'Adeyemi', 'Pembrook', 'Quintanilla',
  'Rasmussen', 'Sandoval', 'Thibodeaux', 'Umezawa', 'Villanueva', 'Westergaard', 'Yamaguchi', 'Zielinski',
  'Bramwell', 'Carrasco', 'Beaumont', 'Eastwick', 'Fontenot', 'Greenbaum', 'Halvorsen', 'Ibarra',
  'Kowalczyk', 'Lindqvist', 'Montenegro', 'Nwachukwu', 'Oyelaran', 'Przybylski', 'Ravindran', 'Szymanski',
];
export const STREET_NAMES = [
  // Deliberately impossible street names: every one contains a word that no real street uses, so a generated
  // address cannot coincide with a real one even in a real city and ZIP.
  'Specimen Way', 'Imaginary Lane', 'Fictitious Road', 'Notional Terrace', 'Hypothetical Drive', 'Simulated Court',
  'Invented Circle', 'Exemplar Way', 'Decoy Bend', 'Ersatz Avenue', 'Nonexistent Street', 'Lorem Ipsum Bend',
  'Prototype Road', 'Blueprint Court', 'Pretend Place', 'Illustrative Lane',
];
// city, state, ZIP5 (real), area code (real, geographic — for 555-01xx numbers), MPFS locality label
export const PLACES = [
  { city: 'Columbus', state: 'OH', zip: '43215', areaCode: '614', locality: 'Rest of Ohio' },
  { city: 'Tucson', state: 'AZ', zip: '85701', areaCode: '520', locality: 'Arizona' },
  { city: 'Raleigh', state: 'NC', zip: '27601', areaCode: '919', locality: 'North Carolina' },
  { city: 'Spokane', state: 'WA', zip: '99201', areaCode: '509', locality: 'Rest of Washington' },
  { city: 'Des Moines', state: 'IA', zip: '50309', areaCode: '515', locality: 'Iowa' },
  { city: 'Knoxville', state: 'TN', zip: '37902', areaCode: '865', locality: 'Tennessee' },
  { city: 'Albuquerque', state: 'NM', zip: '87102', areaCode: '505', locality: 'New Mexico' },
  { city: 'Sarasota', state: 'FL', zip: '34236', areaCode: '941', locality: 'Rest of Florida' },
  { city: 'Lancaster', state: 'PA', zip: '17602', areaCode: '717', locality: 'Rest of Pennsylvania' },
  { city: 'Boise', state: 'ID', zip: '83702', areaCode: '208', locality: 'Idaho' },
];
export const PROVIDER_FIRST = ['Adaeze', 'Bartholomew', 'Celestine', 'Dmitri', 'Eleanora', 'Florian', 'Guadalupe', 'Hyacinth', 'Isidore', 'Jolanta', 'Kwame', 'Leopold', 'Marisol', 'Nikolai', 'Octavia', 'Priyanka', 'Quentin', 'Rosalba', 'Santiago', 'Tamsin'];
export const PROVIDER_LAST = ['Achterberg', 'Balogun', 'Castellanos', 'Dobrowolski', 'Engelhardt', 'Figueroa', 'Grunwald', 'Hashimoto', 'Ionescu', 'Jablonski', 'Kirchner', 'Lindgren', 'Mbatha', 'Narayanan', 'Ostrowski', 'Petrakis', 'Quiroga', 'Rautenberg', 'Sorensen', 'Takahashi'];
export const SPECIALTIES = [
  { code: 'IM', name: 'Internal Medicine' }, { code: 'FP', name: 'Family Practice' }, { code: 'CARD', name: 'Cardiology' },
  { code: 'OPH', name: 'Ophthalmology' }, { code: 'DERM', name: 'Dermatology' }, { code: 'ENDO', name: 'Endocrinology' },
  { code: 'PT', name: 'Physical Therapy' }, { code: 'LAB', name: 'Clinical Laboratory' }, { code: 'RAD', name: 'Diagnostic Radiology' },
];
export const FACILITY_PARTS = {
  // Facility names are built from a word that cannot belong to a real licensed facility ("Specimen",
  // "Fixture", "Example") so they can never match NPPES or the CMS Provider of Services file.
  prefix: ['Specimen', 'Fixture', 'Example', 'Placeholder', 'Sandbox', 'Sample', 'Template', 'Mock', 'Synthetic', 'Testbed'],
  kind: ['Medical Center', 'Community Hospital', 'Regional Medical Group', 'Family Clinic', 'Specialty Associates', 'Diagnostic Laboratory', 'Imaging Center', 'Physical Therapy Center'],
};
export const PHARMACY_NAMES = ['Specimen Pharmacy #0412', 'Fixture Drug Store', 'Sample Apothecary', 'Placeholder Pharmacy #0199'];
