# Suwayomi-Private

Private Anpassung der **vollständigen Suwayomi-WebUI** für das NAS HLP2-NAS01-P. Bibliothek, Suche, Quellen, Kapitelverwaltung, Downloads und Reader bleiben Bestandteil der nativen Oberfläche. Als Basis dient Suwayomi-WebUI `v20260929.01` (Commit `41443eaba44bcbdf45d666fe27471b50d41fd994`, mindestens Server-Revision r2320). Die ursprünglichen Lizenz- und Copyright-Angaben sind erhalten.

## Aktueller Stand

In **Einstellungen → Private Updates** lassen sich neue Projektstände prüfen, installieren und auf den vorherigen erfolgreichen privaten Stand zurücksetzen. GitHub- und Portainer-Schlüssel können dort geprüft und ausgetauscht werden. Leere Eingaben behalten den bisherigen Schlüssel; gespeicherte Schlüssel werden nie an den Browser zurückgegeben.

Die Updatefunktion aktualisiert die private Oberfläche und ihren Dienst aus `kellykiller/Suwayomi-Private/main`. Das vorhandene Suwayomi-Server-Image bleibt erhalten. Automatische Übernahmen neuer Upstream-Versionen erfolgen nicht; Änderungen am Server oder an der Upstream-Basis werden separat geprüft. Die Verwaltung setzt die bestehende Suwayomi-Basic-Auth-Anmeldung voraus.

In **Entdecken → KI-Suche** oder über das KI-Symbol in der globalen Suche lassen sich natürliche Suchwünsche eingeben. **Einstellungen → KI-Einstellungen** verwaltet den OpenAI-API-Key, Aktivierung, Modell, Reasoning-Stufe und die Anzahl der Vorschläge. Standard: GPT-5.4 mini, niedriges Reasoning, maximal sechs Empfehlungen. GPT-5.4 und mittleres Reasoning sind alternativ auswählbar. Die neue Funktion ist ab Version 0.2.0 über das bestehende private Update installierbar.

Die KI interpretiert den Wunsch und liefert bekannte Titel mit Begründungen, Einschränkungen und alternativen Namen. Suwayomi prüft diese anschließend in den ausgewählten **installierten Quellen**. Quellen werden nach deinen Sprach- und Inhaltspräferenzen sowie ihrer Aktivierung gefiltert; angeheftete Quellen schränken die KI-Suche nicht ein. Über „Alle Quellensprachen“ und die Quellenauswahl lässt sich der Umfang ändern. Treffer öffnen die native Manga-Detailseite, von der aus Bibliothek, Kapitel und Downloads wie bisher bedient werden.

Die erste Ausbaustufe nutzt Modellwissen, keine Webrecherche oder vollständige Indexierung sämtlicher Quellenkataloge. Begründungen zu Handlungsentwicklung und Tempo sind KI-Einschätzungen. Verifizierte Quellentreffer bestätigen einen Titeleintrag, nicht die Verfügbarkeit aller Kapitel oder die inhaltliche Einschätzung. Titel werden konservativ anhand normalisierter Namen und expliziter Alternativnamen zugeordnet, damit Fortsetzungen und Spin-offs nicht automatisch mit dem empfohlenen Werk zusammenfallen. Fehlende Treffer beweisen keine Nichtverfügbarkeit. Quellenfehler und unvollständig geprüfte Quellen werden angezeigt. Anime-Streaming ist nicht Teil von Suwayomi; entsprechende Anfragen werden mit einem Hinweis auf passende Manga eingegrenzt.

Ab **0.3.0** enthalten KI-Ergebnisse ein Cover aus einem gefundenen Quelleneintrag und die frisch geladene Kapitelanzahl **je Quelleneintrag**. Unterschiedliche Kapitelstände sind damit direkt sichtbar. Mehrere Einträge mit derselben Kapitelnummer, etwa verschiedene Scanlatoren, werden für die Kapitelanzahl zusammengefasst; die gesamte Eintragszahl erscheint zusätzlich, wenn sie abweicht. Nicht nummerierte Kapitel werden einzeln gezählt. Bei fehlgeschlagenem Laden wird „Kapitelanzahl unbekannt“ angezeigt. Die zwei Beispiel-Prompt-Schaltflächen wurden entfernt. Die zusätzlichen Metadaten werden über Suwayomi geladen; Manga-Seiten werden dafür nicht heruntergeladen oder an OpenAI geschickt.

## Kapitelübersetzung (0.4.0, erster Ausbau)

