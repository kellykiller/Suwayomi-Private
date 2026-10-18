# Automatische Cloud-Uebersetzung (Private 0.5.2)

## Direkt in Suwayomi aktualisieren

Unter **Einstellungen > Private Updates > Pruefen** Version **0.5.2** installieren
und nach erfolgreichem Update die Seite neu laden. Das bestehende Update baut
jetzt auch Uebersetzerdienst **0.1.2** in dasselbe Image ein und aktualisiert den
bereits eingerichteten Dienst automatisch. Kein ZIP-Import, SSH-Aufruf oder
erneutes Eintragen der Cloud-Schluessel ist dafuer erforderlich.

Vor dem Austausch laeuft ein Offline-Selbsttest ohne Netzwerk und ohne Zugriff
auf Daten oder Schluessel. Er prueft insbesondere AVIF, HEIC und PDF. Erst danach
wird ein unbeschaeftigter Dienst ausgetauscht; seine Daten- und Secret-Verzeichnisse,
Loopback-Port und Neustartregel bleiben erhalten. Die Startpruefung kontrolliert
Version und gespeicherte Schluessel. Scheitert der Austausch, wird der bisherige
Dienst wiederhergestellt. Der alte Container bleibt als gestoppte Sicherung
erhalten. Der WebUI-Updater meldet den gesamten Vorgang erst dann erfolgreich,
wenn auch der Dienst bereit ist.

Normale WebUI-Neustarts und ein ausdrueckliches WebUI-Rollback aktualisieren den
Dienst nicht. Das WebUI-Rollback setzt seine Version nicht zurueck. Ist noch kein
separater Dienst eingerichtet, installiert dieses Update keinen neuen Dienst.
Aktive Uebersetzungen vor dem Update abschliessen oder abbrechen. Update und
Selbsttest senden **keine Cloud-Anfragen** und starten keine Uebersetzung neu.
Den fehlgeschlagenen AVIF-Auftrag anschliessend ausdruecklich **Fortsetzen**;
erst diese Verarbeitung kann wieder kostenpflichtige Anfragen ausloesen.

## Bild- und Dokumentformate

Mit Uebersetzerdienst **0.1.2** werden JPG/JPEG, PNG, WebP, AVIF, BMP/DIB,
GIF, TIFF/TIF, HEIC/HEIF, PDF und weitere Rasterformate (JPEG 2000,
PPM/PGM/PBM/PNM, TGA, PCX, ICO) unterstuetzt. Die Alias-Endung `.giff`
wird ebenfalls erkannt. Der Exportadapter uebergibt die Originaldateien;
der Uebersetzungsdienst dekodiert und normalisiert sie lokal vor der OCR.

Mehrseitige TIFFs, PDFs und HEIF-Sammlungen werden vollstaendig aufgeteilt.
Der Gateway unterscheidet Quelldateien von Ausgabeseiten und stellt alle
fertigen Seiten im deutschen Leser sowie in der CBZ bereit. Bei Animationen
(GIF, WebP, AVIF, PNG) wird das erste vollstaendige Bild verarbeitet. PDFs
werden normalerweise mit 300 dpi innerhalb der Dienst-Pixelgrenzen gerendert.
Die Originaldateien bleiben erhalten. API-Budgets richten sich nach den
tatsaechlichen Dokumentseiten; maximal 100 Ausgabeseiten je Kapitel.

Der Dialog verarbeitet weiterhin Suwayomis Kapitel. Dieses Update ergaenzt
keinen separaten Browser-Dateiupload fuer beliebige lokale Dokumente. Der
separate Dienst akzeptiert einzelne Bilder/PDFs auch direkt ueber seine lokale
API oder den Pipeline-Aufruf.

Gespeicherte Schluessel, Zugriffstoken und Auftraege bleiben erhalten.
Neue lokale Eingabefehler werden mit ihrem konkreten Fehlertext angezeigt und
im Uebersetzungsprotokoll festgehalten; der interne Token wird ausgeblendet.

Die private Oberflaeche verbindet sich mit dem separaten Container
`suwayomi-cloud-translator` (Dienstversion 0.1.2) auf `127.0.0.1:18083`. Der getestete
Kapitel-Uebersetzer mit automatischer Ausnahmepruefung bleibt unveraendert.
Google Cloud Vision uebernimmt OCR, OpenAI (`gpt-6-astra`) Bildpruefung und
Uebersetzung mit Kapitelkontext. Retusche und Textsatz laufen im CPU-Dienst
auf dem NAS. Die bisherige lokale OCR bleibt fuer alte Auftraege erreichbar.

## Einmalig verbinden

Voraussetzung: Der Dienst meldet `status: ok`, beide Cloud-Schluessel sind
gespeichert und `control_token_configured` ist `true`.

Im NAS-Terminal den internen Zugriffstoken in das bereits eingebundene
Secret-Verzeichnis der privaten Oberflaeche kopieren:

```sh
sudo sh -c 'set -eu
umask 077
test -s /volume3/docker/suwayomi-translator/secrets/control.token
cp /volume3/docker/suwayomi-translator/secrets/control.token /volume3/docker/suwayomi/secrets/cloud-translator.token.tmp
chmod 600 /volume3/docker/suwayomi/secrets/cloud-translator.token.tmp
mv -f /volume3/docker/suwayomi/secrets/cloud-translator.token.tmp /volume3/docker/suwayomi/secrets/cloud-translator.token'
```

Dies kopiert ausschliesslich den internen Zugriffstoken. Google-/OpenAI-Schluessel
bleiben beim Uebersetzungsdienst. Keine Stack-Aenderung, kein neuer Port und
keine weitere Volume-Freigabe erforderlich. Bei Austausch des internen Tokens
im Dienst den Kopierschritt wiederholen. Niemals Tokenwerte in Chat/Logs posten.

