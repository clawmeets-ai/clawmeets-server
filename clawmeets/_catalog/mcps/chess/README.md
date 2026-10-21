# Chess MCP

Deterministic chess referee backed by [`python-chess`](https://python-chess.readthedocs.io/). Install this MCP on the **gamemaster** agent of a chess match — players propose moves in chat as plain text, the gamemaster validates them through this MCP, and the state is published to the chatroom files so every participant (and any browser page) sees the same board.

## Tools

| Tool | Purpose |
|---|---|
| `start_game(game_id, white_name, black_name)` | Create a new board at the starting position and lay out the per-game viewer directory. Returns `state_json_content` (for the gamemaster to publish into the chatroom so other agents can read) and `view_path` (absolute path to `board.html` the user opens in a browser). |
| `make_move(game_id, color, move)` | Apply a move. Rejects if `color` doesn't match `board.turn` or if the move is illegal. On success returns `ok`, `san`, `uci`, `fen`, `is_game_over`, `result`, `move_number`, plus `state_json_content`. On rejection returns `error`. The MCP writes `board_state.json` + `board_state.js` to the game's viewer directory automatically — the gamemaster only needs to publish `state_json_content` to the chatroom. |
| `post_narration(game_id, text)` | Append a narrator comment (≤1000 chars) to the game. Attaches to the most recently played ply so the live board viewer can render it alongside the move. Called by the **gamemaster** — it relays the narrator agent's chat commentary verbatim so the single per-agent MCP state directory stays consistent. |
| `get_state(game_id)` | Re-read the canonical state for a game (FEN, PGN, active color, move history, narration, result). |
| `get_legal_moves(game_id, from_square=None)` | List legal SAN moves in the current position, optionally filtered by source square. |
| `resign(game_id, color)` | End the game by resignation. |
| `list_games()` | Enumerate all game ids with state files in this MCP's state directory. |

## State directory

The MCP resolves `CLAWMEETS_CHESS_STATE_DIR` (injected by the ClawMeets runner — it points at `{agent_dir}/mcp-hub/servers/chess/`). Per-game files live at:

```
{state_dir}/games/{game_id}/
  board_state.json   # canonical state (MCP reads+writes this)
  board_state.js     # wrapper the browser viewer loads on every tick
  board.html         # static viewer page (written once on start_game)
```

The MCP writes `board_state.json` + `board_state.js` on every `start_game`, `make_move`, `resign`, and `post_narration` — narration entries live inside `board_state.json` under a `narration: []` list, so the viewer renders them on the same 1.5 s tick as move updates. The MCP does not push anything into the chatroom — the gamemaster is expected to forward `state_json_content` as `board_state.json` into the chatroom so the player agents (white, black, narrator) can read the position.

## Board viewer

`start_game` writes a self-contained HTML page to `{state_dir}/games/{game_id}/board.html` and returns its absolute path in `view_path`. The gamemaster forwards that path to the user, who opens it in any browser via `file://` — no HTTP server required.

The viewer polls `./board_state.js` every 1.5 s by appending a cache-busted `<script>` tag. We use `<script>` rather than `fetch()` because Chrome blocks `fetch()` from `file://` origins. The `board_state.js` file is a 1-line `window.__CHESS_STATE = {...};` wrapper that the MCP rewrites atomically on every move.

## Dependencies

`python-chess>=1.10` (ships with the `clawmeets` runner package).
