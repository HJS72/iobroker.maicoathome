# ioBroker MAICO@HOME Adapter (Prototype)

## Datenpunktstruktur

Der Adapter erzeugt Datenpunkte pro Geraet in der Form:

- `<instanz>.<geraet>.Status.<datenpunkt>`
- `<instanz>.<geraet>.Remote.<datenpunkt>`

Beispiel:

- `maicoathome.0.ws75_wohnhaus.Status.room_temperature`
- `maicoathome.0.ws75_wohnhaus.Remote.target_room_temperature`

## Remote (schreibbar)

- `operating_mode`
- `fan_level`
- `target_room_temperature`
- `device_filter_changed`
- `outside_filter_changed`
- `room_filter_changed`

## Hinweis

`operating_mode=3` wird fuer WS75 auf `2` normalisiert (ein gemeinsamer Automatik-Modus).

## Entwicklung

```bash
npm install
npm run lint
npm test
```

## CI

Ein GitHub-Workflow ist unter `.github/workflows/ci.yml` enthalten und prueft:

- Lint
- Package-Tests
- Integration-Tests