In einem heruntergeladenen Kapitel öffnet **Kapitelmenü → Übersetzen** die neue Verwaltung unter **Einstellungen → Kapitelübersetzung**. Im mobilen Reader ist sie zusätzlich im Drei-Punkte-Menü erreichbar. Der Ablauf ist bewusst zweistufig:

1. **Texterkennung starten**: Quellsprache Englisch oder Japanisch wählen. Der vorhandene NAS-Download wird über Suwayomis lokalen CBZ-Export eingelesen; es gibt keinen Rückfall auf Quellenseiten. Downloadkennzeichen, Seitenanzahl und Archiv müssen zusammenpassen. Diese Stufe nutzt OpenAI nicht.
2. Erkannte Texte in der Seitenvorschau prüfen und vor dem ersten KI-Aufruf korrigieren.
3. **Kapitel übersetzen / fortsetzen**: Modell, Reasoning und Gesamtbudget wählen, der Übertragung von Kapiteltext und Kontextbildern an OpenAI ausdrücklich zustimmen. Standard: GPT-5.4 mini, mittleres Reasoning, $0.50 vorsorgliches Kapitelbudget. Die Suchkonfiguration bleibt davon unabhängig; der bereits geschützte OpenAI-Responses-Key wird wiederverwendet.
4. Zuerst wird der vollständige erkannte Kapiteltext für Kontext und Glossar gelesen. Danach erhält jeder Seitenaufruf Kapitelkontext, Nachbardialog und Bilder der aktuellen/angrenzenden Seiten. Lange Webtoon-Seiten werden für OCR und Bildkontext in überlappende Ausschnitte zerlegt, statt den ganzen Streifen unleserlich klein zu rechnen.
5. Übersetzter Text wird in geeignete helle Sprechblasen/Textfelder eingesetzt. Schrift über Zeichnungen, dunkle Flächen, schwierige Soundeffekte oder nicht lesbar passende Texte werden konservativ beibehalten und mit Hinweisen aufgeführt. Das ist **kein vollständig automatischer professioneller Scanlation-Ersatz**. Sprachliche Unsicherheit und fehlgeschlagene Bildbearbeitung werden getrennt angezeigt.
6. **Im Reader öffnen** und dort das Übersetzungssymbol einschalten. Eine fertige deutsche Ausgabe wird anstelle der Originalseiten angezeigt; ohne fertige Ausgabe bleibt es beim Original. Der Sprachwechsel erhält die aktuelle Seite und ändert nicht die Kapitel-IDs. Korrekturen bereits fertiger Übersetzungstexte erzeugen neue Bilddateien ohne weiteren KI-Aufruf.

Der erste Ausbau verarbeitet **ein Kapitel gleichzeitig**, 1–80 Seiten, höchstens 180 Textbereiche pro Seite / 2500 pro Kapitel, Ziel Deutsch. Stapelauswahl, weitere Quellensprachen, automatische Neuübersetzung bei Quellenänderungen, serienübergreifendes Glossar und aufwendige zeichnerische Rekonstruktion bleiben spätere Ausbaustufen. Ein fertiger Auftrag wird zum erneuten Lesen wiederverwendet; innerhalb pausierter Aufträge bleiben fertige Seiten und der Kapitelkontext erhalten. Ein absichtlich neu angelegter Auftrag ist nicht automatisch ein kostenloser Cache-Treffer.

### OCR-Werkzeuge und Ressourcen

