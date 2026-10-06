# XUL-J

A prototype that streams JSON-ized XUL to clients. An app emits UI operations; clients send
back intents (`do <command>`, `input <id> <value>`). Two transports carry the same app:

- **SSE**: `server.js` holds a session and an op log per viewer (no dependencies).
- **MQTT**: the UI lives in retained topics on a broker. The publisher holds no viewer
  connections; viewers and devices talk to the broker only (needs the `mqtt` package).

    npm start          # http://127.0.0.1:8080 (PORT / HOST to override)
    npm test           # end-to-end test against a real server
    npm run tty        # terminal renderer for the same stream

    # MQTT broker setup (once): publisher passwords live in mqtt/.env, never in git
    printf 'XULJ_DEPLOY_PASSWORD=%s\nXULJ_GREENHOUSE_PASSWORD=%s\n' $(openssl rand -hex 16) $(openssl rand -hex 16) > mqtt/.env
    . mqtt/.env; touch mqtt/passwd; mkdir -p mqtt/data
    docker run --rm -v "$PWD/mqtt":/w eclipse-mosquitto:2 sh -c \
      "mosquitto_passwd -b /w/passwd deploy $XULJ_DEPLOY_PASSWORD && mosquitto_passwd -b /w/passwd greenhouse $XULJ_GREENHOUSE_PASSWORD"
    sudo chown 1883:1883 mqtt/passwd mqtt/acl mqtt/data && sudo chmod 600 mqtt/passwd mqtt/acl
    docker run -d --name xulj-mosquitto -p 1884:1883 -p 9101:9001 \
      -v "$PWD/mqtt/mosquitto.conf":/mosquitto/config/mosquitto.conf:ro -v "$PWD/mqtt/passwd":/mosquitto/config/passwd:ro \
      -v "$PWD/mqtt/acl":/mosquitto/config/acl:ro -v "$PWD/mqtt/data":/mosquitto/data eclipse-mosquitto:2

    # MQTT (broker: docker container xulj-mosquitto, tcp 1884, websockets 9101)
    npm run mqtt:app     # deploy console published to xulj/deploy/
    npm run mqtt:device  # simulated greenhouse publishing its own UI to xulj/greenhouse/
    open http://<host>:8091/mqtt.html  (?apps=deploy,greenhouse&broker=ws://host:9101)
    npm run test:mqtt    # end-to-end against the broker (restarts xulj/deploy)

Project site and live demos: <https://xul-j.github.io/>, including an LLM generator where a model
of your choice (through OpenRouter, with your own key) streams an interface as XUL-J and then acts
as its backend.

Bridges serve existing desktop applications through the same SSE protocol and browser client:
[xul-j/net-bridge](https://github.com/xul-j/net-bridge) for .NET WinForms and
[xul-j/java-bridge](https://github.com/xul-j/java-bridge) for Java Swing. Clone them next to this
repo; they embed `public/` and reuse `protocol/` and `clients/` for their tests.

## Layout

- `protocol/schema.json`: JSON Schema for every server → client op
- `protocol/validate.js`: validator; the server refuses to emit an invalid op
- `protocol/model.js`: headless client plus a text renderer
- `public/xulj.js`: DOM renderer (flex boxes, virtualized tree, commands, broadcasters)
- `app/deploy-console.js`: the demo app
- `server.js`: SSE stream with resume (`Last-Event-ID`), intent endpoint with a command allowlist
- `protocol/mqtt-topics.js`: MQTT topics → ops, for the browser and Node
- `transport/mqtt-publisher.js`: gives an app `ui.emit(op)` and publishes retained topics
- `mqtt-app.js`: runs `app/deploy-console.js` (unchanged) over MQTT
- `devices/greenhouse.js`: a device that hand-writes its own UI topics, with a last will
- `mqtt/`: mosquitto config and ACL; `mqtt/.env` holds publisher passwords (not committed)

## MQTT topics (prefix `xulj/<app>/`)

| topic | retained | payload |
|---|---|---|
| `node/<id>` | yes | element `{in, tag, order, ...attrs}`; empty payload removes it |
| `cmd/<id>` | yes | command state; empty deletes it |
| `bc/<id>` | yes | `{value}` |
| `rows/<src>/epoch` | yes | `{epoch}`; a newer epoch clears the source |
| `rows/<src>/ring/<k>` | yes | `{epoch, n, row}`: the last N rows, for late joiners |
| `rows/<src>/live` | no | `{epoch, n0, rows}` |
| `do/<cmd>`, `input/<id>` | no | viewer intents (the only topics anonymous clients may publish) |

Each element is its own topic, so a late joiner gets the current UI with nothing to replay,
and an update resends one widget. Retained messages arrive in any order: nodes wait for
their parent, and `order` fixes sibling position. Viewers validate every payload against
the schema, because there is no server in between. The broker ACL limits each publisher
to its own namespace.

## Ops

| op | meaning |
|---|---|
| `node` | insert an element (with nested children) into `in`, optionally `before` a sibling; waits if `in` has not arrived yet (a live overlay) |
| `replace` | swap element `id` for a new one, e.g. a `pending` placeholder becoming the real widget |
| `set` / `remove` | change attributes of, or remove, element `id` |
| `command` | declare or update an intent (`label`, `disabled`, `key`); every widget with `command=<id>` follows it |
| `broadcast` | set a broadcaster value; any attribute in `observes: {attr: broadcaster}` follows it |
| `rows` | `append` to (or `clear`) a data source; every `tree` bound to it updates |
| `reset` | drop all client state (always seq 1) |
| `download` | *transient*: download a file the host produced (`url` must be `/download/<token>` on the same origin) |
| `notify` | *transient*: show a short message (`level`: info, warning, error) |

Menus (`menubar`, `menu`, `menuitem`, `menuseparator`) open and close in the client; only choosing
an item sends an intent. A `menu` can carry an `accesskey` (`alt+f`), and a `menuitem` can be
`checked`, which works well with `observes` for radio-style groups.

Transient ops are sent to live clients only and never replayed, so a reconnect does not repeat a
download. A `window` with `modal: true` (and an optional `icon`: info, warning, error, question)
renders as a dialog over the others, which become inert. A `filepicker` element uploads the
chosen files with `POST /upload?session=<id>&id=<picker>` (header `X-Filename`); hosts that
support it, such as the desktop bridges, hand the stored files to the application.

## Known gaps

- MQTT: a viewer that disconnects misses live rows; on reconnect it gets only the retained ring.
- MQTT: all viewers share one UI per app (filters too). Per-user state would need per-session topics.
- MQTT: anonymous viewers can flood intent topics; there is no rate limit.

- The op log is never compacted, so a reconnect replays everything (including 100k rows).
- No session epoch: if the server restarts and the new session passes the client's seq, the client resumes wrongly.
- A virtualized tree tops out near the browser's maximum element height (about 800k rows in Firefox).
- The DOM renderer and `model.js` implement the same semantics twice.
