# matterbridge-zigbee2mqtt

**Fork** von [Luligu/matterbridge-zigbee2mqtt](https://github.com/Luligu/matterbridge-zigbee2mqtt) mit erweiterter Transport-Option.

## Ursprung

Basiert auf dem großartigen [matterbridge-zigbee2mqtt](https://www.npmjs.com/package/matterbridge-zigbee2mqtt) v3.2.0 von **Luca Liguori** (@Luligu). Das Original kommuniziert ausschließlich über MQTT mit einem MQTT-Broker.

## Erweiterung: Dualer Transport (MQTT + WebSocket)

Dieser Fork fügt einen **zweiten Transport-Modus** hinzu: direkte WebSocket-Verbindung zum Zigbee2MQTT-Frontend (`ws://host:port/api`). Kein MQTT-Broker mehr nötig.

In der Plugin-Config wählst du per `transport`-Feld:

| transport   | Beschreibung | Erforderlich |
|-------------|-------------|-------------|
| `"websocket"` | Verbindet per WebSocket direkt an Zigbee2MQTT (`ws://host:port/api`). **Kein MQTT-Broker nötig.** | Z2M Frontend (Port 8080) |
| `"mqtt"` | Originaler MQTT-Modus. Erfordert einen MQTT-Broker. | MQTT Broker |

### WebSocket-Modus (`"transport": "websocket"`)

```json
{
  "transport": "websocket",
  "host": "192.168.1.100",
  "port": 8080,
  "token": "",
  "topic": "zigbee2mqtt"
}
```

- Verbindet per `ws://host:port/api`
- `token`: `auth_token` aus der Z2M-Frontend-Config (leer lassen wenn nicht gesetzt)
- Funktioniert mit dem eingebauten WebSocket-Server von Zigbee2MQTT

### MQTT-Modus (`"transport": "mqtt"`)

```json
{
  "transport": "mqtt",
  "mqttHost": "mqtt://192.168.1.100",
  "mqttPort": 1883,
  "mqttUsername": "",
  "mqttPassword": "",
  "topic": "zigbee2mqtt"
}
```

- Alle original MQTT-Features (TLS, Client-Zertifikate, Unix-Socket) bleiben erhalten
- Felder: `ca`, `cert`, `key`, `clientId`, `protocolVersion`, `rejectUnauthorized`

## Was wurde geändert?

| Datei | Änderung |
|-------|----------|
| `src/zigbee2mqtt-mqtt.ts` | Originaler MQTT-Transport (unverändert aus Upstream) |
| `src/zigbee2mqtt-ws.ts` | **Neu**: WebSocket-Transport-Klasse |
| `src/zigbee2mqtt.ts` | Re-exportiert beide Klassen |
| `src/module.ts` | Wählt per `config.transport` die richtige Transport-Klasse + Events |
| `package.json` | `ws` als Dependency hinzugefügt, `mqtt` bleibt |
| `matterbridge-zigbee2mqtt.config.json` | `transport`, `token`, `mqtt*` Felder ergänzt |
| `matterbridge-zigbee2mqtt.schema.json` | Schema für beide Modi aktualisiert |

## Installation

```bash
git clone https://github.com/DEIN_USER/matterbridge-zigbee2mqtt.git
cd matterbridge-zigbee2mqtt
npm install
npm run build
matterbridge --add $(pwd)
matterbridge restart
```

## Lizenz

Apache-2.0 – wie das Original.
