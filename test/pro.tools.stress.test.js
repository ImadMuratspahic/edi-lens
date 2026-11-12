'use strict';

/*
 * Large inputs for the Pro tools: a 50 MB file per format is anonymised, checked against partner
 * rules, queried, renumbered, acknowledged and split in a process whose heap is limited to 1 GB.
 * The EDIFACT file is one message of 1.4 million segments, the X12 and HL7 files hold hundreds of
 * thousands of small messages. Set EDI_LENS_SKIP_STRESS=1 to leave these runs out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SKIP = process.env.EDI_LENS_SKIP_STRESS === '1';

function runChild(format, megabytes) {
  const script = path.join(__dirname, 'helpers', 'protools-stress-child.js');
  const run = spawnSync(process.execPath, ['--max-old-space-size=1024', script, format, String(megabytes)], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 420000, windowsHide: true,
  });
  assert.equal(run.status, 0, 'the child failed (out of memory or an error): ' + String(run.stderr).slice(-600));
  return JSON.parse(run.stdout);
}

for (const format of ['edifact', 'x12', 'hl7']) {
  test('stress: the Pro tools work through a 50 MB ' + format + ' file inside a 1 GB heap', { skip: SKIP }, () => {
    const r = runChild(format, 50);
    assert.ok(r.chars >= 50 * 1024 * 1024);
    assert.ok(r.heapPeakMB < 900, 'peak heap ' + r.heapPeakMB + ' MB');
    // Anonymise: every segment read, the length unchanged, the table in memory capped.
    assert.equal(r.anonymise.ok, true);
    assert.equal(r.anonymise.sameLength, true);
    assert.equal(r.anonymise.segments, r.segments);
    assert.ok(r.anonymise.changed >= r.messages);
    assert.ok(r.anonymise.mapSize <= 100000);
    // Partner rules: every message checked, no violation in the well-formed file.
    assert.equal(r.rules.ok, true);
    assert.deepEqual([r.rules.units, r.rules.unitsChecked, r.rules.violations, r.rules.truncated], [r.messages, r.messages, 0, false]);
    // Query: the one or two messages that match are found.
    assert.equal(r.query.ok, true);
    assert.equal(r.query.units, r.messages);
    assert.equal(r.query.matches, format === 'x12' ? 2 : 1);
    assert.equal(r.query.firstUnit, format === 'edifact' ? 1 : 42);
    // Renumber keeps the length (all numbers keep their width in these files).
    assert.equal(r.renumber.ok, true);
    assert.equal(r.renumber.sameLength, true);
    assert.equal(r.renumber.changed, format === 'edifact' ? 4 : format === 'x12' ? r.messages * 2 + 4 : r.messages);
    if (format === 'x12') {
      // More than 200,000 messages in one file: split and acknowledge say so instead of trying.
      assert.equal(r.split.code, 'ENV-BAD-ENVELOPE');
      assert.equal(r.acknowledge.ok, false);
    } else {
      assert.equal(r.split.ok, true);
      assert.equal(r.split.parts, r.messages);
      assert.equal(r.acknowledge.ok, true);
      assert.deepEqual([r.acknowledge.acknowledged, r.acknowledge.rejected], [r.messages, 0]);
    }
    for (const key of ['anonymiseMs', 'rulesMs', 'queryMs', 'renumberMs', 'acknowledgeMs', 'splitMs']) assert.ok(r[key] < 120000, key + ' ' + r[key]);
  });
}
