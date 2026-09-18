import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  TRACE_EVENT_KINDS,
  toRecord,
  createSpendLedger,
  openProcessRecord,
  closeProcessOutcome,
} from '../dist/trace-events.js';
import { REDACTED } from '../dist/redact.js';
import * as traceEventsModule from '../dist/trace-events.js';

/**
 * Hostile strings: each one tests a specific redaction or flattening case.
 * The test verifies these do not survive in the payload toRecord returns.
 */
const HOSTILE = {
  // GitHub tokens by shape
  classicToken: 'ghp_S3cretT0kenInTheTitle000000000000000',
  fineGrainedToken: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrs',
  opaqueToken: 'v1.0123456789abcdef0123456789abcdef01234567',

  // Fullwidth-decomposed token: must be normalised BEFORE redaction
  fullwidthToken: '\uff47\uff48\uff50\uff3f' + 'S3cretT0kenInTheTitle000000000000000',

  // Bidi control characters
  bidi: 'safe\u202Ehidden\u202Dtext',

  // Line/paragraph separators (U+2028, U+2029)
  lineSeparator: 'line1\u2028line2',
  paragraphSeparator: 'para1\u2029para2',

  // Marker line that must not leak
  markerLine: '@exolvra-genesis round P1 | 1 | WIN |',

  // ANSI escape sequences
  ansiEscape: '\u001b[31mred\u001b[0m text',

  // Embedded newlines and tabs
  newlines: 'line1\nline2\rline3',
  tabs: 'col1\tcol2\tcol3',
};

/**
 * Checks that a string does not contain any hostile content.
 * Returns the first hostile pattern found, or null if clean.
 */
