// shared/badge.js
// Plain script (NOT an ES module), loaded by background.js via
// importScripts and require()d by test/badge_test.js.
// Defines globalThis.PMBadge.
//
// WHY THIS EXISTS (0.1.56)
// ------------------------
// Field observation, 2026-09-17: a new user finished onboarding, started a
// video, and could not tell whether she was protected. Both surfaces were
// working exactly as designed, and that was the bug:
//
//   * The on-player pill said "Protected". She never found it. It lives in
//     the top-left corner of the player, it is small by design, and it
//     shares that corner with YouTube's own chrome.
//   * The toolbar badge said nothing, because until this release the badge
//     only spoke when something was WRONG (a per-tab health failure, or the
//     global review nudge). "No badge" meant "protected", which is
//     reassurance nobody can see.
//
// So the toolbar now mirrors what the pill presents, and does it with the
// two channels a toolbar action has: the badge text/colour, and the action
// icon itself. Greyed icon means "not doing anything here"; coloured icon
// with a green count means "working, and here is how much it has caught".
// A user can answer "am I protected?" from the toolbar without opening
// anything, which is the whole point.
//
// PURE ON PURPOSE. Nothing here touches chrome.*, the DOM, or the clock.
// background.js owns the per-tab bookkeeping and the setBadgeText/setIcon
// calls; this file owns the decision, so the whole table is checkable in
// node (test/badge_test.js) rather than only on someone's toolbar.