Anschliessend in **Einstellungen > Private Updates** Version 0.5.2 installieren
und die Seite neu laden. Unter **Kapiteluebersetzung** erscheint der automatische
Ablauf. Ein gespeicherter Schluessel bedeutet noch keinen bestaetigten Zugang
zum Cloud-Anbieter; dies prueft erst eine ausdruecklich gestartete Verarbeitung.

## Verwenden

- Ein Kapitel, mehrere markierte Kapitel oder Manga in der Bibliothek auswaehlen
  und **Uebersetzen** waehlen. Auf der Manga-Detailseite gibt es ebenfalls die
  Aktion **Manga uebersetzen**.
- Die Auswahl zeigt die Kapitelanzahl und bereits vorhandene Uebersetzungen.
  Fehlende NAS-Downloads erledigt Suwayomis bestehende Warteschlange.
- Nach ausdruecklicher Zustimmung startet **Automatisch uebersetzen** den
  gesamten ausgewaehlten Umfang. Es gibt keine manuellen Seitenfreigaben.
- Der Dienst verwendet fest `gpt-6-astra`. Standardmaessig maximal 160 OpenAI-
  Anfragen je Kapitel; dies ist eine Anzahlgrenze, kein Dollar-/Euro-Limit.
  Google-OCR ist im Dienst auf die Kapitel-Seitenanzahl begrenzt. Kosten beider
  Anbieter werden getrennt abgerechnet. Es wird kein ungepruefter Preis geschaetzt.
- **Deutsch lesen** aktiviert die vorhandene Deutsch-Praeferenz und oeffnet den
  normalen Suwayomi-Leser. Originale und Lesefortschritt bleiben bei Suwayomi.
  Der Leser kann weiterhin zwischen Original und Deutsch wechseln. Bei fehlender
  Uebersetzung zeigt er das Original. Einzelne zurueckgestellte Textbereiche
  bleiben auch innerhalb einer fertigen deutschen Seite im Original erhalten.
- Fertige Kapitel stehen ausserdem als CBZ zur Verfuegung. Die Auswahl wird
  auch unter **Laufende Aufgaben** unabhaengig vom urspruenglichen Browser angezeigt.

## Fortsetzen und Daten

Ein Gateway verarbeitet eine Auswahl zur Zeit und deren Kapitel nacheinander.
Maximal 1000 Kapitel pro Auswahl; die Dienstgrenzen von 1–100 Ausgabeseiten
und 256 MiB Eingang je Kapitel bleiben bestehen. Maximal 300 gespeicherte Auswahlen
und 5000 gespeicherte Kapitelreferenzen begrenzen den Arbeitsspeicherbedarf.

Die Zuordnung und importierten Bilder liegen unter
`/volume3/docker/suwayomi/updater/cloud-translations/` (im UI-Container `/update/cloud-translations`).
Der Dienst behaelt seine Originale, API-Antworten und Ausgaben weiterhin unter
`/volume3/docker/suwayomi-translator/data/`. Es gibt keine automatische Bereinigung.

Abgeschlossene Kapitel werden uebersprungen. Eine gleiche Auswahl mit derselben
Anfrage-ID erzeugt keinen zweiten Lauf; eine neue Auswahl mit einem bereits
unvollstaendigen Kapitel verweist auf den bestehenden Auftrag. WebUI-Neustarts
setzen die Auswahl auf unterbrochen und reichen nichts automatisch erneut ein.
Ein bereits uebergebenes Kapitel kann im separaten Dienst weiterlaufen.
**Fortsetzen** prueft zuerst dessen gespeicherte UUID und uebernimmt fertige
Ausgaben; es setzt abgebrochene Cloud-Jobs nur nach dieser ausdruecklichen Aktion
fort. Die `.pending`-Sperren des Dienstes bleiben wirksam. Modellablehnungen
werden nicht umgangen. Bei Verlust einer Antwort gibt es keinen automatischen
zweiten Upload unter einer neuen UUID.

**Abbrechen** stoppt den aktuellen Cloud-Auftrag und die weitere Kapitelfolge.
Bereits angefallene Kosten bleiben bestehen. Eine bereits gestartete native
Suwayomi-Downloadwarteschlange wird nicht geloescht. Fertige Kapitel bleiben
lesbar. Software-Updates ueber den privaten Gateway sind waehrend einer aktiven
Cloud-Auswahl gesperrt; diese zuerst abschliessen oder abbrechen.

Alle Cloud-API-Routen verwenden die vorhandene Suwayomi-Anmeldung. Veraendernde
Aufrufe benoetigen denselben Origin und `X-Suwayomi-Private: 1`. Der interne
Bearer-Token wird ausschliesslich vom Gateway an Loopback gesendet und erscheint
nicht im Browser. Kapitel-Basic-Auth/Cookies bleiben beim internen Suwayomi-
Backend. Nummerierte PNG-Ausgaben werden vollstaendig samt ZIP-CRC geprueft,
bevor sie fuer den Leser freigegeben werden; Archivpfade werden nicht uebernommen.

## Validierung

Die Tests simulieren die Cloud-Anbieter, verwenden echte CBZ-Dateien und echte
Python-Import-/Exportprozesse. Sie pruefen Auswahl, native Downloads, mehrfaches
Einreichen, verlorene Antworten, Neustarts, explizites Fortsetzen/Abbrechen,
Kapitelaenderungen, unsichere Archive, Leserzuordnung, zentrale Aufgaben und
Anmeldung/Origin-Schutz. Keine echten kostenpflichtigen Anfragen bei diesen Tests.
Ein Live-Test mit dem NAS-Dienst und einem ersten ausgewaehlten Kapitel bleibt
nach der Installation erforderlich.