function findHostileContent(str) {
  if (typeof str !== 'string') return null;

  // GitHub tokens (check for the identifiable parts)
  if (str.includes('ghp_') && str.includes('S3cretT0ken')) return 'classic token';
  if (str.includes('github_pat_')) return 'fine-grained token';
  if (str.includes('v1.0123456789')) return 'opaque token';

  // The fullwidth token normalises to ghp_ so same check applies
  // (If it did not normalise, the original fullwidth chars would be here)
  if (str.includes('\uff47\uff48\uff50')) return 'fullwidth token (not normalised)';

  // Bidi controls
  if (/[\u202A-\u202E\u2066-\u2069]/.test(str)) return 'bidi control';

  // Line/paragraph separators
  if (str.includes('\u2028')) return 'line separator U+2028';
  if (str.includes('\u2029')) return 'paragraph separator U+2029';

  // ANSI escapes
  if (/\u001b\[/.test(str)) return 'ANSI escape';

  // Raw newlines and carriage returns
  if (str.includes('\n') || str.includes('\r')) return 'embedded newline';

  // Raw tabs
  if (str.includes('\t')) return 'embedded tab';

  return null;
}

/**
 * Recursively walks an object and checks all strings for hostile content.
 * Returns an array of paths where hostile content was found.
 */
function findAllHostile(value, path = '') {
  const found = [];
  if (typeof value === 'string') {
    const hostile = findHostileContent(value);
    if (hostile !== null) {
      found.push({ path, hostile, value });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      found.push(...findAllHostile(item, path + '[' + i + ']'));
    });
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      found.push(...findAllHostile(value[key], path + '.' + key));
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Criterion 1: Closed union covering all twelve kinds                         */
/* -------------------------------------------------------------------------- */

describe('TRACE_EVENT_KINDS covers trace and live monitoring events', () => {
  const expectedKinds = [
    'run_started',
    'run_finished',
    'piece_dispatched',
    'builder_round_started',
    'builder_round_ended',
    'critic_dispatched',
    'verdict_recorded',
    'gate_check',
    'pin_check',
    'budget_spend',
    'error_path',
    'process_event',
    'activity',
    'stalled',
    'budget_warning',
  ];

  test('TRACE_EVENT_KINDS has exactly the declared kinds', () => {
    const kinds = Object.keys(TRACE_EVENT_KINDS);
    assert.equal(kinds.length, expectedKinds.length, 'unexpected event vocabulary size');
  });

  test('TRACE_EVENT_KINDS includes every expected kind', () => {
    for (const kind of expectedKinds) {
      assert.equal(
        TRACE_EVENT_KINDS[kind],
        true,
        'missing kind: ' + kind,
      );
    }
  });

  test('TRACE_EVENT_KINDS has no unexpected kinds', () => {
    const kinds = Object.keys(TRACE_EVENT_KINDS);
    for (const kind of kinds) {
      assert.ok(
        expectedKinds.includes(kind),
        'unexpected kind: ' + kind,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 3: toRecord returns proper shape with piece/round as null         */
/* -------------------------------------------------------------------------- */

describe('toRecord builds records with correct shape', () => {
  test('toRecord returns Omit<TraceRecord, seq> with all required fields', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: 'test', source: 'spec' },
    };
    const ctx = { runId: 'r-test-001', at: 1234567890000 };
    const record = toRecord(event, ctx);

    // Check all required fields exist
    assert.ok('at' in record, 'missing at');
    assert.ok('runId' in record, 'missing runId');
    assert.ok('kind' in record, 'missing kind');
    assert.ok('piece' in record, 'missing piece');
    assert.ok('round' in record, 'missing round');
    assert.ok('payload' in record, 'missing payload');

    // Check seq is NOT present (store assigns it)
    assert.ok(!('seq' in record), 'seq should not be present');

    // Check values
    assert.equal(record.at, 1234567890000);
    assert.equal(record.runId, 'r-test-001');
    assert.equal(record.kind, 'run_started');
  });

  test('piece and round are null when not provided, never absent', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: 'test', source: 'spec' },
    };
    const ctx = { runId: 'r-test-001' };
    const record = toRecord(event, ctx);

    assert.equal(record.piece, null, 'piece should be null, not undefined');
    assert.equal(record.round, null, 'round should be null, not undefined');
  });

  test('piece and round are preserved when provided', () => {
    const event = {
      kind: 'builder_round_started',
      piece: 'P1',
      round: 3,
      payload: { attempt: 2 },
    };
    const ctx = { runId: 'r-test-001' };
    const record = toRecord(event, ctx);

    assert.equal(record.piece, 'P1');
    assert.equal(record.round, 3);
  });

  test('at defaults to current time when not provided in context', () => {
    const before = Date.now();
    const event = {
      kind: 'run_started',
      payload: { goal: 'test', source: 'spec' },
    };
    const ctx = { runId: 'r-test-001' };
    const record = toRecord(event, ctx);
    const after = Date.now();

    assert.ok(record.at >= before, 'at should be >= time before call');
    assert.ok(record.at <= after, 'at should be <= time after call');
  });
});

/* -------------------------------------------------------------------------- */
/* Null piece handling: the fix for the null/undefined seam mismatch           */
/* -------------------------------------------------------------------------- */

describe('toRecord handles null and absent piece correctly', () => {
  const ctx = { runId: 'r-test-001', at: 1234567890000 };

  test('toRecord with piece: null returns record with piece: null and does not throw', () => {
    // This is the defect that was fixed: passing null to sanitizeString threw
    // because null !== undefined is true, so it tried to call .normalize() on null.
    const event = {
      kind: 'run_started',
      piece: null,
      round: null,
      payload: { goal: 'test', source: 'spec' },
    };

    // Must not throw
    const record = toRecord(event, ctx);

    // Assert on the returned record
    assert.equal(record.piece, null, 'piece should be null in the returned record');
    assert.equal(record.round, null, 'round should be null in the returned record');
    assert.equal(record.kind, 'run_started');
    assert.equal(record.runId, 'r-test-001');
  });

  test('toRecord with piece field absent still returns piece: null', () => {
    // The existing behaviour: absent piece becomes null, not undefined
    const event = {
      kind: 'run_started',
      payload: { goal: 'test', source: 'spec' },
    };

    const record = toRecord(event, ctx);

    assert.equal(record.piece, null, 'absent piece should become null');
    assert.ok('piece' in record, 'piece field must be present, not absent');
  });

  test('null piece and absent piece produce the same record field for field', () => {
    // This pins the invariant: null and undefined both map to null in the output.
    // If someone fixes the null case by simply never sanitising piece, this test
    // still passes, but test 4 (string piece sanitisation) would fail.
    const eventWithNull = {
      kind: 'run_started',
      piece: null,
      round: null,
      payload: { goal: 'test', source: 'spec' },
    };
    const eventWithAbsent = {
      kind: 'run_started',
      payload: { goal: 'test', source: 'spec' },
    };

    const recordNull = toRecord(eventWithNull, ctx);
    const recordAbsent = toRecord(eventWithAbsent, ctx);

    // Compare all fields
    assert.equal(recordNull.at, recordAbsent.at);
    assert.equal(recordNull.runId, recordAbsent.runId);
    assert.equal(recordNull.kind, recordAbsent.kind);
    assert.equal(recordNull.piece, recordAbsent.piece);
    assert.equal(recordNull.round, recordAbsent.round);
    assert.deepEqual(recordNull.payload, recordAbsent.payload);
  });

  test('string piece with hostile content is still sanitised', () => {
    // This test closes the lazy cheat: making null work by never sanitising piece.
    // A string piece carrying a token and bidi control must come back sanitised.
    // Structure: visible text, then bidi, then token, then more text.
    const hostilePiece = 'prefix-' + '\u202E' + HOSTILE.classicToken + '-suffix';
    const event = {
      kind: 'builder_round_started',
      piece: hostilePiece,
      round: 1,
      payload: { attempt: 1 },
    };

    const record = toRecord(event, ctx);

    // The token must be redacted
    assert.ok(
      !record.piece.includes('ghp_'),
      'token prefix in piece should be redacted',
    );
    assert.ok(
      !record.piece.includes('S3cretT0ken'),
      'token body in piece should be redacted',
    );
    // Bidi control must be stripped
    assert.ok(
      !record.piece.includes('\u202E'),
      'bidi control in piece should be stripped',
    );
    // Visible text survives
    assert.ok(
      record.piece.includes('prefix'),
      'prefix text in piece should survive',
    );
    assert.ok(
      record.piece.includes('suffix'),
      'suffix text in piece should survive',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 4: Redaction funnel cannot be skipped (C5)                        */
/* -------------------------------------------------------------------------- */

describe('C5 - redaction is not optional and not bypassable', () => {
  /**
   * Builds an event of each kind with hostile content in every string field,
   * passes it through toRecord, and asserts nothing hostile survives in the
   * payload that toRecord actually returned.
   *
   * This test walks TRACE_EVENT_KINDS, so adding a new kind that dodges the
   * funnel will fail this test.
   */
  test('every kind in TRACE_EVENT_KINDS passes through the redaction funnel', () => {
    const kinds = Object.keys(TRACE_EVENT_KINDS);
    const ctx = { runId: 'r-test-001', at: Date.now() };

    for (const kind of kinds) {
      // Build a payload with hostile content in every string field
      const hostilePayload = buildHostilePayload(kind);
      const event = {
        kind,
        piece: HOSTILE.classicToken, // Also test piece field
        round: 1,
        payload: hostilePayload,
      };

      const record = toRecord(event, ctx);

      // Assert on the RECORD that toRecord returned, not on our helpers
      const hostileFound = findAllHostile(record.payload);
      assert.deepEqual(
        hostileFound,
        [],
        'kind ' + kind + ' has hostile content in payload: ' + JSON.stringify(hostileFound),
      );

      // Also check the piece field was sanitised (tokens should be redacted)
      // The token should be replaced with [redacted]
      if (record.piece !== null) {
        const pieceHostile = findHostileContent(record.piece);
        assert.equal(
          pieceHostile,
          null,
          'kind ' + kind + ' has hostile content in piece field: ' + pieceHostile,
        );
      }
    }
  });

  /**
   * Builds a payload with hostile strings appropriate for each event kind.
   */
  function buildHostilePayload(kind) {
    switch (kind) {
      case 'run_started':
        return { goal: HOSTILE.classicToken, source: 'spec' };
      case 'run_finished':
        return {
          status: 'win',
          rounds: 1,
          costUsd: 0.5,
          sessionId: HOSTILE.fineGrainedToken,
        };
      case 'piece_dispatched':
        return { pieceId: HOSTILE.opaqueToken, title: HOSTILE.fullwidthToken };
      case 'builder_round_started':
        return { attempt: 1 };
      case 'builder_round_ended':
        return {
          attempt: 1,
          verbatimVerification: true,
          verificationOutput: HOSTILE.ansiEscape + HOSTILE.newlines,
        };
      case 'critic_dispatched':
        return { criticId: HOSTILE.bidi };
      case 'verdict_recorded':
        return { verdict: 'WIN', gap: HOSTILE.lineSeparator };
      case 'gate_check':
        return { gate: HOSTILE.paragraphSeparator, passed: true, detail: HOSTILE.tabs };
      case 'pin_check':
        return { pin: HOSTILE.markerLine, passed: false, detail: HOSTILE.classicToken };
      case 'budget_spend':
        return { inputTokens: 100, outputTokens: 50, costUsd: 0.01 };
      case 'error_path':
        return { fault: HOSTILE.ansiEscape, detail: HOSTILE.bidi };
      case 'process_event':
        return {
          action: 'opened',
          taskId: HOSTILE.fullwidthToken,
          role: 'builder',
        };
      default:
        return { data: HOSTILE.classicToken };
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Criterion 5: Specific hostile inputs, each pinned by test                   */
/* -------------------------------------------------------------------------- */

describe('hostile input handling', () => {
  const ctx = { runId: 'r-test-001', at: Date.now() };

  test('GitHub token by shape (classic) is redacted', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: 'before ' + HOSTILE.classicToken + ' after', source: 'spec' },
    };
    const record = toRecord(event, ctx);

    // Assert on the record toRecord returned
    assert.ok(!record.payload.goal.includes('ghp_'), 'classic token prefix should be redacted');
    assert.ok(!record.payload.goal.includes('S3cretT0ken'), 'classic token body should be redacted');
    // Surrounding text survives
    assert.ok(record.payload.goal.includes('before'), 'text before token should survive');
    assert.ok(record.payload.goal.includes('after'), 'text after token should survive');
  });

  test('GitHub token by shape (fine-grained) is redacted', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: 'token: ' + HOSTILE.fineGrainedToken + ' end', source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(!record.payload.goal.includes('github_pat_'), 'fine-grained token should be redacted');
    assert.ok(record.payload.goal.includes('token:'), 'surrounding text should survive');
    assert.ok(record.payload.goal.includes('end'), 'surrounding text should survive');
  });

  test('GitHub token by shape (opaque installation) is redacted', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: 'key=' + HOSTILE.opaqueToken + ';', source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(!record.payload.goal.includes('v1.0123456789'), 'opaque token should be redacted');
    assert.ok(record.payload.goal.includes('key='), 'surrounding text should survive');
  });

  test('fullwidth-decomposed token is normalised BEFORE redaction', () => {
    // The fullwidth characters FF47 FF48 FF50 FF3F normalise to ghp_ in NFKC
    // If normalisation happens AFTER redaction, the token would not be caught
    const event = {
      kind: 'run_started',
      payload: { goal: 'secret: ' + HOSTILE.fullwidthToken, source: 'spec' },
    };
    const record = toRecord(event, ctx);

    // After normalisation and redaction, neither the fullwidth chars nor
    // the token body should remain
    assert.ok(!record.payload.goal.includes('\uff47'), 'fullwidth g should be normalised away');
    assert.ok(!record.payload.goal.includes('S3cretT0ken'), 'token body should be redacted after normalisation');
    assert.ok(record.payload.goal.includes('secret:'), 'surrounding text should survive');
  });

  test('bidi control characters are removed', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: HOSTILE.bidi, source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(!record.payload.goal.includes('\u202E'), 'RLO should be removed');
    assert.ok(!record.payload.goal.includes('\u202D'), 'LRO should be removed');
    // The visible text remains
    assert.ok(record.payload.goal.includes('safe'), 'visible text should survive');
    assert.ok(record.payload.goal.includes('hidden'), 'visible text should survive');
    assert.ok(record.payload.goal.includes('text'), 'visible text should survive');
  });

  test('U+2028 line separator is removed', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: HOSTILE.lineSeparator, source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(!record.payload.goal.includes('\u2028'), 'U+2028 should be removed');
    assert.ok(record.payload.goal.includes('line1'), 'text should survive');
    assert.ok(record.payload.goal.includes('line2'), 'text should survive');
  });

  test('U+2029 paragraph separator is removed', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: HOSTILE.paragraphSeparator, source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(!record.payload.goal.includes('\u2029'), 'U+2029 should be removed');
    assert.ok(record.payload.goal.includes('para1'), 'text should survive');
    assert.ok(record.payload.goal.includes('para2'), 'text should survive');
  });

  test('marker line is flattened (control chars removed)', () => {
    // The marker line itself is just text, but if it had control chars they would be stripped
    const event = {
      kind: 'run_started',
      payload: { goal: '\n' + HOSTILE.markerLine + '\n', source: 'spec' },
    };
    const record = toRecord(event, ctx);

    // Newlines become spaces in flattening
    assert.ok(!record.payload.goal.includes('\n'), 'newlines should be removed');
    // The text content survives (the marker line is just text, not actually harmful)
    assert.ok(record.payload.goal.includes('@exolvra-genesis'), 'marker text survives flattening');
  });

  test('ANSI escape sequences are removed', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: HOSTILE.ansiEscape, source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(!record.payload.goal.includes('\u001b'), 'ESC should be removed');
    assert.ok(!record.payload.goal.includes('[31m'), 'ANSI sequence should be removed');
    assert.ok(!record.payload.goal.includes('[0m'), 'ANSI reset should be removed');
    assert.ok(record.payload.goal.includes('red'), 'text should survive');
    assert.ok(record.payload.goal.includes('text'), 'text should survive');
  });

  test('embedded newlines and carriage returns are removed', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: HOSTILE.newlines, source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(!record.payload.goal.includes('\n'), 'LF should be removed');
    assert.ok(!record.payload.goal.includes('\r'), 'CR should be removed');
    assert.ok(record.payload.goal.includes('line1'), 'text should survive');
    assert.ok(record.payload.goal.includes('line2'), 'text should survive');
    assert.ok(record.payload.goal.includes('line3'), 'text should survive');
  });

  test('embedded tabs are removed', () => {
    const event = {
      kind: 'run_started',
      payload: { goal: HOSTILE.tabs, source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(!record.payload.goal.includes('\t'), 'tabs should be removed');
    assert.ok(record.payload.goal.includes('col1'), 'text should survive');
    assert.ok(record.payload.goal.includes('col2'), 'text should survive');
    assert.ok(record.payload.goal.includes('col3'), 'text should survive');
  });

  test('redaction does not consume surrounding text', () => {
    const before = 'important context before ';
    const after = ' important context after';
    const event = {
      kind: 'run_started',
      payload: { goal: before + HOSTILE.classicToken + after, source: 'spec' },
    };
    const record = toRecord(event, ctx);

    assert.ok(record.payload.goal.includes('important context before'), 'text before survives');
    assert.ok(record.payload.goal.includes('important context after'), 'text after survives');
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 6: Spend ledger accumulates, does not overwrite (R5)              */
/* -------------------------------------------------------------------------- */

describe('R5 - spend accumulates across retries', () => {
  /**
   * Floating point comparison with tolerance for cost values.
   * Costs are USD values that may accumulate with floating point error.
   */
  function assertCostEqual(actual, expected, message) {
    const tolerance = 1e-10;
    assert.ok(
      Math.abs(actual - expected) < tolerance,
      message + ': expected ' + expected + ', received ' + actual,
    );
  }

  test('a round attempted three times accumulates all attempts', () => {
    const ledger = createSpendLedger();

    // Three attempts at round 1 of piece P1
    ledger.record('P1', 1, { inputTokens: 1000, outputTokens: 500, costUsd: 0.10 });
    ledger.record('P1', 1, { inputTokens: 2000, outputTokens: 1000, costUsd: 0.20 });
    ledger.record('P1', 1, { inputTokens: 500, outputTokens: 250, costUsd: 0.05 });

    const roundSpend = ledger.roundTotal('P1', 1);

    // Assert accumulated, not overwritten: 0.10 + 0.20 + 0.05 = 0.35
    assertCostEqual(roundSpend.costUsd, 0.35, 'cost should be 0.35, not 0.05 (last attempt)');
    assert.equal(roundSpend.inputTokens, 3500, 'inputTokens should accumulate');
    assert.equal(roundSpend.outputTokens, 1750, 'outputTokens should accumulate');
  });

  test('piece total is the sum of its rounds', () => {
    const ledger = createSpendLedger();

    ledger.record('P1', 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.10 });
    ledger.record('P1', 2, { inputTokens: 200, outputTokens: 100, costUsd: 0.20 });
    ledger.record('P1', 3, { inputTokens: 150, outputTokens: 75, costUsd: 0.15 });

    const pieceSpend = ledger.pieceTotal('P1');

    assertCostEqual(pieceSpend.costUsd, 0.45, 'piece cost is sum of rounds');
    assert.equal(pieceSpend.inputTokens, 450, 'piece inputTokens is sum of rounds');
    assert.equal(pieceSpend.outputTokens, 225, 'piece outputTokens is sum of rounds');
  });

  test('run total is the sum of its pieces', () => {
    const ledger = createSpendLedger();

    ledger.record('P1', 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.10 });
    ledger.record('P1', 2, { inputTokens: 100, outputTokens: 50, costUsd: 0.10 });
    ledger.record('P2', 1, { inputTokens: 200, outputTokens: 100, costUsd: 0.20 });
    ledger.record('P3', 1, { inputTokens: 300, outputTokens: 150, costUsd: 0.30 });

    const runSpend = ledger.runTotal();

    assertCostEqual(runSpend.costUsd, 0.70, 'run cost is sum of pieces');
    assert.equal(runSpend.inputTokens, 700, 'run inputTokens is sum of pieces');
    assert.equal(runSpend.outputTokens, 350, 'run outputTokens is sum of pieces');
  });

  test('cost is what was reported, not re-derived', () => {
    // This test ensures we use the reported costUsd, not compute it from tokens
    const ledger = createSpendLedger();

    // Report a cost that does not match token * rate
    ledger.record('P1', 1, { inputTokens: 1000, outputTokens: 500, costUsd: 12.34 });

    const roundSpend = ledger.roundTotal('P1', 1);
    assert.equal(roundSpend.costUsd, 12.34, 'cost should be exactly what was reported');
  });

  test('unknown piece returns zero spend', () => {
    const ledger = createSpendLedger();
    const spend = ledger.pieceTotal('nonexistent');

    assert.equal(spend.costUsd, 0);
    assert.equal(spend.inputTokens, 0);
    assert.equal(spend.outputTokens, 0);
  });

  test('unknown round returns zero spend', () => {
    const ledger = createSpendLedger();
    ledger.record('P1', 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.10 });

    const spend = ledger.roundTotal('P1', 99);

    assert.equal(spend.costUsd, 0);
    assert.equal(spend.inputTokens, 0);
    assert.equal(spend.outputTokens, 0);
  });

  test('pieces() returns all recorded pieces', () => {
    const ledger = createSpendLedger();

    ledger.record('P1', 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.10 });
    ledger.record('P2', 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.10 });
    ledger.record('P3', 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.10 });

    const pieces = ledger.pieces();
    assert.equal(pieces.length, 3);
    assert.ok(pieces.includes('P1'));
    assert.ok(pieces.includes('P2'));
    assert.ok(pieces.includes('P3'));
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 7: C1 - no predicate over TraceRecord                             */
/* -------------------------------------------------------------------------- */

describe('C1 - nothing here reads stored records to decide', () => {
  test('module exports no predicate over TraceRecord', () => {
    // Get all exported functions
    const exportedFunctions = Object.entries(traceEventsModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);

    // A predicate over TraceRecord would take a TraceRecord and return a boolean
    // or make a decision. The known functions are:
    // - toRecord: takes an event and context, returns a record (does not read)
    // - createSpendLedger: returns a ledger (does not read TraceRecord)
    // - openProcessRecord: takes args, returns process fields (does not read)
    // - closeProcessOutcome: takes outcome, returns outcome (does not read)

    const allowed = ['toRecord', 'createSpendLedger', 'openProcessRecord', 'closeProcessOutcome'];

    for (const name of exportedFunctions) {
      assert.ok(
        allowed.includes(name),
        'unexpected exported function: ' + name + '. If this is intentional, verify it does not read TraceRecord to decide anything.',
      );
    }

    // Verify each allowed function is actually exported
    for (const name of allowed) {
      assert.ok(
        exportedFunctions.includes(name),
        'expected function not exported: ' + name,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 8: Process record constructors                                    */
/* -------------------------------------------------------------------------- */

describe('process record constructors', () => {
  test('openProcessRecord creates proper shape', () => {
    const before = Date.now();
    const proc = openProcessRecord('r-001', 'task-123', 'builder', 'P1', 2);
    const after = Date.now();

    assert.equal(proc.runId, 'r-001');
    assert.equal(proc.taskId, 'task-123');
    assert.equal(proc.role, 'builder');
    assert.equal(proc.piece, 'P1');
    assert.equal(proc.round, 2);
    assert.ok(proc.openedAt >= before);
    assert.ok(proc.openedAt <= after);

    // closedAt and outcome are not present (Omit<TraceProcess, 'closedAt' | 'outcome'>)
    assert.ok(!('closedAt' in proc));
    assert.ok(!('outcome' in proc));
  });

  test('openProcessRecord handles null piece and round', () => {
    const proc = openProcessRecord('r-001', 'task-456', 'lead', null, null);

    assert.equal(proc.piece, null);
    assert.equal(proc.round, null);
  });

  test('closeProcessOutcome returns the outcome', () => {
    assert.equal(closeProcessOutcome('complete'), 'complete');
    assert.equal(closeProcessOutcome('failed'), 'failed');
    assert.equal(closeProcessOutcome('died'), 'died');
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 2: Typed payloads                                                 */
/* -------------------------------------------------------------------------- */

describe('typed payloads for each kind', () => {
  const ctx = { runId: 'r-test-001', at: Date.now() };

  test('builder_round_ended carries verbatimVerification field', () => {
    const event = {
      kind: 'builder_round_ended',
      piece: 'P1',
      round: 1,
      payload: {
        attempt: 1,
        verbatimVerification: true,
        verificationOutput: 'all tests passed',
      },
    };
    const record = toRecord(event, ctx);

    assert.equal(record.payload.verbatimVerification, true);
    assert.ok(record.payload.verificationOutput.includes('all tests passed'));
  });

  test('verdict_recorded carries gap field', () => {
    const event = {
      kind: 'verdict_recorded',
      piece: 'P1',
      round: 1,
      payload: {
        verdict: 'LOSS',
        gap: 'The output did not match the expected format',
      },
    };
    const record = toRecord(event, ctx);

    assert.equal(record.payload.verdict, 'LOSS');
    assert.ok(record.payload.gap.includes('output did not match'));
  });

  test('error_path carries fault field', () => {
    const event = {
      kind: 'error_path',
      payload: {
        fault: 'TIMEOUT',
        detail: 'Builder did not respond within 5 minutes',
      },
    };
    const record = toRecord(event, ctx);

    assert.equal(record.payload.fault, 'TIMEOUT');
    assert.ok(record.payload.detail.includes('5 minutes'));
  });
});

/* -------------------------------------------------------------------------- */
/* Deep nesting: ensure sanitisation reaches nested structures                 */
/* -------------------------------------------------------------------------- */

describe('sanitisation reaches nested structures', () => {
  const ctx = { runId: 'r-test-001', at: Date.now() };

  test('hostile content in nested object is sanitised', () => {
    const event = {
      kind: 'run_started',
      payload: {
        goal: 'test',
        source: 'spec',
        nested: {
          deep: {
            secret: HOSTILE.classicToken,
          },
        },
      },
    };
    const record = toRecord(event, ctx);

    // The payload returned by toRecord should have the nested secret redacted
    const nested = record.payload.nested;
    assert.ok(nested !== undefined);
    const deep = nested.deep;
    assert.ok(deep !== undefined);
    assert.ok(!deep.secret.includes('ghp_'), 'nested token should be redacted');
  });

  test('hostile content in array is sanitised', () => {
    const event = {
      kind: 'run_started',
      payload: {
        goal: 'test',
        source: 'spec',
        items: [HOSTILE.classicToken, HOSTILE.ansiEscape, 'normal'],
      },
    };
    const record = toRecord(event, ctx);

    const items = record.payload.items;
    assert.ok(Array.isArray(items));
    assert.ok(!items[0].includes('ghp_'), 'array item 0 should be redacted');
    assert.ok(!items[1].includes('\u001b'), 'array item 1 should have ANSI removed');
    assert.equal(items[2], 'normal', 'safe items unchanged');
  });
});
