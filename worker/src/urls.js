/**
 * Url rules shared by everything that puts a remote image into the page.
 *
 * These live in their own module rather than next to the profile sanitiser
 * because a game cover now appears in three places - a post, a game chip and a
 * chat message - and three copies of the same regex are three chances to disagree
 * about what a safe image url is. The rule is deliberately about the *scheme and
 * the shape*, not the filename: Roblox's own thumbnail urls end in a format token
 * such as `.../GameIcon6/Png/noFilter` and have no extension at all, so any check
 * that wants `.png` throws away every real cover.
 *
 * Refused: a scheme that executes (`javascript:`, `data:`, `vbscript:`), a
 * protocol-relative url whose host is not ours to vouch for, `http:`, and any
 * character that could break out of an HTML attribute (`<`, `>`, `"`, `'`,
 * whitespace including a newline).
 */
export const LOGO_URL = /^https:\/\/[^\s<>"']{3,280}$/;

/**
 * The same rule for a game cover, with a length of its own. Kept as a separate
 * constant rather than a parameterised helper so that widening one - a cover
 * host allowlist, say - cannot quietly widen the other.
 */
export const COVER_URL = /^https:\/\/[^\s<>"']{3,600}$/;

/**
 * True for a url the browser may put in an <img> without the page being at risk.
 *
 * The budget picks the rule: the two regexes differ only in length, so asking for
 * 600 permits a game cover and asking for 280 permits a logo. Neither widens the
 * other, which is the whole point of keeping them apart.
 */
export function isSafeImageUrl(value, max = 600) {
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (!t || t.length > max) return false;
  return (max <= 280 ? LOGO_URL : COVER_URL).test(t);
}