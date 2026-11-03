'use strict';
const fs = require('node:fs');
const path = require('node:path');
process.stdout.write('AAW_NODE_BEGIN\n');
process.stderr.write('AAW_NODE_STDERR\n');
const input = JSON.parse(fs.readFileSync(process.env.AAW_BASELINE, 'utf8'));
const writeDenied = file => {
  try { const fd = fs.openSync(file, 'r+'); fs.closeSync(fd); return false; }
  catch (error) { if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error; return true; }
};
const baselineWriteDenied = writeDenied(process.env.AAW_BASELINE);
const controlWriteDenied = writeDenied(process.env.AAW_CONTROL);
if (!baselineWriteDenied || !controlWriteDenied) throw new Error('Expected isolated write denial missing');
const directory = path.join(process.cwd(), 'nested', 'level two');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ schema: 'aaw.command.probe.output.v1', sum: input.reduce((a, b) => a + b, 0), baselineWriteDenied, controlWriteDenied, cwd: process.cwd(), pid: process.pid, ppid: process.ppid, runtime: process.execPath }) + '\n', { flag: 'wx' });
process.stdout.write('AAW_NODE_RESULT=42\n');
setTimeout(() => { process.stdout.write('AAW_NODE_END\n'); }, 350);