- [manga-ocr](https://github.com/kha-white/manga-ocr) **0.1.16** mit `kha-white/manga-ocr-base`: spezialisiert auf japanische Manga, vertikale/horizontale Schrift und Furigana. Es erkennt Text in Bildausschnitten, ist aber weder englisches OCR noch eine komplette Seitenerkennung/Übersetzung. Es kann selbst bei textlosen Ausschnitten plausible Zeichen erfinden; deshalb werden Bereiche vorher erkannt und Ergebnisse zur Prüfung angeboten. Keine erfundene Prozent-Konfidenz für manga-ocr.
- [EasyOCR](https://github.com/JaidedAI/EasyOCR) **1.7.2**: CRAFT-Detektion für Textbereiche, zusätzlich englische Erkennung. Die Bildverarbeitung nutzt Pillow. Komplexe Bereiche werden nicht mit einer frei generierten ganzen Manga-Seite ersetzt.
- [mokuro](https://github.com/kha-white/mokuro) wurde als Referenz für die Trennung von Seitendetektion und manga-ocr geprüft. Sein Reader und sein Quellcode werden nicht übernommen. Drittanbieterhinweise: [private/translation/THIRD-PARTY.md](private/translation/THIRD-PARTY.md).

Die CPU-Modelle werden **beim Docker-Build** geladen und geprüft, nicht während einer Übersetzung. Das japanische Modell ist auf Revision `aa6573bd10b0d446cbf622e29c3e084914df9741` festgelegt. Der erste 0.4.0-Build ist durch Python, PyTorch und OCR-Gewichte deutlich größer/langsamer als bisher. Neben den bisherigen Zielen müssen `download.pytorch.org`, die Python-Paketserver, Hugging Face / dessen Dateidownloadziele und GitHub-Release-Downloads mit gültigem TLS erreichbar sein. Keine TLS-Ausnahmen oder fremden API-Schlüssel werden automatisch eingerichtet. Eine GPU ist nicht erforderlich; die tatsächliche NAS-Laufzeit wird erst mit einem echten Kapitel gemessen.

Die bestehende Updatefunktion kann 0.4.0 direkt installieren: Das bereits gebaute private Image enthält auch die Bildverarbeitung. Der Gateway erstellt daraus pro Verarbeitung einen isolierten Hilfscontainer mit **Netzwerk `none`**, 2 CPUs, maximal 3 GiB RAM, schreibgeschütztem Root-Dateisystem und ausschließlich dem jeweiligen Arbeitsordner als Schreibmount. Er bekommt keine API-Schlüssel, keinen Docker-Socket und keinen Mount der Originaldaten. Die WebUI bleibt beim bisherigen 256-MiB-Limit. Die kostenpflichtige OpenAI-Verbindung läuft nur über den geschützten Gateway. KI-Suche und Kapitelverarbeitung laufen in dieser ersten Version nicht gleichzeitig. Während einer Kapitelverarbeitung sind private Updates und Schlüsselwechsel gesperrt.

### Speicherung, Kosten und Wiederaufnahme

Die bestehenden Suwayomi-Downloads bleiben unverändert. Arbeitskopien, OCR, Vorschauen, Kapitelkontext und fertige Bilder liegen geschützt unter **`/volume3/docker/suwayomi/updater/translations/<Auftrags-ID>`**. Dafür wird der vorhandene persistente Mount genutzt; der Suwayomi-Server, sein Image, seine Downloadstruktur und seine Einstellungen werden nicht umgebaut. Der Ordner ist kein Wegwerf-Updatecache und muss bei Backups berücksichtigt werden. Es gibt keine automatische Löschung von Übersetzungen. Die Daten sind nach dem Speichern lokal lesbar; **die eigentliche OpenAI-Übersetzung ist nicht vollständig offline**.

Jeder KI-Aufruf wird vor dem Senden in derselben dauerhaften Verbrauchshistorie wie die KI-Suche erfasst, als **Übersetzung** mit Kapitel, Verarbeitungsschritt, vollständigem Textprompt, Übersetzungsanweisung, Prüfsummen der Kontextbilder, Modell, Tokens, Preisbasis und geschätztem Guthaben davor/danach. Die Bilddaten selbst stehen nicht nochmals in der Verbrauchsdatenbank. Bekannte Kosten werden auch bei unvollständiger Antwort erfasst. Der Budgetcheck reserviert vor jedem Aufruf vorsorglich ungekürzte Textbytes, Bild-Tokenobergrenzen und das Ausgabelimit; er ist keine Zusage eines exakt begrenzbaren externen Rechnungsbetrags. Unbekannte Kosten erfordern eine ausdrückliche Bestätigung vor dem Fortsetzen. Es gibt keine automatischen kostenpflichtigen Wiederholungen.

Aufträge bleiben bei Abbruch, Neustart oder privatem Update erhalten. Unvollständige Arbeit wird **pausiert**, nicht blind neu gesendet. Ein zuvor laufender lokaler Hilfscontainer wird anhand seiner exakten Auftragskennung beendet, bevor am Auftrag weitergearbeitet wird. Bereits fertige Übersetzungsseiten und Kapitelkontext werden beim ausdrücklichen Fortsetzen wiederverwendet. Ein zum Abbruchzeitpunkt bereits vom Anbieter bearbeiteter, aber nicht vollständig gespeicherter Aufruf kann trotzdem Kosten verursacht haben. Die Preview bietet Original, Übersetzung, OCR-Text, Unsicherheitshinweise und manuelle Textkorrektur. Auch fertige Ausgaben sollten geprüft werden.

Die Kapitelansicht ist in dieser ersten privaten Version deutschsprachig. Vor einer breiteren Freigabe sind weitere Übersetzungen und reale Kapiteltests nötig. Bei einem alten Server ohne lokalen CBZ-Export wird die Funktion mit einem Hinweis abgebrochen; es erfolgt weder ein Server-Update noch ein Ersatzabruf von den Quellen.

## KI-Verbrauch, Guthaben und Historie

**Einstellungen → KI-Verbrauch und Guthaben** enthält ab 0.3.0 eine dauerhafte, paginierte Suchhistorie und CSV-Export. Jeder gestartete Auftrag protokolliert Zeitpunkt, vollständigen Prompt, Antwortsprache, Modell, Reasoning, gewünschte Vorschlagszahl, ausgewählte Quellen, Ergebnisse, Tokenverbrauch, Kostenbasis und geschätzten Guthabenstand davor/danach. Der Auftrag wird vor dem kostenpflichtigen API-Aufruf gespeichert. Die geschützte SQLite-Datenbank liegt unter `/volume3/docker/suwayomi/updater/ai-usage.sqlite` (Modus 600). Sie bleibt bei privaten Updates erhalten. Neustart oder Abbruch mit fehlenden Tokenwerten erzeugen ausdrücklich unbekannte Kosten; diese werden nicht als kostenlos ausgegeben. Auch unvollständige oder abgewiesene KI-Antworten mit gemeldetem Verbrauch bleiben erfasst. Frühere Suchen aus 0.2.0 können nicht rekonstruiert werden.

Der vom Nutzer genannte **$2.31**-Stand ist der voreingestellte manuelle Ausgangswert. Die Restguthabenanzeige ist eine **lokale Schätzung**, kein live abgefragtes Prepaid-Guthaben. Sie zieht die nach diesem Bezugspunkt erfassten, bekannten geschätzten Suchkosten ab. Andere API-Nutzung, Aufladungen, Erstattungen und verfallende Credits sind nicht automatisch bekannt. Ein neuer manueller Guthabenstand aus dem OpenAI-Dashboard erstellt einen Bezugspunkt, ohne frühere Datensätze zu verändern. Guthabenänderungen sind während laufender Suchen gesperrt. Die Gesamtkosten und der Durchschnitt beziehen sich auf erfasste bekannte Kosten; unbekannte Kosten werden separat gezählt. Lokale KI-Antwort-Cache-Treffer kosten $0.

Die Berechnung nutzt Standardpreise in USD pro Million Tokens, geprüft am 2026-10-14: GPT-5.4 mini $0.75 Eingabe / $0.075 OpenAI-Cache-Eingabe / $4.50 Ausgabe; GPT-5.4 $2.50 / $0.25 / $15.00. Reasoning ist bereits in den Ausgabe-Tokens enthalten und wird nicht nochmals addiert. Jede Anfrage fordert `service_tier: default`; unbekannte Modelle oder andere Verarbeitungsklassen erhalten keine erfundene Schätzung. Jeder Historieneintrag behält seinen ursprünglichen Preissnapshot. Preisänderungen benötigen eine aktualisierte Preisbasis im Projekt. Quellenabfragen und Coverabrufe erzeugen keine OpenAI-Tokens.

Optional lassen sich offizielle Tageskosten über die dokumentierte OpenAI-Costs-API für 7, 30 oder 90 Tage abrufen. Dafür ist ein **separater Admin-Key mit Usage-Leserechten** nötig; der bestehende Responses-Key wird dafür nicht verwendet. Der Admin-Key wird geprüft und geschützt unter `secrets/openai-admin.token` gespeichert und niemals an Browser oder Inferenz-API gesendet. Eine optionale `proj_...`-Projekt-ID begrenzt den Abruf; ohne Filter werden Organisationskosten angezeigt. Abrufzeit und Tageswerte werden gespeichert. Die Costs-API ist kein Restguthaben-Endpunkt und erlaubt keine exakte Abrechnung einzelner Prompts; Werte können verzögert eintreffen. Offizielle Tageskosten werden deshalb separat angezeigt und nicht ein zweites Mal vom lokal geschätzten Guthaben abgezogen.

## KI-Zugang und Suchablauf

Der OpenAI-Key wird ausschließlich geschützt unter `/volume3/docker/suwayomi/secrets/openai.token` gespeichert (root, Modus 600), nicht im Repository oder Browser. Einstellungen und Suchantwort-Cache liegen unter `updater/ai-settings.json` beziehungsweise `updater/ai-cache`. Die API wird separat von einem ChatGPT-Abonnement abgerechnet. Der Key benötigt Zugriff auf die Responses-API und das gewählte Modell. Der optionale Verbindungstest prüft die Modellberechtigung über die Models-API ohne kostenpflichtige Textgenerierung, aber nicht das verfügbare Guthaben; ein eingeschränkter Key benötigt dafür auch Model-Leserechte. `api.openai.com` muss vom NAS aus mit gültigem TLS erreichbar sein.

Jede neue Suche erzeugt höchstens eine Responses-Anfrage mit strukturiertem JSON, niedrigem oder mittlerem Reasoning, maximal 4500 Ausgabetokens und `store: false`. Nur Suchwunsch und Antwortsprache werden als Nutzereingabe übertragen; Bibliothek, Zugangsdaten, Quellenlisten und Manga-Seiten werden nicht an die KI gesendet. `store: false` deaktiviert die Speicherung als Responses-Objekt, ist keine Zusage zu allgemeinen Aufbewahrungsfristen des Anbieters. Identische Wünsche mit derselben Sprache und Modellkonfiguration verwenden den lokalen KI-Antwort-Cache 24 Stunden lang erneut; Quellentreffer werden immer neu geprüft. Der Cache ist auf 100 geschützte Dateien begrenzt. Eingabe- und Ausgabetokens werden nach einer neuen KI-Antwort angezeigt.

Es läuft höchstens ein KI-Suchauftrag gleichzeitig. Bis zu 100 Quellen werden mit drei parallelen Quellenabfragen durchsucht, pro Titel und Alternativname auf maximal zwei Ergebnisseiten. Quellenanfragen haben 15 Sekunden Zeit, die KI-Antwort 90 Sekunden, der gesamte Auftrag vier Minuten. Treffer erscheinen laufend und bleiben bei Abbruch oder Zeitlimit sichtbar. Ergebnisse leben 30 Minuten im Dienstspeicher; nach Dienstneustart ist eine neue Suche nötig. Bei Verbindungsabbruch startet die Oberfläche keine neue kostenpflichtige Anfrage automatisch. Schlüsseländerungen sind während eines Auftrags gesperrt. Abbruch beendet laufende Anfragen, kann bereits angefallene API-Kosten aber nicht zurücknehmen.

## Lokale OCR-Leistung und Fortschritt (0.4.2)

Unter **Einstellungen → Kapitelübersetzung → Lokale OCR-Leistung** stehen drei dauerhafte Profile zur Verfügung: Sparsam (bis 2 CPUs), Ausgewogen (bis 4, neuer Standard) und Schnell (bis 8). Die Zahl wird auf die gemeldeten Host-CPUs begrenzt. Docker-CPU-Limit beziehungsweise Cpuset, Torch, OpenMP, MKL, OpenBLAS und OpenCV werden gemeinsam eingestellt. Das Speicherlimit bleibt 3 GiB; die NAS-Kernel-Kompatibilität aus 0.4.1 bleibt erhalten. Einstellungen liegen unter `/volume3/docker/suwayomi/updater/translation-performance.json` und gelten für den nächsten Worker. Änderungen sind während einer laufenden Kapitelverarbeitung gesperrt.

Die Anzeige unterscheidet lokale OCR-Seiten von übersetzten Seiten. Nach jeder erkannten Seite werden die bisherige Textanzahl, die Dauer dieser Seite und die durchschnittliche OCR-Zeit pro Seite aktualisiert. Modellstart und vorheriges Entpacken sind im Seitendurchschnitt nicht enthalten. Solange ausschließlich OCR läuft, sind null übersetzte Seiten korrekt; es werden keine OpenAI-Aufrufe gestartet. Docker-Messwerte werden nach Möglichkeit etwa alle zehn Sekunden abgefragt: CPU-Prozent (100 % entspricht einem Kern) und RAM-Nutzung; das Messdatum wird angezeigt. Ein nicht unterstützter Statistik-Endpunkt blockiert die OCR nicht.

**Laufende Aufträge vor dem Update abschließen oder abbrechen.** Die neue Version beschleunigt keinen bereits gestarteten Worker. Bei abgebrochener, noch nicht vollständig gespeicherter Texterkennung wird die lokale OCR wiederholt; die Fortschrittsdatei enthält Zähler, keine wiederaufnehmbaren Textresultate einzelner Seiten. Vollständig gespeicherte OCR-Ergebnisse, Originale und fertige Übersetzungen bleiben erhalten.

## Fehlerdiagnose und Protokolle (0.4.1)

**Einstellungen → Protokolle** bietet getrennte Ansichten für Kapitelübersetzung, OCR/Bildverarbeitung, KI-Suche, Private Updates, Private WebUI und Suwayomi-Server. Die aktuelle Ansicht kann als `.log` heruntergeladen, nach Text/Auftragskennung gefiltert und auf Wunsch alle zehn Sekunden aktualisiert werden. Fehler bei Kapitelübersetzungen verlinken direkt auf die passenden Protokolle.

Private Ereignisse liegen dauerhaft unter `/volume3/docker/suwayomi/updater/logs/<Kategorie>.log` (root, 0600). Pro Kategorie gibt es bei 2 MiB drei rotierende Archive. Die Webansicht zeigt höchstens etwa 2 MiB, ergänzt um die letzten 50 gespeicherten Übersetzungs-/Updateaufträge; die Containeransichten fragen höchstens die letzten 500 Zeilen ab. Ein Download ist derselbe begrenzte Auszug, ohne aktiven Textfilter. Ältere vollständige Archive liegen nur im NAS-Dateisystem. Ausgaben temporärer OCR-Container werden vor deren Entfernung gesichert; laufender Seitenfortschritt wird protokolliert. Bestehende 0.4.0-Fehler werden aus den gespeicherten Aufträgen angezeigt, bereits gelöschte Worker-Ausgaben lassen sich rückwirkend nicht rekonstruieren.

Zugriff und Download benötigen dieselbe geprüfte native Basic-Auth-Anmeldung wie die privaten Einstellungen. Bekannte gespeicherte API-Schlüssel sowie übliche Token-/Authorization-Muster werden ausgeblendet. Protokolle können Manga-Titel, Auftragskennungen und technische Fehlerdetails enthalten; vollständige Prompts und Kosten bleiben in der KI-Nutzungshistorie.

Der OCR-Start berücksichtigt die Docker-Kernel-Fähigkeiten: CPU-CFS-Quota (`NanoCpus`) wird nur bei gemeldeter Unterstützung gesetzt. Ohne CFS werden nach Möglichkeit zwei erlaubte CPUs über `CpusetCpus` verwendet, sonst unterstützte CPU-Gewichte und die konfigurierten Torch-Threads. Das ist ohne Cpuset/Quota kein harter Gesamt-CPU-Deckel. Das Prozesslimit wird nur mit gemeldeter PID-Cgroup-Unterstützung gesetzt; das 3-GiB-Speicherlimit und die übrige Isolation bleiben erhalten. Docker-/Portainer-Fehler zeigen nun die begrenzte, bereinigte Fehlermeldung statt lediglich HTTP 400. Ein erneuter lokaler Versuch verwendet den bestehenden Auftrag/CBZ-Export und ruft OpenAI nicht auf.

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

Die Tests prüfen unter anderem native API-/WebSocket-Weiterleitung, Anmeldung, Zugriffsschutz, Schlüsselabschirmung, Archivvalidierung, Auftragsperren, Docker-Buildfehler und Rücksetzen bei unverändertem Stack. Übersetzungstests prüfen zusätzlich lokalen CBZ-Export ohne Quellen-Fallback, Einwilligung, Kapitelkontext vor Seitenaufrufen, Kostenprotokoll, Budgetstop, Wiederaufnahme ohne erneute Bezahlung fertiger Seiten und Containerisolation. Python-Tests prüfen Archivpfade/Links/Größenlimits, Seitenreihenfolge, Erhalt der Originale, Textumbruch und konservatives Rendering. Der CI-Workflow baut das tatsächliche Docker-Image und führt darin einen **Offline-CPU-Smoke-Test** für englisches EasyOCR und das japanische manga-ocr-Modell aus. Kostenpflichtige Übersetzungsaufrufe verwenden lokal und in CI ausschließlich Mocks; ein echter API-/NAS-Kapiteltest ist anschließend erforderlich. CI veröffentlicht keine Pakete oder Images.

Die Originalquellen der verwendeten Upstream-Version liegen im Branch `upstream/v20260929.01`; eigene Änderungen werden auf `main` weiterentwickelt. Weitere Upstream-Hinweise: [Suwayomi-WebUI](https://github.com/Suwayomi/Suwayomi-WebUI), [MPL-2.0](LICENSE).
