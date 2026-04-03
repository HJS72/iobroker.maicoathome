![Logo](admin/maicoathome.png)
# ioBroker MAICO@HOME Adapter

Liest Statuswerte aus der MAICO@HOME Cloud und stellt steuerbare Remote-Datenpunkte in ioBroker bereit.
Getestet mit MAICO@HOME App und WS75 Wohnraumlüfter.

## Datenpunktstruktur

Der Adapter erzeugt Datenpunkte pro Geraet in der Form:

- `<instanz>.<geraet>.Status.<datenpunkt>`
- `<instanz>.<geraet>.Remote.<datenpunkt>`
- `<instanz>.<geraet>.connected`
- `<instanz>.<geraet>.lastupdate`

Beispiel:

- `maicoathome.0.ws75_wohnhaus.Status.room_temperature`
- `maicoathome.0.ws75_wohnhaus.Remote.target_room_temperature`
- `maicoathome.0.ws75_wohnhaus.connected`
- `maicoathome.0.ws75_wohnhaus.lastupdate`

## Remote (schreibbar)

- `operating_mode`
- `fan_level`
- `target_room_temperature`

## Hinweis

`operating_mode=3` wird fuer WS75 auf `2` normalisiert (ein gemeinsamer Automatik-Modus).
