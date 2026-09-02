// Guard: no em-dash (U+2014) and no "honest"/variants anywhere in shipped or authored files.
// Copy standard: use commas, periods, or plain hyphens instead.
var fs = require("fs"), path = require("path");
var root = path.join(__dirname, "..");
// models/ holds fetched third-party Whisper weights and tokenizer vocab
// (0.1.44), not authored source - excluded like node_modules/dist.
var skip = ["node_modules", "dist", ".git", "models"];
var bad = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach(function (name) {
    if (skip.indexOf(name) !== -1) return;
    var p = path.join(dir, name);
    var st = fs.statSync(p);
    if (st.isDirectory()) return walk(p);
    if (!/\.(js|mjs|html|css|md|json)$/.test(name)) return;
    var txt = fs.readFileSync(p, "utf8");
    if (txt.indexOf("\u2014") !== -1) bad.push(p + " (em-dash)");
    if (p.indexOf("no_emdash_test") === -1 && /honest/i.test(txt)) bad.push(p + " (honest)");
  });
})(root);
if (bad.length) { console.error("no_emdash_test.js: FAIL em-dash in:", bad.join(", ")); process.exit(1); }
console.log("no_emdash_test.js: 1/1 passed");
