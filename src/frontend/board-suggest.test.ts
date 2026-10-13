/**
 * The suggested Monday board, against the real TDC Marketing & PR board names
 * as read on 12 Oct 2026.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore -- a plain browser module, tested as it ships
import { suggestBoard, initials } from '../../public/board-suggest.js';

const boards = [
  'NP Activations Board (2026)', 'NP Activations Board', 'NP COMPLETED Activations Board',
  'FS Activations Board (2026)', 'FS Activations Board', 'FS COMPLETED Activations Board 2023/2024',
  'FP Activations Board (2026)', 'FP Activations Board', 'TP COMPLETED Activations Board 2023/2024',
  'SOCMED | NP 2025', 'SOCMED | FS 2025', 'NP Guest Feedback', 'Neon Pigeon — Brand Strategy',
  'GD MKTG Requests', 'Guest Information for Lucky Draw',
].map((name, i) => ({ id: String(i + 1), name }));

test('each venue gets this year\'s activation board', () => {
  assert.equal(initials('Firangi Superstar'), 'FS');
  assert.equal(suggestBoard('Neon Pigeon', boards, 2026).name, 'NP Activations Board (2026)');
  assert.equal(suggestBoard('Firangi Superstar', boards, 2026).name, 'FS Activations Board (2026)');
  assert.equal(suggestBoard('Fat Prince', boards, 2026).name, 'FP Activations Board (2026)');
  assert.match(suggestBoard('Neon Pigeon', boards, 2026).why, /NP, Activations, 2026/);
});

test('a completed board is never suggested, and a tie suggests nothing', () => {
  const only = [{ id: '1', name: 'NP COMPLETED Activations Board' }];
  assert.equal(suggestBoard('Neon Pigeon', only, 2026), null);
  const tie = [{ id: '1', name: 'NP Activations A' }, { id: '2', name: 'NP Activations B' }];
  assert.equal(suggestBoard('Neon Pigeon', tie, 2026), null);
  assert.equal(suggestBoard('Somewhere New', boards, 2026), null);
});

test('next year, last year\'s board is not preferred over an undated one', () => {
  // 2027 event, no 2027 board yet: the undated board beats the 2026 one.
  assert.equal(suggestBoard('Neon Pigeon', boards, 2027).name, 'NP Activations Board');
});
