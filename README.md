# 🕹️ Squad Arcade

8 chaotic online party games you play on your phone with friends, from anywhere
(different wifi, mobile data, different countries). Built-in voice chat, text
chat, emoji reactions and a soundboard.

**Play:** https://subtoferalsloth11.github.io/squad-arcade/

## How to play with a friend

1. Open the site, pick a name (🎲 for a random silly one) and an avatar.
2. Tap **Create Room** and send the 5-letter code (or the 📤 invite link) to your friend.
3. Your friend opens the link (or types the code) and taps **Join**.
4. Tap **🎙️ Voice** to talk. Everyone in the room hears whoever has their mic on.
5. Pick a game. Everyone in the room jumps in. 2–8 players depending on the game.

## Games

| Game | Players | What it is |
| --- | --- | --- |
| 🎨 Doodle Duel | 2–8 | One draws, everyone guesses. Wrong guesses are public. |
| 🤠 Quick Draw | 2–8 | Wait for BANG, tap first. Fake-outs punish jumpy fingers. |
| 🏒 Air Hockey | 2 | Drag your mallet, first to 7. |
| 🍙 Bumper Sumo | 2–8 | Shove everyone off a shrinking arena. DASH to body-slam. |
| 🏍️ Light Cycles | 2–6 | Tron. Swipe to steer, trap your friends, it speeds up. |
| 🔮 Mind Reader | 2–8 | Unhinged would-you-rather: predict what your friend picks. |
| 🚢 Battleship | 2 | Classic naval war. A hit fires again. |
| 🔴 Connect Four | 2 | The classic with a 20-second shot clock. |

If a 2-player game is started in a bigger room, the starter plus a random
opponent play and everyone else spectates.

## Progression

XP for every game (bonus for wins, win streaks and your first game of the day),
levels with ridiculous titles, unlockable avatars, per-game stats and a rival
record against every friend you've played. Saved in your browser.

## How it works

- Static site, no build step, no server of our own: plain HTML/CSS/ES modules on GitHub Pages.
- Networking is peer-to-peer WebRTC through [PeerJS](https://peerjs.com) 1.5.4
  (vendored in `vendor/`). PeerJS' free cloud broker introduces the phones, and its
  STUN/TURN servers get the connection through home routers and mobile networks.
- The room creator's browser is the host and the referee: guests send inputs to the
  host, the host runs the game and broadcasts state (`js/net.js`). If the host
  leaves, the room closes.
- Voice chat is a mesh of WebRTC audio calls between everyone in the room (`js/voice.js`).
- All sound effects are synthesised live with WebAudio (`js/sfx.js`).

### Code map

```
index.html          app shell (home, room, drawers, modals)
css/style.css       all styling
js/app.js           UI controller, chat/reactions/soundboard, game runner, results
js/net.js           Room: host/join, message routing, validation, rate limits
js/voice.js         voice chat mesh + speaking indicators
js/profile.js       name/avatar, XP, levels, unlocks, stats
- Room codes are 5 characters (about 33 million combinations) on PeerJS' public
  broker, and anyone with the code can join while the room is open. Rooms only exist
  while the host's tab is open and hold at most 8 players.
js/sfx.js           synthesised sounds + soundboard list
js/games/*.js       one module per game; see "Adding a game"
```

### Adding a game

Create `js/games/<name>.js` exporting `{ id, title, emoji, blurb, min, max, color, start(api) }`
and add it to `js/games/index.js`. `start` runs on every phone; branch on
`api.isHost` for the referee logic. Key `api` members (built in `startGame()` in `js/app.js`):

- `api.send(d)`: any player → host input; host receives it via `api.onInput((from, d) => …)`.
- `api.broadcast(d)` / `api.sendTo(id, d)`: host → phones; received via `api.onState(d => …)`.
- `api.finish(winnerIds, text)`: host ends the game and shows results.
- `api.after`, `api.every`, `api.loop`, `api.listen`, `api.onCleanup`: timers and listeners that are cleaned up automatically when the game ends.

## Run locally

Any static file server works, e.g. `python3 -m http.server 8000`, then open
http://localhost:8000. Open it in two tabs to play against yourself. Mic access
needs `https://` or `localhost`.
