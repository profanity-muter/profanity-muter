// The shipped package must not contain remote code/model hosts (CWS Blue Argon
// rejection of 0.1.59). Scans the built dist/ plus everything else the zip ships.
const assert = require('assert');
const { scan } = require('../scripts/remote_scan.js');

const hits = scan();
assert.strictEqual(hits.length, 0, 'remote code/model hosts in package:\n' + hits.map((h) => `  ${h.file}: ...${h.snippet}...`).join('\n'));
console.log('no_remote_code_test: ok');