(function (root) {
  "use strict";

  // ---- the two icon sets -------------------------------------------------
  //
  // Named rather than pathed here, because a path map is a chrome.action
  // concern and this module has no business knowing the manifest's layout.
  // background.js turns these names into the path objects.
  var ICON_COLOR = "color";
  // The "off" set is the colour icon at 35% opacity, not a greyscale one. The
  // owner compared both on a real toolbar (2026-09-17): greyscale reads as a
  // different icon, faded reads as this icon switched off, which is the
  // message. Rendered by tools/fade-icons.mjs from icons/icon*.png.
  var ICON_OFF = "off";

  // ---- badge text and colour ---------------------------------------------
  //
  // Chrome truncates badge text past about four characters, so every string
  // below is at most four. "99+" is the cap for the same reason a car's
  // odometer has a width: past a point the exact number stops being the
  // information and "a lot" is.
  var MAX_BADGE_CHARS = 4;
  var COUNT_CAP = 99;
  var COUNT_CAP_TEXT = "99+";

  var TEXT_HEALTH = "!";
  var TEXT_WORKING = "…"; // one ellipsis character, not three dots: three would be four glyphs wide
  var TEXT_PROTECTED_ZERO = "ON";

  // Red matches the warning pill and the popup's health banner, so the one
  // alarming state looks the same on every surface it can appear on.
  var COLOR_HEALTH = "#8a1f11";
  // Amber for "working on it". Deliberately not red: nothing is wrong
  // during analysis, and a user who learns that amber means trouble will
  // read the genuine red the same way.
  var COLOR_WORKING = "#D89B12";
  // Green for protected. The only state that is allowed to be green, so
  // green on the toolbar means exactly one thing.
  var COLOR_PROTECTED = "#1E8E3E";

  // shared/health.js's stable public string, kept as a literal for the same
  // reason shared/moments.js keeps it as one: this module loads in contexts
  // that never load that one.
  var STATUS_UNHEALTHY = "unhealthy";

  // The pill's presented states that are documented LIMITS rather than
  // states of our filter. See shared/pill.js present(): "shorts" and "live"
  // both come with their own calm on-player notice, and a permanent toolbar
  // mark for "this is a Short" would train users to ignore the badge,
  // costing exactly the signal the health case depends on. Extended in
  // 0.1.56 to also grey the icon, which says "not filtering here" without
  // claiming anything is broken.
  var LIMIT_STATES = ["shorts", "live"];

  // The pill's presented state for "the extension is switched off".
  var OFF_STATE = "off";

  // The presented state that means we are actually filtering.
  var PROTECTED_STATE = "protected";

  function isLimitState(presented) {
    return LIMIT_STATES.indexOf(presented) !== -1;
  }

  // What N muted words shows as. Zero never reaches here (the caller shows
  // "ON" instead): a green "0" reads as a score, and the thing being
  // reported is protection, not a tally that starts badly.
  function countText(n) {
    var count = Number(n);
    if (!isFinite(count) || count <= 0) return TEXT_PROTECTED_ZERO;
    count = Math.floor(count);
    return count > COUNT_CAP ? COUNT_CAP_TEXT : String(count);
  }

  // badgeState(state) -> {text, color, iconSet}
  //
  // state:
  //   healthStatus  shared/health.js status for THIS tab, or null
  //   presented     shared/pill.js present().presented for this tab, or null
  //   mutedCount    words muted so far in THIS video (content.js session.mutedCount)
  //   enabled       pm_enabled
  //   isWatchPage   this tab is on a YouTube watch page
  //
  // PRIORITY, in the order the branches appear below. Health is first and
  // stays first: "your filter is not working" is the one thing a user needs
  // whether or not they asked, and it has outranked everything on this
  // badge since 0.1.33. Nothing added in 0.1.56 may displace it.
  function badgeState(state) {
    state = state || {};

    if (state.healthStatus === STATUS_UNHEALTHY) {
      // Colour icon, not grey: this tab IS a video we are supposed to be
      // filtering, and a grey icon under a red "!" would read as "off",
      // which is the opposite of the message.
      return { text: TEXT_HEALTH, color: COLOR_HEALTH, iconSet: ICON_COLOR };
    }

    // Nowhere to filter, or nothing to filter with. Grey, silent. This is
    // the common case across a browser full of tabs, and it is also the
    // default the action starts in.
    if (state.isWatchPage !== true || state.enabled === false || state.presented === OFF_STATE) {
      return { text: "", color: null, iconSet: ICON_OFF };
    }

    // Documented limits: grey, silent, same as not being on a video at all,
    // because from the filter's point of view that is what it is.
    if (isLimitState(state.presented)) {
      return { text: "", color: null, iconSet: ICON_OFF };
    }

    if (state.presented === PROTECTED_STATE) {
      return {
        text: countText(state.mutedCount),
        color: COLOR_PROTECTED,
        iconSet: ICON_COLOR
      };
    }

    // Everything else on a watch page is a transient routine state:
    // "analyzing", "needs-play", "other-tab", and any presented state a
    // future release adds. They all mean the same thing to the person
    // looking at the toolbar, which is "working on it, not yet". Falling
    // through to amber rather than listing them means a new pill state
    // cannot silently produce a blank toolbar, which is the exact failure
    // this release exists to fix.
    return { text: TEXT_WORKING, color: COLOR_WORKING, iconSet: ICON_COLOR };
  }

  var PMBadgeCore = {
    ICON_COLOR: ICON_COLOR,
    ICON_OFF: ICON_OFF,
    MAX_BADGE_CHARS: MAX_BADGE_CHARS,
    COUNT_CAP: COUNT_CAP,
    COUNT_CAP_TEXT: COUNT_CAP_TEXT,
    TEXT_HEALTH: TEXT_HEALTH,
    TEXT_WORKING: TEXT_WORKING,
    TEXT_PROTECTED_ZERO: TEXT_PROTECTED_ZERO,
    COLOR_HEALTH: COLOR_HEALTH,
    COLOR_WORKING: COLOR_WORKING,
    COLOR_PROTECTED: COLOR_PROTECTED,
    LIMIT_STATES: LIMIT_STATES,
    countText: countText,
    badgeState: badgeState
  };

  root.PMBadge = PMBadgeCore;

  // Also expose via module.exports for Node tests, without turning this
  // into an ES module (same pattern as moments.js/pill.js/wordlist.js).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMBadgeCore: PMBadgeCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
