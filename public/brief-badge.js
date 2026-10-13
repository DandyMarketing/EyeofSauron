/**
 * The "Weekly brief" menu link and its badge (Khai, 13 Oct 2026: the weekly
 * brief "needs to live better ... no one actually knows it's there").
 *
 * Every page's menu carries the link; this fills in how many items in the
 * latest week the person has not opened yet. The server counts it with the
 * same venue and role filter as the brief itself, and answers 0 rather than
 * an error, so a broken count never puts a message in the menu.
 */
export async function briefBadge(token) {
  const link = document.querySelector('a[data-brief-link]');
  if (!link || !token) return;
  try {
    const res = await fetch('/api/brief/unseen', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return;
    const { count } = await res.json();
    // The menu's own helper (in every page's menu): draws or clears the badge
    // and remembers it, so the next page paints it before it asks.
    if (window.setNavBrief) window.setNavBrief(count);
    if (count > 0) link.title = count + (count === 1 ? ' new item' : ' new items') + ' in this week\'s brief';
  } catch { /* a badge is a nicety: say nothing */ }
}

/** Opening the brief clears the badge on every device. */
export function markBriefSeen(token) {
  if (!token) return;
  if (window.setNavBrief) window.setNavBrief(0);
  fetch('/api/brief/seen', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
}
