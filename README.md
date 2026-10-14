# Suwayomi-Private

Private Anpassung der **vollständigen Suwayomi-WebUI** für das NAS HLP2-NAS01-P. Bibliothek, Suche, Quellen, Kapitelverwaltung, Downloads und Reader bleiben Bestandteil der nativen Oberfläche. Als Basis dient Suwayomi-WebUI `v20260929.01` (Commit `41443eaba44bcbdf45d666fe27471b50d41fd994`, mindestens Server-Revision r2320). Die ursprünglichen Lizenz- und Copyright-Angaben sind erhalten.

## Aktueller Stand

In **Einstellungen → Private Updates** lassen sich neue Projektstände prüfen, installieren und auf den vorherigen erfolgreichen privaten Stand zurücksetzen. GitHub- und Portainer-Schlüssel können dort geprüft und ausgetauscht werden. Leere Eingaben behalten den bisherigen Schlüssel; gespeicherte Schlüssel werden nie an den Browser zurückgegeben.

Die Updatefunktion aktualisiert die private Oberfläche und ihren Dienst aus `kellykiller/Suwayomi-Private/main`. Das vorhandene Suwayomi-Server-Image bleibt erhalten. Automatische Übernahmen neuer Upstream-Versionen erfolgen nicht; Änderungen am Server oder an der Upstream-Basis werden separat geprüft. Die Verwaltung setzt die bestehende Suwayomi-Basic-Auth-Anmeldung voraus.

In **Entdecken → KI-Suche** oder über das KI-Symbol in der globalen Suche lassen sich natürliche Suchwünsche eingeben. **Einstellungen → KI-Einstellungen** verwaltet den OpenAI-API-Key, Aktivierung, Modell, Reasoning-Stufe und die Anzahl der Vorschläge. Standard: GPT-5.4 mini, niedriges Reasoning, maximal sechs Empfehlungen. GPT-5.4 und mittleres Reasoning sind alternativ auswählbar. Die neue Funktion ist ab Version 0.2.0 über das bestehende private Update installierbar.

Die KI interpretiert den Wunsch und liefert bekannte Titel mit Begründungen, Einschränkungen und alternativen Namen. Suwayomi prüft diese anschließend in den ausgewählten **installierten Quellen**. Quellen werden nach deinen Sprach- und Inhaltspräferenzen sowie ihrer Aktivierung gefiltert; angeheftete Quellen schränken die KI-Suche nicht ein. Über „Alle Quellensprachen“ und die Quellenauswahl lässt sich der Umfang ändern. Treffer öffnen die native Manga-Detailseite, von der aus Bibliothek, Kapitel und Downloads wie bisher bedient werden.

Die erste Ausbaustufe nutzt Modellwissen, keine Webrecherche oder vollständige Indexierung sämtlicher Quellenkataloge. Begründungen zu Handlungsentwicklung und Tempo sind KI-Einschätzungen. Verifizierte Quellentreffer bestätigen einen Titeleintrag, nicht die Verfügbarkeit aller Kapitel oder die inhaltliche Einschätzung. Titel werden konservativ anhand normalisierter Namen und expliziter Alternativnamen zugeordnet, damit Fortsetzungen und Spin-offs nicht automatisch mit dem empfohlenen Werk zusammenfallen. Fehlende Treffer beweisen keine Nichtverfügbarkeit. Quellenfehler und unvollständig geprüfte Quellen werden angezeigt. Anime-Streaming ist nicht Teil von Suwayomi; entsprechende Anfragen werden mit einem Hinweis auf passende Manga eingegrenzt.

Kapitelübersetzung ist noch nicht implementiert. Vorgesehen sind Übersetzungen aus heruntergeladenen Kapiteln mit Bild- und Kapitelkontext. Originaldateien sollen unverändert erhalten bleiben; übersetzte Seiten werden separat erzeugt.

## KI-Zugang und Suchablauf

Der OpenAI-Key wird ausschließlich geschützt unter `/volume3/docker/suwayomi/secrets/openai.token` gespeichert (root, Modus 600), nicht im Repository oder Browser. Einstellungen und Suchantwort-Cache liegen unter `updater/ai-settings.json` beziehungsweise `updater/ai-cache`. Die API wird separat von einem ChatGPT-Abonnement abgerechnet. Der Key benötigt Zugriff auf die Responses-API und das gewählte Modell. Der optionale Verbindungstest prüft die Modellberechtigung über die Models-API ohne kostenpflichtige Textgenerierung, aber nicht das verfügbare Guthaben; ein eingeschränkter Key benötigt dafür auch Model-Leserechte. `api.openai.com` muss vom NAS aus mit gültigem TLS erreichbar sein.

Jede neue Suche erzeugt höchstens eine Responses-Anfrage mit strukturiertem JSON, niedrigem oder mittlerem Reasoning, maximal 4500 Ausgabetokens und `store: false`. Nur Suchwunsch und Antwortsprache werden als Nutzereingabe übertragen; Bibliothek, Zugangsdaten, Quellenlisten und Manga-Seiten werden nicht an die KI gesendet. `store: false` deaktiviert die Speicherung als Responses-Objekt, ist keine Zusage zu allgemeinen Aufbewahrungsfristen des Anbieters. Identische Wünsche mit derselben Sprache und Modellkonfiguration verwenden den lokalen KI-Antwort-Cache 24 Stunden lang erneut; Quellentreffer werden immer neu geprüft. Der Cache ist auf 100 geschützte Dateien begrenzt. Eingabe- und Ausgabetokens werden nach einer neuen KI-Antwort angezeigt.

Es läuft höchstens ein KI-Suchauftrag gleichzeitig. Bis zu 100 Quellen werden mit drei parallelen Quellenabfragen durchsucht, pro Titel und Alternativname auf maximal zwei Ergebnisseiten. Quellenanfragen haben 15 Sekunden Zeit, die KI-Antwort 90 Sekunden, der gesamte Auftrag vier Minuten. Treffer erscheinen laufend und bleiben bei Abbruch oder Zeitlimit sichtbar. Ergebnisse leben 30 Minuten im Dienstspeicher; nach Dienstneustart ist eine neue Suche nötig. Bei Verbindungsabbruch startet die Oberfläche keine neue kostenpflichtige Anfrage automatisch. Schlüsseländerungen sind während eines Auftrags gesperrt. Abbruch beendet laufende Anfragen, kann bereits angefallene API-Kosten aber nicht zurücknehmen.

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
