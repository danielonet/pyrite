#!/usr/bin/env node
// Regenerates src/translator/imports/jdkClasses.ts from the JDK on PATH (needs `java` 17+).
// Run it when moving the index to a newer JDK; the output is committed.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const script = path.join(__dirname, 'JdkIndex.java');
const out = path.join(__dirname, '..', 'src', 'translator', 'imports', 'jdkClasses.ts');
const ts = execFileSync('java', [script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ts, 'utf8');
const packages = (ts.match(/^  '/gm) || []).length;
console.log(`Wrote ${path.relative(process.cwd(), out)} (${packages} packages)`);
