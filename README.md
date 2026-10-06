# XUL-J

**Stream the interface, not the page.** XUL-J is a JSON version of Mozilla's XUL, sent as a stream of
small operations. A producer (a server, an MQTT device, an unmodified desktop app behind a bridge, or a
language model) describes *what* to show and *what can be done*; any client decides how it looks.
User actions go back as intents. This repository holds the protocol, the browser renderer, the SSE and
MQTT transports, a terminal renderer and an MCP server for AI agents. No framework, Node 16+.

- Project site, live demo, LLM generator and bridge docs: <https://xul-j.github.io/>
- Desktop bridges: [net-bridge](https://github.com/xul-j/net-bridge) (.NET WinForms) and
  [java-bridge](https://github.com/xul-j/java-bridge) (Java Swing). Clone them next to this repo:
  they embed `public/` and reuse `protocol/`, `clients/` and `mcp/` in their tests.

**Status:** a working prototype with end-to-end tests for every transport, bridge and the MCP server.
There is no authentication anywhere; put producers behind your own access control.

## Quick start

    npm install
    npm start          # http://127.0.0.1:8080, the demo deploy console over SSE (PORT / HOST to override)
    npm run tty        # the same stream, rendered in a terminal
    npm test           # end-to-end checks against a real server

```jsonl
{"op":"command","id":"cmd_deploy","label":"Deploy","key":"ctrl+enter"}
{"op":"node","in":"root","tag":"window","id":"win","label":"Deploy console"}
{"op":"node","in":"win","tag":"toolbar","id":"tb","children":[{"tag":"toolbarbutton","command":"cmd_deploy"}]}
{"op":"node","in":"win","tag":"pending","id":"log","hint":"tree","flex":1}
{"op":"replace","id":"log","tag":"tree","cols":[{"id":"msg","label":"Message","flex":1}],"rows":{"source":"log"}}
{"op":"rows","source":"log","append":[{"msg":"build ok"}]}
```

## The protocol

### Operations (producer → client)

Every operation is one JSON object described by `protocol/schema.json`. The Node producers refuse to
send an invalid one; MQTT viewers and the generator validate what they receive; the bridges'
end-to-end tests validate everything the bridges emit.

| op | meaning |
|---|---|
| `node` | insert an element (with nested `children`) into `in`, optionally `before` a sibling or at an `order`; it waits if its parent has not arrived yet (a live overlay) |
| `replace` | swap an element for a new one, e.g. a `pending` placeholder becoming the real widget |
| `set` / `remove` | change an element's attributes (`replace: true` swaps them all), or remove it |
| `command` | declare or update an intent: `label`, `disabled`, `key`; every widget with `command: <id>` follows it |
| `broadcast` | set a named value; any attribute listed in `observes: {attr: broadcaster}` follows it |
| `rows` | `append` to (or `clear`) a data source; every `tree` bound to it updates |
| `theme` | design tokens for the interface (see Theming) |
| `reset` | drop all client state |
| `download` | *transient*: download a file the producer made (`url` must be `/download/<token>` on the same origin) |
| `notify` | *transient*: show a short message (`level`: info, warning, error) |

Transient ops reach live clients only and are never replayed, so a reconnect doesn't repeat them.

### Intents (client → producer)

| intent | sent when |
|---|---|
| `{"op":"do","command":"cmd_x"}` | a button, menu item or shortcut runs an enabled command |
| `{"op":"input","id":"x","value":…}` | a text box, checkbox or menulist changes (text is debounced) |
| `{"op":"select","id":"t","rows":[…]}` | the selection of a selectable tree changes |
| `{"op":"activate","id":"t","row":n}` | a tree row is double-clicked or Enter is pressed on it |
| `{"op":"contextmenu","id":"popup","target":"t"}` | a context menu opens over `target` (so the producer can run its opening logic) |
| `POST /upload?session=…&id=<picker>` | a file is chosen in a `filepicker` (name in `X-Filename`) |

Producers check intents against their current state: unknown targets get 404 and disabled commands 409.

### Elements

| tag | key attributes |
|---|---|
| `window` | `label`; `modal` and `icon` (info, warning, error, question) for dialogs, which make the other windows inert |
| `vbox`, `hbox`, `box`, `spacer`, `groupbox`, `toolbar`, `statusbar`, `deck`, `tabbox` / `tabpanel` | layout: `flex`, `width`, `height`, `align`, `label`, `selectedIndex` |
| `label`, `description` | `value`; `class` for roles (`danger`, `warning`, `success`, `muted`, `mono`, `primary`) |
| `button`, `toolbarbutton` | `command` (and optionally `label`) |
| `textbox` | `value`, `placeholder`, `password`, `multiline` |
| `checkbox`, `menulist` | `label`, `value` / `options`, `selectedIndex` |
| `tree` | `cols`, `rows: {source}`, `seltype` (none, single, multiple), `selection`, `contextmenu` |
| `progressmeter`, `pending`, `filepicker` | `value` / `hint` / `accept`, `multiple` |
| `menubar`, `menu`, `menuitem`, `menuseparator`, `menupopup` | `label`, `accesskey` (`alt+f`), `command`, `checked` |

Common attributes: `id`, `flex`, `disabled`, `hidden`, `observes`, `order`, `contextmenu`.

**Menus** open and close in the client, with no round trip: click, hover across the bar, arrow keys,
Home/End, Escape and access keys. Only choosing an item sends `do`. Items show their command's
shortcut, and `checked` pairs well with `observes` for radio-style groups.

**Selection and context menus.** A selectable `tree` reacts to click, Ctrl/Shift-click and the arrow
keys at once, and the producer's `selection` attribute confirms (or corrects) it. An element with
`contextmenu` opens that `menupopup` on right-click (selecting the row first), Shift+F10 or the Menu key.

**Theming.** `{"op":"theme","tokens":{…},"dark":{…}}` carries design tokens, never CSS: colours
(`accent`, `accentText`, `surface`, `background`, `chrome`, `text`, `muted`, `border`, `danger`,
`warning`, `success`), `radius` (0–16), `density` (compact, normal, comfortable) and `font` (system,
serif, mono, rounded, classic). The client applies them as CSS variables scoped to the app root, and
the viewer wins: high-contrast mode ignores producer colours, dark mode uses only an explicit `dark`
palette, and colour pairs below WCAG contrast are dropped. The demo console's View › Theme switches
between three presets.

**Files.** A modal `filepicker` uploads to the producer; a `download` op asks the client to fetch a
file. The desktop bridges use these for open and save dialogs.

## SSE transport

`server.js` keeps a numbered op log per session. A client that reconnects sends `Last-Event-ID` and
receives only what it missed; a new client rebuilds the identical UI from the log. Intents arrive as
small POSTs to `/intent?session=…`.

## MQTT transport

The interface lives in retained topics on a broker. The publisher holds no viewer connections, a late
joiner gets the current UI with nothing to replay, and any device that can publish MQTT can publish
its own interface.

    # broker setup (once): publisher passwords live in mqtt/.env, never in git
    printf 'XULJ_DEPLOY_PASSWORD=%s\nXULJ_GREENHOUSE_PASSWORD=%s\n' $(openssl rand -hex 16) $(openssl rand -hex 16) > mqtt/.env
    . mqtt/.env; touch mqtt/passwd; mkdir -p mqtt/data
    docker run --rm -v "$PWD/mqtt":/w eclipse-mosquitto:2 sh -c \
      "mosquitto_passwd -b /w/passwd deploy $XULJ_DEPLOY_PASSWORD && mosquitto_passwd -b /w/passwd greenhouse $XULJ_GREENHOUSE_PASSWORD"
    sudo chown 1883:1883 mqtt/passwd mqtt/acl mqtt/data && sudo chmod 600 mqtt/passwd mqtt/acl
    docker run -d --name xulj-mosquitto -p 1884:1883 -p 9101:9001 \
      -v "$PWD/mqtt/mosquitto.conf":/mosquitto/config/mosquitto.conf:ro -v "$PWD/mqtt/passwd":/mosquitto/config/passwd:ro \
      -v "$PWD/mqtt/acl":/mosquitto/config/acl:ro -v "$PWD/mqtt/data":/mosquitto/data eclipse-mosquitto:2

    npm run mqtt:app     # the deploy console, published to xulj/deploy/
    npm run mqtt:device  # a simulated greenhouse publishing its own UI to xulj/greenhouse/
    open http://<host>:8080/mqtt.html   (?apps=deploy,greenhouse&broker=ws://host:9101)
    npm run test:mqtt    # end-to-end against the broker (restarts xulj/deploy)

| topic (prefix `xulj/<app>/`) | retained | payload |
|---|---|---|
| `node/<id>` | yes | element `{in, tag, order, ...attrs}`; an empty payload removes it |
| `cmd/<id>` | yes | command state; empty deletes it |
| `bc/<id>` | yes | `{value}` |
| `rows/<src>/epoch` | yes | `{epoch}`; a newer epoch clears the source |
| `rows/<src>/ring/<k>` | yes | `{epoch, n, row}`: the last N rows, for late joiners |
| `rows/<src>/live` | no | `{epoch, n0, rows}` |
| `do/<cmd>`, `input/<id>` | no | viewer intents, the only topics anonymous clients may publish |

Retained messages arrive in any order: nodes wait for their parent, and `order` fixes sibling
position. Viewers validate every payload against the schema, because no server sits in between, and
the broker ACL limits each publisher to its own namespace.

## MCP: let AI agents operate any XUL-J interface

`mcp/server.js` is an MCP server (stdio, no dependencies). It connects to an SSE endpoint (this
server, or a bridge hosting a legacy desktop app) as its own session and gives agents the semantic
tree instead of screenshots:

    claude mcp add xulj -- node /path/to/xul-j/mcp/server.js --url http://127.0.0.1:8092

| tool | does |
|---|---|
| `connect` | connect to a XUL-J URL (unless `--url` or `XULJ_URL` was given) |
| `get_ui` | the interface as an outline: ids, labels, values, commands, tables, dialogs |
| `list_commands` | every command with its label, shortcut and enabled state |
| `do_command` | run a command, as clicking its button or menu item would |
| `set_value` | type into a text box, tick a checkbox, pick a menulist option (by label) |
| `read_table` / `select_rows` / `activate_row` | read rows as JSON, select, double-click |
| `open_context_menu` | open a right-click menu (the producer enables items) and list its commands |
| `upload_file` / `download_file` | answer file dialogs: give the app a file, fetch what it saved |
| `wait_for` | wait for text or an element after something slow |

Every action settles and then reports what changed (`+` added, `-` removed, `~` changed,
`!` notifications, `↓` downloads), with enable/disable flips summarised, so an agent rarely needs to
re-read the screen.

## Repository layout

| path | contents |
|---|---|
| `protocol/schema.json`, `protocol/validate.js` | the JSON Schema and a dependency-free validator (Node and browser) |
| `protocol/model.js` | headless client and text renderer (used by tests, the terminal client and MCP) |
| `protocol/mqtt-topics.js` | MQTT topics → ops, for the browser and Node |
| `public/` | the browser renderer (`xulj.js`, `xul.css`) and the SSE (`index.html`) and MQTT (`mqtt.html`) pages |
| `server.js`, `app/deploy-console.js` | the SSE server and the demo app |
| `transport/mqtt-publisher.js`, `mqtt-app.js`, `devices/greenhouse.js`, `mqtt/` | the MQTT transport, the demo app over MQTT, a self-describing device, broker config |
| `clients/` | a Node SSE client and the terminal renderer |
| `mcp/server.js` | the MCP server |
| `test/` | `e2e.js` (SSE), `mqtt-e2e.js` (MQTT, needs the broker), `mcp-e2e.js` (MCP) |

## Known gaps

- **MQTT** carries elements, commands, broadcasters, rows and the `do`/`input` intents only:
  `theme`, `notify`, selection, activation and context-menu intents are not mapped to topics yet.
  A viewer that disconnects misses live rows (it gets the retained ring), all viewers share one UI
  per app, and anonymous viewers can flood intent topics.
- **SSE**: the op log is never compacted, so a reconnect replays everything; there is no session
  epoch, so a client resuming against a restarted server can resume wrongly.
- **MCP** speaks to SSE endpoints only, and inherits their lack of authentication.
- A virtualized tree tops out near the browser's maximum element height (about 800k rows in Firefox).
- The DOM renderer and `model.js` implement the same semantics twice.

## License

MIT
