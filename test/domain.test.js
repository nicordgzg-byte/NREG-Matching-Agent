import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicParse, scoreMatch } from '../src/domain.js';

test('parses a demand in Spanish with Mexican prices', () => {
  const record = deterministicParse('Busco departamento en Polanco, mínimo 150 m2, 3 recámaras, 2 estacionamientos, máximo 9 mdp.');
  assert.equal(record.record_type, 'DEMAND');
  assert.equal(record.property_type, 'APARTMENT');
  assert.equal(record.price_max, 9_000_000);
  assert.equal(record.area_min_m2, 150);
  assert.equal(record.bedrooms_min, 3);
  assert.equal(record.parking_min, 2);
  assert.ok(record.zones.some((zone) => zone.toLowerCase().includes('polanco')));
});

test('parses an offer and extracts source metadata', () => {
  const record = deterministicParse('Ofrezco depa en Santa Fe, $8.7M, 168 m2, 3 rec, 2 coches. Grupo: Ofrezco Santa Fe');
  assert.equal(record.record_type, 'OFFER');
  assert.equal(record.price_min, 8_700_000);
  assert.equal(record.source_group, 'Ofrezco Santa Fe');
});

test('returns a strong bidirectional match', () => {
  const demand = deterministicParse('Busco departamento en Polanco, mínimo 150 m2, 3 recámaras, 2 estacionamientos, máximo 9 mdp.');
  demand.confidence = 0.95;
  const offer = deterministicParse('Ofrezco departamento en Polanco, $8.7M, 168 m2, 3 recámaras, 2 estacionamientos.');
  offer.confidence = 0.95;
  const match = scoreMatch(offer, demand);
  assert.ok(match);
  assert.ok(match.score >= 80);
  assert.ok(match.objectiveMatches >= 2);
});

test('rejects incompatible zones', () => {
  const demand = deterministicParse('Busco departamento en Polanco hasta 9 mdp.');
  const offer = deterministicParse('Ofrezco departamento en Coyoacán por 8 mdp.');
  assert.equal(scoreMatch(offer, demand), null);
});
