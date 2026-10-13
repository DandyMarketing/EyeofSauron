/**
 * Which Monday board a venue's event tasks most likely belong on.
 *
 * Khai, 13 Oct 2026: "put a default suggested board ... looking at board
 * titles. NP Activations Board (2026) is this year's NP activation board."
 * Rules, not a model: the same titles always give the same suggestion, and a
 * person still sees it and the preview before anything is written.
 *
 *   venue initials (Neon Pigeon -> NP) or full name in the title  +3  (required)
 *   "activation"                                                   +2
 *   the event's year                                               +2
 *   a different year                                               -1
 *   "completed" or "archive"                                       ruled out
 *
 * A tie at the top suggests NOTHING: two equally good boards is a question for
 * the person, not a coin toss.
 */

export function initials(venueName) {
  return String(venueName || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('');
}

export function suggestBoard(venueName, boards, year) {
  const ini = initials(venueName);
  const full = String(venueName || '').toLowerCase();
  const scored = [];
  for (const b of boards || []) {
    const name = String(b.name || '');
    if (/completed|archive/i.test(name)) continue;
    const tokens = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    const why = [];
    let score = 0;
    if (ini.length >= 2 && tokens.includes(ini)) { score += 3; why.push(ini); }
    else if (full && name.toLowerCase().includes(full)) { score += 3; why.push(venueName); }
    else continue;
    if (/activation/i.test(name)) { score += 2; why.push('Activations'); }
    const years = (name.match(/\b20\d{2}\b/g) || []);
    if (years.includes(String(year))) { score += 2; why.push(String(year)); }
    else if (years.length) score -= 1;
    scored.push({ id: b.id, name, score, why });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return { id: scored[0].id, name: scored[0].name, why: 'matches ' + scored[0].why.join(', ') };
}
