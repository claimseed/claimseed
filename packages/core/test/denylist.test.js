import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrands } from '../scripts/lib/brand-denylist.js';
const U = (...cps) => String.fromCodePoint(...cps);   // homoglyph vectors from code points (this file is scanned by every rule but the brand rule)

test('brand denylist is not bypassed by case, spacing, punctuation, entities, tags, zero-width or fullwidth text', () => {
  const must = ['UnitedHealthcare', 'BlueCrossBlueShield', 'CVSHealth', 'QuestDiagnostics', 'Blue  Cross', 'Blue-Cross', 'U.H.C.', 'Wal-Mart',
    'Aet&#110;a', 'Aet&amp;#110;a', 'Hum<span></span>ana', 'United&nbsp;Healthcare', 'Ae​tna', 'Ａｅｔｎａ', 'KAISER PERMANENTE', 'Palmetto GBA', 'MyChart',
    // compounds and brand-as-suffix seen in real domain and product names
    'aarpmedicareplans.com', 'uhcmedicaresolutions.com', 'cvspharmacy', 'myaetna.com', 'mycigna.com', 'myuhc.com', 'AETNAMEDICARE', 'humanagold', 'Aetna2026',
    // legacy entity without semicolon, homoglyphs from Armenian, Cherokee, Lisu, Cyrillic (palochka, we) and small capitals
    'Aet&shyna', U(0x0415) + U(0x0420) + U(0x0406) + U(0x0421) + ' Systems', 'Amerigroup', 'Florida Blue', 'Carelon', 'MinuteClinic', 'Regence', U(0x0561) + 'etna', U(0x13AA) + 'etna', U(0xA4EE) + 'etna', U(0x04CF) + 'abcorp', U(0x051D) + 'algreens', U(0x1D0D) + 'ychart', 'Aet' + U(0x0578) + 'a', 'Hum-ana', 'Cig\nna', 'UnitedHeaIthcare'];
  for (const s of must) assert.ok(findBrands(s).length > 0, `not caught: ${JSON.stringify(s)}`);
});
test('brand denylist does not fire on ordinary billing text', () => {
  const clean = ['Medicare Part B deductible', 'healthcare provider', 'managed care marketing guidance', 'an epidemic', 'the horizon', 'HCA', 'Original Medicare', 'quartz countertop', 'careful marketing', 'the optimum plan',
    'the mycoplasma test', 'myopia screening', 'epicenter', 'members first', 'it was my choice', 'emerging therapies', 'humanity', 'medicare plans', 'a careful plan',
    'tenets of care', 'ascensions', 'Palmetto Street', 'first coast guard', 'an epic delay', 'NGS sequencing', 'the regency', 'novitiate'];
  // 'HCA' alone is a brand; everything else is clean
  for (const s of clean.filter((x) => x !== 'HCA')) assert.deepEqual(findBrands(s), [], `false positive on ${JSON.stringify(s)}`);
  assert.deepEqual(findBrands('HCA'), ['hca']);
});
