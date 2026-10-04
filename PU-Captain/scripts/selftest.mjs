import assert from 'node:assert/strict';
import { sign, verify } from '../api/_lib/jwt.js';
import { validateVoter, validateIncident, normalizePhone, isNgMobile } from '../api/_lib/validate.js';

const S = 'x'.repeat(40);
const id = '11111111-2222-3333-4444-555555555555';

// JWT
const t = sign({ sub: id }, S);
assert.equal(verify(t, S).sub, id);
assert.equal(verify(t, 'y'.repeat(40)), null);
assert.equal(verify(t.slice(0, -2) + 'xx', S), null);
assert.equal(verify(sign({ sub: id }, S, -10), S), null);
const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
assert.equal(verify(`${none}.${t.split('.')[1]}.`, S), null);

// Phones
assert.equal(normalizePhone('+234 803 456 7890'), '08034567890');
assert.ok(isNgMobile('08034567890'));
assert.ok(!isNgMobile('12345'));

// Voters
const base = { id, full_name: 'Test Voter', pvc_status: 'has', sentiment: 'support', issues: ['Jobs', 'Bogus'], consent_given: true, consent_at: new Date().toISOString(), client_created_at: new Date().toISOString() };
const ok = validateVoter({ ...base, phone: '0803 456 7890' });
assert.ok(ok.ok); assert.deepEqual(ok.value.issues, ['Jobs']); assert.equal(ok.value.phone_last4, '7890');
assert.equal(validateVoter({ ...base, consent_given: false }).error, 'consent_required');
assert.equal(validateVoter({ ...base, consent_given: 'true' }).error, 'consent_required');
assert.equal(validateVoter({ ...base, pvc_status: 'x' }).error, 'bad_pvc');
assert.equal(validateVoter({ ...base, id: 'nope' }).error, 'bad_id');
assert.equal(validateVoter({ ...base, phone: '123' }).error, 'bad_phone');
const future = validateVoter({ ...base, client_created_at: '2999-01-01T00:00:00Z' });
assert.ok(Date.parse(future.value.client_created_at) <= Date.now());

// Incidents
assert.ok(validateIncident({ id, type: 'violence', severity: 'sos', client_created_at: new Date().toISOString(), lat: 6.5, lng: 3.3 }).ok);
assert.equal(validateIncident({ id, type: 'x', severity: 'sos', client_created_at: new Date().toISOString() }).error, 'bad_type');
assert.equal(validateIncident({ id, type: 'other', severity: 'low', client_created_at: new Date().toISOString(), lat: 999 }).value.lat, null);

console.log('selftest passed');
