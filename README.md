# Suwayomi-Private

Private Anpassung der **vollständigen Suwayomi-WebUI** für das NAS HLP2-NAS01-P. Bibliothek, Suche, Quellen, Kapitelverwaltung, Downloads und Reader bleiben Bestandteil der nativen Oberfläche. Als Basis dient Suwayomi-WebUI `v20260929.01` (Commit `41443eaba44bcbdf45d666fe27471b50d41fd994`, mindestens Server-Revision r2320). Die ursprünglichen Lizenz- und Copyright-Angaben sind erhalten.

## Aktueller Stand

In **Einstellungen → Private Updates** lassen sich neue Projektstände prüfen, installieren und auf den vorherigen erfolgreichen privaten Stand zurücksetzen. GitHub- und Portainer-Schlüssel können dort geprüft und ausgetauscht werden. Leere Eingaben behalten den bisherigen Schlüssel; gespeicherte Schlüssel werden nie an den Browser zurückgegeben.

Die Updatefunktion aktualisiert die private Oberfläche und ihren Dienst aus `kellykiller/Suwayomi-Private/main`. Das vorhandene Suwayomi-Server-Image bleibt erhalten. Automatische Übernahmen neuer Upstream-Versionen erfolgen nicht; Änderungen am Server oder an der Upstream-Basis werden separat geprüft. Die Verwaltung setzt die bestehende Suwayomi-Basic-Auth-Anmeldung voraus.

KI-Suche und Kapitelübersetzung sind noch nicht implementiert. Vorgesehen sind natürliche Suchanfragen sowie Übersetzungen aus heruntergeladenen Kapiteln mit Bild- und Kapitelkontext. Originaldateien sollen unverändert erhalten bleiben; übersetzte Seiten werden separat erzeugt.

## NAS-Einrichtung

Voraussetzung ist die abgeschlossene MangaFusion-Migration:

- Daten: `/volume3/docker/suwayomi/data`
- Schlüssel: `/volume3/docker/suwayomi/secrets/github.token` und `portainer.token`
- Verbindung: `/volume3/docker/suwayomi/updater/connection.json`
- Portainer-Stack und Backend-Container: `suwayomi`

Der GitHub-Token muss Zugriff auf dieses neue private Repository haben: **Contents: Read** und die automatisch enthaltenen Metadatenrechte genügen. Ein Fine-grained Token, der ausschließlich das gelöschte MangaFusion-Repository auswählt, muss entsprechend angepasst werden. Der Portainer-Token muss den vorhandenen Stack und den lokalen Docker-Endpunkt verwalten können.

`deploy/nas-install.sh` wird einmalig als root mit einer vollständigen, geprüften Commit-SHA ausgeführt. Es erstellt das Image, prüft den vorhandenen Backend-Container und richtet die vollständige private Oberfläche ein. Während des Builds läuft der Reader weiter; beim abschließenden Wechsel wird Suwayomi kurz sauber gestoppt. Der bestehende DSM-Reverse-Proxy bleibt bei **HTTP 192.168.175.60:18081**.

| Zugang                                 | Zweck                                                         |
| -------------------------------------- | ------------------------------------------------------------- |
| `https://hlp2-nas01-p.chickenfight.de` | Vollständige private Suwayomi-Oberfläche                      |
| `http://192.168.175.60:18081`          | Derselbe Dienst direkt im LAN                                 |
| `http://192.168.175.60:18082`          | Originaloberfläche des vorhandenen Servers als Rückfallzugang |

Der zusätzliche Container `suwayomi-private-ui` nutzt Host-Netzwerk, damit er das ausschließlich lokal erreichbare Portainer ansprechen kann; er lauscht nur auf der NAS-IP, Port 18081. API und WebSockets werden an den vorhandenen Server auf Port 18082 weitergeleitet. Anmeldung und Daten bleiben beim Server. Diese Installation ist bewusst auf die bestätigte NAS-Konfiguration zugeschnitten.

Die Einrichtung prüft Image, Benutzer, Datenmount, Zugangskonfiguration, Stack und Docker-Kennung. Bei einem fehlgeschlagenen Wechsel versucht sie, die ursprüngliche Stack-Konfiguration wiederherzustellen. Snapshots liegen geschützt unter `updater/backups`; sie können Zugangsdaten enthalten und gehören nicht ins Repository. Ein tatsächlicher NAS-Lauf ist zur abschließenden Überprüfung erforderlich.

## Updates und Wiederherstellung

Ein Update lädt einen festen Commit aus GitHub und baut ihn lokal über die Portainer-Docker-API. Ein separater Hilfscontainer führt den Auftrag weiter, während die Oberfläche ausgetauscht wird. Gleichzeitige Aufträge sind gesperrt; zwischenzeitliche manuelle Stack-Änderungen werden nicht überschrieben. Bei fehlgeschlagenem Start wird auf das vorherige Image zurückgesetzt. Alte private Images nicht löschen, solange sie als Rücksetzstand gebraucht werden.

Rücksetzen steht nach dem ersten erfolgreichen Update zur Verfügung. Der erstmalige Installationssnapshot wird separat aufbewahrt. Wenn ein Auftrag nach einem NAS-Neustart hängen bleibt, zunächst den zugehörigen Hilfscontainer `suwayomi-private-update-<Auftrags-ID>` und die Dateien unter `updater/jobs` prüfen. Eine Sperre erst nach Bestätigung entfernen, dass kein Auftrag mehr läuft. Der Rückfallzugang auf Port 18082 bleibt verfügbar.

GitHub, codeload.github.com, Docker Hub und die npm-Registry müssen vom NAS aus mit korrektem TLS erreichbar sein. Eine API-Schlüsseländerung ersetzt keine Netzwerkkonfiguration. TLS-Prüfung nicht deaktivieren.

## Entwicklung

Node >=24.20.0 und pnpm 11.1.2:

```sh
pnpm install --frozen-lockfile
pnpm tsc
pnpm lint
pnpm format:check
pnpm test
pnpm setup-env-files
pnpm exec vite build
```

Die Tests prüfen unter anderem native API-/WebSocket-Weiterleitung, Anmeldung, Zugriffsschutz, Schlüsselabschirmung, Archivvalidierung, Auftragsperren, Docker-Buildfehler und Rücksetzen bei unverändertem Stack. Der CI-Workflow prüft zusätzlich den Docker-Build. CI veröffentlicht keine Pakete oder Images.

Die Originalquellen der verwendeten Upstream-Version liegen im Branch `upstream/v20260929.01`; eigene Änderungen werden auf `main` weiterentwickelt. Weitere Upstream-Hinweise: [Suwayomi-WebUI](https://github.com/Suwayomi/Suwayomi-WebUI), [MPL-2.0](LICENSE).
