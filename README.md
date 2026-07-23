# Mölgu — a Mölkky scorekeeper

Three files, no build step, no dependencies. Open `index.html` in a browser — that's it.
Works offline and from the filesystem (`file://`), so it also drops onto any static host as-is.

```
index.html   markup + the two dialogs
style.css    responsive layout, light/dark
app.js       state, scoring, undo history
```

## How it works

State is one plain object: players, each player's list of throws, the rules config, and whose
turn it is. Every change replaces that object with a modified copy and pushes the old one onto
an undo stack — so undoing a throw, a rename, a player removal or a rule change all work the
same way. The whole `{past, present, future}` stack is written to `localStorage` on every
change, which is why history survives a reload.

Scores are never stored. They're recomputed from the throw lists on every render, so editing a
throw from ten turns ago instantly corrects everything downstream, including who is eliminated
and whose turn it is.

## Rules implemented

- Throw values 1–12, or a miss (0).
- Exactly 50 wins; going over drops you back to 25.
- Three misses in a row eliminates you; any scoring throw resets the streak.
- Last player standing also wins.
- A win is announced but doesn't stop the game: dismiss the banner with **Keep playing**
  and everyone else carries on for 2nd, 3rd, … place. The banner comes back for each
  new finisher. Play only really ends when nobody is left who could throw.

All three numbers (target, overshoot score, misses allowed) are editable in ⚙ at any time and
apply retroactively.

## Using it

- Players are added at the bottom of the list; the list order *is* the throwing order.
- `⋯` on a player row: rename, reorder, force the turn to them, or remove them. Works mid-game.
- Tap any past throw to change or delete it; `+` adds a throw you forgot to record.
- Keyboard: `1`–`9` score, `0` misses, `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo.
  10, 11 and 12 are buttons only.
