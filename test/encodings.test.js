// Kodlama tanıma öz-denetimi: node test/encodings.test.js
import assert from 'node:assert/strict';
import { decodeCandidates, rot, atbash } from '../src/core/encodings.js';

const best = (s) => decodeCandidates(s)[0];
const plain = 'the secret endpoint is hidden here';
const b64 = Buffer.from(plain).toString('base64');
assert.equal(best(b64).encoding, 'base64');
assert.equal(best(b64).text, plain);
assert.equal(best(Buffer.from(plain).toString('hex')).text, plain);
const b32 = (buf) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += A[(value << (5 - bits)) & 31];
  return out;
};
assert.equal(best(b32(Buffer.from(plain))).text, plain);
assert.equal(best('&#116;&#104;&#101; &#115;ecret endpoint').text, 'the secret endpoint');
assert.equal(best(rot(plain, 13)).text, plain);
assert.equal(best(atbash(plain)).text, plain);
const xored = Buffer.from([...Buffer.from(plain)].map((b) => b ^ 0x5a)).toString('hex');
const x = best(xored);
assert.equal(x.text, plain);
assert.equal(x.key, '0x5a');
assert.deepEqual(decodeCandidates('normal readable sentence here'), []);
// Vigenère: yeterince uzun metinde anahtar sütun sütun ki-kare ile bulunur
const long = 'send the stolen card numbers to the collection server every night at three';
let ki = 0;
const vig = long.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 'key'.charCodeAt(ki++ % 3) - 97) % 26) + 97));
const v = decodeCandidates(vig).find((c) => c.encoding === 'vigenere');
assert.ok(v, 'vigenere adayı');
assert.equal(v.key, 'key');
console.log('encodings: ok');
