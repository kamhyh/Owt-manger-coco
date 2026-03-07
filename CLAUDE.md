# CLAUDE.md

## Project Overview

Blanc Manger Coco — a browser-based multiplayer card game (French party game similar to Cards Against Humanity). Hosted as a static site on GitHub Pages with peer-to-peer multiplayer via PeerJS (no backend server).

## File Structure

```
index.html   — Single-page app with all screens (menu, lobby, game, result, game over)
style.css    — Light theme styling, responsive, mobile-friendly
cards.js     — Card data: QUESTION_CARDS[] and ANSWER_CARDS[] arrays
game.js      — Game engine: PeerJS networking, lobby, game logic, UI rendering
```

All files are at the root — no build step, no bundler, no dependencies beyond PeerJS (loaded via CDN).

## Architecture

- **Hosting**: GitHub Pages (static files only)
- **Multiplayer**: PeerJS for WebRTC peer-to-peer connections. Host creates a room, guests connect using a 5-char room code. The host is the source of truth for all game state.
- **State flow**: Host maintains `gameState`, broadcasts personalized snapshots to each player. Clients render from received state — they never mutate game state directly.
- **Peer IDs**: Prefixed with `bmc-coco-` + room code for the host. Guests get auto-generated IDs.

## Game Flow

1. Host creates room → gets room code
2. Players join with code, set their name
3. Host starts game (min 3 players)
4. Each round: judge draws question card, others pick an answer card (tap to select, tap again to confirm)
5. Judge picks best answer → winner gets a point
6. First to N points wins (configurable: 3/5/7/10)

## Key Conventions

- **Language**: All UI text is in French
- **No build tools**: Edit files directly. No npm, no transpilation.
- **No server**: Everything runs client-side. PeerJS cloud handles signaling.
- **Design**: Clean light theme (cream `#f5f0eb` background, black `#1a1a1a` question cards, white answer cards). No neon, no glows, no uppercase buttons. Keep it minimal and natural-looking.
- **Cards**: `____` is the blank placeholder in question cards. The `cards.js` arrays are the single source for all card content.

## Development

Open `index.html` in a browser — that's it. No install, no build.

To add cards, edit the arrays in `cards.js`. To change game rules, edit `game.js`. Styling is in `style.css`.

## Deployment

Set GitHub Pages source to the branch root. The site serves `index.html` directly.
